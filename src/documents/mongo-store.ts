/**
 * The document backend on MongoDB.
 *
 * Documents are stored natively (`_permissions` as an array, booleans as
 * booleans, arrays as arrays) so Mongo's own operators can answer Appwrite
 * queries. The SQL backend and this one share `DocumentBackend`, so routes,
 * `WriteBatcher` and `TransactionService` can use either.
 *
 * Limits, documented rather than hidden:
 * - `runInTransaction` runs the callback directly. Multi-document transactions
 *   need a replica set and a session-aware driver; the current Mongo driver
 *   does not open sessions.
 * - `preview` (a read with staged transaction writes) is not supported.
 * - `runBatch` applies operations in order without savepoints: one failure
 *   does not roll back the operations before it.
 * - `orderRandom` is not supported (it needs an aggregation `$sample`).
 */
import type { Caller } from '~/auth/caller'
import { assertCallerScope } from '~/auth/caller'
import type { PermissionType } from '~/auth/permissions'
import { collectionVersionKey } from '~/cluster/versions'
import { UnsupportedFeatureError, uniqueViolation } from '~/db/driver'
import type { MongoDriver } from '~/db/mongo-driver'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { resolveId } from '~/lib/ids'
import type { Collection } from '~/schema/types'
import { encodeAttributes, type Doc } from './codec'
import { compileMongoQueries, mongoCursorFilter, mongoReadFilter, type MongoFilter } from './mongo-query'
import {
  assertBulkPermission,
  assertCreatePermission,
  assertRevision,
  assertUnchangedSince,
  canAccess,
  defaultPermissions,
  documentDate,
  resolvePermissions,
} from './access'
import { ConflictError } from './errors'
import type { BatchOutcome, DocEvent, DocumentBackend, NewDocument, WriteOptions } from './store'

type Row = Record<string, unknown> & {
  _id: string
  _seq?: number
  _createdAt?: string
  _updatedAt?: string
  _permissions?: string[]
  _rev?: number
}

export class MongoDocumentStore implements DocumentBackend {
  events: DocEvent[] = []

  constructor(private driver: MongoDriver) {}

  private collection(collection: Collection) {
    return this.driver.collection<Row>(collection.table)
  }

  private get versions() {
    return this.driver.collection<{ _id: string; value?: number }>('_doc_versions')
  }

  drainEvents(): DocEvent[] {
    const events = this.events
    this.events = []
    return events
  }

  /** Mongo has no list cache here; staged reads are not supported. */
  beginStagedRead(): void {}
  endStagedRead(): void {}
  clearCaches(): void {}

  async collectionVersion(collection: Collection): Promise<number> {
    const row = await this.versions.findOne({ _id: collectionVersionKey(collection.databaseId, collection.id) })
    return Number(row?.value ?? 0)
  }

  private async bump(collection: Collection): Promise<void> {
    const key = collectionVersionKey(collection.databaseId, collection.id)
    const row = await this.versions.findOne({ _id: key })
    await this.versions.upsert({ _id: key }, { _id: key, value: Number(row?.value ?? 0) + 1 })
  }

  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn()
  }

  async preview<T>(_fn: () => Promise<T>): Promise<T> {
    throw new UnsupportedFeatureError(
      'staged transaction reads',
      'MongoDB staged reads need multi-document transactions; use a replica set with the SQL transaction service.',
    )
  }

  async runBatch<T>(operations: Array<() => Promise<T> | T>): Promise<Array<BatchOutcome<T>>> {
    const outcomes: Array<BatchOutcome<T>> = []
    for (const operation of operations) {
      try {
        outcomes.push({ ok: true, value: await operation() })
      } catch (error) {
        outcomes.push({ ok: false, error })
      }
    }
    return outcomes
  }

  // ---------------------------------------------------------------- helpers

  private encode(collection: Collection, data: Record<string, unknown>, mode: 'create' | 'update'): Record<string, unknown> {
    const encoded = encodeAttributes(collection, data, mode)
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(encoded)) {
      const attribute = collection.attributeMap.get(key)!
      if (value === null || value === undefined) out[key] = null
      else if (attribute.array) {
        try {
          out[key] = JSON.parse(value as string)
        } catch {
          out[key] = []
        }
      } else if (attribute.type === 'boolean') out[key] = Boolean(value)
      else out[key] = value
    }
    return out
  }

  private decode(collection: Collection, row: Row, select?: Set<string> | null): Doc {
    const doc = {
      $id: row._id,
      $sequence: String(row._seq ?? 0),
      $collectionId: collection.id,
      $databaseId: collection.databaseId,
      $createdAt: row._createdAt ?? '',
      $updatedAt: row._updatedAt ?? '',
      $permissions: Array.isArray(row._permissions) ? row._permissions : [],
      $revision: Number(row._rev ?? 1),
    } as Doc
    for (const attribute of collection.attributes) {
      if (select && !select.has(attribute.key)) continue
      const value = row[attribute.key]
      if (attribute.array) doc[attribute.key] = Array.isArray(value) ? value : []
      else if (value === undefined) doc[attribute.key] = null
      else doc[attribute.key] = value
    }
    return doc
  }

  private touch(collection: Collection, id: string, options: WriteOptions): void {
    options.guard?.touched.add(`${collection.table}/${id}`)
  }

  private record(collection: Collection, action: DocEvent['action'], row: Row, options: WriteOptions): void {
    if (!collection.databaseId) return
    const sink = options.events ?? this.events
    sink.push({ collection, action, document: this.decode(collection, row) })
  }

  private async row(collection: Collection, id: string): Promise<Row | null> {
    return (await this.collection(collection).findOne({ _id: id })) as Row | null
  }

  private async requireRow(caller: Caller, collection: Collection, id: string, type: PermissionType): Promise<Row> {
    const row = await this.row(collection, id)
    if (!row) throw err('document_not_found', undefined, [id])
    if (!canAccess(caller, collection, Array.isArray(row._permissions) ? row._permissions : [], type)) {
      if (!canAccess(caller, collection, Array.isArray(row._permissions) ? row._permissions : [], 'read')) throw err('document_not_found', undefined, [id])
      throw err('user_unauthorized')
    }
    return row
  }

  private mergeFilter(base: MongoFilter, extra: MongoFilter | null): MongoFilter {
    if (!extra || Object.keys(extra).length === 0) return base
    if (Object.keys(base).length === 0) return extra
    return { $and: [base, extra] }
  }

  // ---------------------------------------------------------------- reads

  async getDocument(caller: Caller, collection: Collection, id: string, rawQueries: unknown[] = []): Promise<Doc> {
    assertCallerScope(caller, 'documents.read')
    const plan = compileMongoQueries(collection, rawQueries)
    if (Object.keys(plan.filter).length || plan.sort || plan.cursor) {
      throw err('general_query_invalid', 'Invalid query: Only select queries are allowed when getting a document.')
    }
    const filter = this.mergeFilter({ _id: id }, mongoReadFilter(caller, collection))
    const row = (await this.collection(collection).findOne(filter)) as Row | null
    if (!row) throw err('document_not_found', undefined, [id])
    return this.decode(collection, row, plan.projection ? new Set(Object.keys(plan.projection)) : null)
  }

  async listDocuments(
    caller: Caller,
    collection: Collection,
    rawQueries: unknown[],
    includeTotal = true,
    _version?: number,
  ): Promise<{ total: number; documents: Doc[] }> {
    assertCallerScope(caller, 'documents.read')
    const plan = compileMongoQueries(collection, rawQueries)
    if (plan.random)
      throw new UnsupportedFeatureError('orderRandom on MongoDB', 'Random order needs an aggregation $sample and is not supported by this backend yet.')
    const sort = plan.sort ?? { _seq: 1 }
    let filter = this.mergeFilter(plan.filter, mongoReadFilter(caller, collection))
    const countFilter = filter
    if (plan.cursor) {
      const row = await this.row(collection, plan.cursor.id)
      if (!row) throw err('general_cursor_not_found', `Document '${plan.cursor.id}' for the 'cursor' value not found.`)
      filter = this.mergeFilter(filter, mongoCursorFilter(sort, row, plan.cursor.before))
    }
    const effectiveSort = plan.cursor?.before
      ? (Object.fromEntries(Object.entries(sort).map(([key, value]) => [key, -value as 1 | -1])) as Record<string, 1 | -1>)
      : sort
    const rows = (await this.collection(collection).find(filter, {
      sort: effectiveSort,
      skip: plan.skip,
      limit: plan.limit,
      projection: plan.projection,
    })) as Row[]
    if (plan.cursor?.before) rows.reverse()
    const select = plan.projection ? new Set(Object.keys(plan.projection)) : null
    return {
      total: includeTotal ? await this.collection(collection).count(countFilter) : 0,
      documents: rows.map((row) => this.decode(collection, row, select)),
    }
  }

  async countDocuments(caller: Caller, collection: Collection): Promise<number> {
    assertCallerScope(caller, 'documents.read')
    return this.collection(collection).count(this.mergeFilter({}, mongoReadFilter(caller, collection)))
  }

  // ---------------------------------------------------------------- writes

  private async insertRow(caller: Caller, collection: Collection, input: NewDocument, options: WriteOptions): Promise<Row> {
    const id = resolveId(input.id, 'Document ID')
    const data = input.data ?? {}
    const permissions = resolvePermissions(caller, input.permissions, defaultPermissions(caller))!
    const stamp = now()
    const values = this.encode(collection, data, 'create')
    const row: Row = {
      ...values,
      _id: id,
      _seq: await this.driver.nextSequence(collection.table),
      _createdAt: documentDate(caller, data, '$createdAt', stamp),
      _updatedAt: documentDate(caller, data, '$updatedAt', stamp),
      _permissions: permissions,
      _rev: 1,
    }
    try {
      await this.collection(collection).insert(row)
    } catch (error) {
      const violation = uniqueViolation(error)
      if (violation) {
        if (options.guard) throw new ConflictError(error instanceof Error ? error.message : String(error))
        throw err('document_already_exists', undefined, [id])
      }
      throw error
    }
    this.touch(collection, id, options)
    this.record(collection, 'create', row, options)
    await this.bump(collection)
    return row
  }

  private async updateRow(
    caller: Caller,
    collection: Collection,
    row: Row,
    data: Record<string, unknown>,
    permissions: unknown,
    options: WriteOptions,
  ): Promise<Row> {
    if (options.guard) assertUnchangedSince(collection, row._id, row._updatedAt, options.guard.touched, options.guard.before)
    assertRevision(row._id, Number(row._rev ?? 1), options.revision)
    const values = this.encode(collection, data, 'update')
    const oldPermissions = Array.isArray(row._permissions) ? row._permissions : []
    const newPermissions = resolvePermissions(caller, permissions, null)
    const changes: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(values)) {
      if (JSON.stringify(row[key] ?? null) !== JSON.stringify(value ?? null)) changes[key] = value
    }
    const permsChanged = newPermissions !== null && JSON.stringify(newPermissions) !== JSON.stringify(oldPermissions)
    const createdAt = documentDate(caller, data, '$createdAt', String(row._createdAt ?? ''))
    if (createdAt !== row._createdAt) changes._createdAt = createdAt
    const explicitUpdatedAt = caller.privileged && data.$updatedAt != null
    if (Object.keys(changes).length === 0 && !permsChanged && !explicitUpdatedAt) {
      this.touch(collection, row._id, options)
      return row
    }
    changes._updatedAt = documentDate(caller, data, '$updatedAt', now())
    changes._rev = Number(row._rev ?? 1) + 1
    if (permsChanged) changes._permissions = newPermissions
    const updated = (await this.collection(collection).update({ _id: row._id }, changes)) as Row | null
    if (!updated) throw err('document_not_found', undefined, [row._id])
    this.touch(collection, row._id, options)
    this.record(collection, 'update', updated, options)
    await this.bump(collection)
    return updated
  }

  private async deleteRow(collection: Collection, row: Row, options: WriteOptions): Promise<void> {
    if (options.guard) assertUnchangedSince(collection, row._id, row._updatedAt, options.guard.touched, options.guard.before)
    assertRevision(row._id, Number(row._rev ?? 1), options.revision)
    await this.collection(collection).delete({ _id: row._id })
    this.touch(collection, row._id, options)
    this.record(collection, 'delete', row, options)
    await this.bump(collection)
  }

  async createDocument(caller: Caller, collection: Collection, input: NewDocument, options: WriteOptions = {}): Promise<Doc> {
    assertCallerScope(caller, 'documents.write')
    return this.createDocumentInTx(caller, collection, input, options)
  }

  async createDocumentInTx(caller: Caller, collection: Collection, input: NewDocument, options: WriteOptions = {}): Promise<Doc> {
    assertCallerScope(caller, 'documents.write')
    assertCreatePermission(caller, collection)
    return this.decode(collection, await this.insertRow(caller, collection, input, options))
  }

  async createDocuments(caller: Caller, collection: Collection, documents: Record<string, unknown>[], options: WriteOptions = {}): Promise<Doc[]> {
    assertCallerScope(caller, 'documents.write')
    assertBulkPermission(caller)
    const created: Doc[] = []
    for (const document of documents) {
      const { $id, $permissions, ...data } = document
      created.push(
        this.decode(
          collection,
          await this.insertRow(
            caller,
            collection,
            { id: $id ?? 'unique()', data: { ...data, $createdAt: document.$createdAt, $updatedAt: document.$updatedAt }, permissions: $permissions ?? null },
            options,
          ),
        ),
      )
    }
    return created
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
    return this.updateDocumentInTx(caller, collection, id, data, permissions, options)
  }

  async updateDocumentInTx(
    caller: Caller,
    collection: Collection,
    id: string,
    data: Record<string, unknown>,
    permissions: unknown,
    options: WriteOptions = {},
  ): Promise<Doc> {
    assertCallerScope(caller, 'documents.write')
    if (Object.keys(data ?? {}).length === 0 && (permissions === null || permissions === undefined)) throw err('document_missing_payload')
    const row = await this.requireRow(caller, collection, id, 'update')
    return this.decode(collection, await this.updateRow(caller, collection, row, data ?? {}, permissions, options))
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
    return this.upsertDocumentInTx(caller, collection, id, data, permissions, options)
  }

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
      if (!canAccess(caller, collection, Array.isArray(row._permissions) ? row._permissions : [], 'update')) throw err('user_unauthorized')
      return { doc: this.decode(collection, await this.updateRow(caller, collection, row, data ?? {}, permissions, options)), created: false }
    }
    if (options.revision !== undefined) throw err('document_update_conflict', `Document '${id}' does not exist, but the request requires an existing revision.`)
    assertCreatePermission(caller, collection)
    return { doc: this.decode(collection, await this.insertRow(caller, collection, { id, data: data ?? {}, permissions }, options)), created: true }
  }

  async upsertDocuments(caller: Caller, collection: Collection, documents: Record<string, unknown>[], options: WriteOptions = {}): Promise<Doc[]> {
    assertCallerScope(caller, 'documents.write')
    assertBulkPermission(caller)
    const result: Doc[] = []
    for (const document of documents) {
      const { $id, $permissions, ...data } = document
      if (typeof $id !== 'string' || !$id) {
        result.push(this.decode(collection, await this.insertRow(caller, collection, { id: 'unique()', data, permissions: $permissions ?? null }, options)))
        continue
      }
      const row = await this.row(collection, $id)
      result.push(
        row
          ? this.decode(collection, await this.updateRow(caller, collection, row, data, $permissions ?? null, options))
          : this.decode(collection, await this.insertRow(caller, collection, { id: $id, data, permissions: $permissions ?? null }, options)),
      )
    }
    return result
  }

  async deleteDocument(caller: Caller, collection: Collection, id: string, options: WriteOptions = {}): Promise<Doc> {
    assertCallerScope(caller, 'documents.write')
    return this.deleteDocumentInTx(caller, collection, id, options)
  }

  async deleteDocumentInTx(caller: Caller, collection: Collection, id: string, options: WriteOptions = {}): Promise<Doc> {
    assertCallerScope(caller, 'documents.write')
    const row = await this.requireRow(caller, collection, id, 'delete')
    await this.deleteRow(collection, row, options)
    return this.decode(collection, row)
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
    assertCallerScope(caller, 'documents.write')
    const attribute = collection.attributeMap.get(key)
    if (!attribute) throw err('attribute_not_found', undefined, [key])
    if ((attribute.type !== 'integer' && attribute.type !== 'double') || attribute.array) {
      throw err('attribute_type_invalid', `Attribute "${key}" must be an integer or float.`)
    }
    if (typeof by !== 'number' || !Number.isFinite(by) || by <= 0)
      throw err('general_argument_invalid', 'Invalid `value` param: Value must be a number greater than 0.')
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
    const updated = (await this.collection(collection).update(
      { _id: row._id },
      { [key]: next, _updatedAt: now(), _rev: Number(row._rev ?? 1) + 1 },
    )) as Row | null
    if (!updated) throw err('document_not_found', undefined, [id])
    this.touch(collection, id, options)
    this.record(collection, 'update', updated, options)
    await this.bump(collection)
    return this.decode(collection, updated)
  }

  incrementAttributeInTx(
    caller: Caller,
    collection: Collection,
    id: string,
    key: string,
    by: number,
    bound: number | null,
    direction: 1 | -1,
    options: WriteOptions = {},
  ): Promise<Doc> {
    return this.incrementAttribute(caller, collection, id, key, by, bound, direction, options)
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
    const rows = await this.bulkRows(caller, collection, rawQueries)
    const updated: Doc[] = []
    for (const row of rows) updated.push(this.decode(collection, await this.updateRow(caller, collection, row, rest, $permissions ?? null, options)))
    return updated
  }

  async deleteDocuments(caller: Caller, collection: Collection, rawQueries: unknown[], options: WriteOptions = {}): Promise<Doc[]> {
    assertCallerScope(caller, 'documents.write')
    assertBulkPermission(caller)
    const rows = await this.bulkRows(caller, collection, rawQueries)
    const deleted: Doc[] = []
    for (const row of rows) {
      await this.deleteRow(collection, row, options)
      deleted.push(this.decode(collection, row))
    }
    return deleted
  }

  private async bulkRows(caller: Caller, collection: Collection, rawQueries: unknown[]): Promise<Row[]> {
    const plan = compileMongoQueries(collection, rawQueries)
    const filter = this.mergeFilter(plan.filter, mongoReadFilter(caller, collection))
    return (await this.collection(collection).find(filter, {
      sort: plan.sort,
      skip: plan.skip,
      limit: plan.sort ? plan.limit : Number.MAX_SAFE_INTEGER,
    })) as Row[]
  }

  async checkStagedWrite(caller: Caller, collection: Collection, id: string, type: PermissionType): Promise<Doc | null> {
    assertCallerScope(caller, type === 'read' ? 'documents.read' : 'documents.write')
    const row = await this.row(collection, id)
    if (!row) return null
    if (!canAccess(caller, collection, Array.isArray(row._permissions) ? row._permissions : [], type)) {
      if (!canAccess(caller, collection, Array.isArray(row._permissions) ? row._permissions : [], 'read')) throw err('document_not_found', undefined, [id])
      throw err('user_unauthorized')
    }
    return this.decode(collection, row)
  }
}
