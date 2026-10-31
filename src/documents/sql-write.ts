/**
 * SQL writes for a collection table.
 *
 * The store passes a context for the current executor (pool or transaction)
 * and the side effects (events, guard bookkeeping). Everything here is the
 * storage mechanics: permissions side table, unique-violation mapping, and the
 * insert/update/delete statements.
 */
import type { Caller } from '~/auth/caller'
import { parsePermission } from '~/auth/permissions'
import { q } from '~/db/connection'
import type { SqlExecutor } from '~/db/driver'
import { uniqueViolation } from '~/db/driver'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { resolveId } from '~/lib/ids'
import type { Collection } from '~/schema/types'
import { documentDate, defaultPermissions, resolvePermissions } from './access'
import { encodeAttributes, type SqlValue } from './codec'
import { ConflictError } from './errors'
import { assertRevision, assertUnchangedSince } from './access'
import type { Row } from './sql-read'
import type { DocEvent, NewDocument, WriteOptions } from './store'

export interface SqlWriteContext {
  /** The current transaction, or the pool for a plain statement. */
  exec(): SqlExecutor
  /** Whether the backend supports `RETURNING *`. */
  readonly returning: boolean
  rowBySeq(collection: Collection, seq: number): Promise<Row>
  record(collection: Collection, action: DocEvent['action'], row: Row, options: WriteOptions): void
  touch(collection: Collection, id: string, options: WriteOptions): void
}

export async function writePermissions(exec: SqlExecutor, collection: Collection, seq: number, permissions: string[]): Promise<void> {
  await exec.run(`DELETE FROM ${q(collection.permsTable)} WHERE doc = ?`, [seq])
  for (const permission of permissions) {
    const { type, role } = parsePermission(permission)
    await exec.run(`INSERT OR IGNORE INTO ${q(collection.permsTable)} (doc, type, role) VALUES (?, ?, ?)`, [seq, type, role])
  }
}

/** Map a driver unique violation to Appwrite's `document_already_exists` / unique-attribute error. */
export function mapUniqueError(error: unknown, collection: Collection, id: string): unknown {
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

export async function insertRow(ctx: SqlWriteContext, caller: Caller, collection: Collection, input: NewDocument, options: WriteOptions): Promise<Row> {
  const id = resolveId(input.id, 'Document ID')
  const data = input.data ?? {}
  const permissions = resolvePermissions(caller, input.permissions, defaultPermissions(caller))!
  const stamp = now()
  const values = encodeAttributes(collection, data, 'create')
  const keys = Object.keys(values)
  const columns = ['_id', '_createdAt', '_updatedAt', '_permissions', '_rev', ...keys]
  const params: SqlValue[] = [
    id,
    documentDate(caller, data, '$createdAt', stamp),
    documentDate(caller, data, '$updatedAt', stamp),
    JSON.stringify(permissions),
    1,
    ...keys.map((key) => values[key]!),
  ]
  let row: Row
  try {
    const sql = `INSERT INTO ${q(collection.table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    if (ctx.returning) {
      row = (await ctx.exec().get<Row>(`${sql} RETURNING *`, params))!
    } else {
      const result = await ctx.exec().run(sql, params)
      row = await ctx.rowBySeq(collection, Number(result.lastInsertId))
    }
  } catch (error) {
    if (options.guard && uniqueViolation(error)) throw new ConflictError(error instanceof Error ? error.message : String(error))
    throw mapUniqueError(error, collection, id)
  }
  await writePermissions(ctx.exec(), collection, row._seq, permissions)
  ctx.touch(collection, id, options)
  ctx.record(collection, 'create', row, options)
  return row
}

/** Update an existing row in place. Skips the write when nothing changes, like Appwrite. */
export async function updateRow(
  ctx: SqlWriteContext,
  caller: Caller,
  collection: Collection,
  row: Row,
  data: Record<string, unknown>,
  permissions: unknown,
  options: WriteOptions,
): Promise<Row> {
  if (options.guard) assertUnchangedSince(collection, row._id, row._updatedAt, options.guard.touched, options.guard.before)
  assertRevision(row._id, Number(row._rev ?? 1), options.revision)
  const values = encodeAttributes(collection, data, 'update')
  const oldPermissions = JSON.parse(row._permissions) as string[]
  const newPermissions = resolvePermissions(caller, permissions, null)
  const changes: Record<string, SqlValue> = {}
  for (const [key, value] of Object.entries(values)) if (row[key] !== value) changes[key] = value
  const permsChanged = newPermissions !== null && JSON.stringify(newPermissions) !== JSON.stringify(oldPermissions)
  const createdAt = documentDate(caller, data, '$createdAt', row._createdAt as string)
  if (createdAt !== row._createdAt) changes._createdAt = createdAt
  const explicitUpdatedAt = caller.privileged && data.$updatedAt != null

  if (Object.keys(changes).length === 0 && !permsChanged && !explicitUpdatedAt) {
    ctx.touch(collection, row._id, options)
    return row
  }
  changes._updatedAt = documentDate(caller, data, '$updatedAt', now())
  if (permsChanged) changes._permissions = JSON.stringify(newPermissions)
  const keys = Object.keys(changes)
  const params: SqlValue[] = [...keys.map((key) => changes[key]!), row._seq]
  const sql = `UPDATE ${q(collection.table)} SET ${keys.map((key) => `${q(key)} = ?`).join(', ')}, ${q('_rev')} = ${q('_rev')} + 1 WHERE _seq = ?`
  let updated: Row
  try {
    if (ctx.returning) {
      updated = (await ctx.exec().get<Row>(`${sql} RETURNING *`, params))!
    } else {
      await ctx.exec().run(sql, params)
      updated = await ctx.rowBySeq(collection, row._seq)
    }
  } catch (error) {
    if (options.guard && uniqueViolation(error)) throw new ConflictError(error instanceof Error ? error.message : String(error))
    throw mapUniqueError(error, collection, row._id)
  }
  if (permsChanged) await writePermissions(ctx.exec(), collection, row._seq, newPermissions!)
  ctx.touch(collection, row._id, options)
  ctx.record(collection, 'update', updated, options)
  return updated
}

export async function deleteRow(ctx: SqlWriteContext, collection: Collection, row: Row, options: WriteOptions): Promise<void> {
  if (options.guard) assertUnchangedSince(collection, row._id, row._updatedAt, options.guard.touched, options.guard.before)
  assertRevision(row._id, Number(row._rev ?? 1), options.revision)
  await ctx.exec().run(`DELETE FROM ${q(collection.table)} WHERE _seq = ?`, [row._seq])
  await ctx.exec().run(`DELETE FROM ${q(collection.permsTable)} WHERE doc = ?`, [row._seq])
  ctx.touch(collection, row._id, options)
  ctx.record(collection, 'delete', row, options)
}
