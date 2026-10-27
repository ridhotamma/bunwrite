/**
 * Apply an appwrite.config.json (the file `appwrite push` reads) to SQLite:
 * create databases, collection tables, columns and indexes, and change them
 * when the file changes. Removed collections are kept unless `prune` is set.
 */
import { resolve } from 'node:path'

import { q, type Db } from '~/db/connection'
import { now } from '~/lib/datetime'
import {
  ftsTableName,
  normalizeAttribute,
  normalizeIndex,
  permsTableName,
  tableName,
  type Attribute,
  type Index,
} from './types'

export interface PushOptions {
  prune?: boolean
  log?: (line: string) => void
  /** Folder the config file lives in; function `path`s are relative to it. */
  baseDir?: string
}

export interface ConfigCollection {
  databaseId: string
  id: string
  name: string
  enabled: boolean
  documentSecurity: boolean
  permissions: string[]
  attributes: Attribute[]
  indexes: Index[]
}

const SYSTEM_COLUMNS = `_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  _id TEXT NOT NULL UNIQUE,
  _createdAt TEXT NOT NULL,
  _updatedAt TEXT NOT NULL,
  _permissions TEXT NOT NULL DEFAULT '[]'`

export function sqlType(attribute: Attribute): string {
  if (attribute.array) return 'TEXT'
  switch (attribute.type) {
    case 'integer':
    case 'boolean':
      return 'INTEGER'
    case 'double':
      return 'REAL'
    default:
      return 'TEXT'
  }
}

/** Read the collections out of a config file, in either the Tables or Collections shape. */
export function readConfig(config: any): { databases: { id: string; name: string; enabled: boolean }[]; collections: ConfigCollection[] } {
  const databases = (config.tablesDB ?? config.databases ?? []).map((d: any) => ({
    id: d.$id,
    name: d.name ?? d.$id,
    enabled: d.enabled ?? true,
  }))
  const raw = config.tables ?? config.collections ?? []
  const collections = raw.map((c: any) => ({
    databaseId: c.databaseId,
    id: c.$id,
    name: c.name ?? c.$id,
    enabled: c.enabled ?? true,
    documentSecurity: c.rowSecurity ?? c.documentSecurity ?? false,
    permissions: c.$permissions ?? [],
    attributes: (c.columns ?? c.attributes ?? []).map(normalizeAttribute),
    indexes: (c.indexes ?? []).map(normalizeIndex),
  }))
  return { databases, collections }
}

export function pushConfig(db: Db, config: any, options: PushOptions = {}): void {
  const log = options.log ?? (() => {})
  const { databases, collections } = readConfig(config)
  const sqlite = db.sqlite

  sqlite.transaction(() => {
    const stamp = now()
    for (const d of databases) {
      const existing = sqlite.query<any, [string]>('SELECT seq FROM _databases WHERE id = ?').get(d.id)
      if (existing) {
        sqlite.run('UPDATE _databases SET name = ?, enabled = ?, updated_at = ? WHERE id = ?', [d.name, d.enabled, stamp, d.id])
      } else {
        sqlite.run('INSERT INTO _databases (id, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
          d.id,
          d.name,
          d.enabled,
          stamp,
          stamp,
        ])
        log(`+ database ${d.id}`)
      }
    }

    const wanted = new Set<string>()
    for (const c of collections) {
      wanted.add(`${c.databaseId}/${c.id}`)
      pushCollection(db, c, stamp, log)
    }

    pushBuckets(db, config.buckets ?? [], stamp, log)
    pushFunctions(db, config.functions ?? [], stamp, log, options.baseDir)

    if (options.prune) {
      const all = sqlite.query<any, []>('SELECT c.database_id, c.id, d.seq AS dseq FROM _collections c JOIN _databases d ON d.id = c.database_id').all()
      for (const c of all) {
        if (wanted.has(`${c.database_id}/${c.id}`)) continue
        dropCollectionTables(db, tableName(c.dseq, c.id))
        sqlite.run('DELETE FROM _collections WHERE database_id = ? AND id = ?', [c.database_id, c.id])
        log(`- collection ${c.database_id}/${c.id}`)
      }
    }
  })()
}

export function pushCollection(db: Db, c: ConfigCollection, stamp: string, log: (line: string) => void): void {
  const sqlite = db.sqlite
  const dseq = sqlite.query<any, [string]>('SELECT seq FROM _databases WHERE id = ?').get(c.databaseId)?.seq
  if (!dseq) throw new Error(`Collection ${c.id} points at unknown database ${c.databaseId}`)
  const table = tableName(dseq, c.id)
  const existing = sqlite
    .query<any, [string, string]>('SELECT name, enabled, document_security, permissions, attributes, indexes FROM _collections WHERE database_id = ? AND id = ?')
    .get(c.databaseId, c.id)

  if (!existing) {
    createCollectionTables(db, table, c.attributes)
    sqlite.run(
      `INSERT INTO _collections (database_id, id, name, enabled, document_security, permissions, attributes, indexes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.databaseId, c.id, c.name, c.enabled, c.documentSecurity, JSON.stringify(c.permissions), JSON.stringify(c.attributes), JSON.stringify(c.indexes), stamp, stamp],
    )
    createIndexes(db, table, c.indexes, c.attributes)
    log(`+ collection ${c.databaseId}/${c.id} (${c.attributes.length} attributes, ${c.indexes.length} indexes)`)
    return
  }

  const before = (JSON.parse(existing.attributes) as unknown[]).map(normalizeAttribute)
  const beforeIndexes = (JSON.parse(existing.indexes) as unknown[]).map(normalizeIndex)
  const beforeMap = new Map(before.map((a) => [a.key, a]))
  const afterMap = new Map(c.attributes.map((a) => [a.key, a]))

  const added = c.attributes.filter((a) => !beforeMap.has(a.key))
  const removed = before.filter((a) => !afterMap.has(a.key))
  const retyped = c.attributes.filter((a) => {
    const old = beforeMap.get(a.key)
    return old && sqlType(old) !== sqlType(a)
  })
  const schemaChanged = added.length + removed.length + retyped.length > 0
  const indexDiff = JSON.stringify(beforeIndexes) !== JSON.stringify(c.indexes)
  const indexesChanged = schemaChanged || indexDiff
  const retypedKeys = new Set(retyped.map((a) => a.key))
  const modified = c.attributes.filter((a) => {
    const old = beforeMap.get(a.key)
    return old && JSON.stringify(old) !== JSON.stringify(a) && !retypedKeys.has(a.key)
  })
  const metadata: string[] = []
  if (existing.name !== c.name) metadata.push('name')
  if (Boolean(existing.enabled) !== c.enabled) metadata.push('enabled')
  if (Boolean(existing.document_security) !== c.documentSecurity) metadata.push('security')
  if (JSON.stringify(JSON.parse(existing.permissions)) !== JSON.stringify(c.permissions)) metadata.push('permissions')
  if (metadata.length) log(`~ collection ${c.id}: ${metadata.join(', ')}`)
  for (const a of modified) log(`~ collection ${c.id}: ~ ${a.key}`)
  if (indexDiff && !schemaChanged) log(`~ collection ${c.id}: indexes`)

  if (indexesChanged) dropIndexes(db, table, beforeIndexes)

  if (retyped.length > 0) {
    rebuildTable(db, table, before, c.attributes)
    log(`~ collection ${c.id}: rebuilt for type change on ${retyped.map((a) => a.key).join(', ')}`)
  } else {
    for (const a of removed) {
      sqlite.run(`ALTER TABLE ${q(table)} DROP COLUMN ${q(a.key)}`)
      log(`~ collection ${c.id}: - ${a.key}`)
    }
    for (const a of added) {
      sqlite.run(`ALTER TABLE ${q(table)} ADD COLUMN ${q(a.key)} ${sqlType(a)}`)
      log(`~ collection ${c.id}: + ${a.key}`)
    }
  }

  if (indexesChanged) createIndexes(db, table, c.indexes, c.attributes)

  sqlite.run(
    `UPDATE _collections SET name = ?, enabled = ?, document_security = ?, permissions = ?, attributes = ?, indexes = ?, updated_at = ?
     WHERE database_id = ? AND id = ?`,
    [c.name, c.enabled, c.documentSecurity, JSON.stringify(c.permissions), JSON.stringify(c.attributes), JSON.stringify(c.indexes), stamp, c.databaseId, c.id],
  )
}

function columnDefs(attributes: Attribute[]): string {
  return attributes.map((a) => `,\n  ${q(a.key)} ${sqlType(a)}`).join('')
}

function createCollectionTables(db: Db, table: string, attributes: Attribute[]): void {
  const perms = permsTableName(table)
  db.sqlite.run(`CREATE TABLE ${q(table)} (\n  ${SYSTEM_COLUMNS}${columnDefs(attributes)}\n)`)
  db.sqlite.run(
    `CREATE TABLE ${q(perms)} (doc INTEGER NOT NULL, type TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (type, role, doc)) WITHOUT ROWID`,
  )
  db.sqlite.run(`CREATE INDEX ${q(perms + '_doc')} ON ${q(perms)} (doc)`)
}

export function dropCollectionTables(db: Db, table: string): void {
  const fts = db.sqlite
    .query<any, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'")
    .all(`${table.replace(/_/g, '\\_')}\\_\\_fts\\_%`)
  for (const t of fts) db.sqlite.run(`DROP TABLE IF EXISTS ${q(t.name)}`)
  db.sqlite.run(`DROP TABLE IF EXISTS ${q(table)}`)
  db.sqlite.run(`DROP TABLE IF EXISTS ${q(permsTableName(table))}`)
}

/** Recreate the table with new column types, copying the data across. */
function rebuildTable(db: Db, table: string, before: Attribute[], after: Attribute[]): void {
  const temp = `${table}__rebuild`
  db.sqlite.run(`CREATE TABLE ${q(temp)} (\n  ${SYSTEM_COLUMNS}${columnDefs(after)}\n)`)
  const oldKeys = new Set(before.map((a) => a.key))
  const shared = after.filter((a) => oldKeys.has(a.key)).map((a) => q(a.key))
  const cols = ['_seq', '_id', '_createdAt', '_updatedAt', '_permissions', ...shared].join(', ')
  db.sqlite.run(`INSERT INTO ${q(temp)} (${cols}) SELECT ${cols} FROM ${q(table)}`)
  db.sqlite.run(`DROP TABLE ${q(table)}`)
  db.sqlite.run(`ALTER TABLE ${q(temp)} RENAME TO ${q(table)}`)
}

function physicalIndexName(table: string, key: string) {
  return `${table}__idx_${key}`
}

function dropIndexes(db: Db, table: string, indexes: Index[]): void {
  for (const index of indexes) {
    if (index.type === 'fulltext') {
      const fts = ftsTableName(table, index.key)
      for (const suffix of ['ai', 'ad', 'au']) db.sqlite.run(`DROP TRIGGER IF EXISTS ${q(`${fts}_${suffix}`)}`)
      db.sqlite.run(`DROP TABLE IF EXISTS ${q(fts)}`)
    } else {
      db.sqlite.run(`DROP INDEX IF EXISTS ${q(physicalIndexName(table, index.key))}`)
    }
  }
}

const SYSTEM_INDEX_COLUMNS: Record<string, string> = {
  $id: '_id',
  $createdAt: '_createdAt',
  $updatedAt: '_updatedAt',
  $sequence: '_seq',
}

function createIndexes(db: Db, table: string, indexes: Index[], attributes: Attribute[]): void {
  db.sqlite.run(`CREATE INDEX IF NOT EXISTS ${q(`${table}__createdAt`)} ON ${q(table)} (_createdAt)`)
  db.sqlite.run(`CREATE INDEX IF NOT EXISTS ${q(`${table}__updatedAt`)} ON ${q(table)} (_updatedAt)`)
  const attributeMap = new Map(attributes.map((a) => [a.key, a]))
  for (const index of indexes) {
    if (index.type === 'fulltext') {
      createFulltext(db, table, index)
      continue
    }
    const columns = index.attributes.map((key, i) => {
      const column = SYSTEM_INDEX_COLUMNS[key] ?? key
      if (!SYSTEM_INDEX_COLUMNS[key] && !attributeMap.has(key)) {
        throw new Error(`Index ${index.key} on ${table} uses unknown attribute ${key}`)
      }
      const order = (index.orders[i] ?? 'ASC').toUpperCase() === 'DESC' ? ' DESC' : ''
      return q(column) + order
    })
    const unique = index.type === 'unique' ? 'UNIQUE ' : ''
    db.sqlite.run(`CREATE ${unique}INDEX ${q(physicalIndexName(table, index.key))} ON ${q(table)} (${columns.join(', ')})`)
  }
}

/**
 * An FTS5 table that mirrors the indexed columns, kept in sync by triggers.
 * The porter stemmer matches PostgreSQL's english full-text config, which the
 * live Appwrite uses ("polos" finds "Polo").
 */
function createFulltext(db: Db, table: string, index: Index): void {
  const fts = ftsTableName(table, index.key)
  const cols = index.attributes.map(q).join(', ')
  const newCols = index.attributes.map((c) => `new.${q(c)}`).join(', ')
  const oldCols = index.attributes.map((c) => `old.${q(c)}`).join(', ')
  db.sqlite.run(
    `CREATE VIRTUAL TABLE ${q(fts)} USING fts5(${cols}, content=${q(table)}, content_rowid='_seq', tokenize='porter unicode61 remove_diacritics 2')`,
  )
  db.sqlite.run(`CREATE TRIGGER ${q(`${fts}_ai`)} AFTER INSERT ON ${q(table)} BEGIN
    INSERT INTO ${q(fts)} (rowid, ${cols}) VALUES (new._seq, ${newCols}); END`)
  db.sqlite.run(`CREATE TRIGGER ${q(`${fts}_ad`)} AFTER DELETE ON ${q(table)} BEGIN
    INSERT INTO ${q(fts)} (${q(fts)}, rowid, ${cols}) VALUES ('delete', old._seq, ${oldCols}); END`)
  db.sqlite.run(`CREATE TRIGGER ${q(`${fts}_au`)} AFTER UPDATE ON ${q(table)} BEGIN
    INSERT INTO ${q(fts)} (${q(fts)}, rowid, ${cols}) VALUES ('delete', old._seq, ${oldCols});
    INSERT INTO ${q(fts)} (rowid, ${cols}) VALUES (new._seq, ${newCols}); END`)
  db.sqlite.run(`INSERT INTO ${q(fts)} (${q(fts)}) VALUES ('rebuild')`)
}

function pushBuckets(db: Db, buckets: any[], stamp: string, log: (line: string) => void): void {
  for (const b of buckets) {
    const values = [
      b.name ?? b.$id,
      b.enabled ?? true,
      b.fileSecurity ?? true,
      JSON.stringify(b.$permissions ?? []),
      b.maximumFileSize ?? 30000000,
      JSON.stringify(b.allowedFileExtensions ?? []),
      b.compression ?? 'none',
      b.encryption ?? false,
      b.antivirus ?? false,
      b.transformations ?? true,
    ]
    const exists = db.sqlite.query('SELECT 1 FROM _buckets WHERE id = ?').get(b.$id)
    if (exists) {
      db.sqlite.run(
        `UPDATE _buckets SET name = ?, enabled = ?, file_security = ?, permissions = ?, maximum_file_size = ?,
         allowed_file_extensions = ?, compression = ?, encryption = ?, antivirus = ?, transformations = ?, updated_at = ? WHERE id = ?`,
        [...values, stamp, b.$id],
      )
    } else {
      db.sqlite.run(
        `INSERT INTO _buckets (name, enabled, file_security, permissions, maximum_file_size, allowed_file_extensions,
         compression, encryption, antivirus, transformations, created_at, updated_at, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...values, stamp, stamp, b.$id],
      )
      log(`+ bucket ${b.$id}`)
    }
  }
}

/**
 * `path` is stored absolute when the config file's folder is known (CLI, SCHEMA_PATH, migrate),
 * and as written otherwise (an uploaded file); relative paths resolve against the functions
 * code folder at run time.
 */
function pushFunctions(db: Db, functions: any[], stamp: string, log: (line: string) => void, baseDir: string | undefined): void {
  for (const f of functions) {
    const values = [
      f.name ?? f.$id,
      f.runtime ?? 'node-22',
      f.entrypoint ?? 'src/main.js',
      baseDir ? resolve(baseDir, f.path ?? `functions/${f.$id}`) : (f.path ?? `functions/${f.$id}`),
      JSON.stringify(f.execute ?? []),
      JSON.stringify(f.events ?? []),
      f.schedule ?? '',
      f.timeout ?? 15,
      f.enabled ?? true,
      JSON.stringify(f.scopes ?? []),
      f.commands ?? '',
      f.logging ?? true,
      f.buildSpecification || 's-1vcpu-512mb',
      f.runtimeSpecification || 's-1vcpu-512mb',
      f.deploymentRetention ?? 0,
    ]
    const exists = db.sqlite.query('SELECT 1 FROM _functions WHERE id = ?').get(f.$id)
    if (exists) {
      db.sqlite.run(
        `UPDATE _functions SET name = ?, runtime = ?, entrypoint = ?, path = ?, execute = ?, events = ?, schedule = ?,
         timeout = ?, enabled = ?, scopes = ?, commands = ?, logging = ?, build_specification = ?, runtime_specification = ?,
         deployment_retention = ?, updated_at = ? WHERE id = ?`,
        [...values, stamp, f.$id],
      )
    } else {
      db.sqlite.run(
        `INSERT INTO _functions (name, runtime, entrypoint, path, execute, events, schedule, timeout, enabled, scopes, commands, logging,
         build_specification, runtime_specification, deployment_retention, created_at, updated_at, id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...values, stamp, stamp, f.$id],
      )
      log(`+ function ${f.$id}`)
    }
  }
}
