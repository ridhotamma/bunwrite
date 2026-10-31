/**
 * Document reads and writes with Appwrite's permission rules.
 *
 * Everything goes through the driver port, so the store runs on SQLite and
 * Postgres. Transactions are explicit at the public boundary and implicit
 * inside: `AsyncLocalStorage` carries the current transaction, so a method
 * called from `runInTransaction` (or from `WriteBatcher`) automatically uses
 * the same connection without threading a `tx` argument through every helper.
 *
 * The list cache and the write batching still assume one process owns the
 * cache; that was already true for SQLite and is unchanged.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import type { Caller } from '~/auth/caller'
import { assertCallerScope } from '~/auth/caller'
import type { PermissionType } from '~/auth/permissions'
import { collectionVersionKey } from '~/cluster/versions'
import { q } from '~/db/connection'
import type { SqlDatabase, SqlExecutor, SqlTransaction } from '~/db/driver'
import { now } from '~/lib/datetime'
import { BunwriteError, err } from '~/lib/errors'
import type { Collection } from '~/schema/types'
import { assertBulkPermission, assertCreatePermission, assertRevision, assertUnchangedSince, canAccess } from './access'
import { decodeRow, type Doc, type SqlValue } from './codec'
import { DocumentListCache, MAX_CACHEABLE_LIMIT } from './list-cache'
import { compileCached, parseQueries, type Compiled, type Query } from './query'
import { countAllRows, countRows, readFilter, rowById, rowBySeq, selectRows, type Row } from './sql-read'
import { deleteRow, insertRow, updateRow, type SqlWriteContext } from './sql-write'

export { COUNT_LIMIT } from './sql-read'

/**
 * Set while committing a transaction: a write to a document changed after
 * `before` (and not already written by this transaction) is a conflict.
 */
export interface Guard {
  before: string
  touched: Set<string>
}

export { ConflictError } from './errors'

/** Thrown inside a rolled-back transaction to carry a value back out. */
class RollbackSignal extends Error {
  constructor(readonly value: unknown) {
    super('rollback')
  }
}

export interface WriteOptions {
  guard?: Guard
  /**
   * Optimistic concurrency: only write when the document is still at this
   * revision. `'*'` requires the document to exist. A mismatch throws
   * `document_update_conflict` (409) without touching the row.
   */
  revision?: number | '*'
  /**
   * Collect the events of this write here instead of the store-wide buffer.
   * Batched writes use a per-write sink so a request only publishes its own
   * events, even while other requests are in the same transaction.
   */
  events?: DocEvent[]
}

/** One write's outcome inside a batch: a failure rolls back only that write. */
export type BatchOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

/** A committed change, for realtime subscribers. */
export interface DocEvent {
  collection: Collection
  action: 'create' | 'update' | 'delete'
  document: Doc
}

export interface NewDocument {
  id: unknown
  data: Record<string, unknown>
  permissions: unknown
}

/**
 * The document operations the routes, the write batcher and the transaction
 * service use. `DocumentStore` implements it for SQL; `MongoDocumentStore`
 * implements it for MongoDB.
 */
export interface DocumentBackend {
  events: DocEvent[]
  drainEvents(): DocEvent[]
  beginStagedRead(): void
  endStagedRead(): void
  clearCaches(): void
  collectionVersion(collection: Collection): Promise<number>
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>
  preview<T>(fn: () => Promise<T>): Promise<T>
  runBatch<T>(operations: Array<() => Promise<T> | T>): Promise<Array<BatchOutcome<T>>>
  getDocument(caller: Caller, collection: Collection, id: string, rawQueries?: unknown[]): Promise<Doc>
  listDocuments(
    caller: Caller,
    collection: Collection,
    rawQueries: unknown[],
    includeTotal?: boolean,
    version?: number,
  ): Promise<{ total: number; documents: Doc[] }>
  countDocuments(caller: Caller, collection: Collection): Promise<number>
  createDocument(caller: Caller, collection: Collection, input: NewDocument, options?: WriteOptions): Promise<Doc>
  createDocumentInTx(caller: Caller, collection: Collection, input: NewDocument, options?: WriteOptions): Promise<Doc>
  createDocuments(caller: Caller, collection: Collection, documents: Record<string, unknown>[], options?: WriteOptions): Promise<Doc[]>
  updateDocument(caller: Caller, collection: Collection, id: string, data: Record<string, unknown>, permissions: unknown, options?: WriteOptions): Promise<Doc>
  updateDocumentInTx(
    caller: Caller,
    collection: Collection,
    id: string,
    data: Record<string, unknown>,
    permissions: unknown,
    options?: WriteOptions,
  ): Promise<Doc>
  upsertDocument(
    caller: Caller,
    collection: Collection,
    id: string,
    data: Record<string, unknown>,
    permissions: unknown,
    options?: WriteOptions,
  ): Promise<{ doc: Doc; created: boolean }>
  upsertDocumentInTx(
    caller: Caller,
    collection: Collection,
    id: string,
    data: Record<string, unknown>,
    permissions: unknown,
    options?: WriteOptions,
  ): Promise<{ doc: Doc; created: boolean }>
  upsertDocuments(caller: Caller, collection: Collection, documents: Record<string, unknown>[], options?: WriteOptions): Promise<Doc[]>
  deleteDocument(caller: Caller, collection: Collection, id: string, options?: WriteOptions): Promise<Doc>
  deleteDocumentInTx(caller: Caller, collection: Collection, id: string, options?: WriteOptions): Promise<Doc>
  incrementAttribute(
    caller: Caller,
    collection: Collection,
    id: string,
    key: string,
    by: number,
    bound: number | null,
    direction: 1 | -1,
    options?: WriteOptions,
  ): Promise<Doc>
  incrementAttributeInTx(
    caller: Caller,
    collection: Collection,
    id: string,
    key: string,
    by: number,
    bound: number | null,
    direction: 1 | -1,
    options?: WriteOptions,
  ): Promise<Doc>
  updateDocuments(caller: Caller, collection: Collection, data: Record<string, unknown>, rawQueries: unknown[], options?: WriteOptions): Promise<Doc[]>
  deleteDocuments(caller: Caller, collection: Collection, rawQueries: unknown[], options?: WriteOptions): Promise<Doc[]>
  checkStagedWrite(caller: Caller, collection: Collection, id: string, type: PermissionType): Promise<Doc | null>
}

export class DocumentStore implements DocumentBackend {
  /** Changes made by the current request; the app publishes them once it succeeds. */
  events: DocEvent[] = []

  private readonly lists = new DocumentListCache()
  private stagedReads = 0
  /** The transaction this async call belongs to, if any. */
  private readonly context = new AsyncLocalStorage<SqlTransaction>()

  constructor(private db: SqlDatabase) {}

  /** The current transaction, or the pool for a plain statement. */
  private exec(): SqlExecutor {
    return this.context.getStore() ?? this.db.driver
  }

  /**
   * SQLite on macOS uses the system build (3.39), which fails inside a
   * transaction when an FTS trigger fires, so it keeps the insert-then-read
   * fallback. Postgres always supports RETURNING.
   */
  private get returning(): boolean {
    return this.db.dialect === 'postgres' || process.platform === 'linux'
  }

  private get writeContext(): SqlWriteContext {
    return {
      exec: () => this.exec(),
      returning: this.returning,
      rowBySeq: (collection, seq) => this.rowBySeq(collection, seq),
      record: (collection, action, row, options) => this.record(collection, action, row, options),
      touch: (collection, id, options) => this.touch(collection, id, options),
    }
  }

  drainEvents(): DocEvent[] {
    const events = this.events
    this.events = []
    return events
  }

  /** A transaction's staged writes must not populate or read the list cache. */
  beginStagedRead(): void {
    this.stagedReads++
  }

  endStagedRead(): void {
    if (this.stagedReads > 0) this.stagedReads--
  }

  /** Drop cached list results; used after the database file is replaced. */
  clearCaches(): void {
    this.lists.clear()
  }

  /**
   * Run `fn` atomically. Reuses an enclosing transaction so callers can compose
   * `...InTx` methods, `WriteBatcher` and transaction commits freely.
   */
  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return fn()
    return this.db.driver.transaction(async (tx) => this.context.run(tx, fn))
  }

  /**
   * Run `fn` with the transaction's staged writes visible, then roll the work
   * back. Used by reads that carry a `transactionId`.
   */
  async preview<T>(fn: () => Promise<T>): Promise<T> {
    const body = async () => {
      const value = await fn()
      throw new RollbackSignal(value)
    }
    const current = this.context.getStore()
    try {
      if (current) {
        return await current.savepoint('bunwrite_preview', async () => this.context.run(current, body))
      }
      return await this.db.driver.transaction(async (tx) => this.context.run(tx, body))
    } catch (error) {
      if (error instanceof RollbackSignal) return error.value as T
      throw error
    }
  }

  /** Bumped by the document table's triggers on every insert, update or delete. */
  async collectionVersion(collection: Collection): Promise<number> {
    const row = await this.exec().get<{ value: number }>('SELECT value FROM _meta WHERE key = ?', [collectionVersionKey(collection.databaseId, collection.id)])
    return Number(row?.value ?? 0)
  }

  private record(collection: Collection, action: DocEvent['action'], row: Row, options: WriteOptions = {}): void {
    if (!collection.databaseId) return // users/teams views never emit
    const sink = options.events ?? this.events
    sink.push({ collection, action, document: decodeRow(collection, row) })
  }

  // ---------------------------------------------------------------- reads

  private row(collection: Collection, id: string): Promise<Row | null> {
    return rowById(this.exec(), collection, id)
  }

  private rowBySeq(collection: Collection, seq: number): Promise<Row> {
    return rowBySeq(this.exec(), collection, seq)
  }

  private can(caller: Caller, collection: Collection, row: Row, type: PermissionType): boolean {
    return canAccess(caller, collection, JSON.parse(row._permissions) as string[], type)
  }

  async getDocument(caller: Caller, collection: Collection, id: string, rawQueries: unknown[] = []): Promise<Doc> {
    assertCallerScope(caller, 'documents.read')
    const compiled = compileCached(collection, rawQueries, this.db.dialect)
    if (compiled.where.length || compiled.orders.length || compiled.cursor) {
      throw err('general_query_invalid', 'Invalid query: Only select queries are allowed when getting a document.')
    }
    const params: SqlValue[] = [id]
    const filter = readFilter(caller, collection, params)
    const row = await this.exec().get<Row>(`SELECT * FROM ${q(collection.table)} t WHERE t._id = ?${filter ? ` AND ${filter}` : ''}`, params)
    if (!row) throw err('document_not_found', undefined, [id])
    return decodeRow(collection, row, compiled.select)
  }

  async listDocuments(
    caller: Caller,
    collection: Collection,
    rawQueries: unknown[],
    includeTotal = true,
    version?: number,
  ): Promise<{ total: number; documents: Doc[] }> {
    assertCallerScope(caller, 'documents.read')
    const compiled = compileCached(collection, rawQueries, this.db.dialect)
    // Views (users, teams, memberships, files, executions) have no write
    // triggers, so their lists must not be cached. Random pages differ every
    // time, and a large page is not worth keeping.
    if (this.stagedReads > 0 || !collection.databaseId || compiled.random || compiled.limit > MAX_CACHEABLE_LIMIT) {
      return this.listWith(caller, collection, compiled, includeTotal)
    }
    const stamp = `${version ?? (await this.collectionVersion(collection))}:${collection.updatedAt}`
    this.lists.purge(collection.table, stamp)
    const key = `${collection.table}\u0000${stamp}\u0000${caller.privileged ? '*' : [...caller.roles].sort().join(',')}\u0000${includeTotal ? 1 : 0}\u0000${JSON.stringify(rawQueries)}`
    const hit = this.lists.get(key)
    if (hit) return { total: hit.total, documents: hit.documents }
    const result = await this.listWith(caller, collection, compiled, includeTotal)
    this.lists.remember(key, result)
    return result
  }

  private async listWith(caller: Caller, collection: Collection, compiled: Compiled, includeTotal: boolean): Promise<{ total: number; documents: Doc[] }> {
    const rows = await selectRows(this.exec(), (c, id) => this.row(c, id), caller, collection, compiled)
    return {
      total: includeTotal ? await countRows(this.exec(), caller, collection, compiled) : 0,
      documents: rows.map((r) => decodeRow(collection, r, compiled.select)),
    }
  }

  /** All documents in a collection the caller may read, without the list cap. */
  async countDocuments(caller: Caller, collection: Collection): Promise<number> {
    assertCallerScope(caller, 'documents.read')
    return countAllRows(this.exec(), caller, collection)
  }

  // ---------------------------------------------------------------- write helpers

  private touch(collection: Collection, id: string, options: WriteOptions): void {
    options.guard?.touched.add(`${collection.table}/${id}`)
  }

  private async requireRow(caller: Caller, collection: Collection, id: string, type: PermissionType): Promise<Row> {
    const row = await this.row(collection, id)
    if (!row) throw err('document_not_found', undefined, [id])
    if (!this.can(caller, collection, row, type)) {
      // Hide documents the caller cannot even read.
      if (!this.can(caller, collection, row, 'read')) throw err('document_not_found', undefined, [id])
      throw err('user_unauthorized')
    }
    return row
  }

  /**
   * Run independent writes in one transaction. Every operation gets a
   * savepoint, so a failing write rolls back only itself and the rest still
   * commit. Operations must use the `...InTx` methods; they must not open
   * their own transaction.
   */
  async runBatch<T>(operations: Array<() => Promise<T> | T>): Promise<Array<BatchOutcome<T>>> {
    if (operations.length === 0) return []
    return this.runInTransaction(async () => {
      const tx = this.context.getStore()!
      const outcomes: Array<BatchOutcome<T>> = []
      for (let index = 0; index < operations.length; index++) {
        try {
          const value = await tx.savepoint(`bunwrite_batch_${index}`, async () => operations[index]!())
          outcomes.push({ ok: true, value })
        } catch (error) {
          outcomes.push({ ok: false, error })
        }
      }
      return outcomes
    })
  }

  // ---------------------------------------------------------------- writes

  async createDocument(caller: Caller, collection: Collection, input: NewDocument, options: WriteOptions = {}): Promise<Doc> {
    assertCallerScope(caller, 'documents.write')
    return this.runInTransaction(async () => this.createDocumentInTx(caller, collection, input, options))
  }

  /** `createDocument` without its own transaction; for `runBatch` and staged writes. */
  async createDocumentInTx(caller: Caller, collection: Collection, input: NewDocument, options: WriteOptions = {}): Promise<Doc> {
    assertCallerScope(caller, 'documents.write')
    assertCreatePermission(caller, collection)
    return decodeRow(collection, await insertRow(this.writeContext, caller, collection, input, options))
  }

  async createDocuments(caller: Caller, collection: Collection, documents: Record<string, unknown>[], options: WriteOptions = {}): Promise<Doc[]> {
    assertCallerScope(caller, 'documents.write')
    assertBulkPermission(caller)
    return this.runInTransaction(async () => {
      const created: Doc[] = []
      for (const d of documents) {
        const { $id, $permissions, ...data } = d
        created.push(
          decodeRow(
            collection,
            await insertRow(
              this.writeContext,
              caller,
              collection,
              { id: $id ?? 'unique()', data: { ...data, $createdAt: d.$createdAt, $updatedAt: d.$updatedAt }, permissions: $permissions ?? null },
              options,
            ),
          ),
        )
      }
      return created
    })
  }

  async updateDocument(
    caller: Caller,
    collection: Collection,
    id: string,
    data: Record<string, unknown>,
    permissions: unknown,
    options: WriteOptions = {},
  ): Promise<Doc> {
    assertCallerScope(caller, 'documents.write')
    return this.runInTransaction(async () => this.updateDocumentInTx(caller, collection, id, data, permissions, options))
  }

  /** `updateDocument` without its own transaction; for `runBatch` and staged writes. */
  async updateDocumentInTx(
    caller: Caller,
    collection: Collection,
    id: string,
    data: Record<string, unknown>,
    permissions: unknown,
    options: WriteOptions = {},
  ): Promise<Doc> {
    assertCallerScope(caller, 'documents.write')
    if (Object.keys(data ?? {}).length === 0 && (permissions === null || permissions === undefined)) {
      throw err('document_missing_payload')
    }
    const row = await this.requireRow(caller, collection, id, 'update')
    return decodeRow(collection, await updateRow(this.writeContext, caller, collection, row, data ?? {}, permissions, options))
  }

  async upsertDocument(
    caller: Caller,
    collection: Collection,
    id: string,
    data: Record<string, unknown>,
    permissions: unknown,
    options: WriteOptions = {},
  ): Promise<{ doc: Doc; created: boolean }> {
    assertCallerScope(caller, 'documents.write')
    return this.runInTransaction(async () => this.upsertDocumentInTx(caller, collection, id, data, permissions, options))
  }

  /** `upsertDocument` without its own transaction; for `runBatch` and staged writes. */
  async upsertDocumentInTx(
    caller: Caller,
    collection: Collection,
    id: string,
    data: Record<string, unknown>,
    permissions: unknown,
    options: WriteOptions = {},
  ): Promise<{ doc: Doc; created: boolean }> {
    assertCallerScope(caller, 'documents.write')
    const row = await this.row(collection, id)
    if (row) {
      if (!this.can(caller, collection, row, 'update')) throw err('user_unauthorized')
      return { doc: decodeRow(collection, await updateRow(this.writeContext, caller, collection, row, data ?? {}, permissions, options)), created: false }
    }
    if (options.revision !== undefined) {
      throw err('document_update_conflict', `Document '${id}' does not exist, but the request requires an existing revision.`)
    }
    assertCreatePermission(caller, collection)
    return { doc: decodeRow(collection, await insertRow(this.writeContext, caller, collection, { id, data: data ?? {}, permissions }, options)), created: true }
  }

  async upsertDocuments(caller: Caller, collection: Collection, documents: Record<string, unknown>[], options: WriteOptions = {}): Promise<Doc[]> {
    assertCallerScope(caller, 'documents.write')
    assertBulkPermission(caller)
    return this.runInTransaction(async () => {
      const result: Doc[] = []
      for (const d of documents) {
        const { $id, $permissions, ...data } = d
        if (typeof $id !== 'string' || !$id) {
          result.push(
            decodeRow(collection, await insertRow(this.writeContext, caller, collection, { id: 'unique()', data, permissions: $permissions ?? null }, options)),
          )
          continue
        }
        const row = await this.row(collection, $id)
        result.push(
          row
            ? decodeRow(collection, await updateRow(this.writeContext, caller, collection, row, data, $permissions ?? null, options))
            : decodeRow(collection, await insertRow(this.writeContext, caller, collection, { id: $id, data, permissions: $permissions ?? null }, options)),
        )
      }
      return result
    })
  }

  async deleteDocument(caller: Caller, collection: Collection, id: string, options: WriteOptions = {}): Promise<Doc> {
    assertCallerScope(caller, 'documents.write')
    return this.runInTransaction(async () => this.deleteDocumentInTx(caller, collection, id, options))
  }

  /** `deleteDocument` without its own transaction; for `runBatch` and staged writes. */
  async deleteDocumentInTx(caller: Caller, collection: Collection, id: string, options: WriteOptions = {}): Promise<Doc> {
    assertCallerScope(caller, 'documents.write')
    const row = await this.requireRow(caller, collection, id, 'delete')
    await deleteRow(this.writeContext, collection, row, options)
    return decodeRow(collection, row)
  }

  async incrementAttribute(
    caller: Caller,
    collection: Collection,
    id: string,
    key: string,
    by: number,
    bound: number | null,
    direction: 1 | -1,
    options: WriteOptions = {},
  ): Promise<Doc> {
    return this.runInTransaction(() => this.incrementAttributeInTx(caller, collection, id, key, by, bound, direction, options))
  }

  /** `incrementAttribute` without its own transaction; for `runBatch` and staged writes. */
  async incrementAttributeInTx(
    caller: Caller,
    collection: Collection,
    id: string,
    key: string,
    by: number,
    bound: number | null,
    direction: 1 | -1,
    options: WriteOptions = {},
  ): Promise<Doc> {
    assertCallerScope(caller, 'documents.write')
    const a = collection.attributeMap.get(key)
    if (!a) throw err('attribute_not_found', undefined, [key])
    if ((a.type !== 'integer' && a.type !== 'double') || a.array) {
      throw err('attribute_type_invalid', `Attribute "${key}" must be an integer or float.`)
    }
    if (typeof by !== 'number' || !Number.isFinite(by) || by <= 0) {
      throw err('general_argument_invalid', 'Invalid `value` param: Value must be a number greater than 0.')
    }
    const row = await this.requireRow(caller, collection, id, 'update')
    if (options.guard) assertUnchangedSince(collection, row._id, row._updatedAt, options.guard.touched, options.guard.before)
    assertRevision(row._id, Number(row._rev ?? 1), options.revision)
    const current = (row[key] as number | null) ?? 0
    const next = current + direction * by
    if (bound !== null && bound !== undefined && (direction === 1 ? next > bound : next < bound)) {
      throw err(
        'attribute_limit_exceeded',
        direction === 1 ? `Attribute value exceeds maximum limit: ${bound}` : `Attribute value exceeds minimum limit: ${bound}`,
      )
    }
    const stamp = now()
    const sql = `UPDATE ${q(collection.table)} SET ${q(key)} = ?, ${q('_updatedAt')} = ?, ${q('_rev')} = ${q('_rev')} + 1 WHERE _seq = ?`
    let updated: Row
    if (this.returning) {
      updated = (await this.exec().get<Row>(`${sql} RETURNING *`, [next, stamp, row._seq]))!
    } else {
      await this.exec().run(sql, [next, stamp, row._seq])
      updated = await this.rowBySeq(collection, row._seq)
    }
    this.touch(collection, id, options)
    this.record(collection, 'update', updated, options)
    return decodeRow(collection, updated)
  }

  /** Rows a bulk operation applies to: the filters and limit, ignoring select. */
  private async bulkRows(caller: Caller, collection: Collection, rawQueries: unknown[]): Promise<Row[]> {
    const queries: Query[] = parseQueries(rawQueries)
    const compiled = compileCached(collection, rawQueries, this.db.dialect)
    // Compiled queries are shared; copy before replacing the limit.
    const effective = queries.some((query) => query.method === 'limit') ? compiled : { ...compiled, limit: Number.MAX_SAFE_INTEGER }
    return selectRows(this.exec(), (c, id) => this.row(c, id), caller, collection, effective)
  }

  async updateDocuments(
    caller: Caller,
    collection: Collection,
    data: Record<string, unknown>,
    rawQueries: unknown[],
    options: WriteOptions = {},
  ): Promise<Doc[]> {
    assertCallerScope(caller, 'documents.write')
    assertBulkPermission(caller)
    const { $permissions, ...rest } = data ?? {}
    return this.runInTransaction(async () => {
      const rows = await this.bulkRows(caller, collection, rawQueries)
      const updated: Doc[] = []
      for (const row of rows)
        updated.push(decodeRow(collection, await updateRow(this.writeContext, caller, collection, row, rest, $permissions ?? null, options)))
      return updated
    })
  }

  async deleteDocuments(caller: Caller, collection: Collection, rawQueries: unknown[], options: WriteOptions = {}): Promise<Doc[]> {
    assertCallerScope(caller, 'documents.write')
    assertBulkPermission(caller)
    return this.runInTransaction(async () => {
      const rows = await this.bulkRows(caller, collection, rawQueries)
      const deleted: Doc[] = []
      for (const row of rows) {
        await deleteRow(this.writeContext, collection, row, options)
        deleted.push(decodeRow(collection, row))
      }
      return deleted
    })
  }

  /** Read-only existence and permission check used when staging transaction writes. */
  async checkStagedWrite(caller: Caller, collection: Collection, id: string, type: PermissionType): Promise<Doc | null> {
    assertCallerScope(caller, type === 'read' ? 'documents.read' : 'documents.write')
    const row = await this.row(collection, id)
    if (!row) return null
    if (!this.can(caller, collection, row, type)) {
      if (!this.can(caller, collection, row, 'read')) throw err('document_not_found', undefined, [id])
      throw err('user_unauthorized')
    }
    return decodeRow(collection, row)
  }
}

export const isBunwriteError = (e: unknown): e is BunwriteError => e instanceof BunwriteError
