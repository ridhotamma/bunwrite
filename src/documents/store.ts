/**
 * Document reads and writes with Appwrite's permission rules. Everything here
 * is synchronous on purpose: bun:sqlite is synchronous, so one request's
 * database work can never interleave with another's.
 */
import type { SQLQueryBindings } from 'bun:sqlite'

import type { Caller } from '~/auth/caller'
import { aggregatePermissions, grants, parsePermission, type PermissionType } from '~/auth/permissions'
import { q, type Db } from '~/db/connection'
import { normalizeDate, now } from '~/lib/datetime'
import { AppwriteError, err, invalidStructure } from '~/lib/errors'
import { resolveId } from '~/lib/ids'
import type { Collection } from '~/schema/types'
import { decodeRow, encodeAttributes, type Doc, type SqlValue } from './codec'
import { compileQueries, cursorCondition, orderExpr, parseQueries, type Compiled, type Query } from './query'

/** Appwrite caps `total` at this many matches. */
export const COUNT_LIMIT = 5000

type Row = Record<string, unknown> & { _seq: number; _id: string; _updatedAt: string; _permissions: string }

/**
 * Set while committing a transaction: a write to a document changed after
 * `before` (and not already written by this transaction) is a conflict.
 */
export interface Guard {
  before: string
  touched: Set<string>
}

export class ConflictError extends Error {}

export interface WriteOptions {
  guard?: Guard
}

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

const bindings = (params: SqlValue[]) => params as SQLQueryBindings[]

export class DocumentStore {
  /** Changes made by the current request; the app publishes them once it succeeds. */
  events: DocEvent[] = []

  constructor(private db: Db) {}

  drainEvents(): DocEvent[] {
    const events = this.events
    this.events = []
    return events
  }

  private record(collection: Collection, action: DocEvent['action'], row: Row): void {
    if (!collection.databaseId) return // users/teams views never emit
    this.events.push({ collection, action, document: decodeRow(collection, row) })
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

  private row(collection: Collection, id: string): Row | null {
    return (this.db.sqlite.query(`SELECT * FROM ${q(collection.table)} WHERE _id = ?`).get(id) as Row | null) ?? null
  }

  private rowBySeq(collection: Collection, seq: number): Row {
    return this.db.sqlite.query(`SELECT * FROM ${q(collection.table)} WHERE _seq = ?`).get(seq) as Row
  }

  private can(caller: Caller, collection: Collection, row: Row, type: PermissionType): boolean {
    if (caller.privileged || grants(collection.permissions, type, caller.roles)) return true
    return collection.documentSecurity && grants(JSON.parse(row._permissions), type, caller.roles)
  }

  getDocument(caller: Caller, collection: Collection, id: string, rawQueries: unknown[] = []): Doc {
    const compiled = compileQueries(collection, parseQueries(rawQueries))
    if (compiled.where.length || compiled.orders.length || compiled.cursor) {
      throw err('general_query_invalid', 'Invalid query: Only select queries are allowed when getting a document.')
    }
    const params: SqlValue[] = [id]
    const filter = this.readFilter(caller, collection, params)
    const row = this.db.sqlite
      .query(`SELECT * FROM ${q(collection.table)} t WHERE t._id = ?${filter ? ` AND ${filter}` : ''}`)
      .get(...bindings(params)) as Row | null
    if (!row) throw err('document_not_found', undefined, [id])
    return decodeRow(collection, row, compiled.select)
  }

  /** Matching rows for `compiled`, honouring cursor, order, limit and offset. */
  private select(caller: Caller, collection: Collection, compiled: Compiled): Row[] {
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
      const cursorRow = this.row(collection, compiled.cursor.id)
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
    const rows = this.db.sqlite.query(sql).all(...bindings(params)) as Row[]
    return compiled.cursor?.before ? rows.reverse() : rows
  }

  private count(caller: Caller, collection: Collection, compiled: Compiled): number {
    const params: SqlValue[] = [...compiled.params]
    const where = [...compiled.where]
    const filter = this.readFilter(caller, collection, params)
    if (filter) where.push(filter)
    const sql =
      `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${q(collection.table)} t` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` LIMIT ${COUNT_LIMIT})`
    return (this.db.sqlite.query(sql).get(...bindings(params)) as { n: number }).n
  }

  listDocuments(caller: Caller, collection: Collection, rawQueries: unknown[], includeTotal = true): { total: number; documents: Doc[] } {
    const compiled = compileQueries(collection, parseQueries(rawQueries))
    const rows = this.select(caller, collection, compiled)
    return {
      total: includeTotal ? this.count(caller, collection, compiled) : 0,
      documents: rows.map((r) => decodeRow(collection, r, compiled.select)),
    }
  }

  /** All documents in a collection the caller may read, without the list cap. */
  countDocuments(caller: Caller, collection: Collection): number {
    const params: SqlValue[] = []
    const filter = this.readFilter(caller, collection, params)
    const sql = `SELECT count(*) AS n FROM ${q(collection.table)} t${filter ? ` WHERE ${filter}` : ''}`
    return (this.db.sqlite.query(sql).get(...bindings(params)) as { n: number }).n
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

  private writePerms(collection: Collection, seq: number, permissions: string[]): void {
    const sqlite = this.db.sqlite
    sqlite.query(`DELETE FROM ${q(collection.permsTable)} WHERE doc = ?`).run(seq)
    const insert = sqlite.query(`INSERT OR IGNORE INTO ${q(collection.permsTable)} (doc, type, role) VALUES (?, ?, ?)`)
    for (const p of permissions) {
      const { type, role } = parsePermission(p)
      insert.run(seq, type, role)
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

  private touch(collection: Collection, id: string, options: WriteOptions): void {
    options.guard?.touched.add(`${collection.table}/${id}`)
  }

  private uniqueError(error: unknown, collection: Collection, id: string): unknown {
    const message = error instanceof Error ? error.message : ''
    if (!message.includes('UNIQUE constraint failed')) return error
    if (message.includes(`${collection.table}._id`)) return err('document_already_exists', undefined, [id])
    return err('document_unique_constraint_violation')
  }

  private insertRow(caller: Caller, collection: Collection, input: NewDocument, options: WriteOptions): Row {
    const id = resolveId(input.id, 'Document ID')
    const data = input.data ?? {}
    const permissions = this.resolvePermissions(caller, input.permissions, this.defaultPermissions(caller))!
    const stamp = now()
    const values = encodeAttributes(collection, data, 'create')
    const keys = Object.keys(values)
    const columns = ['_id', '_createdAt', '_updatedAt', '_permissions', ...keys]
    const params: SqlValue[] = [
      id,
      this.dates(caller, data, '$createdAt', stamp),
      this.dates(caller, data, '$updatedAt', stamp),
      JSON.stringify(permissions),
      ...keys.map((k) => values[k]!),
    ]
    let row: Row
    try {
      // No RETURNING: SQLite 3.39 (macOS) fails it inside a transaction when an FTS trigger fires.
      const result = this.db.sqlite
        .query(`INSERT INTO ${q(collection.table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...bindings(params))
      row = this.rowBySeq(collection, Number(result.lastInsertRowid))
    } catch (error) {
      if (options.guard && error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError(error.message)
      }
      throw this.uniqueError(error, collection, id)
    }
    this.writePerms(collection, row._seq, permissions)
    this.touch(collection, id, options)
    this.record(collection, 'create', row)
    return row
  }

  private assertCreate(caller: Caller, collection: Collection): void {
    if (!caller.privileged && !grants(collection.permissions, 'create', caller.roles)) throw err('user_unauthorized')
  }

  /** Update an existing row in place. Skips the write when nothing changes, like Appwrite. */
  private updateRow(
    caller: Caller,
    collection: Collection,
    row: Row,
    data: Record<string, unknown>,
    permissions: unknown,
    options: WriteOptions,
  ): Row {
    this.guardCheck(collection, row, options)
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
    let updated: Row
    try {
      this.db.sqlite
        .query(`UPDATE ${q(collection.table)} SET ${keys.map((k) => `${q(k)} = ?`).join(', ')} WHERE _seq = ?`)
        .run(...bindings([...keys.map((k) => changes[k]!), row._seq]))
      updated = this.rowBySeq(collection, row._seq)
    } catch (error) {
      if (options.guard && error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError(error.message)
      }
      throw this.uniqueError(error, collection, row._id)
    }
    if (permsChanged) this.writePerms(collection, row._seq, newPermissions!)
    this.touch(collection, row._id, options)
    this.record(collection, 'update', updated)
    return updated
  }

  private deleteRow(collection: Collection, row: Row, options: WriteOptions): void {
    this.guardCheck(collection, row, options)
    this.db.sqlite.query(`DELETE FROM ${q(collection.table)} WHERE _seq = ?`).run(row._seq)
    this.db.sqlite.query(`DELETE FROM ${q(collection.permsTable)} WHERE doc = ?`).run(row._seq)
    this.touch(collection, row._id, options)
    this.record(collection, 'delete', row)
  }

  private requireRow(caller: Caller, collection: Collection, id: string, type: PermissionType): Row {
    const row = this.row(collection, id)
    if (!row) throw err('document_not_found', undefined, [id])
    if (!this.can(caller, collection, row, type)) {
      // Hide documents the caller cannot even read.
      if (!this.can(caller, collection, row, 'read')) throw err('document_not_found', undefined, [id])
      throw err('user_unauthorized')
    }
    return row
  }

  private tx<T>(fn: () => T): T {
    return this.db.sqlite.transaction(fn)()
  }

  // ---------------------------------------------------------------- writes

  createDocument(caller: Caller, collection: Collection, input: NewDocument, options: WriteOptions = {}): Doc {
    this.assertCreate(caller, collection)
    return this.tx(() => decodeRow(collection, this.insertRow(caller, collection, input, options)))
  }

  createDocuments(caller: Caller, collection: Collection, documents: Record<string, unknown>[], options: WriteOptions = {}): Doc[] {
    this.assertBulk(caller)
    return this.tx(() =>
      documents.map((d) => {
        const { $id, $permissions, ...data } = d
        return decodeRow(collection, this.insertRow(caller, collection, { id: $id ?? 'unique()', data: { ...data, $createdAt: d.$createdAt, $updatedAt: d.$updatedAt }, permissions: $permissions ?? null }, options))
      }),
    )
  }

  updateDocument(caller: Caller, collection: Collection, id: string, data: Record<string, unknown>, permissions: unknown, options: WriteOptions = {}): Doc {
    if (Object.keys(data ?? {}).length === 0 && (permissions === null || permissions === undefined)) {
      throw err('document_missing_payload')
    }
    return this.tx(() => {
      const row = this.requireRow(caller, collection, id, 'update')
      return decodeRow(collection, this.updateRow(caller, collection, row, data ?? {}, permissions, options))
    })
  }

  upsertDocument(caller: Caller, collection: Collection, id: string, data: Record<string, unknown>, permissions: unknown, options: WriteOptions = {}): { doc: Doc; created: boolean } {
    return this.tx(() => {
      const row = this.row(collection, id)
      if (row) {
        if (!this.can(caller, collection, row, 'update')) throw err('user_unauthorized')
        return { doc: decodeRow(collection, this.updateRow(caller, collection, row, data ?? {}, permissions, options)), created: false }
      }
      this.assertCreate(caller, collection)
      return { doc: decodeRow(collection, this.insertRow(caller, collection, { id, data: data ?? {}, permissions }, options)), created: true }
    })
  }

  upsertDocuments(caller: Caller, collection: Collection, documents: Record<string, unknown>[], options: WriteOptions = {}): Doc[] {
    this.assertBulk(caller)
    return this.tx(() =>
      documents.map((d) => {
        const { $id, $permissions, ...data } = d
        if (typeof $id !== 'string' || !$id) {
          return decodeRow(collection, this.insertRow(caller, collection, { id: 'unique()', data, permissions: $permissions ?? null }, options))
        }
        const row = this.row(collection, $id)
        if (row) return decodeRow(collection, this.updateRow(caller, collection, row, data, $permissions ?? null, options))
        return decodeRow(collection, this.insertRow(caller, collection, { id: $id, data, permissions: $permissions ?? null }, options))
      }),
    )
  }

  deleteDocument(caller: Caller, collection: Collection, id: string, options: WriteOptions = {}): Doc {
    return this.tx(() => {
      const row = this.requireRow(caller, collection, id, 'delete')
      this.deleteRow(collection, row, options)
      return decodeRow(collection, row)
    })
  }

  incrementAttribute(
    caller: Caller,
    collection: Collection,
    id: string,
    key: string,
    by: number,
    bound: number | null,
    direction: 1 | -1,
    options: WriteOptions = {},
  ): Doc {
    const a = collection.attributeMap.get(key)
    if (!a) throw err('attribute_not_found', undefined, [key])
    if ((a.type !== 'integer' && a.type !== 'double') || a.array) {
      throw err('attribute_type_invalid', `Attribute "${key}" must be an integer or float.`)
    }
    if (typeof by !== 'number' || !Number.isFinite(by) || by <= 0) {
      throw err('general_argument_invalid', 'Invalid `value` param: Value must be a number greater than 0.')
    }
    return this.tx(() => {
      const row = this.requireRow(caller, collection, id, 'update')
      this.guardCheck(collection, row, options)
      const current = (row[key] as number | null) ?? 0
      const next = current + direction * by
      if (bound !== null && bound !== undefined && (direction === 1 ? next > bound : next < bound)) {
        throw err('attribute_limit_exceeded', direction === 1 ? `Attribute value exceeds maximum limit: ${bound}` : `Attribute value exceeds minimum limit: ${bound}`)
      }
      this.db.sqlite.query(`UPDATE ${q(collection.table)} SET ${q(key)} = ?, _updatedAt = ? WHERE _seq = ?`).run(next, now(), row._seq)
      const updated = this.rowBySeq(collection, row._seq)
      this.touch(collection, id, options)
      this.record(collection, 'update', updated)
      return decodeRow(collection, updated)
    })
  }

  private assertBulk(caller: Caller): void {
    if (!caller.privileged) throw err('general_unauthorized_scope')
  }

  /** Rows a bulk operation applies to: the filters and limit, ignoring select. */
  private bulkRows(caller: Caller, collection: Collection, rawQueries: unknown[]): Row[] {
    const queries: Query[] = parseQueries(rawQueries)
    const compiled = compileQueries(collection, queries)
    if (!queries.some((query) => query.method === 'limit')) compiled.limit = Number.MAX_SAFE_INTEGER
    return this.select(caller, collection, compiled)
  }

  updateDocuments(caller: Caller, collection: Collection, data: Record<string, unknown>, rawQueries: unknown[], options: WriteOptions = {}): Doc[] {
    this.assertBulk(caller)
    const { $permissions, ...rest } = data ?? {}
    return this.tx(() =>
      this.bulkRows(caller, collection, rawQueries).map((row) =>
        decodeRow(collection, this.updateRow(caller, collection, row, rest, $permissions ?? null, options)),
      ),
    )
  }

  deleteDocuments(caller: Caller, collection: Collection, rawQueries: unknown[], options: WriteOptions = {}): Doc[] {
    this.assertBulk(caller)
    return this.tx(() =>
      this.bulkRows(caller, collection, rawQueries).map((row) => {
        this.deleteRow(collection, row, options)
        return decodeRow(collection, row)
      }),
    )
  }

  /** Read-only existence and permission check used when staging transaction writes. */
  checkStagedWrite(caller: Caller, collection: Collection, id: string, type: PermissionType): Doc | null {
    const row = this.row(collection, id)
    if (!row) return null
    if (!this.can(caller, collection, row, type)) {
      if (!this.can(caller, collection, row, 'read')) throw err('document_not_found', undefined, [id])
      throw err('user_unauthorized')
    }
    return decodeRow(collection, row)
  }
}

export const isAppwriteError = (e: unknown): e is AppwriteError => e instanceof AppwriteError
