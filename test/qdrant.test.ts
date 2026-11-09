/**
 * Real Qdrant integration tests.
 *
 * These are skipped unless QDRANT_URL points at a running Qdrant REST API:
 *
 *   QDRANT_URL=http://127.0.0.1:6333 bun test test/qdrant.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { defaultVectorsConfig } from '~/vectors/config'
import { annCollectionName } from '~/vectors/ann'
import { adminClient, KEY, makeUser, PROJECT, startServer, type TestServer } from './helpers'

const QDRANT_URL = process.env.QDRANT_URL
const qdrant = QDRANT_URL ? describe : describe.skip
const collectionId = `ann${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
const rebuildId = `reb${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
const headers = { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, 'content-type': 'application/json' }

const unit = (index: number, dimension = 64) => Array.from({ length: dimension }, (_, offset) => (offset === index ? 1 : 0))

let server: TestServer

beforeAll(() => {
  if (!QDRANT_URL) return
  server = startServer(undefined, {
    vectors: defaultVectorsConfig({
      dimension: 64,
      annProvider: 'qdrant',
      annUrl: QDRANT_URL,
      annTimeoutMs: 5_000,
      annFallback: true,
    }),
  })
})

afterAll(async () => {
  if (!server) return
  for (const id of [collectionId, rebuildId]) {
    try {
      await server.services.vectors.deleteCollection(id)
    } catch {
      // The test may already have removed it.
    }
  }
  server.stop()
})

async function search(id: string, body: Record<string, unknown>, extra: Record<string, string> = {}, withKey = true) {
  const base = withKey ? headers : { 'x-appwrite-project': PROJECT, 'content-type': 'application/json' }
  const response = await fetch(`${server.endpoint}/vectors/${id}/search`, {
    method: 'POST',
    headers: { ...base, ...extra },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as any }
}

qdrant('Qdrant ANN adapter', () => {
  test('mirrors writes, applies ACL and metadata filters, and serves hybrid search', async () => {
    const vectors = server.services.vectors
    await vectors.createCollection({ id: collectionId, dimension: 64 })
    await vectors.upsertPoints(collectionId, [
      { id: 'a', vector: unit(0), content: 'apple pie recipe', documentId: 'doc-a', metadata: { lang: 'en', tenant: 'a' }, permissions: ['read("users")'] },
      { id: 'b', vector: unit(1), content: 'banana bread recipe', documentId: 'doc-b', metadata: { lang: 'id', tenant: 'b' }, permissions: ['read("users")'] },
      {
        id: 'secret',
        vector: unit(2),
        content: 'apple private tenant b',
        documentId: 'doc-c',
        metadata: { lang: 'en', tenant: 'b' },
        permissions: ['read("team:other")'],
      },
    ])

    const status = await vectors.indexStatus(collectionId)
    expect(status).toMatchObject({ provider: 'qdrant', configured: true, healthy: true, sqlPoints: 3, indexPoints: 3, missing: 0, status: 'current' })

    const vector = await search(collectionId, { vector: unit(0), topK: 2 })
    expect(vector.status).toBe(200)
    expect(vector.body.total).toBe(3)
    expect(vector.body.points[0].$id).toBe('a')

    const filtered = await search(collectionId, { vector: unit(0), filter: { lang: 'en' }, topK: 5 })
    expect(filtered.body.total).toBe(2)
    expect(filtered.body.points.map((point: any) => point.$id).sort()).toEqual(['a', 'secret'])

    const admin = adminClient(server.endpoint)
    const user = makeUser(server.db, 'ann-user')
    await admin.teams.create({ teamId: 'ann-team', name: 'ANN team' })
    await admin.teams.createMembership({ teamId: 'ann-team', roles: ['member'], userId: user.id })
    const userHeaders = { 'x-appwrite-project': PROJECT, 'x-appwrite-session': user.secret }
    const allowed = await search(collectionId, { vector: unit(0), topK: 5 }, userHeaders, false)
    expect(allowed.status).toBe(200)
    expect(allowed.body.total).toBe(2)
    expect(allowed.body.points.map((point: any) => point.$id).sort()).toEqual(['a', 'b'])

    const hybrid = await search(collectionId, { text: 'apple', hybrid: true, alpha: 0, rerank: false, topK: 5 })
    expect(hybrid.status).toBe(200)
    expect(
      hybrid.body.points
        .slice(0, 2)
        .map((point: any) => point.$id)
        .sort(),
    ).toEqual(['a', 'secret'])

    await vectors.deletePoint(collectionId, 'secret')
    expect((await search(collectionId, { vector: unit(0), topK: 5 })).body.total).toBe(2)
    await vectors.deleteDocument(collectionId, 'doc-a')
    expect((await search(collectionId, { vector: unit(0), topK: 5 })).body.total).toBe(1)
  })

  test('detects a missing index, falls back, and rebuilds it', async () => {
    const vectors = server.services.vectors
    await vectors.createCollection({ id: rebuildId, dimension: 64 })
    await vectors.upsertPoints(rebuildId, [
      { id: 'one', vector: unit(0), content: 'rebuild me', metadata: { kind: 'test' } },
      { id: 'two', vector: unit(1), content: 'another point', metadata: { kind: 'test' } },
    ])

    const removed = await fetch(`${QDRANT_URL}/collections/${annCollectionName(rebuildId)}`, { method: 'DELETE' })
    expect(removed.ok).toBe(true)

    const missing = await vectors.indexStatus(rebuildId)
    expect(missing).toMatchObject({ sqlPoints: 2, indexPoints: 0, missing: 2, status: 'missing' })

    // With the fallback on, search still returns SQL results while the index is gone.
    const fallback = await vectors.search(rebuildId, { vector: unit(0), topK: 1 })
    expect(fallback.points[0]!.$id).toBe('one')

    const rebuilt = await vectors.rebuildIndex(rebuildId)
    expect(rebuilt).toMatchObject({ collectionId: rebuildId, provider: 'qdrant', points: 2 })
    expect(await vectors.indexStatus(rebuildId)).toMatchObject({ indexPoints: 2, missing: 0, status: 'current' })
    expect((await vectors.search(rebuildId, { vector: unit(1), topK: 1 })).points[0]!.$id).toBe('two')

    const reindexed = await vectors.reindex(rebuildId)
    expect(reindexed).toMatchObject({ points: 2, indexed: 2 })
    expect(reindexed.indexError).toBeUndefined()
  })

  test('reindex after a dimension change recreates the provider collection', async () => {
    const vectors = server.services.vectors
    const id = `dim${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    const original = server.services.config.vectors
    await vectors.createCollection({ id, dimension: 64 })
    await vectors.upsertPoints(id, [{ id: 'point', vector: unit(0), content: 'dimension change document' }])
    try {
      await server.services.settings.set('vectors', { ...original, dimension: 32 })
      const result = await vectors.reindex(id)
      expect(result).toMatchObject({ collectionId: id, points: 1, dimension: 32, indexed: 1 })
      expect((await vectors.getCollection(id)).dimension).toBe(32)
      expect((await vectors.indexStatus(id)).status).toBe('current')
      expect((await vectors.search(id, { text: 'dimension change', topK: 1 })).points[0]!.$id).toBe('point')
    } finally {
      await vectors.deleteCollection(id)
      await server.services.settings.reset('vectors')
    }
  })

  test('re-ingesting a shorter document removes stale provider chunks', async () => {
    const vectors = server.services.vectors
    const id = `rep${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    await vectors.createCollection({ id, dimension: 64 })
    try {
      const long = Array.from({ length: 200 }, (_, index) => `word${index}`).join(' ')
      const first = await vectors.ingest({ collectionId: id, documentId: 'guide', text: long, chunkSize: 120, chunkOverlap: 20 })
      expect(first.chunks).toBeGreaterThan(1)
      expect(await vectors.indexStatus(id)).toMatchObject({ sqlPoints: first.chunks, indexPoints: first.chunks, status: 'current' })
      const second = await vectors.ingest({ collectionId: id, documentId: 'guide', text: 'short replacement text', chunkSize: 120, chunkOverlap: 20 })
      expect(second.chunks).toBe(1)
      expect(await vectors.indexStatus(id)).toMatchObject({ sqlPoints: 1, indexPoints: 1, missing: 0, status: 'current' })
      expect((await vectors.search(id, { text: 'replacement', topK: 5 })).points[0]!.$id).toBe('guide.0')
    } finally {
      await vectors.deleteCollection(id)
    }
  })

  test('euclidean scores stay higher-is-better after provider ordering', async () => {
    const vectors = server.services.vectors
    const id = `euc${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    await vectors.createCollection({ id, dimension: 2, metric: 'euclidean' })
    try {
      await vectors.upsertPoints(id, [
        { id: 'near', vector: [0, 0], content: 'near point' },
        { id: 'far', vector: [3, 4], content: 'far point' },
      ])
      const result = await vectors.search(id, { vector: [0, 0], topK: 2 })
      expect(result.points.map((point) => point.$id)).toEqual(['near', 'far'])
      expect(result.points[0]!.score).toBeCloseTo(1, 6)
      expect(result.points[1]!.score).toBeCloseTo(1 / 6, 6)
    } finally {
      await vectors.deleteCollection(id)
    }
  })
})
