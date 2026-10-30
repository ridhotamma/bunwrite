import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ID, Permission, Query, Role } from 'node-appwrite'

import { adminClient, addMembership, DB, failure, makeUser, sessionClient, startServer, type TestServer } from './helpers'

let server: TestServer
let db: ReturnType<typeof adminClient>['databases']

const product = (over: Record<string, unknown> = {}) => ({ tenantId: 't1', name: 'Chuck Taylor All Star', slug: ID.unique(), ...over })

beforeAll(() => {
  server = startServer()
  db = adminClient(server.endpoint).databases
})
afterAll(() => server.stop())

describe('document shape', () => {
  test('create returns Appwrite fields, defaults and empty arrays', async () => {
    const doc = await db.createDocument({ databaseId: DB, collectionId: 'products', documentId: 'p1', data: product({ slug: 'chuck' }) })
    expect(Object.keys(doc).slice(0, 7)).toEqual(['$id', '$sequence', '$collectionId', '$databaseId', '$createdAt', '$updatedAt', '$permissions'])
    expect(doc.$id).toBe('p1')
    expect(typeof doc.$sequence).toBe('string')
    expect(doc.$collectionId).toBe('products')
    expect(doc.$databaseId).toBe(DB)
    expect(doc.$createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/)
    expect(doc.$permissions).toEqual([])
    expect(doc.price).toBe(0)
    expect(doc.active).toBe(true)
    expect(doc.status).toBe('draft')
    expect(doc.sku).toBeNull()
    expect(doc.tags).toEqual([])
  })

  test('get and list return the same document', async () => {
    const got = await db.getDocument({ databaseId: DB, collectionId: 'products', documentId: 'p1' })
    const listed = await db.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.equal('$id', 'p1')] })
    expect(listed.total).toBe(1)
    expect(listed.documents[0]).toEqual(got)
  })

  test('ID.unique() and "unique()" both mint 20-char IDs', async () => {
    const a = await db.createDocument({ databaseId: DB, collectionId: 'products', documentId: ID.unique(), data: product() })
    const b = await db.createDocument({ databaseId: DB, collectionId: 'products', documentId: 'unique()', data: product() })
    expect(a.$id).toHaveLength(20)
    expect(b.$id).toHaveLength(20)
  })

  test('select keeps system fields and the chosen attributes only', async () => {
    const res = await db.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.equal('$id', 'p1'), Query.select(['$id', 'name'])] })
    expect(Object.keys(res.documents[0]!)).toEqual(['$id', '$sequence', '$collectionId', '$databaseId', '$createdAt', '$updatedAt', '$permissions', '$revision', 'name'])
  })

  test('total:false reports 0', async () => {
    const res = await db.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.limit(1)], total: false })
    expect(res.total).toBe(0)
    expect(res.documents).toHaveLength(1)
  })
})

describe('errors', () => {
  test('missing document, collection and database', async () => {
    expect(await failure(db.getDocument({ databaseId: DB, collectionId: 'products', documentId: 'nope' }))).toEqual({
      code: 404,
      type: 'document_not_found',
      message: "Document with the requested ID 'nope' could not be found.",
    })
    expect((await failure(db.listDocuments({ databaseId: DB, collectionId: 'nope' }))).type).toBe('collection_not_found')
    expect((await failure(db.listDocuments({ databaseId: 'nope', collectionId: 'products' }))).type).toBe('database_not_found')
  })

  test('duplicate id and unique index', async () => {
    const dup = await failure(db.createDocument({ databaseId: DB, collectionId: 'products', documentId: 'p1', data: product() }))
    expect([dup.code, dup.type]).toEqual([409, 'document_already_exists'])
    const uniq = await failure(db.createDocument({ databaseId: DB, collectionId: 'products', documentId: ID.unique(), data: product({ slug: 'chuck' }) }))
    expect([uniq.code, uniq.type]).toEqual([409, 'document_unique_constraint_violation'])
  })

  test('structure validation', async () => {
    const unknown = await failure(db.createDocument({ databaseId: DB, collectionId: 'products', documentId: ID.unique(), data: product({ nope: 1 }) }))
    expect(unknown).toEqual({ code: 400, type: 'document_invalid_structure', message: 'Invalid document structure: Unknown attribute: "nope"' })
    const missing = await failure(db.createDocument({ databaseId: DB, collectionId: 'products', documentId: ID.unique(), data: { tenantId: 't1' } }))
    expect(missing.message).toBe('Invalid document structure: Missing required attribute "name"')
    const type = await failure(db.createDocument({ databaseId: DB, collectionId: 'products', documentId: ID.unique(), data: product({ price: '5' }) }))
    expect(type.type).toBe('document_invalid_structure')
    const range = await failure(db.createDocument({ databaseId: DB, collectionId: 'products', documentId: ID.unique(), data: product({ price: -1 }) }))
    expect(range.message).toContain('Value must be a valid range between 0 and 9,007,199,254,740,991')
    const en = await failure(db.createDocument({ databaseId: DB, collectionId: 'products', documentId: ID.unique(), data: product({ status: 'gone' }) }))
    expect(en.message).toContain('Value must be one of (active, draft)')
  })

  test('query errors match Appwrite', async () => {
    const q = (queries: string[]) => failure(db.listDocuments({ databaseId: DB, collectionId: 'products', queries }))
    expect(await q([Query.equal('nope', 'x')])).toEqual({ code: 400, type: 'general_query_invalid', message: 'Invalid query: Attribute not found in schema: nope' })
    expect((await q(['{bad'])).message).toBe('Invalid query: Syntax error')
    expect((await q([Query.limit(0)])).message).toContain('Invalid limit')
    expect((await q([Query.equal('price', '5' as any)])).message).toBe('Invalid query: Query value is invalid for attribute "price"')
    expect((await q([Query.equal('sku', null as any)])).message).toBe('Invalid query: Query value is invalid for attribute "sku"')
    expect((await q([Query.equal('slug', [] as any)])).message).toBe('Invalid query: Equal queries require at least one value.')
    expect(await q([Query.cursorAfter('nope')])).toEqual({ code: 400, type: 'general_cursor_not_found', message: "Document 'nope' for the 'cursor' value not found." })
  })

  test('wrong project and bad key', async () => {
    const res = await fetch(`${server.endpoint}/databases/${DB}/collections/products/documents`, { headers: { 'x-appwrite-project': 'other' } })
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).type).toBe('project_not_found')
    const bad = await fetch(`${server.endpoint}/databases/${DB}/collections/products/documents`, {
      headers: { 'x-appwrite-project': 'test-project', 'x-appwrite-key': 'wrong' },
    })
    expect(bad.status).toBe(401)
  })
})

describe('queries', () => {
  const T = 'q-tenant'
  beforeAll(async () => {
    const rows = [
      { name: 'Chuck Taylor All Star', slug: 'chuck-taylor', price: 300, tags: ['shoe', 'canvas'], rating: 4.5, publishedAt: '2026-10-01', status: 'active' },
      { name: 'Chuck Leather', slug: 'chuck-leather', price: 500, tags: ['shoe'], rating: null, publishedAt: '2026-10-05T10:00:00Z', status: 'active' },
      { name: 'Star Player', slug: 'star-player', price: 200, tags: [], rating: 3, sku: 'SP-1', status: 'draft' },
      { name: 'Kaos Polos', slug: 'kaos-polos', price: 50, tags: ['shirt'], rating: 4, sku: 'KP-1', active: false, status: 'draft' },
      { name: 'Kaos Lengan Panjang', slug: 'kaos-lengan', price: 75, rating: 5, status: 'active' },
    ]
    for (const r of rows) await db.createDocument({ databaseId: DB, collectionId: 'products', documentId: r.slug, data: { tenantId: T, ...r } })
  })
  const slugs = async (...queries: string[]) => {
    const res = await db.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.equal('tenantId', T), Query.limit(100), ...queries] })
    return res.documents.map((d: any) => d.slug)
  }

  test('equal is exact and case-sensitive; IN for several values', async () => {
    expect(await slugs(Query.equal('slug', 'chuck-taylor'))).toEqual(['chuck-taylor'])
    expect(await slugs(Query.equal('slug', 'CHUCK-TAYLOR'))).toEqual([])
    expect(await slugs(Query.equal('slug', ['chuck-taylor', 'star-player']))).toEqual(['chuck-taylor', 'star-player'])
    expect(await slugs(Query.notEqual('status', 'active'))).toEqual(['star-player', 'kaos-polos'])
    expect(await slugs(Query.equal('active', false))).toEqual(['kaos-polos'])
  })

  test('contains/startsWith/endsWith ignore case', async () => {
    expect(await slugs(Query.contains('slug', 'CHUCK'))).toEqual(['chuck-taylor', 'chuck-leather'])
    expect(await slugs(Query.startsWith('slug', 'KAOS'))).toEqual(['kaos-polos', 'kaos-lengan'])
    expect(await slugs(Query.endsWith('slug', 'player'))).toEqual(['star-player'])
    expect(await slugs(Query.contains('slug', ['polos', 'leather']))).toEqual(['chuck-leather', 'kaos-polos'])
  })

  test('contains on arrays matches elements', async () => {
    expect(await slugs(Query.contains('tags', 'shoe'))).toEqual(['chuck-taylor', 'chuck-leather'])
    expect(await slugs(Query.contains('tags', ['canvas', 'shirt']))).toEqual(['chuck-taylor', 'kaos-polos'])
  })

  test('search matches whole words with OR, no prefixes', async () => {
    expect(await slugs(Query.search('name', 'chuck'))).toEqual(['chuck-taylor', 'chuck-leather'])
    expect(await slugs(Query.search('name', 'chu'))).toEqual([])
    expect(await slugs(Query.search('name', 'leather kaos'))).toEqual(['chuck-leather', 'kaos-polos', 'kaos-lengan'])
    const noIndex = await failure(db.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.search('slug', 'x')] }))
    expect(noIndex.message).toContain('requires a fulltext index')
  })

  test('null checks and ranges', async () => {
    expect(await slugs(Query.isNull('sku'))).toEqual(['chuck-taylor', 'chuck-leather', 'kaos-lengan'])
    expect(await slugs(Query.isNotNull('rating'), Query.greaterThan('rating', 4))).toEqual(['chuck-taylor', 'kaos-lengan'])
    expect(await slugs(Query.between('price', 75, 300))).toEqual(['chuck-taylor', 'star-player', 'kaos-lengan'])
    expect(await slugs(Query.lessThanEqual('price', 75))).toEqual(['kaos-polos', 'kaos-lengan'])
    expect(await slugs(Query.greaterThanEqual('publishedAt', '2026-10-02'))).toEqual(['chuck-leather'])
  })

  test('or / and', async () => {
    expect(await slugs(Query.or([Query.equal('slug', 'star-player'), Query.greaterThan('price', 400)]))).toEqual(['chuck-leather', 'star-player'])
    expect(await slugs(Query.and([Query.equal('status', 'active'), Query.lessThan('price', 400)]))).toEqual(['chuck-taylor', 'kaos-lengan'])
  })

  test('ordering, offset and limit', async () => {
    expect(await slugs(Query.orderAsc('price'))).toEqual(['kaos-polos', 'kaos-lengan', 'star-player', 'chuck-taylor', 'chuck-leather'])
    expect(await slugs(Query.orderDesc('price'), Query.limit(2), Query.offset(1))).toEqual(['chuck-taylor', 'star-player'])
    expect(await slugs(Query.orderAsc('status'), Query.orderDesc('price'))).toEqual(['chuck-leather', 'chuck-taylor', 'kaos-lengan', 'star-player', 'kaos-polos'])
    expect(await slugs(Query.orderDesc('$sequence'), Query.limit(1))).toEqual(['kaos-lengan'])
  })

  test('cursor pagination walks every row once, both directions', async () => {
    const all = await slugs(Query.orderAsc('status'), Query.orderDesc('price'))
    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await slugs(Query.orderAsc('status'), Query.orderDesc('price'), Query.limit(2), ...(cursor ? [Query.cursorAfter(cursor)] : []))
      if (page.length === 0) break
      seen.push(...page)
      cursor = page.at(-1)
    }
    expect(seen).toEqual(all)
    expect(await slugs(Query.orderAsc('status'), Query.orderDesc('price'), Query.limit(2), Query.cursorBefore(all[3]!))).toEqual(all.slice(1, 3))
  })

  test('default limit is 25 and total counts every match', async () => {
    for (let i = 0; i < 30; i++) await db.createDocument({ databaseId: DB, collectionId: 'products', documentId: `bulk-${i}`, data: { tenantId: 'many', name: `Item ${i}` } })
    const res = await db.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.equal('tenantId', 'many')] })
    expect(res.documents).toHaveLength(25)
    expect(res.total).toBe(30)
  })
})

describe('updates', () => {
  test('partial update keeps other fields and bumps $updatedAt', async () => {
    const before = await db.createDocument({ databaseId: DB, collectionId: 'products', documentId: 'u1', data: product({ price: 10 }) })
    await Bun.sleep(5)
    const after = await db.updateDocument({ databaseId: DB, collectionId: 'products', documentId: 'u1', data: { price: 20 } })
    expect(after.price).toBe(20)
    expect(after.name).toBe(before.name)
    expect(after.$createdAt).toBe(before.$createdAt)
    expect(after.$updatedAt > before.$updatedAt).toBe(true)
  })

  test('an update that changes nothing leaves $updatedAt alone', async () => {
    const before = await db.getDocument({ databaseId: DB, collectionId: 'products', documentId: 'u1' })
    await Bun.sleep(5)
    const after = await db.updateDocument({ databaseId: DB, collectionId: 'products', documentId: 'u1', data: { price: before.price } })
    expect(after.$updatedAt).toBe(before.$updatedAt)
  })

  test('system fields in update data are ignored', async () => {
    const doc = await db.getDocument({ databaseId: DB, collectionId: 'products', documentId: 'u1' })
    const { $id, $createdAt, $updatedAt, ...rest } = doc
    const after = await db.updateDocument({ databaseId: DB, collectionId: 'products', documentId: 'u1', data: { ...rest, price: 21 } })
    expect(after.price).toBe(21)
  })

  test('empty update is rejected', async () => {
    const e = await failure(db.updateDocument({ databaseId: DB, collectionId: 'products', documentId: 'u1', data: {} }))
    expect(e.type).toBe('document_missing_payload')
  })

  test('increment and decrement respect bounds', async () => {
    const inc = await db.incrementDocumentAttribute({ databaseId: DB, collectionId: 'products', documentId: 'u1', attribute: 'price', value: 5 })
    expect(inc.price).toBe(26)
    const over = await failure(db.incrementDocumentAttribute({ databaseId: DB, collectionId: 'products', documentId: 'u1', attribute: 'price', value: 5, max: 30 }))
    expect([over.code, over.type]).toEqual([400, 'attribute_limit_exceeded'])
    const dec = await db.decrementDocumentAttribute({ databaseId: DB, collectionId: 'products', documentId: 'u1', attribute: 'price', value: 6, min: 0 })
    expect(dec.price).toBe(20)
  })

  test('upsert creates then updates', async () => {
    const created = await db.upsertDocument({ databaseId: DB, collectionId: 'products', documentId: 'up1', data: product({ price: 1 }) })
    expect(created.price).toBe(1)
    const updated = await db.upsertDocument({ databaseId: DB, collectionId: 'products', documentId: 'up1', data: { price: 2 } })
    expect(updated.price).toBe(2)
    expect(updated.name).toBe(created.name)
  })

  test('delete removes the document', async () => {
    await db.deleteDocument({ databaseId: DB, collectionId: 'products', documentId: 'up1' })
    expect((await failure(db.getDocument({ databaseId: DB, collectionId: 'products', documentId: 'up1' }))).code).toBe(404)
  })
})

describe('bulk', () => {
  test('create, upsert, update and delete many', async () => {
    const created = await db.createDocuments({
      databaseId: DB,
      collectionId: 'products',
      documents: [
        { $id: 'b1', tenantId: 'bulk', name: 'One', price: 1 },
        { $id: 'b2', tenantId: 'bulk', name: 'Two', price: 2, $permissions: [Permission.read(Role.any())] },
      ],
    })
    expect(created.total).toBe(2)
    expect(created.documents[1]!.$permissions).toEqual(['read("any")'])

    const upserted = await db.upsertDocuments({
      databaseId: DB,
      collectionId: 'products',
      documents: [
        { $id: 'b2', tenantId: 'bulk', name: 'Two!', price: 22 },
        { $id: 'b3', tenantId: 'bulk', name: 'Three', price: 3 },
      ],
    })
    expect(upserted.total).toBe(2)

    const updated = await db.updateDocuments({ databaseId: DB, collectionId: 'products', data: { status: 'active' }, queries: [Query.equal('tenantId', 'bulk')] })
    expect(updated.total).toBe(3)

    const deleted = await db.deleteDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.equal('tenantId', 'bulk'), Query.lessThan('price', 10)] })
    expect(deleted.documents.map((d: any) => d.$id).sort()).toEqual(['b1', 'b3'])
    const left = await db.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.equal('tenantId', 'bulk')] })
    expect(left.documents.map((d: any) => [d.$id, d.name, d.status])).toEqual([['b2', 'Two!', 'active']])
  })
})

describe('permissions', () => {
  let alice: { id: string; secret: string }
  let bob: { id: string; secret: string }

  beforeAll(async () => {
    alice = makeUser(server.db, 'alice', { verified: true })
    bob = makeUser(server.db, 'bob')
    addMembership(server.db, 'shop1', 'alice', ['owner'])
    const docs: [string, string[]][] = [
      ['perm-team', [Permission.read(Role.team('shop1'))]],
      ['perm-owner', [Permission.read(Role.team('shop1', 'owner')), Permission.update(Role.team('shop1', 'owner'))]],
      ['perm-bob', [Permission.read(Role.user('bob')), Permission.write(Role.user('bob'))]],
      ['perm-any', [Permission.read(Role.any())]],
      ['perm-users', [Permission.read(Role.users('verified'))]],
      ['perm-none', []],
    ]
    for (const [id, permissions] of docs) {
      await db.createDocument({ databaseId: DB, collectionId: 'products', documentId: id, data: product({ tenantId: 'perm' }), permissions })
    }
  })

  const visible = async (secret?: string) => {
    const res = await sessionClient(server.endpoint, secret).databases.listDocuments({
      databaseId: DB,
      collectionId: 'products',
      queries: [Query.equal('tenantId', 'perm')],
    })
    return res.documents.map((d: any) => d.$id)
  }

  test('reads are filtered by role', async () => {
    expect(await visible(alice.secret)).toEqual(['perm-team', 'perm-owner', 'perm-any', 'perm-users'])
    expect(await visible(bob.secret)).toEqual(['perm-bob', 'perm-any'])
    expect(await visible()).toEqual(['perm-any'])
    expect(await visible('not-a-session')).toEqual(['perm-any'])
  })

  test('write expands to update + delete', async () => {
    const doc = await db.getDocument({ databaseId: DB, collectionId: 'products', documentId: 'perm-bob' })
    expect(doc.$permissions).toEqual(['read("user:bob")', 'update("user:bob")', 'delete("user:bob")'])
  })

  test('update needs the update permission; unreadable documents look missing', async () => {
    const asAlice = sessionClient(server.endpoint, alice.secret).databases
    const ok = await asAlice.updateDocument({ databaseId: DB, collectionId: 'products', documentId: 'perm-owner', data: { price: 7 } })
    expect(ok.price).toBe(7)
    const denied = await failure(asAlice.updateDocument({ databaseId: DB, collectionId: 'products', documentId: 'perm-team', data: { price: 7 } }))
    expect([denied.code, denied.type]).toEqual([401, 'user_unauthorized'])
    const hidden = await failure(asAlice.updateDocument({ databaseId: DB, collectionId: 'products', documentId: 'perm-none', data: { price: 7 } }))
    expect(hidden.code).toBe(404)
    const get = await failure(asAlice.getDocument({ databaseId: DB, collectionId: 'products', documentId: 'perm-bob' }))
    expect(get.type).toBe('document_not_found')
  })

  test('creating needs a collection create permission', async () => {
    const asBob = sessionClient(server.endpoint, bob.secret).databases
    const denied = await failure(asBob.createDocument({ databaseId: DB, collectionId: 'products', documentId: ID.unique(), data: product() }))
    expect(denied.type).toBe('user_unauthorized')
    const note = await asBob.createDocument({ databaseId: DB, collectionId: 'notes', documentId: ID.unique(), data: { text: 'hi' } })
    expect(note.$permissions).toEqual(['read("user:bob")', 'update("user:bob")', 'delete("user:bob")'])
    const grant = await failure(
      asBob.createDocument({ databaseId: DB, collectionId: 'notes', documentId: ID.unique(), data: { text: 'x' }, permissions: [Permission.read(Role.team('shop1'))] }),
    )
    expect([grant.code, grant.type]).toEqual([401, 'user_unauthorized'])
  })

  test('collections without document security need collection permissions', async () => {
    const e = await failure(sessionClient(server.endpoint, alice.secret).databases.listDocuments({ databaseId: DB, collectionId: 'locked' }))
    expect([e.code, e.type]).toEqual([401, 'user_unauthorized'])
  })

  test('bulk writes need an API key', async () => {
    const e = await failure(sessionClient(server.endpoint, alice.secret).databases.deleteDocuments({ databaseId: DB, collectionId: 'notes' }))
    expect(e.type).toBe('general_unauthorized_scope')
  })

  test('the session cookie works like the header', async () => {
    const res = await fetch(`${server.endpoint}/databases/${DB}/collections/products/documents?queries[0]=${encodeURIComponent(Query.equal('tenantId', 'perm'))}`, {
      headers: { 'x-appwrite-project': 'test-project', cookie: `a_session_test-project=${bob.secret}` },
    })
    const body: any = await res.json()
    expect(body.documents.map((d: any) => d.$id)).toEqual(['perm-bob', 'perm-any'])
  })
})

describe('CORS', () => {
  test('allowed origins are echoed with credentials', async () => {
    const res = await fetch(`${server.endpoint}/health`, { headers: { origin: 'https://dashboard.example.com' } })
    expect(res.headers.get('access-control-allow-origin')).toBe('https://dashboard.example.com')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    const other = await fetch(`${server.endpoint}/health`, { headers: { origin: 'https://evil.example' } })
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
  })
})
