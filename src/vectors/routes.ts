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
 *   GET    /vectors/:collectionId/documents          list ingested documents
 *   POST   /vectors/:collectionId/documents          upload/chunk/embed a document
 *   PUT    /vectors/:collectionId/documents/:id      replace one document's chunks
 *   GET    /vectors/:collectionId/documents/:id      chunks of one ingested document
 *   DELETE /vectors/:collectionId/documents/:id      delete one ingested document
 *
 *   POST   /rag/ingest                               chunk, embed and store text or a file
 *   POST   /rag/query                                retrieve context and optionally answer
 *   POST   /rag/evaluate                             run a golden question set and return metrics
 *
 * Everything needs an API key. A point may carry an explicit `vector`, or
 * `content` that the configured embedder turns into one. Document ingest takes
 * JSON text, a multipart `file`, or a raw request body.
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { err } from '~/lib/errors'
import { bool, json, noContent, num, str } from '~/lib/http'
import { uniqueId } from '~/lib/ids'
import type { Router } from '~/lib/router'
import { MAX_FILE_BYTES } from './limits'
import type { IngestInput, PointInput } from './types'
import { invalid } from './validate'

function pointFrom(value: unknown, fallbackId?: string): PointInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw err('general_argument_invalid', 'Each point must be an object.')
  }
  return { ...(value as PointInput), ...(fallbackId ? { id: fallbackId } : {}) }
}

/** Multipart forms carry metadata as JSON text; JSON bodies already carry an object. */
function metadataParam(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') return value
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // Fall through to the same validation error as an object input.
  }
  throw invalid('Param "metadata" must be an object.')
}

/**
 * Parameters for a document ingest. A multipart form carries a `file`; a raw
 * POST/PUT body is read as an upload too, with `?filename=` or `X-File-Name`
 * naming it. JSON and form bodies without a file keep the old `text` behavior.
 */
async function ingestInput(
  request: Request,
  params: Record<string, unknown>,
  collectionId: string,
  documentId?: string,
): Promise<IngestInput> {
  const input: IngestInput = {
    collectionId,
    documentId: documentId ?? params.documentId,
    text: params.text !== undefined ? params.text : params.content,
    metadata: metadataParam(params.metadata),
    chunkSize: params.chunkSize,
    chunkOverlap: params.chunkOverlap,
  }
  const picked = params.file
  if (picked instanceof Blob && picked.size > 0) {
    input.file = picked
    return input
  }
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!type || type === 'application/json' || type.endsWith('+json') || type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') {
    return input
  }
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_FILE_BYTES) {
    throw invalid(`The file is too large; the limit is ${(MAX_FILE_BYTES / 1024 / 1024).toLocaleString('en-US')} MB.`)
  }
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length === 0) return input
  const name = str(params.filename) ?? request.headers.get('x-file-name') ?? `upload-${uniqueId().slice(0, 8)}`
  input.file = new File([bytes], name, { type })
  return input
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

  router.get('/vectors/:collectionId/documents', async ({ ctx, path, params }) => {
    requireKey(ctx, 'vectorsdb.documents.read')
    const documents = await ctx.vectors.listDocuments(path.collectionId!, num(params.limit))
    return json({ total: documents.length, documents })
  })

  router.post('/vectors/:collectionId/documents', async ({ ctx, path, params, request }) => {
    requireKey(ctx, 'vectorsdb.documents.write')
    return json(await ctx.vectors.ingest(await ingestInput(request, params, path.collectionId!)), 201)
  })

  router.put('/vectors/:collectionId/documents/:documentId', async ({ ctx, path, params, request }) => {
    requireKey(ctx, 'vectorsdb.documents.write')
    return json(await ctx.vectors.ingest(await ingestInput(request, params, path.collectionId!, path.documentId!)))
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

  router.post('/rag/ingest', async ({ ctx, params, request }) => {
    requireKey(ctx, 'vectorsdb.documents.write')
    return json(await ctx.vectors.ingest(await ingestInput(request, params, String(params.collectionId ?? ''))), 201)
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
        hybrid: params.hybrid,
        rerank: params.rerank,
        alpha: params.alpha,
      }),
    )
  })

  router.post('/rag/evaluate', async ({ ctx, params }) => {
    requireKey(ctx, 'vectorsdb.documents.read')
    return json(
      await ctx.vectors.evaluate({
        collectionId: params.collectionId,
        cases: params.cases,
        topK: num(params.topK),
        filter: params.filter,
        generate: bool(params.generate, false),
        hybrid: params.hybrid,
        rerank: params.rerank,
        alpha: params.alpha,
      }),
    )
  })
}
