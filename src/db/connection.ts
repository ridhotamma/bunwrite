import { Database } from 'bun:sqlite'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  configuredBusyTimeout,
  configuredSqliteCacheMb,
  configuredSqliteMmapMb,
  configuredWalAutocheckpoint,
} from '~/system/autotune'
import { ensureClusterSchema } from './cluster-schema'
import * as schema from './system-schema'

export type Orm = BunSQLiteDatabase<typeof schema>

export interface Db {
  sqlite: Database
  orm: Orm
}

const MIGRATION_LOCK_STALE_MS = 60_000
const MIGRATION_LOCK_WAIT_MS = 60_000

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
): Db {
  if (path !== ':memory:' && !path.startsWith('file::memory:')) {
    mkdirSync(dirname(path), { recursive: true })
    // A restore moves the current database aside before putting the backup in
    // place. If the process stopped between those renames, put it back.
    const beforeRestore = `${path}.before-restore`
    if (!existsSync(path) && existsSync(beforeRestore)) renameSync(beforeRestore, path)
  }
  const sqlite = new Database(path, { create: true, strict: true })
  const orm = drizzle(sqlite, { schema })
  // Holding the lock through the pragmas too: switching a brand-new file to
  // WAL needs an exclusive lock, and SQLite returns SQLITE_BUSY at once when
  // another worker is doing the same instead of waiting on busy_timeout.
  withMigrationLock(path, () => {
    sqlite.run(`PRAGMA busy_timeout = ${Math.max(0, Math.round(busyTimeoutMs))}`)
    sqlite.run('PRAGMA journal_mode = WAL')
    sqlite.run('PRAGMA synchronous = NORMAL')
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
  return { sqlite, orm }
}

/** Quote an SQL identifier. */
export const q = (name: string) => `"${name.replace(/"/g, '""')}"`
