/**
 * SQL persistence for the vector store.
 *
 * Keeping this behind one small store keeps the service free of dialect and
 * row-shape details, and leaves room for a future native index (pgvector or
 * sqlite-vec) without changing the service or the HTTP API.
 */
import type { SqlDatabase, SqlExecutor } from '~/db/driver'
import { now } from '~/lib/datetime'
import { compact, norm } from './similarity'
import type { StoredPoint, VectorCollection, VectorCollectionRow, VectorPoint, VectorPointRow } from './types'
import { collectionModel, pointModel } from './rows'

export interface CollectionRecord {
  id: string
  name: string
  dimension: number
  metric: string
  embedder: string
}

export interface ListPointOptions {
  documentId?: string
  limit: number
  offset: number
}

export interface PointPage {
  total: number
  rows: VectorPointRow[]
}

export class VectorStore {
  constructor(private db: SqlDatabase) {}

  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.db.driver.transaction(fn)
  }

  async listCollections(): Promise<VectorCollection[]> {
    const rows = await this.db.driver.all<VectorCollectionRow & { points: number }>(
      `SELECT c.*, (SELECT count(*) FROM _vector_points p WHERE p.collection_id = c.id) AS points
       FROM _vector_collections c ORDER BY c.id`,
    )
    return rows.map((row) => collectionModel(row, Number(row.points) || 0))
  }

  async collectionRow(id: string): Promise<VectorCollectionRow | null> {
    return this.db.driver.get<VectorCollectionRow>('SELECT * FROM _vector_collections WHERE id = ?', [id])
  }

  async countPoints(collectionId: string, exec: SqlExecutor = this.db.driver): Promise<number> {
    const row = await exec.get<{ total: number }>('SELECT count(*) AS total FROM _vector_points WHERE collection_id = ?', [collectionId])
    return Number(row?.total) || 0
  }

  async collectionWithCount(id: string): Promise<VectorCollection | null> {
    const row = await this.collectionRow(id)
    if (!row) return null
    return collectionModel(row, await this.countPoints(id))
  }

  /** Insert a collection unless its ID already exists. */
  async insertCollection(record: CollectionRecord): Promise<boolean> {
    const stamp = now()
    const result = await this.db.driver.run(
      `INSERT INTO _vector_collections (id, name, dimension, metric, embedder, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [record.id, record.name, record.dimension, record.metric, record.embedder, stamp, stamp],
    )
    return Number(result.changes) > 0
  }

  /** Delete a collection and every point in it inside the caller's transaction. */
  async deleteCollection(collectionId: string, exec: SqlExecutor = this.db.driver): Promise<boolean> {
    await exec.run('DELETE FROM _vector_points WHERE collection_id = ?', [collectionId])
    const result = await exec.run('DELETE FROM _vector_collections WHERE id = ?', [collectionId])
    return Number(result.changes) > 0
  }

  async insertPoints(exec: SqlExecutor, collectionId: string, points: StoredPoint[]): Promise<void> {
    const stamp = now()
    for (const point of points) {
      const stored = compact(point.vector)
      await exec.run(
        `INSERT INTO _vector_points
           (collection_id, id, document_id, chunk_index, content, metadata, embedding, norm, dimension, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (collection_id, id) DO UPDATE SET
           document_id = excluded.document_id,
           chunk_index = excluded.chunk_index,
           content = excluded.content,
           metadata = excluded.metadata,
           embedding = excluded.embedding,
           norm = excluded.norm,
           dimension = excluded.dimension,
           updated_at = excluded.updated_at`,
        [
          collectionId,
          point.id,
          point.documentId,
          point.chunkIndex,
          point.content,
          JSON.stringify(point.metadata),
          JSON.stringify(stored),
          norm(stored),
          stored.length,
          stamp,
          stamp,
        ],
      )
    }
  }

  async existingPointIds(collectionId: string, ids: string[], exec: SqlExecutor = this.db.driver): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    const marks = ids.map(() => '?').join(', ')
    const rows = await exec.all<{ id: string }>(
      `SELECT id FROM _vector_points WHERE collection_id = ? AND id IN (${marks})`,
      [collectionId, ...ids],
    )
    return new Set(rows.map((row) => row.id))
  }

  async point(collectionId: string, pointId: string): Promise<VectorPoint | null> {
    const row = await this.db.driver.get<VectorPointRow>('SELECT * FROM _vector_points WHERE collection_id = ? AND id = ?', [collectionId, pointId])
    return row ? pointModel(row) : null
  }

  async pointsByIds(collectionId: string, ids: string[]): Promise<VectorPoint[]> {
    if (ids.length === 0) return []
    const marks = ids.map(() => '?').join(', ')
    const rows = await this.db.driver.all<VectorPointRow>(
      `SELECT * FROM _vector_points WHERE collection_id = ? AND id IN (${marks}) ORDER BY chunk_index, id`,
      [collectionId, ...ids],
    )
    return rows.map(pointModel)
  }

  /** One page of a search scan, in insertion order. The ranker keeps only the best K. */
  async scanPoints(collectionId: string, afterSeq: number, limit: number): Promise<VectorPointRow[]> {
    return this.db.driver.all<VectorPointRow>(
      'SELECT * FROM _vector_points WHERE collection_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      [collectionId, afterSeq, limit],
    )
  }

  async listPoints(collectionId: string, options: ListPointOptions): Promise<PointPage> {
    const where = options.documentId ? 'WHERE collection_id = ? AND document_id = ?' : 'WHERE collection_id = ?'
    const params = options.documentId ? [collectionId, options.documentId] : [collectionId]
    const total = await this.db.driver.get<{ total: number }>(`SELECT count(*) AS total FROM _vector_points ${where}`, params)
    const rows = await this.db.driver.all<VectorPointRow>(
      `SELECT * FROM _vector_points ${where} ORDER BY chunk_index, seq LIMIT ? OFFSET ?`,
      [...params, options.limit, options.offset],
    )
    return { total: Number(total?.total) || 0, rows }
  }

  async deletePoint(collectionId: string, pointId: string): Promise<boolean> {
    const result = await this.db.driver.run('DELETE FROM _vector_points WHERE collection_id = ? AND id = ?', [collectionId, pointId])
    return Number(result.changes) > 0
  }

  async deleteDocument(collectionId: string, documentId: string, exec: SqlExecutor = this.db.driver): Promise<number> {
    const result = await exec.run('DELETE FROM _vector_points WHERE collection_id = ? AND document_id = ?', [collectionId, documentId])
    return Number(result.changes) || 0
  }
}
