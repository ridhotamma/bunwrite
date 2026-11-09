/**
 * External approximate-nearest-neighbour index.
 *
 * SQL remains the source of truth for points, permissions and documents. An
 * external index mirrors the dense vector plus a sparse term vector, so a
 * filtered ANN query returns candidate point IDs that the service hydrates
 * from SQL and checks again. That split keeps ACLs, metadata filters, reranking
 * and evaluation behaviour identical whether search is local or external.
 *
 * Qdrant is the first provider. The interface is deliberately small so a
 * pgvector, OpenSearch or Vespa adapter can sit beside it later.
 */
import type { VectorsConfig, VectorIndexProvider } from './config'
import { tokenize } from './lexical'
import { parseMetric, type VectorMetric } from './similarity'
import type { StoredPoint, VectorCollectionRow, VectorReadAccess } from './types'
import { sha256 } from '~/lib/ids'

export class AnnError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'AnnError'
  }
}

export interface AnnCollection {
  id: string
  dimension: number
  metric: VectorMetric
  /** Identifies this incarnation of a collection, so stale provider points are ignored. */
  epoch: string
}

export interface AnnCapabilities {
  dimension: number
  metric: VectorMetric
  /** Whether the provider collection has the sparse `text` vector. */
  sparse: boolean
}

export interface AnnHit {
  pointId: string
  score: number
}

export interface AnnSearchResult {
  vector: AnnHit[]
  text: AnnHit[]
  /** Points matching the query filter and ACL in the index. */
  total: number
  /** All points in this collection epoch, used to detect an incomplete index. */
  collectionTotal: number
  /** Whether the provider has sparse lexical vectors. */
  sparse: boolean
  /** A sparse-query failure; the service can use local BM25 instead. */
  textError?: string
}

export interface AnnQuery {
  collection: AnnCollection
  vector: number[]
  limit: number
  filter?: unknown
  access?: VectorReadAccess
  /** Query text; omitted for vector-only search. */
  text?: string
}

export interface AnnHealth {
  ok: boolean
  provider: VectorIndexProvider
  version?: string
  latencyMs: number
  error?: string
}

export interface AnnStatus {
  provider: VectorIndexProvider
  configured: boolean
  healthy: boolean
  collectionId: string
  sqlPoints: number
  indexPoints: number | null
  missing: number | null
  status: 'builtin' | 'current' | 'missing' | 'stale' | 'error'
  blocked?: string | null
  version?: string
  latencyMs?: number
  error?: string
}

export interface AnnRebuildResult {
  collectionId: string
  provider: VectorIndexProvider
  points: number
}

export interface AnnCountOptions {
  filter?: Record<string, unknown>
  /** Create a missing provider collection first. Defaults to true. */
  ensure?: boolean
}

export interface VectorAnnIndex {
  readonly provider: VectorIndexProvider
  readonly label: string
  health(): Promise<AnnHealth>
  ensureCollection(collection: AnnCollection): Promise<AnnCapabilities>
  recreateCollection(collection: AnnCollection): Promise<AnnCapabilities>
  upsert(collection: AnnCollection, points: StoredPoint[]): Promise<void>
  deletePoints(collection: AnnCollection, pointIds: string[]): Promise<void>
  deleteDocument(collection: AnnCollection, documentId: string): Promise<void>
  deleteCollection(collectionId: string): Promise<void>
  search(query: AnnQuery): Promise<AnnSearchResult>
  count(collection: AnnCollection, options?: AnnCountOptions): Promise<number>
}

/** A stable provider collection name from a Bunwrite collection ID. */
export function annCollectionName(collectionId: string): string {
  const safe = collectionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
  return `bw_${safe}_${sha256(`bw:collection:${collectionId}`).slice(0, 8)}`
}

/** A deterministic UUID for an arbitrary Bunwrite point ID. */
export function annPointId(collectionId: string, pointId: string): string {
  const hex = sha256(`bw:point:${collectionId}\u0000${pointId}`).slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20, 32).join('')}`
}

export function annCollectionOf(row: Pick<VectorCollectionRow, 'id' | 'dimension' | 'metric' | 'index_epoch' | 'created_at'>): AnnCollection {
  let metric: VectorMetric = 'cosine'
  try {
    metric = parseMetric(row.metric)
  } catch {
    // A malformed stored value keeps the built-in default.
  }
  return {
    id: row.id,
    dimension: Number(row.dimension),
    metric,
    epoch: row.index_epoch || row.created_at,
  }
}

export function qdrantDistance(metric: VectorMetric): 'Cosine' | 'Dot' | 'Euclid' {
  if (metric === 'dot') return 'Dot'
  if (metric === 'euclidean') return 'Euclid'
  return 'Cosine'
}

// ---------------------------------------------------------------------------
// Sparse lexical vectors
// ---------------------------------------------------------------------------

const PRIME = 16_777_619

function termIndex(term: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < term.length; index++) {
    hash ^= term.charCodeAt(index)
    hash = Math.imul(hash, PRIME)
  }
  return hash >>> 0
}

/**
 * A sparse TF vector. Qdrant's `idf` query modifier applies inverse document
 * frequency, so documents store term frequency and queries store query terms.
 */
export function sparseVector(text: string, maxTerms = 4_096): { indices: number[]; values: number[] } {
  const counts = new Map<number, number>()
  for (const term of tokenize(text)) {
    const index = termIndex(term)
    counts.set(index, (counts.get(index) ?? 0) + 1)
  }
  const entries = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, Math.max(1, maxTerms))
    .sort((a, b) => a[0] - b[0])
  return {
    indices: entries.map(([index]) => index),
    values: entries.map(([, count]) => 1 + Math.log(count)),
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** A condition that never matches, for an empty `any` filter. */
const MATCH_NONE = { key: '__bw_none__', match: { value: '__bw_never__' } }

/**
 * Qdrant can accept these filter shapes exactly enough to narrow the candidate
 * set. The service still checks every hydrated row with `matchesFilter`.
 * Unsupported shapes fall back to the built-in scan.
 */
export function supportsAnnFilter(filter: unknown): boolean {
  if (filter === undefined || filter === null) return true
  if (typeof filter !== 'object' || Array.isArray(filter)) return false
  for (const value of Object.values(filter as Record<string, unknown>)) {
    if (value === null) continue
    if (Array.isArray(value)) {
      if (value.some((item) => item !== null && (typeof item === 'object' || typeof item === 'function' || typeof item === 'symbol'))) return false
      if (value.some((item) => item === null)) return false
      if (value.some((item) => typeof item === 'number' && (!Number.isFinite(item) || !Number.isInteger(item)))) return false
      continue
    }
    if (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') return false
    if (typeof value === 'number' && !Number.isFinite(value)) return false
  }
  return true
}

export function annEpochFilter(epoch: string): Record<string, unknown> {
  return { must: [{ key: 'epoch', match: { value: epoch } }] }
}

/** Translate metadata equality filters and ACL roles into a Qdrant filter. */
export function annQdrantFilter(filter: unknown, access: VectorReadAccess | undefined, epoch: string): Record<string, unknown> {
  const must: Record<string, unknown>[] = [{ key: 'epoch', match: { value: epoch } }]
  if (access) {
    const permissions = [...access.roles].map((role) => `read("${role}")`)
    must.push(permissions.length > 0 ? { key: 'permissions', match: { any: permissions } } : MATCH_NONE)
  }
  if (filter !== undefined && filter !== null) {
    for (const [key, expected] of Object.entries(filter as Record<string, unknown>)) {
      const path = `metadata.${key}`
      if (Array.isArray(expected)) {
        if (expected.length === 0) {
          must.push(MATCH_NONE)
          continue
        }
        must.push({ key: path, match: { any: expected } })
        continue
      }
      if (expected === null) {
        must.push({ is_null: { key: path } })
        continue
      }
      if (typeof expected === 'number') {
        must.push({ key: path, range: { gte: expected, lte: expected } })
        continue
      }
      must.push({ key: path, match: { value: expected } })
    }
  }
  return { must }
}

// ---------------------------------------------------------------------------
// Qdrant adapter
// ---------------------------------------------------------------------------

interface QdrantCollectionInfo {
  result?: {
    config?: {
      params?: {
        vectors?: unknown
        sparse_vectors?: unknown
      }
    }
  }
}

interface QdrantScoredPoint {
  id: string | number
  score: number
  payload?: Record<string, unknown>
}

interface QdrantQueryResponse {
  result?: QdrantScoredPoint[] | { points?: QdrantScoredPoint[] }
}

interface QdrantCountResponse {
  result?: { count?: number }
}

export interface QdrantAnnOptions {
  url: string
  apiKey?: string
  timeoutMs?: number
  /** Injection point for tests; defaults to the global fetch. */
  fetch?: typeof fetch
}

export class QdrantAnnIndex implements VectorAnnIndex {
  readonly provider = 'qdrant' as const
  readonly label = 'Qdrant'

  private readonly base: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly capabilities = new Map<string, AnnCapabilities>()

  constructor(options: QdrantAnnOptions) {
    this.base = options.url.replace(/\/+$/, '')
    this.apiKey = options.apiKey ?? ''
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  async health(): Promise<AnnHealth> {
    const started = performance.now()
    try {
      const data = await this.request<{ version?: string }>('GET', '/')
      return {
        ok: true,
        provider: 'qdrant',
        ...(data.version ? { version: data.version } : {}),
        latencyMs: Math.round(performance.now() - started),
      }
    } catch (error) {
      return {
        ok: false,
        provider: 'qdrant',
        latencyMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async ensureCollection(collection: AnnCollection): Promise<AnnCapabilities> {
    const name = annCollectionName(collection.id)
    const distance = qdrantDistance(collection.metric)
    const cached = this.capabilities.get(name)
    if (cached && cached.dimension === collection.dimension && cached.metric === collection.metric) return cached

    let info: QdrantCollectionInfo | null = null
    try {
      info = await this.request<QdrantCollectionInfo>('GET', `/collections/${encodeURIComponent(name)}`)
    } catch (error) {
      if (!(error instanceof AnnError) || error.status !== 404) throw error
    }

    if (!info) {
      try {
        await this.request('PUT', `/collections/${encodeURIComponent(name)}`, {
          vectors: { dense: { size: collection.dimension, distance } },
          sparse_vectors: { text: {} },
          on_disk_payload: true,
        })
      } catch (error) {
        // Another process may have created it between the GET and the PUT.
        if (!(error instanceof AnnError) || error.status !== 409) throw error
        info = await this.request<QdrantCollectionInfo>('GET', `/collections/${encodeURIComponent(name)}`)
      }
      if (!info) {
        const capabilities = { dimension: collection.dimension, metric: collection.metric, sparse: true }
        this.capabilities.set(name, capabilities)
        await this.createPayloadIndexes(name)
        return capabilities
      }
    }

    const params = info.result?.config?.params
    const vectors = params?.vectors
    let dense: unknown = null
    if (vectors && typeof vectors === 'object' && !Array.isArray(vectors)) {
      const record = vectors as Record<string, unknown>
      dense = record.dense ?? ('size' in record ? record : null)
    }
    if (!dense || typeof dense !== 'object') {
      throw new AnnError(`Qdrant collection "${name}" does not use the named dense vector; rebuild the index with a fresh collection ID.`)
    }
    const size = Number((dense as { size?: unknown }).size)
    const storedDistance = String((dense as { distance?: unknown }).distance ?? '')
    if (size !== collection.dimension) {
      throw new AnnError(`Qdrant collection "${name}" has ${size} dimensions, but this collection expects ${collection.dimension}. Rebuild the index.`)
    }
    if (storedDistance.toLowerCase() !== distance.toLowerCase()) {
      throw new AnnError(`Qdrant collection "${name}" uses ${storedDistance || 'an unknown metric'}, but this collection uses ${distance}. Rebuild the index.`)
    }
    const sparseVectors = params?.sparse_vectors
    const sparse = Boolean(sparseVectors && typeof sparseVectors === 'object' && 'text' in (sparseVectors as Record<string, unknown>))
    const capabilities = { dimension: collection.dimension, metric: collection.metric, sparse }
    this.capabilities.set(name, capabilities)
    return capabilities
  }

  async recreateCollection(collection: AnnCollection): Promise<AnnCapabilities> {
    await this.deleteCollection(collection.id)
    return this.ensureCollection(collection)
  }

  async upsert(collection: AnnCollection, points: StoredPoint[]): Promise<void> {
    if (points.length === 0) return
    const capabilities = await this.ensureCollection(collection)
    const name = annCollectionName(collection.id)
    for (const batch of annBatches(points)) {
      const body = {
        points: batch.map((point) => ({
          id: annPointId(collection.id, point.id),
          vector: capabilities.sparse ? { dense: point.vector, text: sparseVector(point.content) } : { dense: point.vector },
          payload: {
            epoch: collection.epoch,
            point_id: point.id,
            document_id: point.documentId,
            chunk_index: point.chunkIndex,
            content: point.content,
            metadata: point.metadata,
            permissions: point.permissions,
          },
        })),
      }
      await this.request('PUT', `/collections/${encodeURIComponent(name)}/points?wait=true`, body)
    }
  }

  async deletePoints(collection: AnnCollection, pointIds: string[]): Promise<void> {
    if (pointIds.length === 0) return
    const name = annCollectionName(collection.id)
    for (let index = 0; index < pointIds.length; index += 1_000) {
      const chunk = pointIds.slice(index, index + 1_000)
      try {
        await this.request('POST', `/collections/${encodeURIComponent(name)}/points/delete?wait=true`, {
          points: chunk.map((pointId) => annPointId(collection.id, pointId)),
        })
      } catch (error) {
        if (error instanceof AnnError && error.status === 404) {
          this.capabilities.delete(name)
          return
        }
        throw error
      }
    }
  }

  async deleteDocument(collection: AnnCollection, documentId: string): Promise<void> {
    const name = annCollectionName(collection.id)
    try {
      await this.request('POST', `/collections/${encodeURIComponent(name)}/points/delete?wait=true`, {
        filter: {
          must: [
            { key: 'epoch', match: { value: collection.epoch } },
            { key: 'document_id', match: { value: documentId } },
          ],
        },
      })
    } catch (error) {
      if (error instanceof AnnError && error.status === 404) {
        this.capabilities.delete(name)
        return
      }
      throw error
    }
  }

  async deleteCollection(collectionId: string): Promise<void> {
    const name = annCollectionName(collectionId)
    try {
      await this.request('DELETE', `/collections/${encodeURIComponent(name)}`)
    } catch (error) {
      if (!(error instanceof AnnError) || error.status !== 404) throw error
    }
    this.capabilities.delete(name)
  }

  async search(query: AnnQuery): Promise<AnnSearchResult> {
    const capabilities = await this.ensureCollection(query.collection)
    const filter = annQdrantFilter(query.filter, query.access, query.collection.epoch)
    const vector = await this.queryPoints(query.collection, query.vector, query.limit, filter, 'dense')
    let text: AnnHit[] = []
    let textError: string | undefined
    if (query.text && capabilities.sparse) {
      const sparse = sparseVector(query.text)
      if (sparse.indices.length > 0) {
        try {
          text = await this.queryPoints(query.collection, sparse, query.limit, filter, 'text', { modifier: 'idf' })
        } catch (error) {
          textError = error instanceof Error ? error.message : String(error)
        }
      }
    }

    const total = await this.count(query.collection, { filter })
    const collectionTotal =
      (query.filter !== undefined && query.filter !== null) || query.access !== undefined
        ? await this.count(query.collection, { filter: annEpochFilter(query.collection.epoch) })
        : total
    return { vector, text, total, collectionTotal, sparse: capabilities.sparse, ...(textError ? { textError } : {}) }
  }

  async count(collection: AnnCollection, options: AnnCountOptions = {}): Promise<number> {
    const name = annCollectionName(collection.id)
    if (options.ensure !== false) await this.ensureCollection(collection)
    try {
      const data = await this.request<QdrantCountResponse>('POST', `/collections/${encodeURIComponent(name)}/points/count`, {
        exact: true,
        ...(options.filter ? { filter: options.filter } : {}),
      })
      return Number(data.result?.count) || 0
    } catch (error) {
      if (error instanceof AnnError && error.status === 404) {
        this.capabilities.delete(name)
        return 0
      }
      throw error
    }
  }

  private async queryPoints(
    collection: AnnCollection,
    query: number[] | { indices: number[]; values: number[] },
    limit: number,
    filter: Record<string, unknown>,
    using: string,
    extra: Record<string, unknown> = {},
    retry = true,
  ): Promise<AnnHit[]> {
    const name = annCollectionName(collection.id)
    try {
      const data = await this.request<QdrantQueryResponse>('POST', `/collections/${encodeURIComponent(name)}/points/query`, {
        query,
        using,
        limit,
        with_payload: ['point_id'],
        filter,
        ...extra,
      })
      const points = Array.isArray(data.result) ? data.result : (data.result?.points ?? [])
      return points.flatMap((point) => {
        const pointId = point.payload?.point_id
        return typeof pointId === 'string' ? [{ pointId, score: Number(point.score) || 0 }] : []
      })
    } catch (error) {
      if (retry && error instanceof AnnError && error.status === 404) {
        // The provider collection was removed outside Bunwrite. Recreate the
        // empty collection and retry once; the SQL completeness check decides
        // whether the result is safe to use.
        this.capabilities.delete(name)
        await this.ensureCollection(collection)
        return this.queryPoints(collection, query, limit, filter, using, extra, false)
      }
      throw error
    }
  }

  private async createPayloadIndexes(name: string): Promise<void> {
    for (const field of ['epoch', 'permissions', 'document_id']) {
      try {
        await this.request('PUT', `/collections/${encodeURIComponent(name)}/index`, {
          field_name: field,
          field_schema: 'keyword',
        })
      } catch {
        // Filtering works without a payload index; only large collections pay for it.
      }
    }
  }

  private async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (this.apiKey) headers['api-key'] = this.apiKey
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(this.timeoutMs > 0 ? { signal: AbortSignal.timeout(this.timeoutMs) } : {}),
    })
    const text = await response.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }
    if (!response.ok) {
      const record = parsed && typeof parsed === 'object' ? (parsed as { status?: { error?: unknown }; message?: unknown }) : null
      const detail = record?.status?.error ?? record?.message ?? (typeof parsed === 'string' ? parsed : response.statusText)
      throw new AnnError(`Qdrant ${method} ${path} failed (${response.status}): ${String(detail)}`, response.status)
    }
    return (parsed ?? {}) as T
  }
}

/**
 * Qdrant limits request size. Content can be up to one megabyte per chunk, so
 * batch by approximate payload size as well as point count.
 */
function annBatches(points: StoredPoint[], maxCount = 64, maxBytes = 4 * 1024 * 1024): StoredPoint[][] {
  const batches: StoredPoint[][] = []
  let current: StoredPoint[] = []
  let bytes = 0
  for (const point of points) {
    // The vector dominates the request for most embeddings; 12 bytes per number
    // is a safe upper bound for its JSON representation.
    const size = point.content.length + point.vector.length * 12 + 512
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(point)
    bytes += size
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** Build the configured external index, or null for the built-in scan. */
export function makeVectorAnnIndex(config: VectorsConfig): VectorAnnIndex | null {
  if (config.annProvider !== 'qdrant') return null
  const url = (config.annUrl ?? '').trim()
  if (!url) return null
  try {
    return new QdrantAnnIndex({
      url,
      apiKey: config.annApiKey,
      timeoutMs: config.annTimeoutMs,
    })
  } catch {
    return null
  }
}
