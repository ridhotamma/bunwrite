import type { SqlDatabase, SqlExecutor } from '~/db/driver'
import { err } from '~/lib/errors'
import {
  normalizeAttribute,
  normalizeIndex,
  permsTableName,
  tableName,
  type Collection,
} from './types'

export interface DatabaseInfo {
  seq: number
  id: string
  name: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

interface DatabaseRow {
  seq: number
  id: string
  name: string
  enabled: number
  created_at: string
  updated_at: string
}

interface CollectionRow {
  seq: number
  database_id: string
  id: string
  name: string
  enabled: number
  document_security: number
  permissions: string
  attributes: string
  indexes: string
  created_at: string
  updated_at: string
}

/**
 * In-memory view of databases and collections, read from `_databases` and
 * `_collections`. Call `reload()` after a schema change.
 */
export class Registry {
  databases = new Map<string, DatabaseInfo>()
  collections = new Map<string, Collection>()

  constructor(private db: SqlDatabase) {
    // SQLite loads synchronously, as before. A network backend waits for
    // `load()` from the boot path (services.ready()).
    if (db.dialect === 'sqlite') this.reload()
  }

  /** Reload over the synchronous SQLite path; schema DDL is still SQLite-only. */
  reload(): void {
    const dbs = this.db.sqlite!
      .query<DatabaseRow, []>('SELECT seq, id, name, enabled, created_at, updated_at FROM _databases')
      .all()
    const rows = this.db.sqlite!.query<CollectionRow, []>('SELECT * FROM _collections').all()
    this.apply(dbs, rows)
  }

  /** Reload through the driver port so it works on Postgres too. */
  async load(): Promise<void> {
    await this.loadFrom(this.db.driver)
  }

  /**
   * Reload inside an open transaction, so a composite schema change sees its
   * own uncommitted rows (Postgres uses a different pooled connection
   * outside the transaction).
   */
  async loadFrom(executor: SqlExecutor): Promise<void> {
    const dbs = await executor.all<DatabaseRow>('SELECT seq, id, name, enabled, created_at, updated_at FROM _databases')
    const rows = await executor.all<CollectionRow>('SELECT * FROM _collections')
    this.apply(dbs, rows)
  }

  private apply(dbs: DatabaseRow[], rows: CollectionRow[]): void {
    this.databases.clear()
    this.collections.clear()
    for (const d of dbs) {
      this.databases.set(d.id, {
        seq: d.seq,
        id: d.id,
        name: d.name,
        enabled: Boolean(d.enabled),
        createdAt: d.created_at,
        updatedAt: d.updated_at,
      })
    }
    for (const r of rows) {
      const database = this.databases.get(r.database_id)
      if (!database) continue
      const attributes = (JSON.parse(r.attributes) as unknown[]).map(normalizeAttribute)
      const table = tableName(database.seq, r.id)
      this.collections.set(`${r.database_id}/${r.id}`, {
        seq: r.seq,
        databaseId: r.database_id,
        databaseSeq: database.seq,
        id: r.id,
        name: r.name,
        enabled: Boolean(r.enabled),
        documentSecurity: Boolean(r.document_security),
        permissions: JSON.parse(r.permissions),
        attributes,
        indexes: (JSON.parse(r.indexes) as unknown[]).map(normalizeIndex),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        table,
        permsTable: permsTableName(table),
        attributeMap: new Map(attributes.map((a) => [a.key, a])),
      })
    }
  }

  database(databaseId: string, privileged: boolean): DatabaseInfo {
    const database = this.databases.get(databaseId)
    if (!database || (!database.enabled && !privileged)) {
      throw err('database_not_found', undefined, [databaseId])
    }
    return database
  }

  collection(databaseId: string, collectionId: string, privileged: boolean): Collection {
    this.database(databaseId, privileged)
    const collection = this.collections.get(`${databaseId}/${collectionId}`)
    if (!collection || (!collection.enabled && !privileged)) {
      throw err('collection_not_found', undefined, [collectionId])
    }
    return collection
  }
}
