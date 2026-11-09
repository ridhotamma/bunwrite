/** Vectors and RAG console pages. Markup lives in console/views/vectors. */
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { checked, numberOrUndefined, parseJsonObject, value } from '~/console/forms'
import { pageCount, pageParams } from '~/console/query'
import { emptyEvaluationDraft, evaluationView, type EvaluationDraft } from '~/console/views/evaluation'
import { err, BunwriteError } from '~/lib/errors'
import {
  VECTORS,
  collectionCreateView,
  collectionSettingsView,
  collectionUrl,
  emptyIngestDraft,
  emptyQueryDraft,
  pointCreateView,
  pointUrl,
  pointView,
  pointsView,
  ragView,
  vectorsView,
  type CollectionDraft,
  type IngestDraft,
  type PointDraft,
  type QueryDraft,
  type RagOptions,
  type VectorEnv,
} from '~/console/views/vectors'
import type { EvaluateResult, VectorCollection, VectorMatch, VectorPoint } from '~/vectors/types'

const POINT_LIMIT = 25
const TOP_K = ['5', '10', '20', '50']

function envOf(ctx: ConsoleContext): VectorEnv {
  const config = ctx.services.config.vectors
  return {
    embedder: ctx.services.vectors.embedderName,
    dimension: config.dimension,
    canAnswer: ctx.services.vectors.canAnswer,
    chatModel: config.chatModel,
    maxPoints: config.maxPoints,
    hybrid: config.hybridSearch,
    rerank: config.rerank,
    reranker: ctx.services.vectors.rerankerName,
  }
}

function vectorOf(raw: string, label = 'vector'): number[] | undefined {
  if (raw.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw err('general_argument_invalid', `The ${label} must be a JSON array of numbers.`)
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw err('general_argument_invalid', `The ${label} must be a JSON array of numbers.`)
  }
  return parsed
}

function jsonObject(raw: string, label: string): Record<string, unknown> {
  return parseJsonObject(raw.trim() || '{}', `${label} must be a JSON object.`)
}

function collectionDraft(ctx: ConsoleContext, env: VectorEnv): CollectionDraft {
  return {
    name: value(ctx.form, 'name'),
    id: value(ctx.form, 'id'),
    dimension: value(ctx.form, 'dimension') || String(env.dimension),
    metric: value(ctx.form, 'metric') || 'cosine',
  }
}

function pointDraft(ctx: ConsoleContext): PointDraft {
  return {
    id: value(ctx.form, 'id'),
    content: String(ctx.form.content ?? ''),
    vector: String(ctx.form.vector ?? ''),
    documentId: value(ctx.form, 'documentId'),
    chunkIndex: value(ctx.form, 'chunkIndex') || '0',
    metadata: String(ctx.form.metadata ?? '{}'),
  }
}

function ingestDraft(ctx: ConsoleContext): IngestDraft {
  return {
    text: String(ctx.form.text ?? ''),
    documentId: value(ctx.form, 'documentId'),
    chunkSize: value(ctx.form, 'chunkSize'),
    chunkOverlap: value(ctx.form, 'chunkOverlap'),
    metadata: String(ctx.form.metadata ?? '{}'),
  }
}

function queryDraft(ctx: ConsoleContext, env: VectorEnv): QueryDraft {
  return {
    query: String(ctx.form.query ?? ''),
    topK: value(ctx.form, 'topK') || '5',
    filter: value(ctx.form, 'filter'),
    generate: env.canAnswer && checked(ctx.form.generate),
  }
}

function topKOf(raw: string | null): string {
  return raw && TOP_K.includes(raw) ? raw : '10'
}

function evaluationDraft(ctx: ConsoleContext, env: VectorEnv): EvaluationDraft {
  const fallback = emptyEvaluationDraft(env)
  return {
    name: value(ctx.form, 'name'),
    dataset: String(ctx.form.dataset ?? fallback.dataset),
    topK: value(ctx.form, 'topK') || fallback.topK,
    generate: checked(ctx.form.generate),
    hybrid: checked(ctx.form.hybrid),
    rerank: checked(ctx.form.rerank),
    baselineId: value(ctx.form, 'baselineId'),
  }
}

async function evaluationPage(
  ctx: ConsoleContext,
  collection: VectorCollection,
  options: { draft?: EvaluationDraft; result?: EvaluateResult; error?: string } = {},
): Promise<Response> {
  const env = envOf(ctx)
  const runs = await ctx.services.vectors.listEvaluations(collection.$id, 25)
  const runId = ctx.url.searchParams.get('run')
  let selected
  if (runId) {
    try {
      const run = await ctx.services.vectors.getEvaluation(runId)
      if (run.collectionId === collection.$id) selected = run
    } catch (error) {
      if (!(error instanceof BunwriteError)) throw error
    }
  }
  return ctx.render(
    'Evaluation',
    'vectors',
    evaluationView(env, {
      collection,
      runs,
      draft: options.draft ?? emptyEvaluationDraft(env),
      result: options.result,
      selected,
      error: options.error,
    }),
  )
}

function casesFrom(raw: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw err('general_argument_invalid', 'Cases JSON is not valid JSON.')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw err('general_argument_invalid', 'Cases JSON must be a non-empty array.')
  return parsed
}

async function ragPage(ctx: ConsoleContext, collection: VectorCollection, options: Omit<RagOptions, 'collection' | 'documents'>): Promise<ReturnType<typeof ragView>> {
  const documents = await ctx.services.vectors.listDocuments(collection.$id)
  return ragView(envOf(ctx), { collection, documents, ...options })
}

/** Point-list tab: browse, search and filter. */
async function pointsPage(ctx: ConsoleContext, collection: VectorCollection): Promise<Response> {
  const env = envOf(ctx)
  const { page, limit, offset } = pageParams(ctx.url, POINT_LIMIT)
  const query = (ctx.url.searchParams.get('q') ?? '').trim()
  const filterRaw = (ctx.url.searchParams.get('filter') ?? '').trim()
  const topK = topKOf(ctx.url.searchParams.get('topK'))
  const documentId = ctx.url.searchParams.get('documentId') || undefined
  let searchError = ''
  let matches: VectorMatch[] | undefined
  let total = 0
  let points: VectorPoint[] = []

  if (query || filterRaw) {
    if (!query) searchError = 'Enter a search term to use a metadata filter.'
    let filter: Record<string, unknown> | undefined
    if (!searchError && filterRaw) {
      try {
        filter = jsonObject(filterRaw, 'Filter')
      } catch (error) {
        searchError = error instanceof Error ? error.message : String(error)
      }
    }
    if (!searchError) {
      try {
        const found = await ctx.services.vectors.search(collection.$id, { text: query, topK: Number(topK), filter })
        matches = found.points
        total = found.total
      } catch (error) {
        searchError = error instanceof Error ? error.message : String(error)
      }
    }
  } else {
    const listed = await ctx.services.vectors.listPoints(collection.$id, { documentId, limit, offset })
    points = listed.points
    total = listed.total
  }

  return ctx.render(
    collection.name,
    'vectors',
    pointsView(env, {
      collection,
      points,
      matches,
      total,
      page,
      pages: pageCount(total, limit),
      query,
      filter: filterRaw,
      topK,
      documentId,
      searchError,
    }),
  )
}

export function vectorPages(router: ConsoleRouter): void {
  router.get(VECTORS, async ({ ctx }) => {
    const collections = await ctx.services.vectors.listCollections()
    return ctx.render('Vectors', 'vectors', vectorsView(collections))
  })

  router.get(`${VECTORS}/new`, ({ ctx }) =>
    ctx.render('Create collection', 'vectors', collectionCreateView(envOf(ctx))),
  )

  router.post(VECTORS, async ({ ctx }) => {
    const env = envOf(ctx)
    const draft = collectionDraft(ctx, env)
    try {
      const collection = await ctx.services.vectors.createCollection({
        id: draft.id,
        name: draft.name,
        dimension: Number(draft.dimension),
        metric: draft.metric,
      })
      return ctx.go(collectionUrl(collection.$id), { tone: 'success', text: 'Vector collection created' })
    } catch (error) {
      if (!(error instanceof BunwriteError)) throw error
      return ctx.render('Create collection', 'vectors', collectionCreateView(env, { draft, error: error.message }))
    }
  })

  router.get(`${VECTORS}/:collectionId`, async ({ ctx, path }) => {
    const collection = await ctx.services.vectors.getCollection(path.collectionId!)
    return pointsPage(ctx, collection)
  })

  router.get(`${VECTORS}/:collectionId/rag`, async ({ ctx, path }) => {
    const collection = await ctx.services.vectors.getCollection(path.collectionId!)
    const env = envOf(ctx)
    return ctx.render(
      collection.name,
      'vectors',
      await ragPage(ctx, collection, { ingest: emptyIngestDraft(), query: emptyQueryDraft(env) }),
    )
  })

  router.get(`${VECTORS}/:collectionId/settings`, async ({ ctx, path }) => {
    const collection = await ctx.services.vectors.getCollection(path.collectionId!)
    return ctx.render(collection.name, 'vectors', collectionSettingsView(envOf(ctx), collection))
  })

  router.get(`${VECTORS}/:collectionId/points/new`, async ({ ctx, path }) => {
    const collection = await ctx.services.vectors.getCollection(path.collectionId!)
    return ctx.render('Add point', 'vectors', pointCreateView(envOf(ctx), collection))
  })

  router.post(`${VECTORS}/:collectionId/points`, async ({ ctx, path }) => {
    const collection = await ctx.services.vectors.getCollection(path.collectionId!)
    const env = envOf(ctx)
    const draft = pointDraft(ctx)
    try {
      const [point] = await ctx.services.vectors.upsertPoints(collection.$id, [
        {
          id: draft.id || undefined,
          content: draft.content,
          vector: vectorOf(draft.vector),
          documentId: draft.documentId || undefined,
          chunkIndex: numberOrUndefined(draft.chunkIndex),
          metadata: jsonObject(draft.metadata, 'Metadata'),
        },
      ])
      return ctx.go(pointUrl(collection.$id, point!.$id), { tone: 'success', text: 'Point saved' })
    } catch (error) {
      if (!(error instanceof BunwriteError)) throw error
      return ctx.render('Add point', 'vectors', pointCreateView(env, collection, { draft, error: error.message }))
    }
  })

  router.get(`${VECTORS}/:collectionId/points/:pointId`, async ({ ctx, path }) => {
    const collection = await ctx.services.vectors.getCollection(path.collectionId!)
    const point = await ctx.services.vectors.getPoint(collection.$id, path.pointId!)
    return ctx.render(point.$id, 'vectors', pointView(collection, point))
  })

  router.post(`${VECTORS}/:collectionId/points/:pointId/delete`, async ({ ctx, path }) => {
    await ctx.services.vectors.deletePoint(path.collectionId!, path.pointId!)
    return ctx.go(collectionUrl(path.collectionId!), { tone: 'success', text: 'Point deleted' })
  })

  router.post(`${VECTORS}/:collectionId/reindex`, async ({ ctx, path }) => {
    const result = await ctx.services.vectors.reindex(path.collectionId!)
    return ctx.go(`${collectionUrl(path.collectionId!)}/settings`, {
      tone: 'success',
      text: `Re-embedded ${result.points} point${result.points === 1 ? '' : 's'} at ${result.dimension} dimensions`,
    })
  })

  router.post(`${VECTORS}/:collectionId/delete`, async ({ ctx, path }) => {
    await ctx.services.vectors.deleteCollection(path.collectionId!)
    return ctx.go(VECTORS, { tone: 'success', text: 'Vector collection deleted' })
  })

  router.post(`${VECTORS}/:collectionId/rag/ingest`, async ({ ctx, path }) => {
    const collection = await ctx.services.vectors.getCollection(path.collectionId!)
    const env = envOf(ctx)
    const draft = ingestDraft(ctx)
    const upload = ctx.form.file
    try {
      const result = await ctx.services.vectors.ingest({
        collectionId: collection.$id,
        documentId: draft.documentId || undefined,
        file: upload instanceof Blob && upload.size > 0 ? upload : undefined,
        text: draft.text,
        metadata: jsonObject(draft.metadata, 'Metadata'),
        chunkSize: numberOrUndefined(draft.chunkSize),
        chunkOverlap: numberOrUndefined(draft.chunkOverlap),
      })
      return ctx.go(`${collectionUrl(collection.$id)}/rag`, {
        tone: 'success',
        text: `Ingested ${result.chunks} chunk${result.chunks === 1 ? '' : 's'} from ${result.format.toUpperCase()}`,
      })
    } catch (error) {
      if (!(error instanceof BunwriteError)) throw error
      return ctx.render(
        collection.name,
        'vectors',
        await ragPage(ctx, collection, {
          ingest: draft,
          query: emptyQueryDraft(env),
          error: error.message,
        }),
      )
    }
  })

  router.post(`${VECTORS}/:collectionId/rag/query`, async ({ ctx, path }) => {
    const collection = await ctx.services.vectors.getCollection(path.collectionId!)
    const env = envOf(ctx)
    const draft = queryDraft(ctx, env)
    let filter: Record<string, unknown> | undefined
    try {
      filter = draft.filter ? jsonObject(draft.filter, 'Filter') : undefined
      const result = await ctx.services.vectors.query({
        collectionId: collection.$id,
        query: draft.query,
        topK: Number(draft.topK),
        filter,
        generate: draft.generate,
      })
      return ctx.render(
        collection.name,
        'vectors',
        await ragPage(ctx, collection, { ingest: emptyIngestDraft(), query: draft, result }),
      )
    } catch (error) {
      if (!(error instanceof BunwriteError)) throw error
      return ctx.render(
        collection.name,
        'vectors',
        await ragPage(ctx, collection, { ingest: emptyIngestDraft(), query: draft, error: error.message }),
      )
    }
  })

  router.get(`${VECTORS}/:collectionId/evaluation`, async ({ ctx, path }) => {
    const collection = await ctx.services.vectors.getCollection(path.collectionId!)
    return evaluationPage(ctx, collection)
  })

  router.post(`${VECTORS}/:collectionId/evaluation`, async ({ ctx, path }) => {
    const collection = await ctx.services.vectors.getCollection(path.collectionId!)
    const env = envOf(ctx)
    const draft = evaluationDraft(ctx, env)
    try {
      const result = await ctx.services.vectors.evaluate({
        collectionId: collection.$id,
        cases: casesFrom(draft.dataset),
        topK: Number(draft.topK),
        generate: draft.generate,
        hybrid: draft.hybrid,
        rerank: draft.rerank,
        baselineId: draft.baselineId || undefined,
        name: draft.name || undefined,
        save: true,
      })
      return evaluationPage(ctx, collection, { draft, result })
    } catch (error) {
      if (!(error instanceof BunwriteError)) throw error
      return evaluationPage(ctx, collection, { draft, error: error.message })
    }
  })

  router.post(`${VECTORS}/:collectionId/evaluation/:evaluationId/delete`, async ({ ctx, path }) => {
    await ctx.services.vectors.deleteEvaluation(path.evaluationId!)
    return ctx.go(`${collectionUrl(path.collectionId!)}/evaluation`, { tone: 'success', text: 'Evaluation run deleted' })
  })

  router.post(`${VECTORS}/:collectionId/documents/:documentId/delete`, async ({ ctx, path }) => {
    const deleted = await ctx.services.vectors.deleteDocument(path.collectionId!, path.documentId!)
    return ctx.go(`${collectionUrl(path.collectionId!)}/rag`, {
      tone: 'success',
      text: `Deleted ${deleted} chunk${deleted === 1 ? '' : 's'}`,
    })
  })
}
