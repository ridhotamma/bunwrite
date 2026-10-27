/**
 * Migration, end to end: fill one server through the SDK (it speaks Appwrite's
 * API), import it into a fresh database, then check the copy behaves the same.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Permission, Query, Role } from 'node-appwrite'

import { createApp, createServices } from '~/app'
import { openDb } from '~/db/connection'
import { importFromAppwrite, verifyAgainstAppwrite } from '~/migrate/importer'
import { MemoryMailer } from '~/mail/mailer'
import { adminClient, DB, KEY, PROJECT, sessionClient, startServer, testConfig, testSchema, type TestServer } from './helpers'

let dir: string
let source: TestServer
let target: { endpoint: string; stop(): void }
let report: Awaited<ReturnType<typeof importFromAppwrite>>
let targetDb: ReturnType<typeof openDb>

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bunwrite-migrate-'))
  const schema = { ...testSchema, buckets: [{ $id: 'media', name: 'Media', fileSecurity: true, allowedFileExtensions: [], maximumFileSize: 1_000_000 }] }
  source = startServer(schema, { storagePath: join(dir, 'source') })
  const a = adminClient(source.endpoint)

  await a.users.create({ userId: 'seller', email: 'seller@example.com', password: 'old password 1', name: 'Seller' })
  await a.users.updateLabels({ userId: 'seller', labels: ['vip'] })
  await a.users.updatePrefs({ userId: 'seller', prefs: { lang: 'id' } })
  await a.users.create({ userId: 'staff', email: 'staff@example.com', phone: '+6281200000000' })
  await a.teams.create({ teamId: 'shop', name: 'Toko' })
  await a.teams.updatePrefs({ teamId: 'shop', prefs: { plan: 'pro' } })
  await a.teams.createMembership({ teamId: 'shop', userId: 'seller', roles: ['owner'] })
  await a.teams.createMembership({ teamId: 'shop', userId: 'staff', roles: ['cashier'] })
  source.db.sqlite
    .query("INSERT INTO _identities (id, user_id, provider, provider_uid, provider_email, created_at, updated_at) VALUES ('ident1', 'seller', 'google', 'g-123', 'seller@example.com', ?, ?)")
    .run('2026-10-01T00:00:00.000+00:00', '2026-10-01T00:00:00.000+00:00')

  for (let i = 0; i < 1203; i++) {
    await a.databases.createDocument({
      databaseId: DB,
      collectionId: 'products',
      documentId: `p${i}`,
      data: { tenantId: i % 2 ? 'shop' : 'other', name: `Kaos ${i}`, slug: `kaos-${i}`, price: i, tags: i % 3 ? ['a', 'b'] : [], active: i % 4 !== 0, publishedAt: i % 5 ? '2026-10-01T10:00:00.000+00:00' : null, rating: i % 7 ? i / 10 : null },
      permissions: i % 2 ? [Permission.read(Role.team('shop')), Permission.update(Role.team('shop', 'owner'))] : [],
    })
  }
  await a.databases.deleteDocument({ databaseId: DB, collectionId: 'products', documentId: 'p5' }) // a gap in $sequence
  await a.storage.createFile({ bucketId: 'media', fileId: 'logo', file: new File([new Uint8Array([1, 2, 3, 4])], 'logo.png', { type: 'image/png' }), permissions: [Permission.read(Role.any())] })

  const db = openDb(':memory:')
  targetDb = db
  const storagePath = join(dir, 'target')
  report = await importFromAppwrite(db, { endpoint: source.endpoint, projectId: PROJECT, key: KEY, storagePath, pageSize: 250 })
  const config = testConfig({ storagePath })
  const services = createServices(config, db, { mailer: new MemoryMailer() })
  const app = createApp(services)
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.websocket })
  config.port = server.port!
  target = { endpoint: `http://localhost:${server.port}/v1`, stop: () => server.stop(true) }
}, 120_000)

afterAll(() => {
  source?.stop()
  target?.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('import from an Appwrite-compatible source', () => {
  test('report counts everything', () => {
    expect(report.users).toBe(2)
    expect(report.identities).toBe(1)
    expect(report.teams).toBe(1)
    expect(report.memberships).toBe(2)
    expect(report.files).toBe(1)
    expect(report.collections.find((c) => c.id === `${DB}/products`)).toEqual({ id: `${DB}/products`, source: 1202, imported: 1202 })
    expect(report.hashFormats).toEqual({ 'argon2id-phc': 1, none: 1 })
    expect(report.skipped).toEqual([])
  })

  test('documents are identical, $sequence and timestamps included', async () => {
    const result = await verifyAgainstAppwrite(targetDb, { endpoint: source.endpoint, projectId: PROJECT, key: KEY, storagePath: '' })
    expect(result.checked).toBe(100)
    expect(result.mismatches).toEqual([])
    // Compare over HTTP too, page by page.
    const a = adminClient(source.endpoint).databases
    const b = adminClient(target.endpoint).databases
    for (const queries of [
      [Query.orderAsc('$sequence'), Query.limit(500)],
      [Query.orderAsc('$sequence'), Query.limit(500), Query.offset(500)],
      [Query.equal('tenantId', 'shop'), Query.orderDesc('price'), Query.limit(50)],
      [Query.search('name', 'kaos'), Query.limit(5)],
      [Query.contains('tags', 'a'), Query.isNull('rating'), Query.limit(100)],
    ]) {
      const [x, y] = await Promise.all([a.listDocuments({ databaseId: DB, collectionId: 'products', queries }), b.listDocuments({ databaseId: DB, collectionId: 'products', queries })])
      expect(JSON.stringify(y)).toBe(JSON.stringify(x))
    }
  })

  test('the old password still works, and team roles still open documents', async () => {
    const session = await adminClient(target.endpoint).account.createEmailPasswordSession('seller@example.com', 'old password 1')
    const asSeller = sessionClient(target.endpoint, session.secret)
    const me = await asSeller.account.get()
    expect([me.labels, me.prefs]).toEqual([['vip'], { lang: 'id' }])
    const visible = await asSeller.databases.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.limit(1)] })
    expect(visible.total).toBe(600) // odd ids are the shop's, minus the deleted p5
    const team = await adminClient(target.endpoint).teams.get({ teamId: 'shop' })
    expect(team.total).toBe(2)
    expect(await adminClient(target.endpoint).teams.getPrefs({ teamId: 'shop' })).toEqual({ plan: 'pro' })
    const identities = await adminClient(target.endpoint).users.listIdentities()
    expect(identities.identities.map((i: any) => [i.userId, i.provider, i.providerUid])).toEqual([['seller', 'google', 'g-123']])
  })

  test('files come across byte for byte', async () => {
    const view = await fetch(`${target.endpoint}/storage/buckets/media/files/logo/view?project=${PROJECT}`)
    expect([...new Uint8Array(await view.arrayBuffer())]).toEqual([1, 2, 3, 4])
  })

  test('new writes continue the sequence', async () => {
    const created = await adminClient(target.endpoint).databases.createDocument({ databaseId: DB, collectionId: 'products', documentId: 'after', data: { tenantId: 'x', name: 'After' } })
    expect(Number(created.$sequence)).toBe(1204)
  })
})
