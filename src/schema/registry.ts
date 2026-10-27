import type { Db } from '~/db/connection'
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

/**
 * In-memory view of databases and collections, read from `_databases` and
 * `_collections`. Call `reload()` after a schema change.
 */
export class Registry {
  databases = new Map<string, DatabaseInfo>()
  collections = new Map<string, Collection>()

  constructor(private db: Db) {
    this.reload()
  }

  reload(): void {
    this.databases.clear()
    this.collections.clear()
    const dbs = this.db.sqlite
      .query<any, []>('SELECT seq, id, name, enabled, created_at, updated_at FROM _databases')
      .all()
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
    const rows = this.db.sqlite.query<any, []>('SELECT * FROM _collections').all()
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
