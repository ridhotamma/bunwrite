/**
 * Cross-process cache invalidation. Triggers on the tables that back the
 * in-memory caches bump a counter in `_meta`; every process compares its last
 * seen counters with the database and reloads what changed. By default the
 * comparison happens on every request; `CACHE_CHECK_MS` can throttle it.
 */
import type { Db } from '~/db/connection'

export const VERSION_KEYS = ['schema', 'settings', 'catalog', 'projects'] as const
export type VersionKey = (typeof VERSION_KEYS)[number]
export type VersionChanges = Record<VersionKey, boolean>

/** The `_meta` key a collection's document triggers bump on every write. */
export const collectionVersionKey = (databaseId: string, collectionId: string): string =>
  `collection:${databaseId}/${collectionId}`

const NO_CHANGES: VersionChanges = { schema: false, settings: false, catalog: false, projects: false }

export class VersionMonitor {
  private seen: Record<VersionKey, number>
  private checkedAt = 0

  constructor(
    private db: Db,
    private intervalMs = 0,
  ) {
    this.seen = this.read()
  }

  private read(): Record<VersionKey, number> {
    const values: Record<VersionKey, number> = { schema: 0, settings: 0, catalog: 0, projects: 0 }
    try {
      for (const row of this.db.sqlite.query<{ key: string; value: number }, []>('SELECT key, value FROM _meta').all()) {
        if ((VERSION_KEYS as readonly string[]).includes(row.key)) values[row.key as VersionKey] = Number(row.value) || 0
      }
    } catch {
      // A database opened before `_meta` existed: treat everything as fresh.
    }
    return values
  }

  /** Which caches another process changed since the last call. Throttled. */
  poll(): VersionChanges {
    const stamp = Date.now()
    if (this.checkedAt && stamp - this.checkedAt < this.intervalMs) return NO_CHANGES
    this.checkedAt = stamp
    const next = this.read()
    const changes: VersionChanges = {
      schema: next.schema !== this.seen.schema,
      settings: next.settings !== this.seen.settings,
      catalog: next.catalog !== this.seen.catalog,
      projects: next.projects !== this.seen.projects,
    }
    this.seen = next
    return changes
  }

  /** Re-baseline after this process applied the change, or after a restore. */
  reset(): void {
    this.seen = this.read()
    this.checkedAt = Date.now()
  }
}
