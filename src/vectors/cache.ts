/**
 * Parsed points for the built-in search, kept per collection.
 *
 * Without it every search re-reads the collection and runs `JSON.parse` on
 * each row's embedding, metadata and permissions, and tokenizes its content
 * for BM25, often twice. The cache holds those parsed values: vectors as
 * `Float64Array` (the same math as before), and content as integer term IDs
 * from a per-collection dictionary so hybrid search needs no tokenizing.
 *
 * Each entry is tagged with the collection's `_meta` version, which triggers
 * bump on every point write from any process, so a write made by another
 * worker or the CLI is seen on the next search. The version is read before the
 * scan: a write during the build leaves the entry older than the counter, and
 * the next search rebuilds it.
 *
 * Memory is bounded by a byte budget per process. Collections that do not fit
 * are not cached and keep using the streaming scan.
 */
import { tokenize } from './lexical'
import type { VectorPointRow } from './types'

export interface CachedPoint {
  /** The row without its embedding text, for `pointModel()`. */
  row: VectorPointRow
  vector: Float64Array
  norm: number
  metadata: Record<string, unknown>
  permissions: string[]
  /** Content terms as dictionary IDs, in order. */
  terms: Uint32Array
}

export interface CachedCollection {
  version: number
  points: CachedPoint[]
  /** Term → ID for this collection's content. */
  dictionary: Map<string, number>
  bytes: number
}

/** What the builder needs for each row; the service supplies the parsing. */
export interface PointParts {
  vector: number[] | null
  norm: number
  metadata: Record<string, unknown>
  permissions: string[]
}

/** Rough per-point overhead: the row object, maps and array headers. */
const POINT_OVERHEAD = 400

export class VectorSearchCache {
  private readonly entries = new Map<string, CachedCollection>()
  /** Builds in flight, so concurrent searches share one scan. */
  private readonly building = new Map<string, Promise<CachedCollection | null>>()
  /** Collections too large for the budget at a given version. */
  private readonly tooLarge = new Map<string, number>()
  private total = 0

  constructor(readonly budgetBytes: number) {}

  /** The cached collection at `version`, building it with `scan` when needed; null when it does not fit. */
  async get(
    collectionId: string,
    version: number,
    /** Bytes the collection needs at least; only asked on a miss. */
    estimate: () => Promise<number>,
    scan: (visit: (row: VectorPointRow) => boolean) => Promise<void>,
    parse: (row: VectorPointRow) => PointParts,
  ): Promise<CachedCollection | null> {
    if (this.budgetBytes <= 0) return null
    const current = this.entries.get(collectionId)
    if (current && current.version === version) {
      // Most recently used goes last; eviction takes from the front.
      this.entries.delete(collectionId)
      this.entries.set(collectionId, current)
      return current
    }
    if (this.tooLarge.get(collectionId) === version) return null
    const key = `${collectionId}\u0000${version}`
    let pending = this.building.get(key)
    if (!pending) {
      if ((await estimate()) > this.budgetBytes) {
        this.tooLarge.set(collectionId, version)
        return null
      }
      pending = this.building.get(key)
    }
    if (!pending) {
      pending = this.build(collectionId, version, scan, parse).finally(() => this.building.delete(key))
      this.building.set(key, pending)
    }
    return pending
  }

  /** Forget a collection, for example after it is deleted. */
  drop(collectionId: string): void {
    const entry = this.entries.get(collectionId)
    if (entry) this.total -= entry.bytes
    this.entries.delete(collectionId)
    this.tooLarge.delete(collectionId)
  }

  clear(): void {
    this.entries.clear()
    this.tooLarge.clear()
    this.total = 0
  }

  get size(): { collections: number; bytes: number } {
    return { collections: this.entries.size, bytes: this.total }
  }

  private async build(
    collectionId: string,
    version: number,
    scan: (visit: (row: VectorPointRow) => boolean) => Promise<void>,
    parse: (row: VectorPointRow) => PointParts,
  ): Promise<CachedCollection | null> {
    const dictionary = new Map<string, number>()
    const points: CachedPoint[] = []
    let bytes = 0
    let fits = true
    await scan((row) => {
      const parts = parse(row)
      const words = tokenize(row.content)
      const terms = new Uint32Array(words.length)
      for (let i = 0; i < words.length; i++) {
        let id = dictionary.get(words[i]!)
        if (id === undefined) {
          id = dictionary.size
          dictionary.set(words[i]!, id)
          bytes += words[i]!.length * 2 + 48
        }
        terms[i] = id
      }
      const vector = parts.vector ? Float64Array.from(parts.vector) : new Float64Array(0)
      bytes += vector.byteLength + terms.byteLength + row.content.length * 2 + row.metadata.length * 2 + POINT_OVERHEAD
      if (bytes > this.budgetBytes) {
        fits = false
        return false
      }
      points.push({
        row: { ...row, embedding: '' },
        vector,
        norm: parts.norm,
        metadata: parts.metadata,
        permissions: parts.permissions,
        terms,
      })
      return true
    })
    if (!fits) {
      this.tooLarge.set(collectionId, version)
      return null
    }
    const previous = this.entries.get(collectionId)
    if (previous) {
      // A newer build may have landed first; keep whichever is current.
      if (previous.version > version) return previous
      this.total -= previous.bytes
      this.entries.delete(collectionId)
    }
    while (this.total + bytes > this.budgetBytes && this.entries.size > 0) {
      const [oldest, entry] = this.entries.entries().next().value as [string, CachedCollection]
      this.entries.delete(oldest)
      this.total -= entry.bytes
    }
    const entry: CachedCollection = { version, points, dictionary, bytes }
    this.entries.set(collectionId, entry)
    this.total += bytes
    this.tooLarge.delete(collectionId)
    return entry
  }
}
