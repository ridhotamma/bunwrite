/** Row-permission reads: correct results, and a query plan that stays per-row. */
import { afterAll, expect, test } from 'bun:test'

import { readFilter } from '~/documents/sql-read'
import { q } from '~/db/connection'
import type { SqlValue } from '~/documents/codec'
import { KEY, makeUser, PROJECT, startServer } from './helpers'

const server = startServer()
afterAll(() => server.stop())

const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-appwrite-key': KEY }) =>
  fetch(`${server.endpoint}${path}`, {
    method,
    headers: { 'x-appwrite-project': PROJECT, 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
const docs = '/databases/main/collections/products/documents'

test('a signed-in user reads, lists and counts only the rows granted to them', async () => {
  const alice = makeUser(server.db)
  const bob = makeUser(server.db)
  const documents = Array.from({ length: 30 }, (_, i) => ({
    $id: `rf${i}`,
    tenantId: 't',
    name: `Row ${i}`,
    $permissions: [i % 3 === 0 ? `read("user:${alice.id}")` : i % 3 === 1 ? 'read("users")' : `read("user:${bob.id}")`],
  }))
  expect((await api('POST', docs, { documents })).status).toBe(201)

  const asAlice = { 'x-appwrite-session': alice.secret }
  expect((await api('GET', `${docs}/rf0`, undefined, asAlice)).status).toBe(200)
  expect((await api('GET', `${docs}/rf1`, undefined, asAlice)).status).toBe(200)
  expect((await api('GET', `${docs}/rf2`, undefined, asAlice)).status).toBe(404)

  const limit = encodeURIComponent(JSON.stringify({ method: 'limit', values: [100] }))
  const list = (await (await api('GET', `${docs}?queries[]=${limit}`, undefined, asAlice)).json()) as { total: number; documents: { $id: string }[] }
  expect(list.total).toBe(20)
  expect(list.documents.every((doc) => Number(doc.$id.slice(2)) % 3 !== 2)).toBe(true)
})

test('the permission check probes each row instead of listing every readable document', () => {
  const collection = server.services.registry.collection('main', 'products', true)
  const user = { kind: 'user', privileged: false, user: null, sessionId: null, roles: new Set(['any', 'users', 'user:x']), scopes: null } as const
  const params: SqlValue[] = ['rf0']
  const filter = readFilter(user as never, collection, params)!
  const plan = server.db.sqlite
    .query<{ detail: string }, SqlValue[]>(`EXPLAIN QUERY PLAN SELECT * FROM ${q(collection.table)} t WHERE t._id = ? AND ${filter}`)
    .all(...params)
    .map((row) => row.detail)
    .join('\n')
  // A LIST SUBQUERY would materialise every readable document on each read.
  expect(plan).not.toContain('LIST SUBQUERY')
  expect(plan).toContain('CORRELATED')
})
