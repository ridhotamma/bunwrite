/**
 * Schema changes made in the console. Every change edits a collection's
 * definition and re-applies it with `pushCollection`, so the console and
 * `schema:push` alter tables the same way. Export/import use the
 * appwrite.config.json shape Pesanle keeps in its repo.
 */
import type { Db } from '~/db/connection'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { isValidId } from '~/lib/ids'
import { dropCollectionTables, pushCollection, pushConfig, type ConfigCollection } from './push'
import type { Registry } from './registry'
import { normalizeAttribute, normalizeIndex, tableName, type Attribute, type Index } from './types'

export class SchemaAdmin {
  constructor(
    private db: Db,
    private registry: Registry,
  ) {}

  private def(databaseId: string, collectionId: string): ConfigCollection {
    const c = this.registry.collection(databaseId, collectionId, true)
    return {
      databaseId: c.databaseId,
      id: c.id,
      name: c.name,
      enabled: c.enabled,
      documentSecurity: c.documentSecurity,
      permissions: [...c.permissions],
      attributes: c.attributes.map((a) => ({ ...a })),
      indexes: c.indexes.map((i) => ({ ...i })),
    }
  }

  private apply(def: ConfigCollection): string[] {
    const log: string[] = []
    this.db.sqlite.transaction(() => pushCollection(this.db, def, now(), (l) => log.push(l)))()
    this.registry.reload()
    return log
  }

  createDatabase(id: string, name: string): void {
    if (!isValidId(id)) throw err('general_argument_invalid', 'Database ID: up to 36 chars of a-z, A-Z, 0-9, period, hyphen and underscore.')
    if (this.registry.databases.has(id)) throw err('database_already_exists')
    const stamp = now()
    this.db.sqlite.query('INSERT INTO _databases (id, name, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').run(id, name || id, stamp, stamp)
    this.registry.reload()
  }

  updateDatabase(id: string, name: string, enabled: boolean): void {
    this.registry.database(id, true)
    this.db.sqlite.query('UPDATE _databases SET name = ?, enabled = ?, updated_at = ? WHERE id = ?').run(name, enabled ? 1 : 0, now(), id)
    this.registry.reload()
  }

  deleteDatabase(id: string): void {
    const database = this.registry.database(id, true)
    this.db.sqlite.transaction(() => {
      for (const c of [...this.registry.collections.values()].filter((c) => c.databaseId === id)) {
        dropCollectionTables(this.db, tableName(database.seq, c.id))
      }
      this.db.sqlite.query('DELETE FROM _collections WHERE database_id = ?').run(id)
      this.db.sqlite.query('DELETE FROM _databases WHERE id = ?').run(id)
    })()
    this.registry.reload()
  }

  createCollection(databaseId: string, id: string, name: string, documentSecurity: boolean, permissions: string[]): void {
    this.registry.database(databaseId, true)
    if (!isValidId(id)) throw err('general_argument_invalid', 'Collection ID: up to 36 chars of a-z, A-Z, 0-9, period, hyphen and underscore.')
    if (this.registry.collections.has(`${databaseId}/${id}`)) throw err('collection_already_exists')
    this.apply({ databaseId, id, name: name || id, enabled: true, documentSecurity, permissions, attributes: [], indexes: [] })
  }

  updateCollection(databaseId: string, id: string, patch: { name?: string; enabled?: boolean; documentSecurity?: boolean; permissions?: string[] }): void {
    const def = this.def(databaseId, id)
    this.apply({ ...def, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) })
  }

  deleteCollection(databaseId: string, id: string): void {
    const c = this.registry.collection(databaseId, id, true)
    this.db.sqlite.transaction(() => {
      dropCollectionTables(this.db, c.table)
      this.db.sqlite.query('DELETE FROM _collections WHERE database_id = ? AND id = ?').run(databaseId, id)
    })()
    this.registry.reload()
  }

  /** Add or replace an attribute. A type change rebuilds the table, keeping the data. */
  saveAttribute(databaseId: string, collectionId: string, raw: Record<string, unknown>, replace = false): string[] {
    const def = this.def(databaseId, collectionId)
    const attribute = normalizeAttribute(raw)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(attribute.key)) {
      throw err('general_argument_invalid', 'Attribute key: up to 36 chars of a-z, A-Z, 0-9, period, hyphen and underscore.')
    }
    const at = def.attributes.findIndex((a) => a.key === attribute.key)
    if (at >= 0 && !replace) throw err('attribute_already_exists')
    if (at < 0 && replace) throw err('attribute_not_found', undefined, [attribute.key])
    if (attribute.required && attribute.default !== null) {
      throw err('attribute_default_unsupported', 'Cannot set a default value for a required attribute.')
    }
    if (at >= 0) def.attributes[at] = attribute
    else def.attributes.push(attribute)
    return this.apply(def)
  }

  deleteAttribute(databaseId: string, collectionId: string, key: string): string[] {
    const def = this.def(databaseId, collectionId)
    if (!def.attributes.some((a) => a.key === key)) throw err('attribute_not_found', undefined, [key])
    def.attributes = def.attributes.filter((a) => a.key !== key)
    // Indexes on a removed attribute go with it, as in Appwrite.
    def.indexes = def.indexes.filter((i) => !i.attributes.includes(key))
    return this.apply(def)
  }

  saveIndex(databaseId: string, collectionId: string, raw: Record<string, unknown>): string[] {
    const def = this.def(databaseId, collectionId)
    const index: Index = normalizeIndex(raw)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(index.key)) throw err('general_argument_invalid', 'Index key is not valid.')
    if (!['key', 'unique', 'fulltext'].includes(index.type)) throw err('index_invalid', 'Index type must be key, unique or fulltext.')
    if (index.attributes.length === 0) throw err('index_invalid', 'Pick at least one attribute.')
    const known = new Set([...def.attributes.map((a) => a.key), '$id', '$createdAt', '$updatedAt', '$sequence'])
    for (const a of index.attributes) if (!known.has(a)) throw err('attribute_not_found', undefined, [a])
    if (def.indexes.some((i) => i.key === index.key)) throw err('index_already_exists')
    def.indexes.push(index)
    return this.apply(def)
  }

  deleteIndex(databaseId: string, collectionId: string, key: string): string[] {
    const def = this.def(databaseId, collectionId)
    if (!def.indexes.some((i) => i.key === key)) throw err('index_not_found', undefined, [key])
    def.indexes = def.indexes.filter((i) => i.key !== key)
    return this.apply(def)
  }

  /** Current schema in appwrite.config.json shape (tablesDB/tables/buckets). */
  export(): Record<string, unknown> {
    const sql = this.db.sqlite
    const attribute = (a: Attribute) => {
      const out: Record<string, unknown> = { key: a.key, type: a.type, required: a.required, array: a.array }
      if (a.type === 'string') {
        out.size = a.size
        if (a.format) out.format = a.format
        if (a.elements) out.elements = a.elements
        out.encrypt = false
      }
      if (a.type === 'integer' || a.type === 'double') {
        if (a.min !== undefined) out.min = a.min
        if (a.max !== undefined) out.max = a.max
      }
      if (a.type === 'datetime') out.format = ''
      out.default = a.default ?? null
      return out
    }
    const buckets = sql.query<any, []>('SELECT * FROM _buckets ORDER BY seq').all()
    return {
      tablesDB: [...this.registry.databases.values()].map((d) => ({ $id: d.id, name: d.name, enabled: d.enabled })),
      tables: [...this.registry.collections.values()]
        .sort((a, b) => a.seq - b.seq)
        .map((c) => ({
          $id: c.id,
          $permissions: c.permissions,
          databaseId: c.databaseId,
          name: c.name,
          enabled: c.enabled,
          rowSecurity: c.documentSecurity,
          columns: c.attributes.map(attribute),
          indexes: c.indexes.map((i) => ({ key: i.key, type: i.type, status: 'available', columns: i.attributes, orders: i.orders })),
        })),
      buckets: buckets.map((b) => ({
        $id: b.id,
        $permissions: JSON.parse(b.permissions),
        fileSecurity: Boolean(b.file_security),
        name: b.name,
        enabled: Boolean(b.enabled),
        maximumFileSize: b.maximum_file_size,
        allowedFileExtensions: JSON.parse(b.allowed_file_extensions),
        compression: b.compression,
        encryption: Boolean(b.encryption),
        antivirus: Boolean(b.antivirus),
      })),
    }
  }

  /**
   * Apply a config file. With `dryRun` the changes are made inside a
   * savepoint and rolled back, so the console can show them before applying.
   */
  importConfig(config: unknown, options: { baseDir?: string; prune?: boolean; dryRun?: boolean }): string[] {
    const log: string[] = []
    const sql = this.db.sqlite
    sql.run('SAVEPOINT schema_import')
    try {
      pushConfig(this.db, config, { baseDir: options.baseDir, prune: options.prune, log: (l) => log.push(l) })
      if (options.dryRun) sql.run('ROLLBACK TO schema_import')
      sql.run('RELEASE schema_import')
    } catch (error) {
      sql.run('ROLLBACK TO schema_import')
      sql.run('RELEASE schema_import')
      throw error
    }
    this.registry.reload()
    return log
  }
}
