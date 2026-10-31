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
import { aggregatePermissions, grants, parsePermission, type PermissionType } from '~/auth/permissions'
import { collectionVersionKey } from '~/cluster/versions'
import { q } from '~/db/connection'
import type { SqlDatabase, SqlExecutor, SqlTransaction } from '~/db/driver'
import { uniqueViolation } from '~/db/driver'
import { normalizeDate, now } from '~/lib/datetime'
import { BunwriteError, err, invalidStructure } from '~/lib/errors'
import { resolveId } from '~/lib/ids'
import type { Collection } from '~/schema/types'
import { decodeRow, encodeAttributes, type Doc, type SqlValue } from './codec'
import { compileCached, cursorCondition, orderExpr, parseQueries, type Compiled, type Query } from './query'

/** Appwrite caps `total` at this many matches. */
export const COUNT_LIMIT = 5000

/** List results are cached per worker; these caps keep a few hot pages, not a second database. */
const LIST_CACHE_ENTRIES = 200
const LIST_CACHE_DOCS = 5000
const LIST_CACHE_MAX_LIMIT = 200

type Row = Record<string, unknown> & { _seq: number; _id: string; _updatedAt: string; _permissions: string; _rev: number }

/**
 * Set while committing a transaction: a write to a document changed after
 * `before` (and not already written by this transaction) is a conflict.
 */
export interface Guard {
  before: string
  touched: Set<string>
}

export class ConflictError extends Error {}

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
  listDocuments(caller: Caller, collection: Collection, rawQueries: unknown[], includeTotal?: boolean, version?: number): Promise<{ total: number; documents: Doc[] }>
  countDocuments(caller: Caller, collection: Collection): Promise<number>
  createDocument(caller: Caller, collection: Collection, input: NewDocument, options?: WriteOptions): Promise<Doc>
  createDocumentInTx(caller: Caller, collection: Collection, input: NewDocument, options?: WriteOptions): Promise<Doc>
  createDocuments(caller: Caller, collection: Collection, documents: Record<string, unknown>[], options?: WriteOptions): Promise<Doc[]>
  updateDocument(caller: Caller, collection: Collection, id: string, data: Record<string, unknown>, permissions: unknown, options?: WriteOptions): Promise<Doc>
  updateDocumentInTx(caller: Caller, collection: Collection, id: string, data: Record<string, unknown>, permissions: unknown, options?: WriteOptions): Promise<Doc>
  upsertDocument(caller: Caller, collection: Collection, id: string, data: Record<string, unknown>, permissions: unknown, options?: WriteOptions): Promise<{ doc: Doc; created: boolean }>
  upsertDocumentInTx(caller: Caller, collection: Collection, id: string, data: Record<string, unknown>, permissions: unknown, options?: WriteOptions): Promise<{ doc: Doc; created: boolean }>
  upsertDocuments(caller: Caller, collection: Collection, documents: Record<string, unknown>[], options?: WriteOptions): Promise<Doc[]>
  deleteDocument(caller: Caller, collection: Collection, id: string, options?: WriteOptions): Promise<Doc>
  deleteDocumentInTx(caller: Caller, collection: Collection, id: string, options?: WriteOptions): Promise<Doc>
  incrementAttribute(caller: Caller, collection: Collection, id: string, key: string, by: number, bound: number | null, direction: 1 | -1, options?: WriteOptions): Promise<Doc>
  incrementAttributeInTx(caller: Caller, collection: Collection, id: string, key: string, by: number, bound: number | null, direction: 1 | -1, options?: WriteOptions): Promise<Doc>
  updateDocuments(caller: Caller, collection: Collection, data: Record<string, unknown>, rawQueries: unknown[], options?: WriteOptions): Promise<Doc[]>
  deleteDocuments(caller: Caller, collection: Collection, rawQueries: unknown[], options?: WriteOptions): Promise<Doc[]>
  checkStagedWrite(caller: Caller, collection: Collection, id: string, type: PermissionType): Promise<Doc | null>
}

export class DocumentStore implements DocumentBackend {
  /** Changes made by the current request; the app publishes them once it succeeds. */
  events: DocEvent[] = []

  private readonly listCache = new Map<string, { total: number; documents: Doc[] }>()
  private cachedDocs = 0
  private stagedReads = 0
  private readonly listVersions = new Map<string, string>()
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
    this.listCache.clear()
    this.listVersions.clear()
    this.cachedDocs = 0
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
    const row = await this.exec().get<{ value: number }>('SELECT value FROM _meta WHERE key = ?', [
      collectionVersionKey(collection.databaseId, collection.id),
    ])
    return Number(row?.value ?? 0)
  }

  private record(collection: Collection, action: DocEvent['action'], row: Row, options: WriteOptions = {}): void {
    if (!collection.databaseId) return // users/teams views never emit
    const sink = options.events ?? this.events
    sink.push({ collection, action, document: decodeRow(collection, row) })
  }

  // ---------------------------------------------------------------- reads

  /** SQL condition limiting rows to what the caller may read, or null for all rows. */
  private readFilter(caller: Caller, collection: Collection, params: SqlValue[]): string | null {
    if (caller.privileged || grants(collection.permissions, 'read', caller.roles)) return null
    if (!collection.documentSecurity) throw err('user_unauthorized')
    const roles = [...caller.roles]
    params.push(...roles)
    return `t._seq IN (SELECT doc FROM ${q(collection.permsTable)} WHERE type = 'read' AND role IN (${roles.map(() => '?').join(', ')}))`
  }

  private async row(collection: Collection, id: string): Promise<Row | null> {
    return this.exec().get<Row>(`SELECT * FROM ${q(collection.table)} WHERE _id = ?`, [id])
  }

  private async rowBySeq(collection: Collection, seq: number): Promise<Row> {
    return (await this.exec().get<Row>(`SELECT * FROM ${q(collection.table)} WHERE _seq = ?`, [seq]))!
  }

  private can(caller: Caller, collection: Collection, row: Row, type: PermissionType): boolean {
    if (caller.privileged || grants(collection.permissions, type, caller.roles)) return true
    return collection.documentSecurity && grants(JSON.parse(row._permissions), type, caller.roles)
  }

  async getDocument(caller: Caller, collection: Collection, id: string, rawQueries: unknown[] = []): Promise<Doc> {
    assertCallerScope(caller, 'documents.read')
    const compiled = compileCached(collection, rawQueries, this.db.dialect)
    if (compiled.where.length || compiled.orders.length || compiled.cursor) {
      throw err('general_query_invalid', 'Invalid query: Only select queries are allowed when getting a document.')
    }
    const params: SqlValue[] = [id]
    const filter = this.readFilter(caller, collection, params)
    const row = await this.exec().get<Row>(`SELECT * FROM ${q(collection.table)} t WHERE t._id = ?${filter ? ` AND ${filter}` : ''}`, params)
    if (!row) throw err('document_not_found', undefined, [id])
    return decodeRow(collection, row, compiled.select)
  }

  /** Matching rows for `compiled`, honouring cursor, order, limit and offset. */
  private async select(caller: Caller, collection: Collection, compiled: Compiled): Promise<Row[]> {
    const params: SqlValue[] = []
    const where = [...compiled.where]
    params.push(...compiled.params)
    const filter = this.readFilter(caller, collection, params)
    if (filter) where.push(filter)

    const orders = [...compiled.orders]
    if (!orders.some((o) => o.column === '_seq' || o.column === '_id')) {
      orders.push({ column: '_seq', desc: false })
    }
    const effective = compiled.cursor?.before ? orders.map((o) => ({ ...o, desc: !o.desc })) : orders

    if (compiled.cursor) {
      const cursorRow = await this.row(collection, compiled.cursor.id)
      if (!cursorRow) {
        throw err('general_cursor_not_found', `Document '${compiled.cursor.id}' for the 'cursor' value not found.`)
      }
      where.push(cursorCondition(effective, cursorRow, params))
    }

    const orderSql = compiled.random
      ? 'random()'
      : effective.map((o) => `${orderExpr(o)} ${o.desc ? 'DESC' : 'ASC'}`).join(', ')
    const sql =
      `SELECT t.* FROM ${q(collection.table)} t` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY ${orderSql} LIMIT ? OFFSET ?`
    params.push(compiled.limit, compiled.offset)
    const rows = await this.exec().all<Row>(sql, params)
    return compiled.cursor?.before ? rows.reverse() : rows
  }

  private async count(caller: Caller, collection: Collection, compiled: Compiled): Promise<number> {
    const params: SqlValue[] = [...compiled.params]
    const where = [...compiled.where]
    const filter = this.readFilter(caller, collection, params)
    if (filter) where.push(filter)
    const sql =
      `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${q(collection.table)} t` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` LIMIT ${COUNT_LIMIT}) AS limited`
    const row = await this.exec().get<{ n: number }>(sql, params)
    return Number(row?.n ?? 0)
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
    if (this.stagedReads > 0 || !collection.databaseId || compiled.random || compiled.limit > LIST_CACHE_MAX_LIMIT) {
      return this.listWith(caller, collection, compiled, includeTotal)
    }
    const stamp = `${version ?? (await this.collectionVersion(collection))}:${collection.updatedAt}`
    this.purgeListCache(collection.table, stamp)
    const key = `${collection.table}\u0000${stamp}\u0000${caller.privileged ? '*' : [...caller.roles].sort().join(',')}\u0000${includeTotal ? 1 : 0}\u0000${JSON.stringify(rawQueries)}`
    const hit = this.listCache.get(key)
    if (hit) {
      // Refresh LRU position. Callers treat the returned documents as read-only.
      this.listCache.delete(key)
      this.listCache.set(key, hit)
      return { total: hit.total, documents: hit.documents }
    }
    const result = await this.listWith(caller, collection, compiled, includeTotal)
    this.rememberList(key, result)
    return result
  }

  private async listWith(
    caller: Caller,
    collection: Collection,
    compiled: Compiled,
    includeTotal: boolean,
  ): Promise<{ total: number; documents: Doc[] }> {
    const rows = await this.select(caller, collection, compiled)
    return {
      total: includeTotal ? await this.count(caller, collection, compiled) : 0,
      documents: rows.map((r) => decodeRow(collection, r, compiled.select)),
    }
  }

  /** A document write, or a schema/permission change, makes this collection's pages stale. */
  private purgeListCache(table: string, version: string): void {
    const before = this.listVersions.get(table)
    if (before === version) return
    this.listVersions.set(table, version)
    if (before === undefined) return
    const prefix = `${table}\u0000`
    for (const [key, value] of [...this.listCache]) {
      if (!key.startsWith(prefix)) continue
      this.cachedDocs -= value.documents.length
      this.listCache.delete(key)
    }
  }

  private rememberList(key: string, result: { total: number; documents: Doc[] }): void {
    this.listCache.set(key, result)
    this.cachedDocs += result.documents.length
    while (this.listCache.size > LIST_CACHE_ENTRIES || this.cachedDocs > LIST_CACHE_DOCS) {
      const oldest = this.listCache.keys().next().value
      if (!oldest) break
      this.cachedDocs -= this.listCache.get(oldest)!.documents.length
      this.listCache.delete(oldest)
    }
  }

  /** All documents in a collection the caller may read, without the list cap. */
  async countDocuments(caller: Caller, collection: Collection): Promise<number> {
    assertCallerScope(caller, 'documents.read')
    const params: SqlValue[] = []
    const filter = this.readFilter(caller, collection, params)
    const sql = `SELECT count(*) AS n FROM ${q(collection.table)} t${filter ? ` WHERE ${filter}` : ''}`
    const row = await this.exec().get<{ n: number }>(sql, params)
    return Number(row?.n ?? 0)
  }

  // ---------------------------------------------------------------- write helpers

  /** Resolve the permissions a write will store, enforcing who may grant what. */
  private resolvePermissions(caller: Caller, permissions: unknown, fallback: string[] | null): string[] | null {
    const aggregated = aggregatePermissions(permissions)
    if (aggregated === null) return fallback
    if (!caller.privileged) {
      for (const p of aggregated) {
        const { role } = parsePermission(p)
        if (!caller.roles.has(role)) {
          throw err('user_unauthorized', `Permissions must be one of: (${[...caller.roles].join(', ')})`)
        }
      }
    }
    return aggregated
  }

  private defaultPermissions(caller: Caller): string[] {
    if (caller.privileged || !caller.user) return []
    const id = caller.user.id
    return [`read("user:${id}")`, `update("user:${id}")`, `delete("user:${id}")`]
  }

  /** `$createdAt` / `$updatedAt` may be set by API keys only; others are ignored. */
  private dates(caller: Caller, data: Record<string, unknown>, key: '$createdAt' | '$updatedAt', fallback: string): string {
    const value = data[key]
    if (!caller.privileged || value === undefined || value === null) return fallback
    const date = normalizeDate(value)
    if (!date) throw invalidStructure(`Attribute "${key}" has invalid format. Value must be valid date between 0000-01-01 and 9999-12-31.`)
    return date
  }

  private async writePerms(collection: Collection, seq: number, permissions: string[]): Promise<void> {
    const exec = this.exec()
    await exec.run(`DELETE FROM ${q(collection.permsTable)} WHERE doc = ?`, [seq])
    for (const p of permissions) {
      const { type, role } = parsePermission(p)
      await exec.run(`INSERT OR IGNORE INTO ${q(collection.permsTable)} (doc, type, role) VALUES (?, ?, ?)`, [seq, type, role])
    }
  }

  private guardCheck(collection: Collection, row: Row, options: WriteOptions): void {
    const guard = options.guard
    if (!guard) return
    const key = `${collection.table}/${row._id}`
    if (!guard.touched.has(key) && row._updatedAt > guard.before) {
      throw new ConflictError('Document was updated after the transaction operation')
    }
  }

  /**
   * Enforce `If-Match` / `data.$revision` inside the write transaction, so two
   * concurrent updates at the same revision cannot both pass. `'*'` only
   * asserts that the row exists, which the callers already know.
   */
  private revisionCheck(row: Row, options: WriteOptions): void {
    const expected = options.revision
    if (expected === undefined || expected === '*') return
    const current = Number(row._rev ?? 1)
    if (current !== expected) {
      throw err(
        'document_update_conflict',
        `Document '${row._id}' is at revision ${current}, not ${expected}. Fetch it again and retry.`,
      )
    }
  }

  private touch(collection: Collection, id: string, options: WriteOptions): void {
    options.guard?.touched.add(`${collection.table}/${id}`)
  }

  private uniqueError(error: unknown, collection: Collection, id: string): unknown {
    const violation = uniqueViolation(error)
    if (!violation) return error
    const constraint = violation.constraint ?? ''
    const onId =
      constraint === `${collection.table}__id_key` ||
      constraint.endsWith('__id_key') ||
      /(?:^|[.\s:])_id$/.test(constraint) ||
      (error instanceof Error && error.message.includes(`${collection.table}._id`))
    return onId ? err('document_already_exists', undefined, [id]) : err('document_unique_constraint_violation')
  }

  private async insertRow(caller: Caller, collection: Collection, input: NewDocument, options: WriteOptions): Promise<Row> {
    const id = resolveId(input.id, 'Document ID')
    const data = input.data ?? {}
    const permissions = this.resolvePermissions(caller, input.permissions, this.defaultPermissions(caller))!
    const stamp = now()
    const values = encodeAttributes(collection, data, 'create')
    const keys = Object.keys(values)
    const columns = ['_id', '_createdAt', '_updatedAt', '_permissions', '_rev', ...keys]
    const params: SqlValue[] = [
      id,
      this.dates(caller, data, '$createdAt', stamp),
      this.dates(caller, data, '$updatedAt', stamp),
      JSON.stringify(permissions),
      1,
      ...keys.map((k) => values[k]!),
    ]
    let row: Row
    try {
      const sql = `INSERT INTO ${q(collection.table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      if (this.returning) {
        row = (await this.exec().get<Row>(`${sql} RETURNING *`, params))!
      } else {
        const result = await this.exec().run(sql, params)
        row = await this.rowBySeq(collection, Number(result.lastInsertId))
      }
    } catch (error) {
      if (options.guard && uniqueViolation(error)) throw new ConflictError(error instanceof Error ? error.message : String(error))
      throw this.uniqueError(error, collection, id)
    }
    await this.writePerms(collection, row._seq, permissions)
    this.touch(collection, id, options)
    this.record(collection, 'create', row, options)
    return row
  }

  private assertCreate(caller: Caller, collection: Collection): void {
    if (!caller.privileged && !grants(collection.permissions, 'create', caller.roles)) throw err('user_unauthorized')
  }

  /** Update an existing row in place. Skips the write when nothing changes, like Appwrite. */
  private async updateRow(
    caller: Caller,
    collection: Collection,
    row: Row,
    data: Record<string, unknown>,
    permissions: unknown,
    options: WriteOptions,
  ): Promise<Row> {
    this.guardCheck(collection, row, options)
    this.revisionCheck(row, options)
    const values = encodeAttributes(collection, data, 'update')
    const oldPermissions = JSON.parse(row._permissions) as string[]
    const newPermissions = this.resolvePermissions(caller, permissions, null)
    const changes: Record<string, SqlValue> = {}
    for (const [k, v] of Object.entries(values)) if (row[k] !== v) changes[k] = v
    const permsChanged = newPermissions !== null && JSON.stringify(newPermissions) !== JSON.stringify(oldPermissions)
    const createdAt = this.dates(caller, data, '$createdAt', row._createdAt as string)
    if (createdAt !== row._createdAt) changes._createdAt = createdAt
    const explicitUpdatedAt = caller.privileged && data.$updatedAt != null

    if (Object.keys(changes).length === 0 && !permsChanged && !explicitUpdatedAt) {
      this.touch(collection, row._id, options)
      return row
    }
    changes._updatedAt = this.dates(caller, data, '$updatedAt', now())
    if (permsChanged) changes._permissions = JSON.stringify(newPermissions)
    const keys = Object.keys(changes)
    const params: SqlValue[] = [...keys.map((k) => changes[k]!), row._seq]
    const sql = `UPDATE ${q(collection.table)} SET ${keys.map((k) => `${q(k)} = ?`).join(', ')}, ${q('_rev')} = ${q('_rev')} + 1 WHERE _seq = ?`
    let updated: Row
    try {
      if (this.returning) {
        updated = (await this.exec().get<Row>(`${sql} RETURNING *`, params))!
      } else {
        await this.exec().run(sql, params)
        updated = await this.rowBySeq(collection, row._seq)
      }
    } catch (error) {
      if (options.guard && uniqueViolation(error)) throw new ConflictError(error instanceof Error ? error.message : String(error))
      throw this.uniqueError(error, collection, row._id)
    }
    if (permsChanged) await this.writePerms(collection, row._seq, newPermissions!)
    this.touch(collection, row._id, options)
    this.record(collection, 'update', updated, options)
    return updated
  }

  private async deleteRow(collection: Collection, row: Row, options: WriteOptions): Promise<void> {
    this.guardCheck(collection, row, options)
    this.revisionCheck(row, options)
    await this.exec().run(`DELETE FROM ${q(collection.table)} WHERE _seq = ?`, [row._seq])
    await this.exec().run(`DELETE FROM ${q(collection.permsTable)} WHERE doc = ?`, [row._seq])
    this.touch(collection, row._id, options)
    this.record(collection, 'delete', row, options)
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
    this.assertCreate(caller, collection)
    return decodeRow(collection, await this.insertRow(caller, collection, input, options))
  }

  async createDocuments(caller: Caller, collection: Collection, documents: Record<string, unknown>[], options: WriteOptions = {}): Promise<Doc[]> {
    assertCallerScope(caller, 'documents.write')
    this.assertBulk(caller)
    return this.runInTransaction(async () => {
      const created: Doc[] = []
      for (const d of documents) {
        const { $id, $permissions, ...data } = d
        created.push(
          decodeRow(
            collection,
            await this.insertRow(caller, collection, { id: $id ?? 'unique()', data: { ...data, $createdAt: d.$createdAt, $updatedAt: d.$updatedAt }, permissions: $permissions ?? null }, options),
          ),
        )
      }
      return created
    })
  }

  async updateDocument(caller: Caller, collection: Collection, id: string, data: Record<string, unknown>, permissions: unknown, options: WriteOptions = {}): Promise<Doc> {
    assertCallerScope(caller, 'documents.write')
    return this.runInTransaction(async () => this.updateDocumentInTx(caller, collection, id, data, permissions, options))
  }

  /** `updateDocument` without its own transaction; for `runBatch` and staged writes. */
  async updateDocumentInTx(caller: Caller, collection: Collection, id: string, data: Record<string, unknown>, permissions: unknown, options: WriteOptions = {}): Promise<Doc> {
    assertCallerScope(caller, 'documents.write')
    if (Object.keys(data ?? {}).length === 0 && (permissions === null || permissions === undefined)) {
      throw err('document_missing_payload')
    }
    const row = await this.requireRow(caller, collection, id, 'update')
    return decodeRow(collection, await this.updateRow(caller, collection, row, data ?? {}, permissions, options))
  }

  async upsertDocument(caller: Caller, collection: Collection, id: string, data: Record<string, unknown>, permissions: unknown, options: WriteOptions = {}): Promise<{ doc: Doc; created: boolean }> {
    assertCallerScope(caller, 'documents.write')
    return this.runInTransaction(async () => this.upsertDocumentInTx(caller, collection, id, data, permissions, options))
  }

  /** `upsertDocument` without its own transaction; for `runBatch` and staged writes. */
  async upsertDocumentInTx(caller: Caller, collection: Collection, id: string, data: Record<string, unknown>, permissions: unknown, options: WriteOptions = {}): Promise<{ doc: Doc; created: boolean }> {
    assertCallerScope(caller, 'documents.write')
    const row = await this.row(collection, id)
    if (row) {
      if (!this.can(caller, collection, row, 'update')) throw err('user_unauthorized')
      return { doc: decodeRow(collection, await this.updateRow(caller, collection, row, data ?? {}, permissions, options)), created: false }
    }
    if (options.revision !== undefined) {
      throw err('document_update_conflict', `Document '${id}' does not exist, but the request requires an existing revision.`)
    }
    this.assertCreate(caller, collection)
    return { doc: decodeRow(collection, await this.insertRow(caller, collection, { id, data: data ?? {}, permissions }, options)), created: true }
  }

  async upsertDocuments(caller: Caller, collection: Collection, documents: Record<string, unknown>[], options: WriteOptions = {}): Promise<Doc[]> {
    assertCallerScope(caller, 'documents.write')
    this.assertBulk(caller)
    return this.runInTransaction(async () => {
      const result: Doc[] = []
      for (const d of documents) {
        const { $id, $permissions, ...data } = d
        if (typeof $id !== 'string' || !$id) {
          result.push(decodeRow(collection, await this.insertRow(caller, collection, { id: 'unique()', data, permissions: $permissions ?? null }, options)))
          continue
        }
        const row = await this.row(collection, $id)
        result.push(
          row
            ? decodeRow(collection, await this.updateRow(caller, collection, row, data, $permissions ?? null, options))
            : decodeRow(collection, await this.insertRow(caller, collection, { id: $id, data, permissions: $permissions ?? null }, options)),
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
    await this.deleteRow(collection, row, options)
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
    this.guardCheck(collection, row, options)
    this.revisionCheck(row, options)
    const current = (row[key] as number | null) ?? 0
    const next = current + direction * by
    if (bound !== null && bound !== undefined && (direction === 1 ? next > bound : next < bound)) {
      throw err('attribute_limit_exceeded', direction === 1 ? `Attribute value exceeds maximum limit: ${bound}` : `Attribute value exceeds minimum limit: ${bound}`)
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

  private assertBulk(caller: Caller): void {
    if (!caller.privileged) throw err('general_unauthorized_scope')
  }

  /** Rows a bulk operation applies to: the filters and limit, ignoring select. */
  private async bulkRows(caller: Caller, collection: Collection, rawQueries: unknown[]): Promise<Row[]> {
    const queries: Query[] = parseQueries(rawQueries)
    const compiled = compileCached(collection, rawQueries, this.db.dialect)
    // Compiled queries are shared; copy before replacing the limit.
    const effective = queries.some((query) => query.method === 'limit')
      ? compiled
      : { ...compiled, limit: Number.MAX_SAFE_INTEGER }
    return this.select(caller, collection, effective)
  }

  async updateDocuments(caller: Caller, collection: Collection, data: Record<string, unknown>, rawQueries: unknown[], options: WriteOptions = {}): Promise<Doc[]> {
    assertCallerScope(caller, 'documents.write')
    this.assertBulk(caller)
    const { $permissions, ...rest } = data ?? {}
    return this.runInTransaction(async () => {
      const rows = await this.bulkRows(caller, collection, rawQueries)
      const updated: Doc[] = []
      for (const row of rows) updated.push(decodeRow(collection, await this.updateRow(caller, collection, row, rest, $permissions ?? null, options)))
      return updated
    })
  }

  async deleteDocuments(caller: Caller, collection: Collection, rawQueries: unknown[], options: WriteOptions = {}): Promise<Doc[]> {
    assertCallerScope(caller, 'documents.write')
    this.assertBulk(caller)
    return this.runInTransaction(async () => {
      const rows = await this.bulkRows(caller, collection, rawQueries)
      const deleted: Doc[] = []
      for (const row of rows) {
        await this.deleteRow(collection, row, options)
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
