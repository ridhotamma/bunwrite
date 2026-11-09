/** The Console's Vectors and RAG pages: list, create, points, search, ingest and query. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ConsoleAuth } from '~/console/auth'
import { PROJECT, startServer, type TestServer } from './helpers'

let server: TestServer
let base: string
let cookie = ''

async function form(path: string, fields: Record<string, string | string[]>) {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) for (const one of ([] as string[]).concat(value)) body.append(key, one)
  return fetch(`${base}${path}`, {
    method: 'POST',
    body,
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  })
}

async function upload(path: string, file: File, fields: Record<string, string> = {}) {
  const body = new FormData()
  body.append('file', file)
  for (const [key, value] of Object.entries(fields)) body.append(key, value)
  return fetch(`${base}${path}`, { method: 'POST', body, redirect: 'manual', headers: { cookie } })
}

const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' })
const flash = (res: Response) => new URL(res.headers.get('location') ?? '/', base).searchParams

beforeAll(async () => {
  server = startServer()
  base = server.endpoint.replace(/\/v1$/, '')
  await new ConsoleAuth(server.db).upsert('admin@example.com', 'console-password')
  const login = await fetch(`${base}/console/login`, {
    method: 'POST',
    body: new URLSearchParams({ email: 'admin@example.com', password: 'console-password' }),
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  cookie = `${login.headers.get('set-cookie')!.split(';')[0]!}; console_project=${PROJECT}`
})

afterAll(() => server.stop())

describe('vectors console', () => {
  test('the nav entry, list and create pages render', async () => {
    const list = await get('/console/vectors')
    expect(list.status).toBe(200)
    const body = await list.text()
    expect(body).toContain('href="/console/vectors" class="on"')
    expect(body).toContain('No vector collections yet')
    expect(body).toContain('Create collection')
    // Configuration lives in Settings instead of an explanatory paragraph.
    expect(body).toContain('href="/console/settings/vectors"')
    expect(body).not.toContain('Points live in this project')

    const create = await (await get('/console/vectors/new')).text()
    expect(create).toContain('Create collection')
    expect(create).toContain('name="dimension"')
    expect(create).toContain('Cosine similarity')
    expect(create).toContain('local:64')
    expect(create).toContain('data-slug-from="name"')

    expect(await (await get('/console/overview')).text()).toContain('href="/console/vectors"')
  })

  test('a collection is created from the form and its page shows the tabs', async () => {
    const created = await form('/console/vectors', { name: 'Knowledge', id: 'knowledge', dimension: '64', metric: 'cosine' })
    expect(created.status).toBe(303)
    expect(created.headers.get('location')).toStartWith('/console/vectors/knowledge')

    const page = await (await get('/console/vectors/knowledge')).text()
    expect(page).toContain('Knowledge')
    expect(page).toContain('Points')
    expect(page).toContain('RAG')
    expect(page).toContain('Settings')
    expect(page).toContain('/console/vectors/knowledge/points/new')
    // The old summary cards were moved into the collection's Settings tab.
    expect(page).not.toContain('class="stats"')
    expect(page).toContain('/console/vectors/knowledge/settings')
  })

  test('a text point is embedded, listed, inspected and searched', async () => {
    const saved = await form('/console/vectors/knowledge/points', {
      id: 'p1',
      content: 'Bunwrite stores vectors in SQLite and Postgres.',
      chunkIndex: '0',
      metadata: '{"source":"guide","lang":"en"}',
    })
    expect(saved.status).toBe(303)
    expect(saved.headers.get('location')).toStartWith('/console/vectors/knowledge/points/p1')

    const point = await (await get('/console/vectors/knowledge/points/p1')).text()
    expect(point).toContain('Bunwrite stores vectors in SQLite and Postgres.')
    expect(point).toContain('id="vector-point-id"')
    expect(point).toContain('source')
    expect(point).toContain('guide')

    const list = await (await get('/console/vectors/knowledge')).text()
    expect(list).toContain('p1')
    expect(list).toContain('Bunwrite stores vectors')

    const found = await (await get('/console/vectors/knowledge?q=Postgres&topK=5')).text()
    expect(found).toContain('Search points by text')
    expect(found).toContain('value="Postgres"')
    expect(found).toContain('hx-trigger="submit"')
    expect(found).toContain('p1')
    expect(found).toContain('Score')
    expect(found).toContain('matching point')

    const filtered = await (await get(`/console/vectors/knowledge?q=Postgres&filter=${encodeURIComponent('{"source":"guide"}')}`)).text()
    expect(filtered).toContain('p1')

    // A point can also be stored with an explicit vector.
    const vector = JSON.stringify(Array.from({ length: 64 }, (_, index) => (index === 0 ? 1 : 0)))
    const vectorSaved = await form('/console/vectors/knowledge/points', {
      id: 'v1',
      vector,
      metadata: '{"source":"external"}',
    })
    expect(vectorSaved.status).toBe(303)
    expect(await (await get('/console/vectors/knowledge/points/v1')).text()).toContain('vector-only')
  })

  test('bad input comes back on the page without losing the draft', async () => {
    const badVector = await form('/console/vectors/knowledge/points', { content: 'Keep me', vector: 'not-json' })
    expect(badVector.status).toBe(200)
    const body = await badVector.text()
    expect(body).toContain('must be a JSON array')
    expect(body).toContain('Keep me')

    const badFilter = await (await get(`/console/vectors/knowledge?q=Postgres&filter=${encodeURIComponent('{bad')}`)).text()
    expect(badFilter).toContain('Filter must be a JSON object')
  })

  test('RAG ingests chunks, lists documents and answers without a model', async () => {
    const ingested = await form('/console/vectors/knowledge/rag/ingest', {
      documentId: 'handbook',
      text: 'Bunwrite is a lightweight backend on Bun. It stores data in SQLite or Postgres, and runs vector search in the process.',
      metadata: '{"source":"handbook.md"}',
      chunkSize: '240',
      chunkOverlap: '20',
    })
    expect(ingested.status).toBe(303)
    expect(ingested.headers.get('location')).toStartWith('/console/vectors/knowledge/rag')
    expect(flash(ingested).get('ok')).toContain('Ingested')

    const page = await (await get('/console/vectors/knowledge/rag')).text()
    expect(page).toContain('Ask a question')
    expect(page).toContain('Ingest a document')
    expect(page).toContain('handbook')
    expect(page).not.toContain('No ingested documents')
    // Answer generation is configured in Settings; the RAG page stays quiet.
    expect(page).not.toContain('Answer generation is off')
    expect(page).not.toContain('class="stats"')

    const answer = await form('/console/vectors/knowledge/rag/query', {
      query: 'Which database does Bunwrite use?',
      topK: '5',
      filter: '',
    })
    expect(answer.status).toBe(200)
    const body = await answer.text()
    expect(body).toContain('No generated answer')
    expect(body).toContain('Sources')
    expect(body).toContain('Context')
    expect(body).toContain('SQLite')
    expect(body).toContain('handbook')

    const badFilter = await form('/console/vectors/knowledge/rag/query', {
      query: 'anything',
      topK: '5',
      filter: '{bad',
    })
    expect(await badFilter.text()).toContain('Filter must be a JSON object')
  })

  test('a file upload is converted and the page reports the source format', async () => {
    const uploaded = await upload(
      '/console/vectors/knowledge/rag/ingest',
      new File(['# Uploaded handbook\n\nUploaded files become chunks without pasting text.'], 'uploaded-handbook.md', { type: 'text/markdown' }),
      { metadata: '{"source":"upload"}', chunkSize: '240', chunkOverlap: '20' },
    )
    expect(uploaded.status).toBe(303)
    expect(flash(uploaded).get('ok')).toContain('MARKDOWN')

    const page = await (await get('/console/vectors/knowledge/rag')).text()
    expect(page).toContain('uploaded-handbook')
    expect(page).toContain('uploaded-handbook.md')
    expect(page).toContain('name="file"')
    expect(page).toContain('enctype="multipart/form-data"')
    expect(page).toContain('Drag and drop a document here')

    await form('/console/vectors/knowledge/documents/uploaded-handbook/delete', {})
  })

  test('the evaluation dashboard runs a golden set and stores history', async () => {
    const page = await (await get('/console/vectors/knowledge/evaluation')).text()
    expect(page).toContain('Run an evaluation')
    expect(page).toContain('Cases JSON')
    expect(page).toContain('No evaluation runs')

    const run = await form('/console/vectors/knowledge/evaluation', {
      name: 'smoke',
      dataset: JSON.stringify([{ id: 'database', query: 'Which database does Bunwrite use?', expectedDocuments: ['handbook'], expectedKeywords: ['SQLite'] }]),
      topK: '2',
      hybrid: 'on',
      rerank: 'on',
    })
    expect(run.status).toBe(200)
    const result = await run.text()
    expect(result).toContain('Result')
    expect(result).toContain('Recall@k')
    expect(result).toContain('Pass')
    expect(result).toContain('smoke')

    const history = await (await get('/console/vectors/knowledge/evaluation')).text()
    expect(history).toContain('smoke')
    expect(history).toContain('/evaluation?run=')
  })

  test('documents and the collection can be deleted', async () => {
    const deleted = await form('/console/vectors/knowledge/documents/handbook/delete', {})
    expect(deleted.status).toBe(303)
    expect(flash(deleted).get('ok')).toContain('Deleted')

    const afterDocument = await (await get('/console/vectors/knowledge/rag')).text()
    expect(afterDocument).toContain('No ingested documents')

    const settings = await (await get('/console/vectors/knowledge/settings')).text()
    expect(settings).toContain('Collection')
    expect(settings).toContain('Delete collection')
    expect(settings).toContain('local:64')
    expect(settings).toContain('2 / 50,000')
    expect(settings).toContain('href="/console/settings/vectors"')

    const removed = await form('/console/vectors/knowledge/delete', {})
    expect(removed.status).toBe(303)
    expect(removed.headers.get('location')).toStartWith('/console/vectors')
    expect(await (await get('/console/vectors')).text()).toContain('No vector collections yet')
  })

  test('a duplicate collection ID is reported in place', async () => {
    expect((await form('/console/vectors', { name: 'Dup', id: 'dup', dimension: '64' })).status).toBe(303)
    const duplicate = await form('/console/vectors', { name: 'Dup again', id: 'dup', dimension: '64' })
    expect(duplicate.status).toBe(200)
    const body = await duplicate.text()
    expect(body).toContain('already exists')
    expect(body).toContain('Dup again')
    await form('/console/vectors/dup/delete', {})
  })

  test('Vectors & RAG settings are editable in the console and apply live', async () => {
    const page = await (await get('/console/settings/vectors')).text()
    expect(page).toContain('Embeddings')
    expect(page).toContain('Answer generation')
    expect(page).toContain('Retrieval and reranking')
    expect(page).toContain('Ingestion and limits')
    expect(page).toContain('action="/console/settings/vectors/embedding"')
    expect(page).toContain('action="/console/settings/vectors/answers"')
    expect(page).toContain('action="/console/settings/vectors/retrieval"')
    expect(page).toContain('action="/console/settings/vectors/guardrails"')
    expect(page).toContain('action="/console/settings/vectors/limits"')

    const retrieval = await form('/console/settings/vectors/retrieval', {
      hybridSearch: 'on',
      hybridAlpha: '0.3',
      rerank: 'on',
      rerankUrl: 'https://api.example.com/v1',
      rerankModel: 'rerank-test',
      rerankApiKey: 'rerank-key',
      rerankCandidates: '40',
      multiHop: 'on',
      multiHopQueries: '4',
    })
    expect(retrieval.status).toBe(303)
    expect(server.config.vectors).toMatchObject({
      hybridSearch: true,
      hybridAlpha: 0.3,
      rerank: true,
      rerankUrl: 'https://api.example.com/v1',
      rerankModel: 'rerank-test',
      rerankApiKey: 'rerank-key',
      rerankCandidates: 40,
      multiHop: true,
      multiHopQueries: 4,
    })
    expect(server.services.vectors.rerankerName).toBe('http:rerank-test')

    const guardrails = await form('/console/settings/vectors/guardrails', { redactPii: 'on', promptInjectionGuard: 'on', auditQueries: 'on' })
    expect(guardrails.status).toBe(303)
    expect(server.config.vectors).toMatchObject({ redactPii: true, promptInjectionGuard: true, auditQueries: true })

    const limits = await form('/console/settings/vectors/limits', { maxPoints: '1200', chunkSize: '600', chunkOverlap: '100' })
    expect(limits.status).toBe(303)
    expect(server.config.vectors).toMatchObject({ maxPoints: 1200, chunkSize: 600, chunkOverlap: 100 })

    const answers = await form('/console/settings/vectors/answers', {
      enabled: 'on',
      chatUrl: 'https://api.example.com/v1',
      chatModel: 'gpt-test',
      chatApiKey: 'chat-key',
      chatSystemPrompt: 'Answer briefly.',
      chatTemperature: '0.4',
      chatMaxTokens: '500',
      contextChars: '8000',
    })
    expect(answers.status).toBe(303)
    expect(server.config.vectors).toMatchObject({
      chatUrl: 'https://api.example.com/v1',
      chatModel: 'gpt-test',
      chatApiKey: 'chat-key',
      chatSystemPrompt: 'Answer briefly.',
      chatTemperature: 0.4,
      chatMaxTokens: 500,
      contextChars: 8000,
    })
    expect(server.services.vectors.canAnswer).toBe(true)

    const embedding = await form('/console/settings/vectors/embedding', {
      embedder: 'http',
      dimension: '64',
      embeddingUrl: 'https://api.example.com/v1',
      embeddingModel: 'embed-test',
      embeddingApiKey: 'embed-key',
      embeddingBatchSize: '32',
      timeoutMs: '20000',
      sendDimensions: 'on',
    })
    expect(embedding.status).toBe(303)
    expect(server.config.vectors).toMatchObject({
      embedder: 'http',
      dimension: 64,
      embeddingUrl: 'https://api.example.com/v1',
      embeddingModel: 'embed-test',
      embeddingApiKey: 'embed-key',
      embeddingBatchSize: 32,
      timeoutMs: 20000,
      sendDimensions: true,
    })
    expect(server.services.vectors.embedderName).toBe('http:embed-test')
    const saved = await (await get('/console/settings/vectors')).text()
    expect(saved).toContain('value="embed-test"')
    expect(saved).not.toContain('embed-key')
    expect(saved).not.toContain('chat-key')
    expect(saved).not.toContain('rerank-key')

    await form('/console/settings/vectors/reset', {})
    expect(server.config.vectors).toMatchObject({
      embedder: 'local',
      dimension: 64,
      maxPoints: 50000,
      chunkSize: 1000,
      chunkOverlap: 200,
      chatUrl: '',
      hybridSearch: true,
      hybridAlpha: 0.55,
      rerank: true,
      rerankUrl: '',
      rerankCandidates: 0,
      redactPii: false,
      promptInjectionGuard: true,
      auditQueries: false,
      multiHop: false,
      multiHopQueries: 3,
    })
    expect(server.services.vectors.canAnswer).toBe(false)
    expect(server.services.vectors.embedderName).toBe('local:64')
  })
})
