/**
 * Apply a project config file to Postgres.
 *
 * The synchronous `pushConfig` in `push.ts` builds SQLite DDL. This is the
 * Postgres counterpart: the same `appwrite.config.json` shape, the same diff
 * rules (add/drop/retype attributes, recreate indexes), but the table, index
 * and version-trigger DDL comes from `postgres-schema.ts`.
 *
 * `src/cli/db.ts --schema appwrite.config.json` calls it after the system
 * schema is in place. The console and the boot path still use the SQLite push
 * until the remaining services are ported.
 */
import { resolve } from 'node:path'

import { collectionVersionKey } from '~/cluster/versions'
import type { SqlExecutor } from '~/db/driver'
import type { PostgresDriver } from '~/db/postgres-driver'
import {
  postgresAttributeType,
  postgresCollectionVersionStatements,
  postgresDocumentIndexStatements,
  postgresDocumentTableStatements,
} from '~/db/postgres-schema'
import { now } from '~/lib/datetime'
import { readConfig, type ConfigCollection, type PushOptions } from './push'
import type { BucketConfig, FunctionConfig, ProjectConfig } from './config'
import { ftsTableName, permsTableName, tableName, type Attribute, type Index } from './types'

const q = (name: string) => `"${name.replace(/"/g, '""')}"`

const flag = (value: boolean | number) => (value ? 1 : 0)

interface ExistingCollection {
  name: string
  enabled: number
  document_security: number
  permissions: string
  attributes: string
  indexes: string
}

/** Apply a config file in one transaction. */
export async function pushConfigPostgres(driver: PostgresDriver, config: unknown, options: PushOptions = {}): Promise<void> {
  await driver.transaction((tx) => applyConfigPostgres(tx, config, options))
}

/** The transaction body, shared with the console's dry-run preview. */
export async function applyConfigPostgres(driver: SqlExecutor, config: unknown, options: PushOptions = {}): Promise<void> {
  const log = options.log ?? (() => {})
  const project = config && typeof config === 'object' ? (config as ProjectConfig) : {}
  const { databases, collections } = readConfig(config)
  const stamp = now()

  for (const database of databases) {
    const existing = await driver.get<{ seq: number }>('SELECT seq FROM _databases WHERE id = ?', [database.id])
    if (existing) {
      await driver.run('UPDATE _databases SET name = ?, enabled = ?, updated_at = ? WHERE id = ?', [database.name, flag(database.enabled), stamp, database.id])
    } else {
      await driver.run('INSERT INTO _databases (id, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
        database.id,
        database.name,
        flag(database.enabled),
        stamp,
        stamp,
      ])
      log(`+ database ${database.id}`)
    }
  }

  const wanted = new Set<string>()
  for (const collection of collections) {
    wanted.add(`${collection.databaseId}/${collection.id}`)
    await pushCollectionPostgres(driver, collection, stamp, log)
  }

  await pushBuckets(driver, project.buckets ?? [], stamp, log)
  await pushFunctions(driver, project.functions ?? [], stamp, log, options.baseDir)

  if (options.prune) {
    const all = await driver.all<{ database_id: string; id: string; dseq: number }>(
      'SELECT c.database_id, c.id, d.seq AS dseq FROM _collections c JOIN _databases d ON d.id = c.database_id',
    )
    for (const collection of all) {
      if (wanted.has(`${collection.database_id}/${collection.id}`)) continue
      await dropCollectionTablesPostgres(driver, tableName(collection.dseq, collection.id))
      await driver.run('DELETE FROM _collections WHERE database_id = ? AND id = ?', [collection.database_id, collection.id])
      await driver.run('DELETE FROM _meta WHERE key = ?', [collectionVersionKey(collection.database_id, collection.id)])
      log(`- collection ${collection.database_id}/${collection.id}`)
    }
  }
}

export async function pushCollectionPostgres(driver: SqlExecutor, collection: ConfigCollection, stamp: string, log: (line: string) => void): Promise<void> {
  const database = await driver.get<{ seq: number }>('SELECT seq FROM _databases WHERE id = ?', [collection.databaseId])
  if (!database) throw new Error(`Collection ${collection.id} points at unknown database ${collection.databaseId}`)
  const table = tableName(database.seq, collection.id)
  const existing = await driver.get<ExistingCollection>(
    'SELECT name, enabled, document_security, permissions, attributes, indexes FROM _collections WHERE database_id = ? AND id = ?',
    [collection.databaseId, collection.id],
  )

  if (!existing) {
    for (const sql of postgresDocumentTableStatements(table, collection.attributes)) await driver.exec(sql)
    for (const sql of postgresDocumentIndexStatements(table, collection.indexes, collection.attributes)) await driver.exec(sql)
    for (const sql of postgresCollectionVersionStatements(collection.databaseId, collection.id, table)) await driver.exec(sql)
    await driver.run(
      `INSERT INTO _collections (database_id, id, name, enabled, document_security, permissions, attributes, indexes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        collection.databaseId,
        collection.id,
        collection.name,
        flag(collection.enabled),
        flag(collection.documentSecurity),
        JSON.stringify(collection.permissions),
        JSON.stringify(collection.attributes),
        JSON.stringify(collection.indexes),
        stamp,
        stamp,
      ],
    )
    log(`+ collection ${collection.databaseId}/${collection.id} (${collection.attributes.length} attributes, ${collection.indexes.length} indexes)`)
    return
  }

  const before = JSON.parse(existing.attributes) as Attribute[]
  const beforeIndexes = JSON.parse(existing.indexes) as Index[]
  const beforeMap = new Map(before.map((a) => [a.key, a]))
  const afterMap = new Map(collection.attributes.map((a) => [a.key, a]))
  const added = collection.attributes.filter((a) => !beforeMap.has(a.key))
  const removed = before.filter((a) => !afterMap.has(a.key))
  const retyped = collection.attributes.filter((a) => {
    const old = beforeMap.get(a.key)
    return old && postgresAttributeType(old) !== postgresAttributeType(a)
  })
  const schemaChanged = added.length + removed.length + retyped.length > 0
  const indexDiff = JSON.stringify(beforeIndexes) !== JSON.stringify(collection.indexes)

  if (schemaChanged || indexDiff) {
    for (const index of beforeIndexes) {
      const name = index.type === 'fulltext' ? ftsTableName(table, index.key) : `${table}__idx_${index.key}`
      await driver.exec(`DROP INDEX IF EXISTS ${q(name)}`)
    }
  }

  for (const attribute of retyped) {
    const type = postgresAttributeType(attribute)
    try {
      await driver.exec(`ALTER TABLE ${q(table)} ALTER COLUMN ${q(attribute.key)} TYPE ${type} USING ${q(attribute.key)}::${type}`)
      log(`~ collection ${collection.id}: ${attribute.key} -> ${type}`)
    } catch (error) {
      // Do not update `_collections.attributes`: the API and registry would
      // then advertise a type the physical column does not have.
      throw new Error(`collection ${collection.id}: could not retype ${attribute.key}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      })
    }
  }
  for (const attribute of removed) {
    await driver.exec(`ALTER TABLE ${q(table)} DROP COLUMN IF EXISTS ${q(attribute.key)}`)
    log(`~ collection ${collection.id}: - ${attribute.key}`)
  }
  for (const attribute of added) {
    await driver.exec(`ALTER TABLE ${q(table)} ADD COLUMN IF NOT EXISTS ${q(attribute.key)} ${postgresAttributeType(attribute)}`)
    log(`~ collection ${collection.id}: + ${attribute.key}`)
  }

  if (schemaChanged || indexDiff) {
    for (const sql of postgresDocumentIndexStatements(table, collection.indexes, collection.attributes)) await driver.exec(sql)
    for (const sql of postgresCollectionVersionStatements(collection.databaseId, collection.id, table)) await driver.exec(sql)
  }

  await driver.run(
    `UPDATE _collections SET name = ?, enabled = ?, document_security = ?, permissions = ?, attributes = ?, indexes = ?, updated_at = ?
     WHERE database_id = ? AND id = ?`,
    [
      collection.name,
      flag(collection.enabled),
      flag(collection.documentSecurity),
      JSON.stringify(collection.permissions),
      JSON.stringify(collection.attributes),
      JSON.stringify(collection.indexes),
      stamp,
      collection.databaseId,
      collection.id,
    ],
  )
}

/** Drop a collection's tables and its permission table. */
export async function dropCollectionTablesPostgres(driver: SqlExecutor, table: string): Promise<void> {
  await driver.exec(`DROP TABLE IF EXISTS ${q(table)} CASCADE`)
  await driver.exec(`DROP TABLE IF EXISTS ${q(permsTableName(table))} CASCADE`)
}

/** Buckets and functions are the same rows as on SQLite; only the driver differs. */
async function pushBuckets(driver: SqlExecutor, buckets: BucketConfig[], stamp: string, log: (line: string) => void): Promise<void> {
  for (const b of buckets) {
    const values = [
      b.name ?? b.$id,
      flag(b.enabled ?? true),
      flag(b.fileSecurity ?? true),
      JSON.stringify(b.$permissions ?? []),
      b.maximumFileSize ?? 30000000,
      JSON.stringify(b.allowedFileExtensions ?? []),
      b.compression ?? 'none',
      flag(b.encryption ?? false),
      flag(b.antivirus ?? false),
      flag(b.transformations ?? true),
    ]
    const exists = await driver.get('SELECT 1 FROM _buckets WHERE id = ?', [b.$id])
    if (exists) {
      await driver.run(
        `UPDATE _buckets SET name = ?, enabled = ?, file_security = ?, permissions = ?, maximum_file_size = ?,
         allowed_file_extensions = ?, compression = ?, encryption = ?, antivirus = ?, transformations = ?, updated_at = ? WHERE id = ?`,
        [...values, stamp, b.$id],
      )
    } else {
      await driver.run(
        `INSERT INTO _buckets (name, enabled, file_security, permissions, maximum_file_size, allowed_file_extensions,
         compression, encryption, antivirus, transformations, created_at, updated_at, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...values, stamp, stamp, b.$id],
      )
      log(`+ bucket ${b.$id}`)
    }
  }
}

async function pushFunctions(
  driver: SqlExecutor,
  functions: FunctionConfig[],
  stamp: string,
  log: (line: string) => void,
  baseDir: string | undefined,
): Promise<void> {
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
      flag(f.enabled ?? true),
      JSON.stringify(f.scopes ?? []),
      f.commands ?? '',
      flag(f.logging ?? true),
      f.buildSpecification || 's-1vcpu-512mb',
      f.runtimeSpecification || 's-1vcpu-512mb',
      f.deploymentRetention ?? 0,
    ]
    const exists = await driver.get('SELECT 1 FROM _functions WHERE id = ?', [f.$id])
    if (exists) {
      await driver.run(
        `UPDATE _functions SET name = ?, runtime = ?, entrypoint = ?, path = ?, execute = ?, events = ?, schedule = ?,
         timeout = ?, enabled = ?, scopes = ?, commands = ?, logging = ?, build_specification = ?, runtime_specification = ?,
         deployment_retention = ?, updated_at = ? WHERE id = ?`,
        [...values, stamp, f.$id],
      )
    } else {
      await driver.run(
        `INSERT INTO _functions (name, runtime, entrypoint, path, execute, events, schedule, timeout, enabled, scopes, commands, logging,
         build_specification, runtime_specification, deployment_retention, created_at, updated_at, id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...values, stamp, stamp, f.$id],
      )
      log(`+ function ${f.$id}`)
    }
  }
}
