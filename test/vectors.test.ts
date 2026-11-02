/**
 * Built-in vector store and RAG: portable storage, similarity metrics, local
 * embeddings, chunked ingest, and the HTTP extension.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { postgresSystemIndexStatements, postgresSystemStatements } from '~/db/postgres-schema'
import { chunkText } from '~/vectors/chunk'
import { vectorConfigFromEnv } from '~/vectors/config'
import { localVector } from '~/vectors/embedder'
import { TopK } from '~/vectors/rank'
import { KEY, PROJECT, startServer, type TestServer } from './helpers'

let server: TestServer

beforeAll(() => {
  server = startServer()
})

afterAll(() => server.stop())

const headers = { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, 'content-type': 'application/json' }
const call = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`${server.endpoint}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  const text = await response.text()
  return { response, body: text ? (JSON.parse(text) as any) : null }
}

describe('vector helpers', () => {
  test('the local embedder is deterministic and normalised', () => {
    const a = localVector('Postgres and SQLite vector search', 64)
    const b = localVector('Postgres and SQLite vector search', 64)
    expect(a).toEqual(b)
    expect(a).toHaveLength(64)
    expect(Math.sqrt(a.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 5)
    expect(localVector('a completely different sentence', 64)).not.toEqual(a)
  })

  test('chunking stays on word boundaries and overlaps', () => {
    const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
    const chunks = chunkText(text, { size: 80, overlap: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, i) => i))
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(80)
    // Adjacent chunks share some words because of the overlap.
    expect(chunks[0]!.text.split(' ')).toContain(chunks[1]!.text.split(' ')[0]!)
  })

  test('bounded top-k keeps the best scores without sorting the whole collection', () => {
    const top = new TopK<number>(3)
    for (const value of [5, 1, 9, 3, 7, 2]) top.push(value, value)
    expect(top.values().map((entry) => entry.item)).toEqual([9, 7, 5])
  })

  test('config switches to an OpenAI-compatible embedder only when configured', () => {
    const local = vectorConfigFromEnv({})
    expect(local).toMatchObject({ embedder: 'local', dimension: 384, chatUrl: '' })
    const remote = vectorConfigFromEnv({ OPENAI_API_KEY: 'sk-test' })
    expect(remote).toMatchObject({ embedder: 'http', dimension: 1536 })
    expect(remote.embeddingUrl).toContain('/v1')
    expect(remote.chatUrl).toContain('/chat/completions')
    expect(vectorConfigFromEnv({ EMBEDDING_URL: 'http://127.0.0.1:11434', EMBEDDING_DIMENSION: '768' })).toMatchObject({
      embedder: 'http',
      dimension: 768,
      embeddingUrl: 'http://127.0.0.1:11434',
    })
  })
})

describe('vector store', () => {
  test('collections are created, listed, read and deleted', async () => {
    const vectors = server.services.vectors
    const created = await vectors.createCollection({ id: 'docs', name: 'Docs' })
    expect(created).toMatchObject({ $id: 'docs', name: 'Docs', dimension: 64, metric: 'cosine', points: 0 })

    expect((await vectors.listCollections()).some((collection) => collection.$id === 'docs')).toBe(true)
    expect(await vectors.getCollection('docs')).toMatchObject({ $id: 'docs', points: 0 })
    expect(await vectors.createCollection({ id: 'docs' }).catch((error) => error)).toMatchObject({ type: 'collection_already_exists' })

    await vectors.deleteCollection('docs')
    expect(await vectors.getCollection('docs').catch((error) => error)).toMatchObject({ type: 'collection_not_found' })
  })

  test('cosine, dot and euclidean ranking, batching and filters', async () => {
    const vectors = server.services.vectors
    await vectors.createCollection({ id: 'cosine', dimension: 3, metric: 'cosine' })
    await vectors.upsertPoints('cosine', [
      { id: 'a', vector: [1, 0, 0], content: 'apple', metadata: { lang: 'en', kind: 'fruit' } },
      { id: 'b', vector: [0, 1, 0], content: 'banana', metadata: { lang: 'id', kind: 'fruit' } },
      { id: 'c', vector: [0.9, 0.1, 0], content: 'apple pie', metadata: { lang: 'en', kind: 'food' } },
    ])
    const result = await vectors.search('cosine', { vector: [1, 0, 0], topK: 2 })
    expect(result.total).toBe(3)
    expect(result.points.map((point) => point.$id)).toEqual(['a', 'c'])
    expect(result.points[0]!.score).toBeCloseTo(1, 6)

    const filtered = await vectors.search('cosine', { vector: [1, 0, 0], filter: { lang: 'en' } })
    expect(filtered.total).toBe(2)
    expect(filtered.points.map((point) => point.$id).sort()).toEqual(['a', 'c'])

    // Upserting an existing ID updates it instead of adding a duplicate.
    await vectors.upsertPoints('cosine', [{ id: 'a', vector: [0, 1, 0], content: 'pear' }])
    expect((await vectors.getCollection('cosine')).points).toBe(3)
    expect((await vectors.getPoint('cosine', 'a')).content).toBe('pear')

    await vectors.createCollection({ id: 'dot', dimension: 2, metric: 'dot' })
    await vectors.upsertPoints('dot', [
      { id: 'small', vector: [1, 0] },
      { id: 'large', vector: [3, 0] },
    ])
    expect((await vectors.search('dot', { vector: [1, 0] })).points.map((point) => point.$id)).toEqual(['large', 'small'])

    await vectors.createCollection({ id: 'euclidean', dimension: 2, metric: 'euclidean' })
    await vectors.upsertPoints('euclidean', [
      { id: 'near', vector: [0, 0] },
      { id: 'far', vector: [3, 4] },
    ])
    const euclidean = await vectors.search('euclidean', { vector: [0, 0] })
    expect(euclidean.points.map((point) => point.$id)).toEqual(['near', 'far'])
    expect(euclidean.points[1]!.score).toBeCloseTo(1 / 6, 6)
  })

  test('dimension mismatches and empty vectors are rejected', async () => {
    const vectors = server.services.vectors
    await vectors.createCollection({ id: 'typed', dimension: 4 })
    expect(await vectors.upsertPoints('typed', [{ id: 'bad', vector: [1, 2] }]).catch((error) => error)).toMatchObject({
      type: 'general_argument_invalid',
    })
    expect(await vectors.search('typed', { vector: [1, 2] }).catch((error) => error)).toMatchObject({
      type: 'general_argument_invalid',
    })
    // A zero vector has no direction but remains a valid point for dot/euclidean.
    expect((await vectors.upsertPoints('typed', [{ id: 'zero', vector: [0, 0, 0, 0] }]))[0]!.$id).toBe('zero')
    expect(
      await vectors
        .upsertPoints('typed', [
          { id: 'duplicate', vector: [1, 0, 0, 0] },
          { id: 'duplicate', vector: [0, 1, 0, 0] },
        ])
        .catch((error) => error),
    ).toMatchObject({ type: 'general_argument_invalid' })
  })

  test('search pages through a collection larger than one scan batch', async () => {
    const vectors = server.services.vectors
    await vectors.createCollection({ id: 'large', dimension: 2 })
    for (let start = 0; start < 2100; start += 100) {
      const points = Array.from({ length: Math.min(100, 2100 - start) }, (_, index) => ({
        id: `p${start + index}`,
        vector: [start + index, 1],
      }))
      await vectors.upsertPoints('large', points)
    }
    const result = await vectors.search('large', { vector: [2099, 1], topK: 3 })
    expect(result.total).toBe(2100)
    expect(result.points.map((point) => point.$id)).toEqual(['p2099', 'p2098', 'p2097'])
  })

  test('deletes points and whole documents', async () => {
    const vectors = server.services.vectors
    await vectors.createCollection({ id: 'delete-me', dimension: 2 })
    await vectors.upsertPoints('delete-me', [
      { id: 'p1', vector: [1, 0], documentId: 'doc' },
      { id: 'p2', vector: [0, 1], documentId: 'doc' },
      { id: 'p3', vector: [1, 1], documentId: 'other' },
    ])
    await vectors.deletePoint('delete-me', 'p3')
    expect(await vectors.deletePoint('delete-me', 'p3').catch((error) => error)).toMatchObject({ type: 'document_not_found' })
    expect(await vectors.deleteDocument('delete-me', 'doc')).toBe(2)
    expect((await vectors.listPoints('delete-me')).total).toBe(0)
  })
})

describe('RAG', () => {
  test('ingest chunks and embeds text, searches it, and replaces a document on re-ingest', async () => {
    const vectors = server.services.vectors
    await vectors.createCollection({ id: 'rag', name: 'Knowledge' })
    const text = Array.from({ length: 80 }, (_, i) => `Sentence ${i} covers ${i % 2 ? 'Postgres' : 'SQLite'} vector search.`).join(' ')
    const first = await vectors.ingest({
      collectionId: 'rag',
      documentId: 'handbook',
      text,
      metadata: { source: 'handbook.md', lang: 'en' },
      chunkSize: 220,
      chunkOverlap: 30,
    })
    expect(first.chunks).toBeGreaterThan(1)
    const chunks = await vectors.listDocumentPoints('rag', 'handbook')
    expect(chunks.total).toBe(first.chunks)
    expect(chunks.points[0]).toMatchObject({ documentId: 'handbook', chunkIndex: 0, metadata: { source: 'handbook.md', lang: 'en' } })

    const found = await vectors.search('rag', { text: 'Postgres vector search', topK: 3, filter: { source: 'handbook.md' } })
    expect(found.points.length).toBeGreaterThan(0)
    expect(found.points[0]!.content.toLowerCase()).toContain('vector')

    const replaced = await vectors.ingest({ collectionId: 'rag', documentId: 'handbook', text: 'A much shorter handbook about RAG.' })
    expect(replaced.chunks).toBe(1)
    expect((await vectors.listPoints('rag')).total).toBe(1)
    expect(await vectors.deleteDocument('rag', 'handbook')).toBe(1)
  })

  test('query returns context and sources without a chat provider', async () => {
    const vectors = server.services.vectors
    await vectors.createCollection({ id: 'rag-query', dimension: 64 })
    await vectors.ingest({
      collectionId: 'rag-query',
      documentId: 'notes',
      text: 'Bunwrite stores vectors in ordinary SQLite and Postgres tables. Local embeddings need no API key.',
    })
    const result = await vectors.query({ collectionId: 'rag-query', query: 'Where are vectors stored?' })
    expect(result.answer).toBeNull()
    expect(result.model).toBeNull()
    expect(result.context).toContain('SQLite')
    expect(result.sources.length).toBeGreaterThan(0)
    expect(result.sources[0]!.content).toContain('Bunwrite')
    expect(Number.isFinite(result.sources[0]!.score)).toBe(true)
  })
})

describe('HTTP extension', () => {
  test('collections, points, search and RAG are reachable with an API key', async () => {
    const created = await call('/vectors', { method: 'POST', body: JSON.stringify({ collectionId: 'http', dimension: 64 }) })
    expect(created.response.status).toBe(201)
    expect(created.body).toMatchObject({ $id: 'http', dimension: 64 })

    const point = await call('/vectors/http/points', {
      method: 'POST',
      body: JSON.stringify({ points: [{ id: 'p1', content: 'Bunwrite is a lightweight backend on Bun and SQLite.' }] }),
    })
    expect(point.response.status).toBe(200)
    expect(point.body.points[0].$id).toBe('p1')

    const found = await call('/vectors/http/search', { method: 'POST', body: JSON.stringify({ text: 'SQLite backend', topK: 1 }) })
    expect(found.response.status).toBe(200)
    expect(found.body.points[0].$id).toBe('p1')

    const ingest = await call('/rag/ingest', {
      method: 'POST',
      body: JSON.stringify({ collectionId: 'http', documentId: 'guide', text: 'RAG joins retrieval with generation. Bunwrite can return the context alone.' }),
    })
    expect(ingest.response.status).toBe(201)
    expect(ingest.body.chunks).toBe(1)

    const query = await call('/rag/query', {
      method: 'POST',
      body: JSON.stringify({ collectionId: 'http', query: 'What does RAG join?', generate: false }),
    })
    expect(query.response.status).toBe(200)
    expect(query.body.answer).toBeNull()
    expect(query.body.sources.length).toBeGreaterThan(0)

    const collection = await call('/vectors/http')
    expect(collection.body.points).toBe(2)
    expect((await call('/vectors/http', { method: 'DELETE' })).response.status).toBe(204)
  })

  test('a scoped key needs the vectorsdb scope', async () => {
    const key = (await server.services.settings.createKey('vector-reader', null, ['vectorsdb.collections.read'])).secret
    const read = await call('/vectors', { headers: { 'x-appwrite-key': key } })
    expect(read.response.status).toBe(200)
    const denied = await call('/vectors', {
      method: 'POST',
      headers: { 'x-appwrite-key': key },
      body: JSON.stringify({ collectionId: 'nope' }),
    })
    expect(denied.response.status).toBe(401)
    expect(denied.body.type).toBe('general_unauthorized_scope')
  })
})

describe('Postgres schema', () => {
  test('the vector tables and indexes are part of the derived Postgres DDL', () => {
    const tables = postgresSystemStatements().join('\n')
    expect(tables).toContain('"_vector_collections"')
    expect(tables).toContain('"_vector_points"')
    expect(tables).toContain('"dimension" integer')
    expect(tables).toContain('"embedding" text')
    const indexes = postgresSystemIndexStatements().join('\n')
    expect(indexes).toContain('"_vector_collections_id"')
    expect(indexes).toContain('"_vector_points_collection_point"')
  })
})
