/**
 * Infrastructure tables shared by every process that opens the same database:
 * cache versions, rate limits, the leader lease, realtime presence and the
 * realtime event bus. They are created next to the drizzle migrations so a
 * database restored from an older backup gets them too.
 *
 * Triggers bump the version counters from any writer, including the CLI and a
 * worker that does not own the in-memory cache, which is what lets the other
 * processes notice a change cheaply.
 */
import type { Database } from 'bun:sqlite'

import { collectionVersionKey } from '~/cluster/versions'
import { tableName } from '~/schema/types'

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`

const TABLES = [
  `CREATE TABLE IF NOT EXISTS \`_meta\` (
    \`key\` TEXT PRIMARY KEY NOT NULL,
    \`value\` INTEGER NOT NULL DEFAULT 0
  )`,
  `INSERT OR IGNORE INTO \`_meta\` (\`key\`, \`value\`) VALUES
    ('schema', 0), ('settings', 0), ('catalog', 0), ('projects', 0), ('auth', 0)`,
  `CREATE TABLE IF NOT EXISTS \`_rate_limits\` (
    \`key\` TEXT PRIMARY KEY NOT NULL,
    \`count\` INTEGER NOT NULL,
    \`reset_at\` INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS \`_cluster_leases\` (
    \`name\` TEXT PRIMARY KEY NOT NULL,
    \`owner\` TEXT NOT NULL,
    \`expires_at\` INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS \`_cluster_processes\` (
    \`id\` TEXT PRIMARY KEY NOT NULL,
    \`sockets\` INTEGER NOT NULL DEFAULT 0,
    \`started_at\` TEXT NOT NULL,
    \`heartbeat_at\` TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS \`_cluster_processes_sockets\` ON \`_cluster_processes\` (\`sockets\`)`,
  `CREATE TABLE IF NOT EXISTS \`_realtime_events\` (
    \`seq\` INTEGER PRIMARY KEY AUTOINCREMENT,
    \`origin\` TEXT NOT NULL,
    \`project_id\` TEXT NOT NULL,
    \`payload\` TEXT NOT NULL,
    \`created_at\` TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS \`_realtime_events_created_at\` ON \`_realtime_events\` (\`created_at\`)`,
]

/** `[version counter, table]` for the caches each table feeds. */
const VERSIONED: [string, string][] = [
  ['schema', '_databases'],
  ['schema', '_collections'],
  ['settings', '_settings'],
  ['catalog', '_sites'],
  ['catalog', '_proxy_rules'],
  ['projects', '_projects'],
  ['auth', '_sessions'],
  ['auth', '_users'],
  ['auth', '_memberships'],
  ['auth', '_teams'],
]

const TRIGGERS = VERSIONED.flatMap(([version, table]) =>
  ['INSERT', 'UPDATE', 'DELETE'].map(
    (event) => `CREATE TRIGGER IF NOT EXISTS \`_meta_${table}_${event.toLowerCase()}\`
      AFTER ${event} ON \`${table}\`
      BEGIN
        UPDATE \`_meta\` SET \`value\` = \`value\` + 1 WHERE \`key\` = '${version}';
      END`,
  ),
)

/**
 * A version row per collection, bumped by the document table's own triggers.
 * List caches and ETags key off it, so every worker sees a write immediately
 * without putting document writes through `_collections` (which would reload
 * the schema cache on every insert).
 */
export function collectionVersionTriggers(sqlite: Database, databaseId: string, collectionId: string, table: string): void {
  const key = literal(collectionVersionKey(databaseId, collectionId))
  for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
    const suffix = event === 'INSERT' ? 'ai' : event === 'UPDATE' ? 'au' : 'ad'
    sqlite.run(`CREATE TRIGGER IF NOT EXISTS ${ident(`${table}__version_${suffix}`)}
      AFTER ${event} ON ${ident(table)}
      BEGIN
        INSERT INTO \`_meta\` (\`key\`, \`value\`) VALUES (${key}, 1)
        ON CONFLICT(\`key\`) DO UPDATE SET \`value\` = \`value\` + 1;
      END`)
  }
}

/** Recreate version triggers for collections that existed before this feature or came from a backup. */
function ensureCollectionVersionTriggers(sqlite: Database): void {
  const collections = sqlite
    .query<{ database_id: string; id: string; database_seq: number }, []>(
      'SELECT c.database_id AS database_id, c.id AS id, d.seq AS database_seq FROM _collections c JOIN _databases d ON d.id = c.database_id',
    )
    .all()
  for (const collection of collections) {
    // Tables are named after the database's sequence, not the collection's.
    const table = tableName(collection.database_seq, collection.id)
    const exists = sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    if (exists) collectionVersionTriggers(sqlite, collection.database_id, collection.id, table)
  }
}

/**
 * Every document row carries `_rev`, bumped on each write, for `If-Match`
 * preconditions. Tables created before this feature (or restored from an older
 * backup) get the column here; rows start at revision 1.
 */
function ensureDocumentRevisions(sqlite: Database): void {
  const collections = sqlite
    .query<{ id: string; database_seq: number }, []>(
      'SELECT c.id AS id, d.seq AS database_seq FROM _collections c JOIN _databases d ON d.id = c.database_id',
    )
    .all()
  for (const collection of collections) {
    const table = tableName(collection.database_seq, collection.id)
    const columns = sqlite.query<{ name: string }, []>(`PRAGMA table_info(${ident(table)})`).all()
    if (columns.length === 0 || columns.some((column) => column.name === '_rev')) continue
    sqlite.run(`ALTER TABLE ${ident(table)} ADD COLUMN \`_rev\` INTEGER NOT NULL DEFAULT 1`)
  }
}

export function ensureClusterSchema(sqlite: Database): void {
  sqlite.transaction(() => {
    for (const statement of [...TABLES, ...TRIGGERS]) sqlite.run(statement)
    ensureCollectionVersionTriggers(sqlite)
    ensureDocumentRevisions(sqlite)
  }).immediate()
}
