/** Edge cases in vector search, chunking, ingestion and the search cache. */
import { afterAll, describe, expect, test } from 'bun:test'

import { chunkText } from '~/vectors/chunk'
import { documentIdForFile } from '~/vectors/service'
import { VectorService } from '~/vectors/service'
import { matchesFilter } from '~/vectors/validate'
import { startServer } from './helpers'

const server = startServer()
afterAll(() => server.stop())
const vectors = server.services.vectors

describe('chunking', () => {
  test('text without spaces is split to the window, and joins back unchanged', () => {
    const cjk = '這是一個沒有空格的長文本'.repeat(500)
    const chunks = chunkText(cjk, { size: 1000, overlap: 0 })
    expect(chunks.length).toBeGreaterThan(5)
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(1000)
    // Pieces are glued back without spaces, so nothing is added to the text.
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(cjk)
  })

  test('a long URL is cut into pieces and overlap still applies', () => {
    const url = `see https://example.com/${'x'.repeat(20_000)} for details`
    const chunks = chunkText(url, { size: 1000, overlap: 200 })
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(1000)
    expect(chunks[0]!.text.startsWith('see https://example.com/')).toBe(true)
    expect(chunks[chunks.length - 1]!.text.endsWith('for details')).toBe(true)
  })

  test('emoji and other surrogate pairs are never split', () => {
    const chunks = chunkText('😀'.repeat(3000), { size: 200, overlap: 0 })
    for (const chunk of chunks) expect(chunk.text).not.toContain('�')
    for (const chunk of chunks) expect(Array.from(chunk.text).every((char) => char === '😀')).toBe(true)
  })
})

describe('search edge cases', () => {
  test('a query with no letters or digits finds nothing instead of everything', async () => {
    await vectors.createCollection({ id: 'edge-zero' })
    await vectors.upsertPoints('edge-zero', [
      { id: 'a', content: 'refund policy for annual plans' },
      { id: 'b', content: 'how to reset a password' },
    ])
    expect((await vectors.search('edge-zero', { text: '???' })).points).toEqual([])
    const rag = await vectors.query({ collectionId: 'edge-zero', query: '?!?!', generate: false })
    expect(rag.sources).toEqual([])
    // A real query still works.
    expect((await vectors.search('edge-zero', { text: 'password reset' })).points[0]?.$id).toBe('b')
  })

  test('filters match items of array fields, and objects in any key order', async () => {
    expect(matchesFilter({ tags: ['billing', 'faq'] }, { tags: 'billing' })).toBe(true)
    expect(matchesFilter({ tags: ['billing', 'faq'] }, { tags: ['sales', 'faq'] })).toBe(true)
    expect(matchesFilter({ tags: ['billing', 'faq'] }, { tags: ['billing', 'faq'] })).toBe(true)
    expect(matchesFilter({ tags: ['billing'] }, { tags: 'sales' })).toBe(false)
    expect(matchesFilter({ owner: { id: 1, role: 'admin' } }, { owner: { role: 'admin', id: 1 } })).toBe(true)

    await vectors.createCollection({ id: 'edge-tags' })
    await vectors.upsertPoints('edge-tags', [
      { id: 'p', content: 'tagged billing guide', metadata: { tags: ['billing', 'faq'] } },
      { id: 'q', content: 'tagged sales guide', metadata: { tags: ['sales'] } },
    ])
    const found = await vectors.search('edge-tags', { text: 'tagged guide', filter: { tags: 'billing' } })
    expect(found.points.map((point) => point.$id)).toEqual(['p'])
  })
})

describe('ingestion', () => {
  test('different files whose names map to the same ID do not replace each other', async () => {
    await vectors.createCollection({ id: 'edge-files' })
    const first = await vectors.ingest({
      collectionId: 'edge-files',
      file: new File(['Quarterly revenue grew in Q3.'], 'Report 2024.md', { type: 'text/markdown' }),
    })
    const second = await vectors.ingest({
      collectionId: 'edge-files',
      file: new File(['The team offsite is in May.'], 'report-2024.txt', { type: 'text/plain' }),
    })
    expect(first.documentId).toBe('report-2024')
    expect(second.documentId).toBe(documentIdForFile('report-2024.txt'))
    expect(second.documentId.length).toBeLessThanOrEqual(36)
    const documents = (await vectors.listDocuments('edge-files')).map((document) => document.documentId).sort()
    expect(documents).toEqual([first.documentId, second.documentId].sort())

    // Uploading the same file again still replaces its earlier version.
    const again = await vectors.ingest({
      collectionId: 'edge-files',
      file: new File(['Quarterly revenue grew in Q4.'], 'Report 2024.md', { type: 'text/markdown' }),
    })
    expect(again.documentId).toBe(first.documentId)
    const revenue = await vectors.search('edge-files', { text: 'quarterly revenue', topK: 5 })
    expect(revenue.points.map((point) => point.content)).toContain('Quarterly revenue grew in Q4.')
    expect(revenue.points.map((point) => point.content)).not.toContain('Quarterly revenue grew in Q3.')
  })
})

describe('search cache', () => {
  test('a write from another process is seen on the next search', async () => {
    await vectors.createCollection({ id: 'edge-cache' })
    await vectors.upsertPoints('edge-cache', [{ id: 'one', content: 'apples and pears' }])
    expect((await vectors.search('edge-cache', { text: 'bananas', topK: 5 })).points.map((p) => p.$id)).not.toContain('two')

    // A second service on the same database stands in for another worker.
    const other = new VectorService(server.services.db, server.services.config.vectors)
    await other.upsertPoints('edge-cache', [{ id: 'two', content: 'bananas and mangoes' }])
    expect((await vectors.search('edge-cache', { text: 'bananas', topK: 1 })).points[0]?.$id).toBe('two')

    await other.deletePoint('edge-cache', 'two')
    expect((await vectors.search('edge-cache', { text: 'bananas', topK: 5 })).points.map((p) => p.$id)).not.toContain('two')
  })

  test('cached and uncached search return the same results', async () => {
    await vectors.createCollection({ id: 'edge-same' })
    const words = ['refund', 'invoice', 'password', 'shipping', 'account', 'plan', 'billing', 'export']
    await vectors.upsertPoints(
      'edge-same',
      Array.from({ length: 60 }, (_, i) => ({
        id: `p${i}`,
        content: Array.from({ length: 12 }, (_, k) => words[(i * 3 + k) % words.length]).join(' '),
        metadata: { group: i % 3 },
        permissions: i % 4 === 0 ? ['read("users")'] : [],
      })),
    )
    const uncached = new VectorService(server.services.db, server.services.config.vectors, undefined, { searchCacheBytes: 0 })
    const access = { roles: new Set(['any', 'users']), userId: 'u1' }
    for (const input of [
      { text: 'refund for annual billing plan', topK: 8 },
      { text: 'password account', topK: 5, hybrid: false, rerank: false },
      { text: 'shipping export', topK: 6, filter: { group: 1 } },
    ]) {
      const a = await vectors.search('edge-same', input)
      const b = await uncached.search('edge-same', input)
      expect(a.total).toBe(b.total)
      expect(a.points.map((p) => [p.$id, p.score])).toEqual(b.points.map((p) => [p.$id, p.score]))
      const c = await vectors.search('edge-same', input, access)
      const d = await uncached.search('edge-same', input, access)
      expect(c.points.map((p) => p.$id)).toEqual(d.points.map((p) => p.$id))
    }
  })

  test('a collection larger than the budget falls back to the streaming scan', async () => {
    const tiny = new VectorService(server.services.db, server.services.config.vectors, undefined, { searchCacheBytes: 1024 })
    const found = await tiny.search('edge-same', { text: 'refund billing', topK: 3 })
    expect(found.points).toHaveLength(3)
  })
})
