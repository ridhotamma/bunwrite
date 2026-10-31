import { Database } from 'bun:sqlite'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  configuredBusyTimeout,
  configuredSqliteCacheMb,
  configuredSqliteMmapMb,
  configuredSqliteSynchronous,
  configuredWalAutocheckpoint,
  type SqliteSynchronous,
} from '~/system/autotune'
import { ensureClusterSchema } from './cluster-schema'
import type { DriverCapabilities } from './driver'
import { withBusyRetry } from './errors'
import { createSqliteDriver, type SqliteDriver } from './sqlite-driver'
import * as schema from './system-schema'

export { isBusyError, withBusyRetry, type BusyRetryOptions } from './errors'

export type Orm = BunSQLiteDatabase<typeof schema>

/**
 * The synchronous SQLite connection plus the async driver port.
 *
 * Existing services keep using `sqlite` (and `driver` is the same connection
 * behind the async port). A migration to Postgres or MongoDB moves a service
 * from `sqlite` to `driver`; see docs/DATABASE.md.
 */
export interface Db {
  sqlite: Database
  orm: Orm
  driver: SqliteDriver
  readonly dialect: 'sqlite'
  readonly capabilities: DriverCapabilities
}

const MIGRATION_LOCK_STALE_MS = 60_000
const MIGRATION_LOCK_WAIT_MS = 60_000

/**
 * Install a retry around every transaction on this connection. A retry is only
 * safe before the callback starts: once it has run, its JavaScript side effects
 * (events, ID generation, counters) may already be visible, so those errors
 * still surface to the caller.
 */
function installTransactionRetry(sqlite: Database): void {
  const native = sqlite.transaction.bind(sqlite)
  type AnyTx = ((...args: any[]) => any) & {
    deferred: (...args: any[]) => any
    immediate: (...args: any[]) => any
    exclusive: (...args: any[]) => any
  }
  sqlite.transaction = ((fn: AnyTx) => {
    let started = false
    const tx = native((...args: any[]) => {
      started = true
      return fn(...args)
    })
    const run = (call: (...callArgs: any[]) => any, args: any[]) => {
      started = false
      return withBusyRetry(() => call(...args), { canRetry: () => !started })
    }
    const wrapped = ((...args: any[]) => run(tx, args)) as AnyTx
    wrapped.deferred = (...args: any[]) => run(tx.deferred, args)
    wrapped.immediate = (...args: any[]) => run(tx.immediate, args)
    wrapped.exclusive = (...args: any[]) => run(tx.exclusive, args)
    return wrapped
  }) as typeof sqlite.transaction
}

/**
 * Workers open the same database at the same time on boot. Drizzle's migrator
 * reads which migrations ran and then applies them, so without a lock two
 * processes can try to create the same table. The lock is a directory next to
 * the database: atomic to create, removed in `finally`, and ignored once stale.
 */
function withMigrationLock<T>(path: string, run: () => T): T {
  if (path === ':memory:' || path.startsWith('file::memory:')) return run()
  const lock = `${path}.migrate.lock`
  const deadline = Date.now() + MIGRATION_LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > MIGRATION_LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true })
          continue
        }
      } catch {
        // The holder removed it between the two calls: try again.
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the database migration lock at ${lock}.`)
      Bun.sleepSync(25)
    }
  }
  try {
    return run()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

function migrationsFolder(): string {
  const candidates = [
    join(import.meta.dir, '..', '..', 'drizzle'),
    join(import.meta.dir, 'drizzle'),
    join(import.meta.dir, '..', 'drizzle'),
    join(import.meta.dir, '..', '..', '..', 'drizzle'),
  ]
  return candidates.find((path) => existsSync(join(path, 'meta', '_journal.json'))) ?? candidates[0]!
}

/** Open (or create) the database file, tune it for the host, and migrate. */
export function openDb(
  path: string,
  cacheMb = configuredSqliteCacheMb(),
  mmapMb = configuredSqliteMmapMb(),
  walPages = configuredWalAutocheckpoint(),
  busyTimeoutMs = configuredBusyTimeout(),
  synchronous: SqliteSynchronous = configuredSqliteSynchronous(),
): Db {
  if (path !== ':memory:' && !path.startsWith('file::memory:')) {
    mkdirSync(dirname(path), { recursive: true })
    // A restore moves the current database aside before putting the backup in
    // place. If the process stopped between those renames, put it back.
    const beforeRestore = `${path}.before-restore`
    if (!existsSync(path) && existsSync(beforeRestore)) renameSync(beforeRestore, path)
  }
  const sqlite = new Database(path, { create: true, strict: true })
  installTransactionRetry(sqlite)
  const orm = drizzle(sqlite, { schema })
  const driver = createSqliteDriver({ db: sqlite })
  // Holding the lock through the pragmas too: switching a brand-new file to
  // WAL needs an exclusive lock, and SQLite returns SQLITE_BUSY at once when
  // another worker is doing the same instead of waiting on busy_timeout.
  withMigrationLock(path, () => {
    sqlite.run(`PRAGMA busy_timeout = ${Math.max(0, Math.round(busyTimeoutMs))}`)
    sqlite.run('PRAGMA journal_mode = WAL')
    // NORMAL skips an fsync per commit and can lose recent commits after a
    // power loss; FULL fsyncs each commit. The whitelist keeps the pragma value
    // from being interpolated from an arbitrary string.
    sqlite.run(`PRAGMA synchronous = ${synchronous === 'FULL' ? 'FULL' : 'NORMAL'}`)
    sqlite.run('PRAGMA foreign_keys = ON')
    // Negative cache_size is KiB; keep at least 1 MB.
    sqlite.run(`PRAGMA cache_size = -${Math.max(1, Math.round(Number(cacheMb) || 16)) * 1000}`)
    sqlite.run('PRAGMA temp_store = MEMORY')
    // Reads map the file instead of copying pages per query; the OS shares the
    // mapped pages between workers. 0 keeps mmap off.
    if (mmapMb > 0) sqlite.run(`PRAGMA mmap_size = ${Math.round(mmapMb) * 1024 * 1024}`)
    // A slightly larger WAL than SQLite's 1000-page default means fewer
    // checkpoint stalls under several writers. 0 disables automatic checkpoints.
    if (walPages >= 0) sqlite.run(`PRAGMA wal_autocheckpoint = ${Math.round(walPages)}`)
    migrate(orm, { migrationsFolder: migrationsFolder() })
    ensureClusterSchema(sqlite)
  })
  return { sqlite, orm, driver, dialect: 'sqlite', capabilities: driver.capabilities }
}

/** Quote an SQL identifier. */
export const q = (name: string) => `"${name.replace(/"/g, '""')}"`
