import { Database } from 'bun:sqlite'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import * as schema from './system-schema'

export type Orm = BunSQLiteDatabase<typeof schema>

export interface Db {
  sqlite: Database
  orm: Orm
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

/** Open (or create) the database file, tune it for a small VPS, and migrate. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const sqlite = new Database(path, { create: true, strict: true })
  sqlite.run('PRAGMA journal_mode = WAL')
  sqlite.run('PRAGMA synchronous = NORMAL')
  sqlite.run('PRAGMA foreign_keys = ON')
  sqlite.run('PRAGMA busy_timeout = 5000')
  sqlite.run('PRAGMA cache_size = -16000') // ~16 MB page cache
  sqlite.run('PRAGMA temp_store = MEMORY')
  const orm = drizzle(sqlite, { schema })
  migrate(orm, { migrationsFolder: migrationsFolder() })
  return { sqlite, orm }
}

/** Quote an SQL identifier. */
export const q = (name: string) => `"${name.replace(/"/g, '""')}"`
