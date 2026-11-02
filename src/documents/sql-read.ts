/**
 * SQL reads for a collection table.
 *
 * These are the storage-facing half of `DocumentStore`: they build the
 * permission filter, run the compiled query and count matches. The store keeps
 * the orchestration (cache, events, transactions) and passes its current
 * executor, which is the pool or an open transaction.
 */
import type { Caller } from '~/auth/caller'
import { grants } from '~/auth/permissions'
import { q } from '~/db/connection'
import type { SqlExecutor } from '~/db/driver'
import { err } from '~/lib/errors'
import type { Collection } from '~/schema/types'
import type { SqlValue } from './codec'
import { cursorCondition, orderExpr, type Compiled } from './query'

/** Appwrite caps `total` at this many matches. */
export const COUNT_LIMIT = 5000

export type Row = Record<string, unknown> & {
  _seq: number
  _id: string
  _updatedAt: string
  _permissions: string
  _rev: number
}

/** SQL condition limiting rows to what the caller may read, or null for all rows. */
export function readFilter(caller: Caller, collection: Collection, params: SqlValue[]): string | null {
  if (caller.privileged || grants(collection.permissions, 'read', caller.roles)) return null
  if (!collection.documentSecurity) throw err('user_unauthorized')
  const roles = [...caller.roles]
  params.push(...roles)
  return `t._seq IN (SELECT doc FROM ${q(collection.permsTable)} WHERE type = 'read' AND role IN (${roles.map(() => '?').join(', ')}))`
}

export function rowById(exec: SqlExecutor, collection: Collection, id: string, forUpdate = false): Promise<Row | null> {
  // Postgres only: lock the row so a permission check and the following write
  // cannot be split by a concurrent update/revoke. SQLite serialises writers.
  return exec.get<Row>(`SELECT * FROM ${q(collection.table)} WHERE _id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [id])
}

export async function rowBySeq(exec: SqlExecutor, collection: Collection, seq: number): Promise<Row> {
  return (await exec.get<Row>(`SELECT * FROM ${q(collection.table)} WHERE _seq = ?`, [seq]))!
}

/** Matching rows for `compiled`, honouring cursor, order, limit and offset. */
export async function selectRows(
  exec: SqlExecutor,
  cursorRow: (collection: Collection, id: string) => Promise<Row | null>,
  caller: Caller,
  collection: Collection,
  compiled: Compiled,
): Promise<Row[]> {
  const params: SqlValue[] = []
  const where = [...compiled.where]
  params.push(...compiled.params)
  const filter = readFilter(caller, collection, params)
  if (filter) where.push(filter)

  const orders = [...compiled.orders]
  if (!orders.some((o) => o.column === '_seq' || o.column === '_id')) {
    orders.push({ column: '_seq', desc: false })
  }
  const effective = compiled.cursor?.before ? orders.map((o) => ({ ...o, desc: !o.desc })) : orders

  if (compiled.cursor) {
    const row = await cursorRow(collection, compiled.cursor.id)
    if (!row) {
      throw err('general_cursor_not_found', `Document '${compiled.cursor.id}' for the 'cursor' value not found.`)
    }
    // The cursor is only an anchor, but its existence and position are still
    // data the caller may not be allowed to read.
    const checkParams: SqlValue[] = []
    const cursorFilter = readFilter(caller, collection, checkParams)
    if (cursorFilter) {
      const allowed = await exec.get(
        `SELECT 1 FROM ${q(collection.table)} t WHERE t._id = ? AND ${cursorFilter}`,
        [compiled.cursor.id, ...checkParams],
      )
      if (!allowed) throw err('general_cursor_not_found', `Document '${compiled.cursor.id}' for the 'cursor' value not found.`)
    }
    where.push(cursorCondition(effective, row, params))
  }

  const orderSql = compiled.random ? 'random()' : effective.map((o) => `${orderExpr(o)} ${o.desc ? 'DESC' : 'ASC'}`).join(', ')
  const sql = `SELECT t.* FROM ${q(collection.table)} t` + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ` ORDER BY ${orderSql} LIMIT ? OFFSET ?`
  params.push(compiled.limit, compiled.offset)
  const rows = await exec.all<Row>(sql, params)
  return compiled.cursor?.before ? rows.reverse() : rows
}

/** `COUNT(*)` for a compiled query, capped like Appwrite. */
export async function countRows(exec: SqlExecutor, caller: Caller, collection: Collection, compiled: Compiled): Promise<number> {
  const params: SqlValue[] = [...compiled.params]
  const where = [...compiled.where]
  const filter = readFilter(caller, collection, params)
  if (filter) where.push(filter)
  const sql =
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${q(collection.table)} t` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` LIMIT ${COUNT_LIMIT}) AS limited`
  const row = await exec.get<{ n: number }>(sql, params)
  return Number(row?.n ?? 0)
}

/** Every document in a collection the caller may read, without the list cap. */
export async function countAllRows(exec: SqlExecutor, caller: Caller, collection: Collection): Promise<number> {
  const params: SqlValue[] = []
  const filter = readFilter(caller, collection, params)
  const sql = `SELECT count(*) AS n FROM ${q(collection.table)} t${filter ? ` WHERE ${filter}` : ''}`
  const row = await exec.get<{ n: number }>(sql, params)
  return Number(row?.n ?? 0)
}
