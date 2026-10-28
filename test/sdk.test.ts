/**
 * The Bunwrite SDK (packages/sdk) against a real server: the same calls the
 * Appwrite SDKs make, from Bun with no browser globals.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Account,
  BunwriteException,
  Client,
  Databases,
  Functions,
  Health,
  ID,
  InputFile,
  Messaging,
  Permission,
  Query,
  Realtime,
  Role,
  Storage,
  TablesDB,
  Teams,
  Users,
  Webhooks,
  Channel,
} from '../packages/sdk/src'
import { DB, KEY, PROJECT, startServer, type TestServer } from './helpers'

let server: TestServer
let storage: string
const admin = () => new Client().setEndpoint(server.endpoint).setProject(PROJECT).setKey(KEY)
const guest = () => new Client().setEndpoint(server.endpoint).setProject(PROJECT)

beforeAll(() => {
  storage = mkdtempSync(join(tmpdir(), 'bunwrite-sdk-'))
  server = startServer(undefined, { storagePath: storage, apiCompat: 'bunwrite' })
})

afterAll(() => {
  server.stop()
  rmSync(storage, { recursive: true, force: true })
})

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(BunwriteException)
    const e = error as BunwriteException
    return { code: e.code, type: e.type, message: e.message }
  }
  throw new Error('Expected the call to fail')
}

describe('client', () => {
  test('health answers without a project', async () => {
    const health = new Health(new Client().setEndpoint(server.endpoint))
    expect(await health.get()).toMatchObject({ status: 'pass' })
    expect((await health.getVersion()).version).toBeString()
  })

  test('errors carry a code and type', async () => {
    const result = await failure(new Databases(guest()).getDocument({ databaseId: DB, collectionId: 'products', documentId: 'nope' }))
    expect(result.code).toBe(404)
    expect(result.type).toBeString()
  })

  test('a bad endpoint is refused before any request', () => {
    expect(() => new Client().setEndpoint('localhost:8080')).toThrow('Invalid endpoint URL')
  })
})

describe('databases', () => {
  test('document CRUD, queries, increments and bulk writes with an API key', async () => {
    const databases = new Databases(admin())
    const doc = await databases.createDocument({
      databaseId: DB,
      collectionId: 'products',
      documentId: 'sdk-1',
      data: { tenantId: 't', name: 'Apple', price: 3, tags: ['fruit'] },
      permissions: [Permission.read(Role.any())],
    })
    expect(doc).toMatchObject({ $id: 'sdk-1', name: 'Apple', price: 3, $permissions: ['read("any")'] })

    await databases.createDocuments({
      databaseId: DB,
      collectionId: 'products',
      documents: [
        { $id: 'sdk-2', tenantId: 't', name: 'Banana', price: 1 },
        { $id: 'sdk-3', tenantId: 't', name: 'Cherry', price: 7 },
      ],
    })
    const cheap = await databases.listDocuments({
      databaseId: DB,
      collectionId: 'products',
      queries: [Query.equal('tenantId', 't'), Query.lessThan('price', 5), Query.orderAsc('price')],
    })
    expect(cheap.documents.map((d) => d.$id)).toEqual(['sdk-2', 'sdk-1'])
    expect(cheap.total).toBe(2)

    const bumped = await databases.incrementDocumentAttribute({ databaseId: DB, collectionId: 'products', documentId: 'sdk-1', attribute: 'price', value: 2 })
    expect(bumped.price).toBe(5)
    expect((await databases.updateDocument({ databaseId: DB, collectionId: 'products', documentId: 'sdk-1', data: { name: 'Green apple' } })).name).toBe('Green apple')

    await databases.deleteDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.equal('tenantId', 't')] })
    expect((await databases.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.equal('tenantId', 't')] })).total).toBe(0)
  })

  test('the deprecated positional style still works', async () => {
    const databases = new Databases(admin())
    await databases.createDocument(DB, 'products', 'sdk-positional', { tenantId: 'p', name: 'Pear' })
    expect((await databases.getDocument(DB, 'products', 'sdk-positional')).name).toBe('Pear')
  })

  test('transactions stage writes until commit', async () => {
    const databases = new Databases(admin())
    const tx = await databases.createTransaction()
    await databases.createDocument({ databaseId: DB, collectionId: 'products', documentId: 'sdk-tx', data: { tenantId: 'x', name: 'Staged' }, transactionId: tx.$id })
    expect((await failure(databases.getDocument({ databaseId: DB, collectionId: 'products', documentId: 'sdk-tx' }))).code).toBe(404)
    await databases.updateTransaction({ transactionId: tx.$id, commit: true })
    expect((await databases.getDocument({ databaseId: DB, collectionId: 'products', documentId: 'sdk-tx' })).name).toBe('Staged')
  })

  test('schema: databases, collections, attributes and indexes', async () => {
    const databases = new Databases(admin())
    await databases.create({ databaseId: 'sdk', name: 'SDK' })
    await databases.createCollection({ databaseId: 'sdk', collectionId: 'items', name: 'Items', permissions: [Permission.read(Role.any())] })
    await databases.createStringAttribute({ databaseId: 'sdk', collectionId: 'items', key: 'title', size: 100, required: true })
    await databases.createIntegerAttribute({ databaseId: 'sdk', collectionId: 'items', key: 'qty', required: false, min: 0, xdefault: 1 })
    await databases.createEnumAttribute({ databaseId: 'sdk', collectionId: 'items', key: 'kind', elements: ['a', 'b'], required: false })
    await databases.createIndex({ databaseId: 'sdk', collectionId: 'items', key: 'idx_title', type: 'key' as any, attributes: ['title'] })
    const collection = await databases.getCollection({ databaseId: 'sdk', collectionId: 'items' })
    expect(collection.attributes.map((a: any) => a.key)).toEqual(['title', 'qty', 'kind'])
    expect(collection.indexes.map((i: any) => i.key)).toEqual(['idx_title'])
    const doc = await databases.createDocument({ databaseId: 'sdk', collectionId: 'items', documentId: ID.unique(), data: { title: 'Box' } })
    expect(doc.qty).toBe(1)
  })

  test('TablesDB manages the same schema as tables and columns', async () => {
    const tables = new TablesDB(admin())
    await tables.create({ databaseId: 'sdk-tables', name: 'Tables' })
    await tables.createTable({ databaseId: 'sdk-tables', tableId: 'leads', name: 'Leads' })
    await tables.createStringColumn({ databaseId: 'sdk-tables', tableId: 'leads', key: 'name', size: 50, required: true })
    await tables.createBooleanColumn({ databaseId: 'sdk-tables', tableId: 'leads', key: 'won', required: false })
    const table = await tables.getTable({ databaseId: 'sdk-tables', tableId: 'leads' })
    expect(table.columns.map((c: any) => c.key)).toEqual(['name', 'won'])
    expect((await tables.list()).databases.map((d) => d.$id)).toContain('sdk-tables')
  })
})

describe('users and account', () => {
  test('a user signs in with email and password, and acts with their session', async () => {
    const users = new Users(admin())
    const user = await users.create({ userId: 'sdk-user', email: 'sdk@example.com', password: 'correct horse battery', name: 'SDK' })
    expect(user.email).toBe('sdk@example.com')
    await users.updateLabels({ userId: user.$id, labels: ['vip'] })

    const session = await new Account(admin()).createEmailPasswordSession({ email: 'sdk@example.com', password: 'correct horse battery' })
    const client = guest().setSession(session.secret)
    const account = new Account(client)
    expect(await account.get()).toMatchObject({ $id: 'sdk-user', name: 'SDK', labels: ['vip'] })
    await account.updatePrefs({ prefs: { theme: 'dark' } })
    expect((await account.getPrefs()) as object).toEqual({ theme: 'dark' })

    // Row permissions apply to the session, not the key.
    const databases = new Databases(admin())
    await databases.createDocument({ databaseId: DB, collectionId: 'products', documentId: 'mine', data: { tenantId: 'u', name: 'Mine' }, permissions: [Permission.read(Role.user('sdk-user'))] })
    await databases.createDocument({ databaseId: DB, collectionId: 'products', documentId: 'theirs', data: { tenantId: 'u', name: 'Theirs' } })
    const seen = await new Databases(client).listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.equal('tenantId', 'u')] })
    expect(seen.documents.map((d) => d.$id)).toEqual(['mine'])

    const { jwt } = await account.createJWT()
    expect((await new Account(guest().setJWT(jwt)).get()).$id).toBe('sdk-user')

    await account.deleteSession({ sessionId: 'current' })
    expect((await failure(account.get())).code).toBe(401)
  })

  test('createOAuth2Token returns the URL to send the browser to outside a browser', () => {
    const url = new Account(guest()).createOAuth2Token({ provider: 'google' as any, success: 'https://app.example.com/ok' })
    expect(url).toStartWith(`${server.endpoint}/account/tokens/oauth2/google?`)
    expect(url).toContain(`project=${PROJECT}`)
  })
})

describe('teams', () => {
  test('create, rename and list members', async () => {
    const teams = new Teams(admin())
    await teams.create({ teamId: 'sdk-team', name: 'Team' })
    await teams.updateName({ teamId: 'sdk-team', name: 'Renamed' })
    await teams.createMembership({ teamId: 'sdk-team', roles: ['editor'], userId: 'sdk-user' })
    expect((await teams.get({ teamId: 'sdk-team' })).name).toBe('Renamed')
    expect((await teams.listMemberships({ teamId: 'sdk-team' })).memberships.map((m) => m.userId)).toEqual(['sdk-user'])
  })
})

describe('storage', () => {
  test('buckets, uploads in chunks, bytes and URLs', async () => {
    const storage = new Storage(admin())
    await storage.createBucket({ bucketId: 'sdk-bucket', name: 'SDK', permissions: [Permission.read(Role.any())], fileSecurity: false })

    const small = await storage.createFile({ bucketId: 'sdk-bucket', fileId: 'hello', file: InputFile.fromPlainText('hello world', 'hello.txt') })
    expect(small).toMatchObject({ $id: 'hello', name: 'hello.txt', sizeOriginal: 11 })
    expect(new TextDecoder().decode(await storage.getFileViewBytes({ bucketId: 'sdk-bucket', fileId: 'hello' }))).toBe('hello world')

    // The URL works on its own, for <img src> and links.
    const url = new Storage(guest()).getFileView({ bucketId: 'sdk-bucket', fileId: 'hello' })
    expect(await (await fetch(url)).text()).toBe('hello world')

    // 12 MB: three chunks, uploaded in parallel after the first.
    const big = new Uint8Array(12 * 1024 * 1024).map((_, i) => i % 251)
    const progress: number[] = []
    const file = await storage.createFile({
      bucketId: 'sdk-bucket',
      fileId: 'big',
      file: new File([big], 'big.bin'),
      onProgress: (p) => progress.push(p.chunksUploaded),
    })
    expect(file.sizeOriginal).toBe(big.length)
    expect(progress.at(-1)).toBe(3)
    const back = new Uint8Array(await storage.getFileDownloadBytes({ bucketId: 'sdk-bucket', fileId: 'big' }))
    expect(back.length).toBe(big.length)
    expect(Bun.hash(back)).toBe(Bun.hash(big))
  })
})

describe('functions, messaging and webhooks', () => {
  test('list and read what the server has', async () => {
    expect((await new Functions(admin()).list()).total).toBeGreaterThanOrEqual(0)
    const messaging = new Messaging(admin())
    await messaging.createTopic({ topicId: 'sdk-news', name: 'News', subscribe: ['users'] })
    expect((await messaging.getTopic({ topicId: 'sdk-news' })).name).toBe('News')
    const webhooks = new Webhooks(admin())
    const hook = await webhooks.create({ webhookId: 'sdk-hook', url: 'https://example.com/hook', name: 'Hook', events: ['databases.*'] })
    expect(hook.name).toBe('Hook')
    expect((await webhooks.list()).webhooks.map((w) => w.$id)).toContain('sdk-hook')
  })
})

describe('realtime', () => {
  test('the Realtime service hears document events in Bun', async () => {
    const realtime = new Realtime(admin())
    const events: any[] = []
    const subscription = await realtime.subscribe(Channel.database(DB).collection('products').document(), (e) => events.push(e))
    await Bun.sleep(200)
    await new Databases(admin()).createDocument({
      databaseId: DB,
      collectionId: 'products',
      documentId: 'rt-sdk',
      data: { tenantId: 'rt', name: 'Live' },
      permissions: [Permission.read(Role.any())],
    })
    await Bun.sleep(300)
    expect(events.map((e) => e.payload.$id)).toContain('rt-sdk')
    await subscription.close()
    await realtime.disconnect()
  })
})
