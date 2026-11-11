/**
 * Cross-process cache invalidation. Triggers on the tables that back the
 * in-memory caches bump a counter in `_meta`; every process compares its last
 * seen counters with the database and reloads what changed. By default the
 * comparison happens on every request; `CACHE_CHECK_MS` can throttle it.
 */
import type { SqlDatabase } from '~/db/driver'

export const VERSION_KEYS = ['schema', 'settings', 'catalog', 'projects', 'auth', 'keys'] as const
export type VersionKey = (typeof VERSION_KEYS)[number]
export type VersionChanges = Record<VersionKey, boolean>

/** The `_meta` key a collection's document triggers bump on every write. */
export const collectionVersionKey = (databaseId: string, collectionId: string): string => `collection:${databaseId}/${collectionId}`
/** Bumped by triggers on every write to one vector collection's points; search caches key off it. */
export const VECTOR_VERSION_PREFIX = 'vectors:'
export const vectorVersionKey = (collectionId: string): string => `${VECTOR_VERSION_PREFIX}${collectionId}`

const NO_CHANGES: VersionChanges = {
  schema: false,
  settings: false,
  catalog: false,
  projects: false,
  auth: false,
  keys: false,
}

export class VersionMonitor {
  private seen: Record<VersionKey, number>
  private checkedAt = 0

  constructor(
    private db: SqlDatabase,
    private intervalMs = 0,
  ) {
    // SQLite loads synchronously, as before. A network backend starts at zero
    // and `load()` (from services.ready()) establishes the baseline.
    this.seen = this.db.dialect === 'sqlite' ? this.readSync() : emptyVersions()
  }

  private readSync(): Record<VersionKey, number> {
    const values = emptyVersions()
    try {
      for (const row of this.db.sqlite!.query<{ key: string; value: number }, []>('SELECT key, value FROM _meta').all()) {
        if ((VERSION_KEYS as readonly string[]).includes(row.key)) values[row.key as VersionKey] = Number(row.value) || 0
      }
    } catch {
      // A database opened before `_meta` existed: treat everything as fresh.
    }
    return values
  }

  private async readAsync(): Promise<Record<VersionKey, number>> {
    const values = emptyVersions()
    try {
      for (const row of await this.db.driver.all<{ key: string; value: number }>('SELECT key, value FROM _meta')) {
        if ((VERSION_KEYS as readonly string[]).includes(row.key)) values[row.key as VersionKey] = Number(row.value) || 0
      }
    } catch {
      // A database opened before `_meta` existed: treat everything as fresh.
    }
    return values
  }

  private diff(next: Record<VersionKey, number>): VersionChanges {
    const changes: VersionChanges = {
      schema: next.schema !== this.seen.schema,
      settings: next.settings !== this.seen.settings,
      catalog: next.catalog !== this.seen.catalog,
      projects: next.projects !== this.seen.projects,
      auth: next.auth !== this.seen.auth,
      keys: next.keys !== this.seen.keys,
    }
    this.seen = next
    return changes
  }

  private throttled(stamp: number): boolean {
    if (this.checkedAt && stamp - this.checkedAt < this.intervalMs) return true
    this.checkedAt = stamp
    return false
  }

  /** Establish the baseline for a backend that did not load synchronously. */
  async load(): Promise<void> {
    this.seen = await this.readAsync()
    this.checkedAt = Date.now()
  }

  /** Which caches another process changed since the last call. Throttled. */
  poll(): VersionChanges {
    const stamp = Date.now()
    if (this.throttled(stamp)) return NO_CHANGES
    return this.diff(this.readSync())
  }

  /** Like `poll`, but uses the driver port so it works on Postgres too. */
  async pollAsync(): Promise<VersionChanges> {
    const stamp = Date.now()
    if (this.throttled(stamp)) return NO_CHANGES
    return this.diff(await this.readAsync())
  }

  /**
   * Last observed counter for a cache that lives outside this class, such as
   * sessions and API keys. It advances on `poll()`, so with `CACHE_CHECK_MS`
   * throttling, callers reuse the same read instead of querying `_meta` again.
   */
  version(key: VersionKey): number {
    return this.seen[key]
  }

  authVersion(): number {
    return this.seen.auth
  }

  keysVersion(): number {
    return this.seen.keys
  }

  /** Re-baseline after this process applied the change, or after a restore. */
  reset(): void {
    this.seen = this.readSync()
    this.checkedAt = Date.now()
  }

  async resetAsync(): Promise<void> {
    this.seen = await this.readAsync()
    this.checkedAt = Date.now()
  }
}

const emptyVersions = (): Record<VersionKey, number> => ({ schema: 0, settings: 0, catalog: 0, projects: 0, auth: 0, keys: 0 })
