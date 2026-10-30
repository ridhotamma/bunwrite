/**
 * Infrastructure tables shared by every process that opens the same database:
 * cache versions, the leader lease, realtime presence and the realtime event
 * bus. They are created next to the drizzle migrations so a database restored
 * from an older backup gets them too.
 *
 * Triggers bump the version counters from any writer, including the CLI and a
 * worker that does not own the in-memory cache, which is what lets the other
 * processes notice a change cheaply.
 */
import type { Database } from 'bun:sqlite'

const TABLES = [
  `CREATE TABLE IF NOT EXISTS \`_meta\` (
    \`key\` TEXT PRIMARY KEY NOT NULL,
    \`value\` INTEGER NOT NULL DEFAULT 0
  )`,
  `INSERT OR IGNORE INTO \`_meta\` (\`key\`, \`value\`) VALUES
    ('schema', 0), ('settings', 0), ('catalog', 0), ('projects', 0)`,
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

export function ensureClusterSchema(sqlite: Database): void {
  sqlite.transaction(() => {
    for (const statement of [...TABLES, ...TRIGGERS]) sqlite.run(statement)
  })()
}
