/**
 * SQL persistence for the vector store.
 *
 * Keeping this behind one small store keeps the service free of dialect and
 * row-shape details, and leaves room for a future native index (pgvector or
 * sqlite-vec) without changing the service or the HTTP API.
 */
import { vectorVersionKey } from '~/cluster/versions'
import type { SqlDatabase, SqlExecutor } from '~/db/driver'
import { now } from '~/lib/datetime'
import { uniqueId } from '~/lib/ids'
import { compact, norm } from './similarity'
import type {
  EvaluationRun,
  EvaluationRunSummary,
  EvaluateResult,
  StoredPoint,
  VectorAuditEntry,
  VectorCollection,
  VectorCollectionRow,
  VectorDocument,
  VectorPoint,
  VectorPointRow,
} from './types'
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

interface EvaluationRow {
  seq: number
  id: string
  collection_id: string
  name: string
  dataset: string
  result: string
  total: number
  passed: number
  failed: number
  metrics: string
  created_at: string
  updated_at: string
}

function parsed<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function evaluationSummary(row: EvaluationRow): EvaluationRunSummary {
  return {
    $id: row.id,
    collectionId: row.collection_id,
    name: row.name,
    total: Number(row.total) || 0,
    passed: Number(row.passed) || 0,
    failed: Number(row.failed) || 0,
    metrics: parsed<EvaluateResult['metrics']>(row.metrics, {
      recallAtK: null,
      mrr: null,
      ndcgAtK: null,
      contextKeywordCoverage: null,
      answerKeywordCoverage: null,
      refusalAccuracy: null,
      averageLatencyMs: 0,
    }),
    $createdAt: row.created_at,
    $updatedAt: row.updated_at,
  }
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
      `INSERT INTO _vector_collections (id, name, dimension, metric, embedder, index_epoch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [record.id, record.name, record.dimension, record.metric, record.embedder, uniqueId(), stamp, stamp],
    )
    return Number(result.changes) > 0
  }

  /** Delete a collection and every point in it inside the caller's transaction. */
  async deleteCollection(collectionId: string, exec: SqlExecutor = this.db.driver): Promise<boolean> {
    await exec.run('DELETE FROM _vector_points WHERE collection_id = ?', [collectionId])
    await exec.run('DELETE FROM _vector_evaluation_runs WHERE collection_id = ?', [collectionId])
    await exec.run('DELETE FROM _vector_audit_logs WHERE collection_id = ?', [collectionId])
    const result = await exec.run('DELETE FROM _vector_collections WHERE id = ?', [collectionId])
    return Number(result.changes) > 0
  }

  async insertPoints(exec: SqlExecutor, collectionId: string, points: StoredPoint[]): Promise<void> {
    const stamp = now()
    for (const point of points) {
      const stored = compact(point.vector)
      await exec.run(
        `INSERT INTO _vector_points
           (collection_id, id, document_id, chunk_index, content, metadata, embedding, norm, dimension, permissions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (collection_id, id) DO UPDATE SET
           document_id = excluded.document_id,
           chunk_index = excluded.chunk_index,
           content = excluded.content,
           metadata = excluded.metadata,
           embedding = excluded.embedding,
           norm = excluded.norm,
           dimension = excluded.dimension,
           permissions = excluded.permissions,
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
          JSON.stringify(point.permissions),
          stamp,
          stamp,
        ],
      )
    }
  }

  async updatePointVectors(
    exec: SqlExecutor,
    collectionId: string,
    updates: { id: string; embedding: number[]; dimension: number }[],
  ): Promise<void> {
    const stamp = now()
    for (const update of updates) {
      const stored = compact(update.embedding)
      await exec.run(
        'UPDATE _vector_points SET embedding = ?, norm = ?, dimension = ?, updated_at = ? WHERE collection_id = ? AND id = ?',
        [JSON.stringify(stored), norm(stored), update.dimension, stamp, collectionId, update.id],
      )
    }
  }

  async updateCollectionEmbedder(exec: SqlExecutor, collectionId: string, embedder: string, dimension: number): Promise<void> {
    await exec.run('UPDATE _vector_collections SET embedder = ?, dimension = ?, updated_at = ? WHERE id = ?', [embedder, dimension, now(), collectionId])
  }

  /**
   * Invalidate every point currently in the external index for a collection.
   * Used after a mirror failure so a restart cannot treat a partially updated
   * provider collection as current.
   */
  async rotateIndexEpoch(collectionId: string): Promise<string> {
    const epoch = uniqueId()
    await this.db.driver.run('UPDATE _vector_collections SET index_epoch = ?, updated_at = ? WHERE id = ?', [epoch, now(), collectionId])
    return epoch
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

  /** Raw rows for hydrating external ANN hits; IDs are chunked for SQLite's variable limit. */
  async rowsByIds(collectionId: string, ids: string[]): Promise<VectorPointRow[]> {
    const rows: VectorPointRow[] = []
    for (let index = 0; index < ids.length; index += 500) {
      const chunk = ids.slice(index, index + 500)
      const marks = chunk.map(() => '?').join(', ')
      rows.push(
        ...(await this.db.driver.all<VectorPointRow>(
          `SELECT * FROM _vector_points WHERE collection_id = ? AND id IN (${marks})`,
          [collectionId, ...chunk],
        )),
      )
    }
    return rows
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

  /** Ingested documents with their chunk counts, newest first. */
  async listDocuments(collectionId: string, limit: number): Promise<VectorDocument[]> {
    const rows = await this.db.driver.all<{
      document_id: string
      chunks: number
      created_at: string
      updated_at: string
      metadata: string | null
    }>(
      `SELECT p.document_id, count(*) AS chunks, min(p.created_at) AS created_at, max(p.updated_at) AS updated_at,
         (SELECT q.metadata FROM _vector_points q
          WHERE q.collection_id = p.collection_id AND q.document_id = p.document_id
          ORDER BY q.chunk_index, q.id LIMIT 1) AS metadata
       FROM _vector_points p
       WHERE p.collection_id = ? AND p.document_id <> ''
       GROUP BY p.document_id
       ORDER BY max(p.updated_at) DESC
       LIMIT ?`,
      [collectionId, limit],
    )
    return rows.map((row) => {
      let metadata: Record<string, unknown> = {}
      try {
        const parsed: unknown = row.metadata ? JSON.parse(row.metadata) : {}
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>
      } catch {
        // A corrupt metadata row should not hide the rest of the document index.
      }
      return {
        documentId: row.document_id,
        chunks: Number(row.chunks) || 0,
        metadata,
        $createdAt: row.created_at,
        $updatedAt: row.updated_at,
      }
    })
  }

  async insertAudit(entry: {
    id: string
    collectionId: string
    userId: string | null
    callerKind: string
    query: string
    answer: string
    sourceIds: string[]
    security: unknown
    latencyMs: number
  }): Promise<void> {
    await this.db.driver.run(
      `INSERT INTO _vector_audit_logs
         (id, collection_id, user_id, caller_kind, query, answer, source_ids, security, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.collectionId,
        entry.userId,
        entry.callerKind,
        entry.query,
        entry.answer,
        JSON.stringify(entry.sourceIds),
        JSON.stringify(entry.security),
        entry.latencyMs,
        now(),
      ],
    )
  }

  async listAudit(collectionId: string, limit = 25): Promise<VectorAuditEntry[]> {
    const rows = await this.db.driver.all<{
      id: string
      collection_id: string
      user_id: string | null
      caller_kind: string
      query: string
      answer: string
      source_ids: string
      security: string
      latency_ms: number
      created_at: string
    }>('SELECT * FROM _vector_audit_logs WHERE collection_id = ? ORDER BY seq DESC LIMIT ?', [collectionId, limit])
    return rows.map((row) => ({
      $id: row.id,
      collectionId: row.collection_id,
      userId: row.user_id,
      callerKind: row.caller_kind,
      query: row.query,
      answer: row.answer,
      sourceIds: parsed<string[]>(row.source_ids, []),
      security: parsed<VectorAuditEntry['security']>(row.security, { redactions: 0, redactionKinds: [], suspiciousSources: [] }),
      latencyMs: Number(row.latency_ms) || 0,
      $createdAt: row.created_at,
    }))
  }

  async deleteAudit(collectionId: string): Promise<number> {
    const result = await this.db.driver.run('DELETE FROM _vector_audit_logs WHERE collection_id = ?', [collectionId])
    return Number(result.changes) || 0
  }

  async insertEvaluation(
    id: string,
    collectionId: string,
    name: string,
    dataset: unknown,
    result: EvaluateResult,
  ): Promise<EvaluationRun> {
    const stamp = now()
    await this.db.driver.run(
      `INSERT INTO _vector_evaluation_runs
         (id, collection_id, name, dataset, result, total, passed, failed, metrics, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        collectionId,
        name,
        JSON.stringify(dataset),
        JSON.stringify(result),
        result.total,
        result.passed,
        result.failed,
        JSON.stringify(result.metrics),
        stamp,
        stamp,
      ],
    )
    return (await this.evaluation(id))!
  }

  async listEvaluations(collectionId: string, limit = 25): Promise<EvaluationRunSummary[]> {
    const rows = await this.db.driver.all<EvaluationRow>(
      'SELECT * FROM _vector_evaluation_runs WHERE collection_id = ? ORDER BY seq DESC LIMIT ?',
      [collectionId, limit],
    )
    return rows.map(evaluationSummary)
  }

  async evaluation(id: string): Promise<EvaluationRun | null> {
    const row = await this.db.driver.get<EvaluationRow>('SELECT * FROM _vector_evaluation_runs WHERE id = ?', [id])
    if (!row) return null
    return {
      ...evaluationSummary(row),
      dataset: parsed<unknown>(row.dataset, null),
      result: parsed<EvaluateResult>(row.result, {
        collectionId: row.collection_id,
        total: 0,
        passed: 0,
        failed: 0,
        metrics: evaluationSummary(row).metrics,
        cases: [],
      }),
    }
  }

  async deleteEvaluation(id: string): Promise<boolean> {
    const result = await this.db.driver.run('DELETE FROM _vector_evaluation_runs WHERE id = ?', [id])
    return Number(result.changes) > 0
  }

  /**
   * The file a document was ingested from: its `filename` metadata, '' when it
   * came from text, or null when the document does not exist.
   */
  async documentSource(collectionId: string, documentId: string): Promise<string | null> {
    const row = await this.db.driver.get<{ metadata: string }>(
      'SELECT metadata FROM _vector_points WHERE collection_id = ? AND document_id = ? ORDER BY chunk_index, id LIMIT 1',
      [collectionId, documentId],
    )
    if (!row) return null
    const metadata = parsed<Record<string, unknown>>(row.metadata, {})
    return typeof metadata.filename === 'string' ? metadata.filename : ''
  }

  /** The collection's point-write counter, bumped by triggers from any process; 0 before the first write. */
  async vectorVersion(collectionId: string): Promise<number> {
    const row = await this.db.driver.get<{ value: number }>('SELECT value FROM _meta WHERE key = ?', [vectorVersionKey(collectionId)])
    return Number(row?.value) || 0
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
