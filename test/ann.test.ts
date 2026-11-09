/**
 * External ANN adapter helpers and request shapes. The Qdrant service itself
 * is exercised by test/qdrant.test.ts when QDRANT_URL is set.
 */
import { describe, expect, test } from 'bun:test'

import {
  annCollectionName,
  annPointId,
  annQdrantFilter,
  makeVectorAnnIndex,
  qdrantDistance,
  QdrantAnnIndex,
  sparseVector,
  supportsAnnFilter,
  type AnnCollection,
} from '~/vectors/ann'
import { defaultVectorsConfig } from '~/vectors/config'
import type { StoredPoint } from '~/vectors/types'

const collection: AnnCollection = { id: 'demo', dimension: 4, metric: 'cosine', epoch: 'epoch-1' }
const point: StoredPoint = {
  id: 'p1',
  documentId: 'doc',
  chunkIndex: 0,
  content: 'hello world',
  metadata: { lang: 'en', score: 2.5 },
  permissions: ['read("users")'],
  vector: [1, 0, 0, 0],
}

interface Call {
  method: string
  url: string
  body: any
  headers: Record<string, string>
}

function fakeFetch(handler: (call: Call) => Response | undefined) {
  const calls: Call[] = []
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    calls.push(call)
    return handler(call) ?? Response.json({ result: true })
  }) as typeof fetch
  return { calls, impl }
}

const collectionInfo = (dimension = 4, distance = 'Cosine', sparse = true) =>
  Response.json({
    result: {
      config: {
        params: {
          vectors: { dense: { size: dimension, distance } },
          ...(sparse ? { sparse_vectors: { text: {} } } : {}),
        },
      },
    },
  })

describe('ANN helpers', () => {
  test('collection names and point IDs are stable and provider-safe', () => {
    expect(annCollectionName('handbook')).toBe(annCollectionName('handbook'))
    expect(annCollectionName('handbook')).toStartWith('bw_handbook_')
    expect(annCollectionName('handbook')).not.toBe(annCollectionName('handbook2'))
    const id = annPointId('demo', 'user/point 1')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(annPointId('demo', 'user/point 1')).toBe(id)
    expect(annPointId('other', 'user/point 1')).not.toBe(id)
  })

  test('sparse vectors sort, deduplicate and weight repeated terms', () => {
    const sparse = sparseVector('Apple apple banana')
    expect(sparse.indices).toEqual([...sparse.indices].sort((a, b) => a - b))
    expect(sparse.indices).toHaveLength(2)
    expect(sparse.values.every((value) => value > 0)).toBe(true)
    expect(Math.max(...sparse.values)).toBeGreaterThan(Math.min(...sparse.values))
    expect(sparseVector('').indices).toEqual([])
    expect(sparseVector('apple').indices).toEqual(sparseVector('apple').indices)
    expect(sparseVector(Array.from({ length: 50 }, (_, index) => `term${index}`).join(' '), 5).indices).toHaveLength(5)
  })

  test('metadata filters translate to Qdrant conditions with ACL roles', () => {
    const filter = annQdrantFilter(
      { lang: 'en', score: 2.5, missing: null, tags: ['a', 'b'], empty: [] },
      { roles: new Set(['users', 'team:acme']) },
      'epoch-1',
    )
    const must = filter.must as any[]
    expect(must).toContainEqual({ key: 'epoch', match: { value: 'epoch-1' } })
    expect(must).toContainEqual({ key: 'permissions', match: { any: ['read("users")', 'read("team:acme")'] } })
    expect(must).toContainEqual({ key: 'metadata.lang', match: { value: 'en' } })
    expect(must).toContainEqual({ key: 'metadata.score', range: { gte: 2.5, lte: 2.5 } })
    expect(must).toContainEqual({ is_null: { key: 'metadata.missing' } })
    expect(must).toContainEqual({ key: 'metadata.tags', match: { any: ['a', 'b'] } })
    expect(must.some((condition) => condition.match?.value === '__bw_never__')).toBe(true)
  })

  test('unsupported filters stay on the built-in scan', () => {
    expect(supportsAnnFilter(undefined)).toBe(true)
    expect(supportsAnnFilter({ lang: 'en', tags: ['a'], missing: null })).toBe(true)
    expect(supportsAnnFilter({ nested: { a: 1 } })).toBe(false)
    expect(supportsAnnFilter({ tags: [{ a: 1 }] })).toBe(false)
    expect(supportsAnnFilter({ value: Number.NaN })).toBe(false)
    expect(qdrantDistance('cosine')).toBe('Cosine')
    expect(qdrantDistance('dot')).toBe('Dot')
    expect(qdrantDistance('euclidean')).toBe('Euclid')
  })

  test('the factory only creates Qdrant when an endpoint is configured', () => {
    expect(makeVectorAnnIndex(defaultVectorsConfig())).toBeNull()
    expect(makeVectorAnnIndex(defaultVectorsConfig({ annProvider: 'qdrant', annUrl: '' }))).toBeNull()
    const index = makeVectorAnnIndex(defaultVectorsConfig({ annProvider: 'qdrant', annUrl: 'http://localhost:6333' }))
    expect(index?.provider).toBe('qdrant')
  })
})

describe('Qdrant adapter requests', () => {
  test('creates a collection, mirrors points and indexes filter fields', async () => {
    let created = false
    const { calls, impl } = fakeFetch((call) => {
      if (call.method === 'GET' && call.url.endsWith('/collections/' + annCollectionName('demo'))) {
        return created ? collectionInfo() : Response.json({ status: { error: 'not found' } }, { status: 404 })
      }
      if (call.method === 'PUT' && call.url.endsWith('/collections/' + annCollectionName('demo'))) {
        created = true
        return Response.json({ result: true })
      }
      return undefined
    })
    const ann = new QdrantAnnIndex({ url: 'http://qdrant.test', apiKey: 'secret', fetch: impl })
    await ann.upsert(collection, [point])

    const create = calls.find((call) => call.method === 'PUT' && call.url.endsWith('/collections/' + annCollectionName('demo')))
    expect(create?.body).toMatchObject({ vectors: { dense: { size: 4, distance: 'Cosine' } }, sparse_vectors: { text: {} } })
    expect(create?.headers['api-key']).toBe('secret')

    const indexFields = calls.filter((call) => call.url.endsWith('/index')).map((call) => call.body.field_name)
    expect(indexFields.sort()).toEqual(['document_id', 'epoch', 'permissions'])

    const upsert = calls.find((call) => call.method === 'PUT' && call.url.includes('/points?wait=true'))
    expect(upsert?.body.points[0]).toMatchObject({
      id: annPointId('demo', 'p1'),
      payload: {
        epoch: 'epoch-1',
        point_id: 'p1',
        document_id: 'doc',
        chunk_index: 0,
        content: 'hello world',
        metadata: { lang: 'en', score: 2.5 },
        permissions: ['read("users")'],
      },
    })
    expect(upsert?.body.points[0].vector.dense).toEqual([1, 0, 0, 0])
    expect(upsert?.body.points[0].vector.text.indices).toHaveLength(2)
  })

  test('dense and sparse search carry epoch, metadata and ACL filters', async () => {
    const { calls, impl } = fakeFetch((call) => {
      if (call.method === 'GET') return collectionInfo()
      if (call.url.endsWith('/points/query')) {
        return Response.json({ result: { points: [{ id: 'uuid', score: call.body.using === 'text' ? 2 : 1, payload: { point_id: 'p1' } }] } })
      }
      if (call.url.endsWith('/points/count')) {
        const filter = call.body.filter
        const acl = JSON.stringify(filter).includes('read(\\"users\\")')
        return Response.json({ result: { count: acl ? 1 : 5 } })
      }
      return undefined
    })
    const ann = new QdrantAnnIndex({ url: 'http://qdrant.test', fetch: impl })
    const result = await ann.search({
      collection,
      vector: [1, 0, 0, 0],
      limit: 10,
      text: 'hello',
      filter: { lang: 'en' },
      access: { roles: new Set(['users']) },
    })

    const queries = calls.filter((call) => call.url.endsWith('/points/query'))
    expect(queries).toHaveLength(2)
    const dense = queries.find((call) => call.body.using === 'dense')!
    expect(dense.body.filter.must).toContainEqual({ key: 'epoch', match: { value: 'epoch-1' } })
    expect(dense.body.filter.must).toContainEqual({ key: 'permissions', match: { any: ['read("users")'] } })
    expect(dense.body.filter.must).toContainEqual({ key: 'metadata.lang', match: { value: 'en' } })
    const sparse = queries.find((call) => call.body.using === 'text')!
    expect(sparse.body.modifier).toBe('idf')
    expect(sparse.body.query.indices.length).toBeGreaterThan(0)

    expect(result).toMatchObject({ vector: [{ pointId: 'p1', score: 1 }], text: [{ pointId: 'p1', score: 2 }], total: 1, collectionTotal: 5, sparse: true })
    const counts = calls.filter((call) => call.url.endsWith('/points/count'))
    expect(counts).toHaveLength(2)
    expect(JSON.stringify(counts[1]!.body.filter)).not.toContain('permissions')
  })

  test('deletes points, documents and collections', async () => {
    const { calls, impl } = fakeFetch((call) => {
      if (call.method === 'GET') return collectionInfo()
      if (call.method === 'DELETE') return Response.json({ result: true })
      return Response.json({ result: { operation_id: 1, status: 'completed' } })
    })
    const ann = new QdrantAnnIndex({ url: 'http://qdrant.test', fetch: impl })
    await ann.deletePoints(collection, ['p1', 'p2'])
    await ann.deleteDocument(collection, 'doc')
    await ann.deleteCollection('demo')

    const deletes = calls.filter((call) => call.method === 'POST' && call.url.includes('/points/delete'))
    expect(deletes).toHaveLength(2)
    expect(deletes[0]!.body.points).toEqual([annPointId('demo', 'p1'), annPointId('demo', 'p2')])
    expect(deletes[1]!.body.filter.must).toContainEqual({ key: 'epoch', match: { value: 'epoch-1' } })
    expect(deletes[1]!.body.filter.must).toContainEqual({ key: 'document_id', match: { value: 'doc' } })
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/collections/' + annCollectionName('demo')))).toBe(true)
  })

  test('health reports the provider version and failures', async () => {
    const healthy = new QdrantAnnIndex({
      url: 'http://qdrant.test',
      fetch: fakeFetch(() => Response.json({ title: 'qdrant', version: '1.20.0' })).impl,
    })
    expect(await healthy.health()).toMatchObject({ ok: true, provider: 'qdrant', version: '1.20.0' })

    const down = new QdrantAnnIndex({
      url: 'http://qdrant.test',
      fetch: fakeFetch(() => Response.json({ status: { error: 'down' } }, { status: 503 })).impl,
    })
    expect(await down.health()).toMatchObject({ ok: false, provider: 'qdrant' })
  })
})
