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

/**
 * Optimistic-concurrency precondition for a single-document write. Accepts the
 * standard `If-Match` header (the Appwrite SDKs let a client set headers) and,
 * for convenience, `$revision` inside `data` or a `revision` param. A revision
 * is the `$revision` value a previous read returned; `*` only requires the
 * document to exist.
 */
function expectedRevision(request: Request, value: unknown): number | '*' | undefined {
  const header = request.headers.get('if-match')?.trim()
  const raw = header || (value === undefined || value === null || value === '' ? undefined : value)
  if (raw === undefined) return undefined
  // `If-Match: "3", "4"` means "any of these"; this API stores one revision.
  const first = String(raw).split(',')[0]!.trim()
  if (first === '*') return '*'
  const revision = Number(first.replace(/^W\//i, '').replace(/^"|"$/g, ''))
  if (!Number.isInteger(revision) || revision < 0) {
    throw err('general_argument_invalid', 'Invalid `If-Match` header or `$revision`: expected a document revision number or "*".')
  }
  return revision
}

/** Transactions already detect conflicts at commit; a staged write cannot carry If-Match. */
function assertNoRevision(revision: number | '*' | undefined, transactionId: string | undefined): void {
  if (revision !== undefined && transactionId) {
    throw err('general_argument_invalid', 'If-Match is not supported with transactionId; transactions detect conflicts at commit.')
  }
}

/** The caller's role set is part of every ETag: another user must never reuse one. */
const callerTag = (caller: AppContext['caller']) => (caller.privileged ? '*' : [...caller.roles].sort().join(','))

/** Public only when every anonymous caller may read the collection and the operator enabled it. */
const cacheControl = (ctx: AppContext, collection: Collection): string => {
  const maxAge = ctx.config.cache.publicMaxAge
  // Only an actual guest may share a response. A session user can see more
  // documents than a guest even in a collection readable by "any" when
  // document security is on, so their response must stay private.
  if (ctx.caller.kind !== 'guest' || maxAge <= 0 || !grants(collection.permissions, 'read', new Set(['any']))) {
    return 'private, max-age=0, must-revalidate'
  }
  return `public, max-age=${maxAge}`
}

export function documentRoutes(router: Router<AppContext>): void {
  const collectionOf = (ctx: AppContext, path: Record<string, string>) => ctx.registry.collection(path.databaseId!, path.collectionId!, ctx.caller.privileged)

  /** Stage `action` when a transactionId is present; returns true if it was staged. */
  const staged = async (
    ctx: AppContext,
    params: Params,
    path: Record<string, string>,
    action: Action,
    documentId: string | null,
    data: Record<string, unknown>,
  ) => {
    const transactionId = str(params.transactionId)
    if (!transactionId) return false
    const input = { databaseId: path.databaseId!, collectionId: path.collectionId!, documentId, action, data }
    await ctx.transactions.stage(ctx.caller, transactionId, input)
    path.stagedId = input.documentId ?? ''
    return true
  }

  router.get(DOCS, async ({ ctx, request, params, path }) => {
    const collection = collectionOf(ctx, path)
    const queries = list(params.queries)
    const includeTotal = bool(params.total, true)
    const transactionId = str(params.transactionId)
    if (transactionId) {
      const result = await ctx.transactions.withStaged(ctx.caller, transactionId, () => ctx.store.listDocuments(ctx.caller, collection, queries, includeTotal))
      return json(result)
    }
    const version = await ctx.store.collectionVersion(collection)
    // The project ID is part of the tag: the same URL can target different
    // projects via X-Appwrite-Project, and a shared cache must not mix them.
    const etag = etagFor(
      `${ctx.config.projectId}\u0000${collection.table}\u0000${version}\u0000${collection.updatedAt}\u0000${callerTag(ctx.caller)}\u0000${includeTotal ? 1 : 0}\u0000${JSON.stringify(queries)}`,
    )
    const headers = { 'cache-control': cacheControl(ctx, collection), etag, vary: 'X-Bunwrite-Project, X-Appwrite-Project' }
    if (ifNoneMatch(request, etag)) return notModified(etag, { 'cache-control': headers['cache-control'], vary: headers.vary })
    return json(await ctx.store.listDocuments(ctx.caller, collection, queries, includeTotal, version), 200, headers)
  })

  router.get(`${DOCS}/:documentId`, async ({ ctx, request, params, path }) => {
    const collection = collectionOf(ctx, path)
    const queries = list(params.queries)
    const transactionId = str(params.transactionId)
    if (transactionId) {
      const doc = await ctx.transactions.withStaged(ctx.caller, transactionId, () => ctx.store.getDocument(ctx.caller, collection, path.documentId!, queries))
      return json(doc)
    }
    const version = await ctx.store.collectionVersion(collection)
    const etag = etagFor(
      `${ctx.config.projectId}\u0000${collection.table}\u0000${version}\u0000${collection.updatedAt}\u0000${callerTag(ctx.caller)}\u0000${path.documentId}\u0000${JSON.stringify(queries)}`,
    )
    const headers = { 'cache-control': cacheControl(ctx, collection), etag, vary: 'X-Bunwrite-Project, X-Appwrite-Project' }
    if (ifNoneMatch(request, etag)) return notModified(etag, { 'cache-control': headers['cache-control'], vary: headers.vary })
    return json(await ctx.store.getDocument(ctx.caller, collection, path.documentId!, queries), 200, headers)
  })

  router.post(DOCS, async ({ ctx, params, path }) => {
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
      if (await staged(ctx, params, path, 'bulkCreate', null, { documents })) {
        return json({ total: documents.length, documents: [] }, 201)
      }
      const created = await ctx.store.createDocuments(ctx.caller, collection, documents)
      return json({ total: created.length, documents: created }, 201)
    }
    if (!params.documentId) throw err('document_missing_data', 'Document ID is required when creating a single document.')
    const data = obj(params.data)
    if (await staged(ctx, params, path, 'create', String(params.documentId), { data, permissions: params.permissions })) {
      return json(mockDocument(collection, path.stagedId!, data), 201)
    }
    const { value: doc, events } = await ctx.writes.submit((sink) =>
      ctx.store.createDocumentInTx(ctx.caller, collection, { id: params.documentId, data, permissions: params.permissions ?? null }, { events: sink }),
    )
    ctx.events.push(...events)
    return json(doc, 201)
  })

  router.put(DOCS, async ({ ctx, params, path }) => {
    const collection = collectionOf(ctx, path)
    const documents = docs(params.documents)
    if (await staged(ctx, params, path, 'bulkUpsert', null, { documents })) {
      return json({ total: documents.length, documents: [] }, 201)
    }
    const upserted = await ctx.store.upsertDocuments(ctx.caller, collection, documents)
    return json({ total: upserted.length, documents: upserted }, 201)
  })

  router.patch(DOCS, async ({ ctx, params, path }) => {
    const collection = collectionOf(ctx, path)
    const data = obj(params.data)
    const queries = list(params.queries)
    if (await staged(ctx, params, path, 'bulkUpdate', null, { data, queries })) {
      return json({ total: 0, documents: [] })
    }
    const updated = await ctx.store.updateDocuments(ctx.caller, collection, data, queries)
    return json({ total: updated.length, documents: updated })
  })

  router.delete(DOCS, async ({ ctx, params, path }) => {
    const collection = collectionOf(ctx, path)
    const queries = list(params.queries)
    if (await staged(ctx, params, path, 'bulkDelete', null, { queries })) {
      return json({ total: 0, documents: [] })
    }
    const deleted = await ctx.store.deleteDocuments(ctx.caller, collection, queries)
    return json({ total: deleted.length, documents: deleted })
  })

  router.put(`${DOCS}/:documentId`, async ({ ctx, params, path, request }) => {
    const collection = collectionOf(ctx, path)
    const { $revision, ...data } = obj(params.data)
    const revision = expectedRevision(request, $revision ?? params.revision)
    assertNoRevision(revision, str(params.transactionId))
    if (await staged(ctx, params, path, 'upsert', path.documentId!, { data, permissions: params.permissions })) {
      return json(mockDocument(collection, path.documentId!, data), 201)
    }
    const { value, events } = await ctx.writes.submit((sink) =>
      ctx.store.upsertDocumentInTx(ctx.caller, collection, path.documentId!, data, params.permissions ?? null, { events: sink, revision }),
    )
    ctx.events.push(...events)
    return json(value.doc, 201)
  })

  router.patch(`${DOCS}/:documentId`, async ({ ctx, params, path, request }) => {
    const collection = collectionOf(ctx, path)
    const { $revision, ...data } = obj(params.data)
    const revision = expectedRevision(request, $revision ?? params.revision)
    const transactionId = str(params.transactionId)
    if (transactionId) {
      assertNoRevision(revision, transactionId)
      const base = await ctx.transactions.withStaged(ctx.caller, transactionId, async () => {
        try {
          return await ctx.store.getDocument(ctx.caller, collection, path.documentId!)
        } catch {
          return null
        }
      })
      await staged(ctx, params, path, 'update', path.documentId!, { data, permissions: params.permissions })
      return json(mockDocument(collection, path.documentId!, data, base))
    }
    const { value: doc, events } = await ctx.writes.submit((sink) =>
      ctx.store.updateDocumentInTx(ctx.caller, collection, path.documentId!, data, params.permissions ?? null, { events: sink, revision }),
    )
    ctx.events.push(...events)
    return json(doc)
  })

  router.delete(`${DOCS}/:documentId`, async ({ ctx, params, path, request }) => {
    const collection = collectionOf(ctx, path)
    const revision = expectedRevision(request, params.revision)
    assertNoRevision(revision, str(params.transactionId))
    if (await staged(ctx, params, path, 'delete', path.documentId!, {})) return noContent()
    const { events } = await ctx.writes.submit((sink) => ctx.store.deleteDocumentInTx(ctx.caller, collection, path.documentId!, { events: sink, revision }))
    ctx.events.push(...events)
    return noContent()
  })

  for (const action of ['increment', 'decrement'] as const) {
    router.patch(`${DOCS}/:documentId/:attribute/${action}`, async ({ ctx, params, path, request }) => {
      const collection = collectionOf(ctx, path)
      const value = num(params.value, 1)!
      const bound = num(action === 'increment' ? params.max : params.min) ?? null
      const revision = expectedRevision(request, params.revision)
      assertNoRevision(revision, str(params.transactionId))
      if (await staged(ctx, params, path, action, path.documentId!, { attribute: path.attribute, value, bound })) {
        return json(mockDocument(collection, path.documentId!, { [path.attribute!]: value }))
      }
      const { value: doc, events } = await ctx.writes.submit((sink) =>
        ctx.store.incrementAttributeInTx(ctx.caller, collection, path.documentId!, path.attribute!, value, bound, action === 'increment' ? 1 : -1, {
          events: sink,
          revision,
        }),
      )
      ctx.events.push(...events)
      return json(doc)
    })
  }
}

export function transactionRoutes(router: Router<AppContext>): void {
  router.post('/databases/transactions', async ({ ctx, params }) => json(await ctx.transactions.create(ctx.caller, num(params.ttl, 300)), 201))
  router.get('/databases/transactions', async ({ ctx }) => json(await ctx.transactions.list(ctx.caller)))
  router.get('/databases/transactions/:transactionId', async ({ ctx, path }) => json(await ctx.transactions.get(ctx.caller, path.transactionId!)))
  router.patch('/databases/transactions/:transactionId', async ({ ctx, params, path }) =>
    json(await ctx.transactions.update(ctx.caller, path.transactionId!, bool(params.commit, false), bool(params.rollback, false))),
  )
  router.delete('/databases/transactions/:transactionId', async ({ ctx, path }) => {
    await ctx.transactions.delete(ctx.caller, path.transactionId!)
    return noContent()
  })
  router.post('/databases/transactions/:transactionId/operations', async ({ ctx, params, path }) => {
    for (const raw of list(params.operations)) {
      const op = obj(raw)
      const action = op.action as Action
      const data = op.data
      const record = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
      const input: Record<string, unknown> =
        action === 'create' || action === 'update' || action === 'upsert'
          ? { data: { ...record, $permissions: undefined }, permissions: record.$permissions }
          : action === 'increment' || action === 'decrement'
            ? { attribute: record.attribute ?? record.column, value: record.value ?? 1, bound: record.max ?? record.min ?? null }
            : action === 'bulkCreate' || action === 'bulkUpsert'
              ? { documents: Array.isArray(data) ? data : (record.documents ?? []) }
              : { data: record.data ?? {}, queries: record.queries ?? [] }
      const payload = input.data
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) delete (payload as Record<string, unknown>).$permissions
      await ctx.transactions.stage(ctx.caller, path.transactionId!, {
        databaseId: String(op.databaseId ?? ''),
        collectionId: String(op.collectionId ?? op.tableId ?? ''),
        documentId: (op.documentId ?? op.rowId ?? null) as string | null,
        action,
        data: input,
      })
    }
    return json(await ctx.transactions.get(ctx.caller, path.transactionId!), 201)
  })
}
