import { grants } from '~/auth/permissions'
import { bool, etagFor, ifNoneMatch, json, list, noContent, notModified, num, str, type Params } from '~/lib/http'
import { err } from '~/lib/errors'
import type { Router } from '~/lib/router'
import type { AppContext } from '~/app'
import type { Collection } from '~/schema/types'
import { mockDocument, type Action } from '~/transactions/service'

const DOCS = '/databases/:databaseId/collections/:collectionId/documents'

const obj = (value: unknown): Record<string, unknown> => {
  if (value === undefined || value === null) return {}
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      throw err('document_invalid_structure', 'Invalid document structure: data must be a JSON object.')
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw err('document_invalid_structure', 'Invalid document structure: data must be a JSON object.')
  }
  return value as Record<string, unknown>
}

const docs = (value: unknown): Record<string, unknown>[] => list(value).map(obj)

/** The caller's role set is part of every ETag: another user must never reuse one. */
const callerTag = (caller: AppContext['caller']) => (caller.privileged ? '*' : [...caller.roles].sort().join(','))

/** Public only when every anonymous caller may read the collection and the operator enabled it. */
const cacheControl = (ctx: AppContext, collection: Collection): string =>
  !ctx.caller.privileged && ctx.config.cache.publicMaxAge > 0 && grants(collection.permissions, 'read', new Set(['any']))
    ? `public, max-age=${ctx.config.cache.publicMaxAge}`
    : 'private, max-age=0, must-revalidate'

export function documentRoutes(router: Router<AppContext>): void {
  const collectionOf = (ctx: AppContext, path: Record<string, string>) =>
    ctx.registry.collection(path.databaseId!, path.collectionId!, ctx.caller.privileged)

  /** Stage `action` when a transactionId is present; returns true if it was staged. */
  const staged = (ctx: AppContext, params: Params, path: Record<string, string>, action: Action, documentId: string | null, data: Record<string, any>) => {
    const transactionId = str(params.transactionId)
    if (!transactionId) return false
    const input = { databaseId: path.databaseId!, collectionId: path.collectionId!, documentId, action, data }
    ctx.transactions.stage(ctx.caller, transactionId, input)
    path.stagedId = input.documentId ?? ''
    return true
  }

  router.get(DOCS, ({ ctx, request, params, path }) => {
    const collection = collectionOf(ctx, path)
    const queries = list(params.queries)
    const includeTotal = bool(params.total, true)
    const transactionId = str(params.transactionId)
    if (transactionId) {
      const result = ctx.transactions.withStaged(ctx.caller, transactionId, () =>
        ctx.store.listDocuments(ctx.caller, collection, queries, includeTotal),
      )
      return json(result)
    }
    const version = ctx.store.collectionVersion(collection)
    const etag = etagFor(
      `${collection.table}\u0000${version}\u0000${collection.updatedAt}\u0000${callerTag(ctx.caller)}\u0000${includeTotal ? 1 : 0}\u0000${JSON.stringify(queries)}`,
    )
    const headers = { 'cache-control': cacheControl(ctx, collection), etag }
    if (ifNoneMatch(request, etag)) return notModified(etag, { 'cache-control': headers['cache-control'] })
    return json(ctx.store.listDocuments(ctx.caller, collection, queries, includeTotal, version), 200, headers)
  })

  router.get(`${DOCS}/:documentId`, ({ ctx, request, params, path }) => {
    const collection = collectionOf(ctx, path)
    const queries = list(params.queries)
    const transactionId = str(params.transactionId)
    if (transactionId) {
      const doc = ctx.transactions.withStaged(ctx.caller, transactionId, () =>
        ctx.store.getDocument(ctx.caller, collection, path.documentId!, queries),
      )
      return json(doc)
    }
    const version = ctx.store.collectionVersion(collection)
    const etag = etagFor(
      `${collection.table}\u0000${version}\u0000${collection.updatedAt}\u0000${callerTag(ctx.caller)}\u0000${path.documentId}\u0000${JSON.stringify(queries)}`,
    )
    const headers = { 'cache-control': cacheControl(ctx, collection), etag }
    if (ifNoneMatch(request, etag)) return notModified(etag, { 'cache-control': headers['cache-control'] })
    return json(ctx.store.getDocument(ctx.caller, collection, path.documentId!, queries), 200, headers)
  })

  router.post(DOCS, ({ ctx, params, path }) => {
    const collection = collectionOf(ctx, path)
    const hasData = params.data !== undefined && params.data !== null
    const hasDocuments = Array.isArray(params.documents) && params.documents.length > 0
    if (hasData && hasDocuments) {
      throw err('general_bad_request', 'You can only send one of the following parameters: data, documents')
    }
    if (hasDocuments) {
      if (params.documentId) {
        throw err('general_bad_request', 'Param "documentId" is not allowed when creating multiple documents, set "$id" on each instead.')
      }
      if (params.permissions) {
        throw err('general_bad_request', 'Param "permissions" is disallowed when creating multiple documents, set "$permissions" on each instead')
      }
      const documents = docs(params.documents)
      if (staged(ctx, params, path, 'bulkCreate', null, { documents })) {
        return json({ total: documents.length, documents: [] }, 201)
      }
      const created = ctx.store.createDocuments(ctx.caller, collection, documents)
      return json({ total: created.length, documents: created }, 201)
    }
    if (!params.documentId) throw err('document_missing_data', 'Document ID is required when creating a single document.')
    const data = obj(params.data)
    if (staged(ctx, params, path, 'create', String(params.documentId), { data, permissions: params.permissions })) {
      return json(mockDocument(collection, path.stagedId!, data), 201)
    }
    const doc = ctx.store.createDocument(ctx.caller, collection, {
      id: params.documentId,
      data,
      permissions: params.permissions ?? null,
    })
    return json(doc, 201)
  })

  router.put(DOCS, ({ ctx, params, path }) => {
    const collection = collectionOf(ctx, path)
    const documents = docs(params.documents)
    if (staged(ctx, params, path, 'bulkUpsert', null, { documents })) {
      return json({ total: documents.length, documents: [] }, 201)
    }
    const upserted = ctx.store.upsertDocuments(ctx.caller, collection, documents)
    return json({ total: upserted.length, documents: upserted }, 201)
  })

  router.patch(DOCS, ({ ctx, params, path }) => {
    const collection = collectionOf(ctx, path)
    const data = obj(params.data)
    const queries = list(params.queries)
    if (staged(ctx, params, path, 'bulkUpdate', null, { data, queries })) {
      return json({ total: 0, documents: [] })
    }
    const updated = ctx.store.updateDocuments(ctx.caller, collection, data, queries)
    return json({ total: updated.length, documents: updated })
  })

  router.delete(DOCS, ({ ctx, params, path }) => {
    const collection = collectionOf(ctx, path)
    const queries = list(params.queries)
    if (staged(ctx, params, path, 'bulkDelete', null, { queries })) {
      return json({ total: 0, documents: [] })
    }
    const deleted = ctx.store.deleteDocuments(ctx.caller, collection, queries)
    return json({ total: deleted.length, documents: deleted })
  })

  router.put(`${DOCS}/:documentId`, ({ ctx, params, path }) => {
    const collection = collectionOf(ctx, path)
    const data = obj(params.data)
    if (staged(ctx, params, path, 'upsert', path.documentId!, { data, permissions: params.permissions })) {
      return json(mockDocument(collection, path.documentId!, data), 201)
    }
    const { doc } = ctx.store.upsertDocument(ctx.caller, collection, path.documentId!, data, params.permissions ?? null)
    return json(doc, 201)
  })

  router.patch(`${DOCS}/:documentId`, ({ ctx, params, path }) => {
    const collection = collectionOf(ctx, path)
    const data = obj(params.data)
    const transactionId = str(params.transactionId)
    if (transactionId) {
      const base = ctx.transactions.withStaged(ctx.caller, transactionId, () => {
        try {
          return ctx.store.getDocument(ctx.caller, collection, path.documentId!)
        } catch {
          return null
        }
      })
      staged(ctx, params, path, 'update', path.documentId!, { data, permissions: params.permissions })
      return json(mockDocument(collection, path.documentId!, data, base))
    }
    const doc = ctx.store.updateDocument(ctx.caller, collection, path.documentId!, data, params.permissions ?? null)
    return json(doc)
  })

  router.delete(`${DOCS}/:documentId`, ({ ctx, params, path }) => {
    const collection = collectionOf(ctx, path)
    if (staged(ctx, params, path, 'delete', path.documentId!, {})) return noContent()
    ctx.store.deleteDocument(ctx.caller, collection, path.documentId!)
    return noContent()
  })

  for (const action of ['increment', 'decrement'] as const) {
    router.patch(`${DOCS}/:documentId/:attribute/${action}`, ({ ctx, params, path }) => {
      const collection = collectionOf(ctx, path)
      const value = num(params.value, 1)!
      const bound = num(action === 'increment' ? params.max : params.min) ?? null
      if (staged(ctx, params, path, action, path.documentId!, { attribute: path.attribute, value, bound })) {
        return json(mockDocument(collection, path.documentId!, { [path.attribute!]: value }))
      }
      const doc = ctx.store.incrementAttribute(ctx.caller, collection, path.documentId!, path.attribute!, value, bound, action === 'increment' ? 1 : -1)
      return json(doc)
    })
  }
}

export function transactionRoutes(router: Router<AppContext>): void {
  router.post('/databases/transactions', ({ ctx, params }) => json(ctx.transactions.create(ctx.caller, num(params.ttl, 300)), 201))
  router.get('/databases/transactions', ({ ctx }) => json(ctx.transactions.list(ctx.caller)))
  router.get('/databases/transactions/:transactionId', ({ ctx, path }) => json(ctx.transactions.get(ctx.caller, path.transactionId!)))
  router.patch('/databases/transactions/:transactionId', ({ ctx, params, path }) =>
    json(ctx.transactions.update(ctx.caller, path.transactionId!, bool(params.commit, false), bool(params.rollback, false))),
  )
  router.delete('/databases/transactions/:transactionId', ({ ctx, path }) => {
    ctx.transactions.delete(ctx.caller, path.transactionId!)
    return noContent()
  })
  router.post('/databases/transactions/:transactionId/operations', ({ ctx, params, path }) => {
    for (const raw of list(params.operations)) {
      const op = obj(raw) as Record<string, any>
      const action = op.action as Action
      const data = op.data ?? {}
      const input: Record<string, any> =
        action === 'create' || action === 'update' || action === 'upsert'
          ? { data: { ...data, $permissions: undefined }, permissions: data.$permissions }
          : action === 'increment' || action === 'decrement'
            ? { attribute: data.attribute ?? data.column, value: data.value ?? 1, bound: data.max ?? data.min ?? null }
            : action === 'bulkCreate' || action === 'bulkUpsert'
              ? { documents: Array.isArray(data) ? data : data.documents ?? [] }
              : { data: data.data ?? {}, queries: data.queries ?? [] }
      if (input.data) delete input.data.$permissions
      ctx.transactions.stage(ctx.caller, path.transactionId!, {
        databaseId: op.databaseId,
        collectionId: op.collectionId ?? op.tableId,
        documentId: op.documentId ?? op.rowId ?? null,
        action,
        data: input,
      })
    }
    return json(ctx.transactions.get(ctx.caller, path.transactionId!), 201)
  })
}
