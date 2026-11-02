/**
 * /v1/vectors and /v1/rag — the built-in vector store and RAG extension.
 *
 *   GET    /vectors                                  list collections
 *   POST   /vectors                                  create a collection
 *   GET    /vectors/:collectionId                    collection details
 *   DELETE /vectors/:collectionId                    drop a collection and its points
 *
 *   GET    /vectors/:collectionId/points             list points
 *   POST   /vectors/:collectionId/points             upsert one point or a batch
 *   GET    /vectors/:collectionId/points/:pointId    read one point
 *   PUT    /vectors/:collectionId/points/:pointId    upsert one point
 *   DELETE /vectors/:collectionId/points/:pointId    delete one point
 *   POST   /vectors/:collectionId/search             similarity search
 *
 *   GET    /vectors/:collectionId/documents/:id      chunks of one ingested document
 *   DELETE /vectors/:collectionId/documents/:id      delete one ingested document
 *
 *   POST   /rag/ingest                               chunk, embed and store text
 *   POST   /rag/query                                retrieve context and optionally answer
 *
 * Everything needs an API key. A point may carry an explicit `vector`, or
 * `content` that the configured embedder turns into one.
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { err } from '~/lib/errors'
import { bool, json, noContent, num, str } from '~/lib/http'
import type { Router } from '~/lib/router'
import type { PointInput } from './types'

function pointFrom(value: unknown, fallbackId?: string): PointInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw err('general_argument_invalid', 'Each point must be an object.')
  }
  return { ...(value as PointInput), ...(fallbackId ? { id: fallbackId } : {}) }
}

export function vectorRoutes(router: Router<AppContext>): void {
  router.get('/vectors', async ({ ctx }) => {
    requireKey(ctx, 'vectorsdb.collections.read')
    const collections = await ctx.vectors.listCollections()
    return json({ total: collections.length, collections })
  })

  router.post('/vectors', async ({ ctx, params }) => {
    requireKey(ctx, 'vectorsdb.collections.write')
    const collection = await ctx.vectors.createCollection({
      id: params.collectionId ?? params.id,
      name: params.name,
      dimension: params.dimension,
      metric: params.metric,
    })
    return json(collection, 201)
  })

  router.get('/vectors/:collectionId', async ({ ctx, path }) => {
    requireKey(ctx, 'vectorsdb.collections.read')
    return json(await ctx.vectors.getCollection(path.collectionId!))
  })

  router.delete('/vectors/:collectionId', async ({ ctx, path }) => {
    requireKey(ctx, 'vectorsdb.collections.write')
    await ctx.vectors.deleteCollection(path.collectionId!)
    return noContent()
  })

  router.get('/vectors/:collectionId/points', async ({ ctx, path, params }) => {
    requireKey(ctx, 'vectorsdb.documents.read')
    return json(
      await ctx.vectors.listPoints(path.collectionId!, {
        documentId: str(params.documentId),
        limit: num(params.limit),
        offset: num(params.offset),
      }),
    )
  })

  router.post('/vectors/:collectionId/points', async ({ ctx, path, params }) => {
    requireKey(ctx, 'vectorsdb.documents.write')
    const batch =
      params.points === undefined
        ? [pointFrom(params)]
        : Array.isArray(params.points)
          ? params.points.map((point) => pointFrom(point))
          : [pointFrom(params.points)]
    return json({ points: await ctx.vectors.upsertPoints(path.collectionId!, batch) })
  })

  router.get('/vectors/:collectionId/points/:pointId', async ({ ctx, path }) => {
    requireKey(ctx, 'vectorsdb.documents.read')
    return json(await ctx.vectors.getPoint(path.collectionId!, path.pointId!))
  })

  router.put('/vectors/:collectionId/points/:pointId', async ({ ctx, path, params }) => {
    requireKey(ctx, 'vectorsdb.documents.write')
    const [point] = await ctx.vectors.upsertPoints(path.collectionId!, [pointFrom(params, path.pointId!)])
    return json(point)
  })

  router.delete('/vectors/:collectionId/points/:pointId', async ({ ctx, path }) => {
    requireKey(ctx, 'vectorsdb.documents.write')
    await ctx.vectors.deletePoint(path.collectionId!, path.pointId!)
    return noContent()
  })

  router.post('/vectors/:collectionId/search', async ({ ctx, path, params }) => {
    requireKey(ctx, 'vectorsdb.documents.read')
    return json(await ctx.vectors.search(path.collectionId!, params))
  })

  router.get('/vectors/:collectionId/documents/:documentId', async ({ ctx, path, params }) => {
    requireKey(ctx, 'vectorsdb.documents.read')
    return json(
      await ctx.vectors.listDocumentPoints(path.collectionId!, path.documentId!, {
        limit: num(params.limit),
        offset: num(params.offset),
      }),
    )
  })

  router.delete('/vectors/:collectionId/documents/:documentId', async ({ ctx, path }) => {
    requireKey(ctx, 'vectorsdb.documents.write')
    return json({ deleted: await ctx.vectors.deleteDocument(path.collectionId!, path.documentId!) })
  })

  router.post('/rag/ingest', async ({ ctx, params }) => {
    requireKey(ctx, 'vectorsdb.documents.write')
    return json(
      await ctx.vectors.ingest({
        collectionId: params.collectionId,
        documentId: params.documentId,
        text: params.text !== undefined ? params.text : params.content,
        metadata: params.metadata,
        chunkSize: params.chunkSize,
        chunkOverlap: params.chunkOverlap,
      }),
      201,
    )
  })

  router.post('/rag/query', async ({ ctx, params }) => {
    requireKey(ctx, 'vectorsdb.documents.read')
    return json(
      await ctx.vectors.query({
        collectionId: params.collectionId,
        query: params.query !== undefined ? params.query : params.prompt,
        text: params.text,
        topK: num(params.topK),
        filter: params.filter,
        generate: bool(params.generate, true),
      }),
    )
  })
}
