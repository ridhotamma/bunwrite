/**
 * The per-worker list cache.
 *
 * A collection's list pages are keyed by the `_meta` counter that triggers bump
 * on every write, so any write from any process makes the pages stale. The
 * cache only keeps a few hot pages; it is not a second database.
 */
import type { Doc } from './codec'

const MAX_ENTRIES = 200
const MAX_DOCS = 5000
/** Pages larger than this are not worth keeping in memory. */
export const MAX_CACHEABLE_LIMIT = 200

type Page = { total: number; documents: Doc[] }

export class DocumentListCache {
  private readonly entries = new Map<string, Page>()
  private readonly versions = new Map<string, string>()
  private cachedDocs = 0

  /** A hit refreshes the LRU position. Callers must treat the documents as read-only. */
  get(key: string): Page | undefined {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit
  }

  /** Drop a table's pages when its version counter moved. */
  purge(table: string, version: string): void {
    const before = this.versions.get(table)
    if (before === version) return
    this.versions.set(table, version)
    if (before === undefined) return
    const prefix = `${table}\u0000`
    for (const [key, value] of [...this.entries]) {
      if (!key.startsWith(prefix)) continue
      this.cachedDocs -= value.documents.length
      this.entries.delete(key)
    }
  }

  remember(key: string, page: Page): void {
    this.entries.set(key, page)
    this.cachedDocs += page.documents.length
    while (this.entries.size > MAX_ENTRIES || this.cachedDocs > MAX_DOCS) {
      const oldest = this.entries.keys().next().value
      if (!oldest) break
      this.cachedDocs -= this.entries.get(oldest)!.documents.length
      this.entries.delete(oldest)
    }
  }

  clear(): void {
    this.entries.clear()
    this.versions.clear()
    this.cachedDocs = 0
  }
}
