/**
 * The APIs behind `appwrite pull/push settings, webhooks, topics, buckets`,
 * through node-appwrite: Project (services, protocols, sign-in methods,
 * policies, mock phones), Webhooks with delivery, Messaging topics, bucket
 * writes, deployment downloads, and the console-project API the CLI signs
 * in to.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client, ID, Messaging, Project, Query, Storage, Webhooks } from 'node-appwrite'

import { ConsoleAuth } from '~/console/auth'
import { webhookSignature } from '~/webhooks/service'
import { adminClient, DB, failure, KEY, makeUser, PROJECT, sessionClient, startServer, type TestServer } from './helpers'

const keyClient = (s: TestServer) => new Client().setEndpoint(s.endpoint).setProject(PROJECT).setKey(KEY)

async function call(s: TestServer, method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) {
  const response = await fetch(`${s.endpoint}${path}`, {
    method,
    headers: { 'x-appwrite-project': PROJECT, 'content-type': 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await response.text()
  return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as any) : null }
}

describe('Project: services, protocols and sign-in methods', () => {
  let server: TestServer
  let project: any
  beforeAll(() => {
    server = startServer()
    project = new Project(keyClient(server))
  })
  afterAll(() => server.stop())

  test('the project lists every service, protocol and method, all on by default', async () => {
    const p = await project.get()
    expect(p).toMatchObject({ $id: PROJECT, name: 'Test Project', teamId: 'org_test' })
    expect(p.services.every((s: any) => s.enabled)).toBe(true)
    expect(p.services.map((s: any) => s.$id)).toEqual(expect.arrayContaining(['account', 'databases', 'storage', 'teams', 'users', 'functions', 'messaging']))
    expect(p.protocols).toEqual([
      { $id: 'rest', enabled: true },
      { $id: 'graphql', enabled: true },
      { $id: 'websocket', enabled: true },
    ])
    expect(p.authMethods.map((m: any) => m.$id)).toEqual(['email-password', 'magic-url', 'email-otp', 'anonymous', 'invites', 'jwt', 'phone'])
  })

  test('unknown IDs and non-boolean values are refused', async () => {
    expect(await failure(project.updateService({ serviceId: 'nope', enabled: false }))).toMatchObject({ code: 400 })
    expect(await failure(project.updateProtocol({ protocolId: 'ftp', enabled: false }))).toMatchObject({ code: 400 })
    expect(await failure(project.updateAuthMethod({ methodId: 'carrier-pigeon', enabled: false }))).toMatchObject({ code: 400 })
    expect((await call(server, 'PATCH', '/project/services/storage', { headers: { 'x-appwrite-key': KEY }, body: { enabled: 'no' } })).status).toBe(400)
  })

  test('only API keys and console admins may read or change them', async () => {
    const user = makeUser(server.db)
    expect((await call(server, 'GET', '/project')).status).toBe(401)
    expect((await call(server, 'GET', '/project/policies', { headers: { 'x-appwrite-session': user.secret } })).status).toBe(401)
    expect((await call(server, 'PATCH', '/project/services/storage', { headers: { 'x-appwrite-session': user.secret }, body: { enabled: false } })).status).toBe(401)
  })

  test('a switched-off service stops clients but not API keys', async () => {
    const admin = adminClient(server.endpoint)
    await admin.storage.createBucket({ bucketId: 'pics', name: 'Pics', permissions: ['read("any")'] })
    await project.updateService({ serviceId: 'storage', enabled: false })
    const guest = sessionClient(server.endpoint)
    expect(await failure(guest.storage.listFiles({ bucketId: 'pics' }))).toMatchObject({ code: 403, type: 'general_service_disabled' })
    expect((await admin.storage.listFiles({ bucketId: 'pics' })).total).toBe(0)
    // Other services carry on.
    expect((await guest.databases.listDocuments({ databaseId: DB, collectionId: 'notes' })).total).toBe(0)
    await project.updateService({ serviceId: 'storage', enabled: true })
    expect((await guest.storage.listFiles({ bucketId: 'pics' })).total).toBe(0)
  })

  test('switching off databases also closes the TablesDB API', async () => {
    await project.updateService({ serviceId: 'databases', enabled: false })
    const guest = sessionClient(server.endpoint)
    expect(await failure(guest.databases.listDocuments({ databaseId: DB, collectionId: 'notes' }))).toMatchObject({ type: 'general_service_disabled' })
    expect((await call(server, 'GET', `/tablesdb/${DB}`)).body.type).toBe('general_service_disabled')
    await project.updateService({ serviceId: 'databases', enabled: true })
  })

  test('the REST protocol off refuses clients; API keys still work', async () => {
    await project.updateProtocol({ protocolId: 'rest', enabled: false })
    const guest = sessionClient(server.endpoint)
    expect(await failure(guest.databases.listDocuments({ databaseId: DB, collectionId: 'notes' }))).toMatchObject({ code: 403, type: 'general_api_disabled' })
    expect((await adminClient(server.endpoint).databases.listDocuments({ databaseId: DB, collectionId: 'notes' })).total).toBe(0)
    await project.updateProtocol({ protocolId: 'rest', enabled: true })
  })

  test('the WebSocket protocol off refuses realtime connections', async () => {
    const connect = () =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`${server.endpoint.replace('http', 'ws')}/realtime?project=${PROJECT}&channels[]=documents`)
        ws.onopen = () => {
          ws.close()
          resolve('open')
        }
        ws.onerror = () => resolve('refused')
      })
    expect(await connect()).toBe('open')
    await project.updateProtocol({ protocolId: 'websocket', enabled: false })
    expect(await connect()).toBe('refused')
    await project.updateProtocol({ protocolId: 'websocket', enabled: true })
  })

  test('sign-in methods: email-password, email-otp, jwt and invites', async () => {
    const guest = sessionClient(server.endpoint)
    await project.updateAuthMethod({ methodId: 'email-password', enabled: false })
    expect(await failure(guest.account.create({ userId: ID.unique(), email: 'new@example.com', password: 'password123' }))).toMatchObject({ code: 501, type: 'user_auth_method_unsupported' })
    expect(await failure(guest.account.createEmailPasswordSession({ email: 'new@example.com', password: 'password123' }))).toMatchObject({ code: 501 })
    // API keys still create sessions for server-side sign-in.
    const keyed = adminClient(server.endpoint)
    await keyed.users.create({ userId: 'u-keyed', email: 'keyed@example.com', password: 'password123' })
    expect((await keyed.account.createEmailPasswordSession({ email: 'keyed@example.com', password: 'password123' })).userId).toBe('u-keyed')
    await project.updateAuthMethod({ methodId: 'email-password', enabled: true })

    await project.updateAuthMethod({ methodId: 'email-otp', enabled: false })
    expect(await failure(guest.account.createEmailToken({ userId: ID.unique(), email: 'otp@example.com' }))).toMatchObject({ code: 501 })
    await project.updateAuthMethod({ methodId: 'email-otp', enabled: true })

    const user = makeUser(server.db)
    await project.updateAuthMethod({ methodId: 'jwt', enabled: false })
    expect((await call(server, 'POST', '/account/jwts', { headers: { 'x-appwrite-session': user.secret } })).body.type).toBe('user_auth_method_unsupported')
    await project.updateAuthMethod({ methodId: 'jwt', enabled: true })
    expect((await call(server, 'POST', '/account/jwts', { headers: { 'x-appwrite-session': user.secret } })).status).toBe(201)

    await keyed.teams.create({ teamId: 'crew', name: 'Crew' })
    await keyed.teams.createMembership({ teamId: 'crew', roles: ['owner'], userId: user.id })
    await project.updateAuthMethod({ methodId: 'invites', enabled: false })
    const member = sessionClient(server.endpoint, user.secret)
    expect(await failure(member.teams.createMembership({ teamId: 'crew', roles: [], email: 'friend@example.com', url: 'http://localhost/join' }))).toMatchObject({ code: 501 })
    await project.updateAuthMethod({ methodId: 'invites', enabled: true })
  })
})

describe('Project: policies and mock phones', () => {
  let server: TestServer
  let project: any
  beforeAll(() => {
    server = startServer()
    project = new Project(keyClient(server))
  })
  afterAll(() => server.stop())

  test('policies list with their current values and can be read one at a time', async () => {
    const { total, policies } = await project.listPolicies()
    expect(total).toBe(12)
    expect(policies).toContainEqual({ $id: 'session-duration', duration: 31536000 })
    expect(policies).toContainEqual({ $id: 'session-limit', total: 10 })
    expect(policies).toContainEqual({ $id: 'user-limit', total: 0 })
    expect((await project.listPolicies({ queries: [Query.limit(2), Query.offset(1)] })).policies.map((p: any) => p.$id)).toEqual(['password-history', 'password-personal-data'])
    expect(await project.getPolicy({ policyId: 'password-history' })).toEqual({ $id: 'password-history', total: 0 })
    expect((await call(server, 'GET', '/project/policies/nope', { headers: { 'x-appwrite-key': KEY } })).status).toBe(400)
  })

  test('every policy update is stored and read back', async () => {
    await project.updatePasswordDictionaryPolicy({ enabled: true })
    await project.updatePasswordHistoryPolicy({ total: 5 })
    await project.updateSessionAlertPolicy({ enabled: true })
    await project.updateSessionInvalidationPolicy({ enabled: true })
    await project.updateDenyAliasedEmailPolicy({ enabled: true })
    await project.updateDenyDisposableEmailPolicy({ enabled: true })
    await project.updateDenyFreeEmailPolicy({ enabled: true })
    await project.updateMembershipPrivacyPolicy({ userEmail: false, userPhone: false })
    const byId = Object.fromEntries((await project.listPolicies({ queries: [Query.limit(100)] })).policies.map((p: any) => [p.$id, p]))
    expect(byId['password-dictionary']).toEqual({ $id: 'password-dictionary', enabled: true })
    expect(byId['password-history']).toEqual({ $id: 'password-history', total: 5 })
    expect(byId['session-alert'].enabled).toBe(true)
    expect(byId['session-invalidation'].enabled).toBe(true)
    expect([byId['deny-aliased-email'].enabled, byId['deny-disposable-email'].enabled, byId['deny-free-email'].enabled]).toEqual([true, true, true])
    expect(byId['membership-privacy']).toMatchObject({ userId: true, userEmail: false, userPhone: false, userName: true })
  })

  test('out-of-range values are refused', async () => {
    expect(await failure(project.updatePasswordHistoryPolicy({ total: 21 }))).toMatchObject({ code: 400 })
    expect(await failure(project.updateUserLimitPolicy({ total: -1 }))).toMatchObject({ code: 400 })
    expect(await failure(project.updateSessionDurationPolicy({ duration: 1 }))).toMatchObject({ code: 400 })
    expect(await failure(project.updateSessionLimitPolicy({ total: 101 }))).toMatchObject({ code: 400 })
  })

  test('session duration and limit apply to new sessions', async () => {
    await project.updateSessionDurationPolicy({ duration: 600 })
    await project.updateSessionLimitPolicy({ total: 2 })
    expect(server.config).toMatchObject({ sessionDuration: 600, sessionsLimit: 2 })
    const admin = adminClient(server.endpoint)
    await admin.users.create({ userId: 'limited', email: 'limited@example.com', password: 'password123' })
    const guest = sessionClient(server.endpoint)
    const session = await guest.account.createEmailPasswordSession({ email: 'limited@example.com', password: 'password123' })
    const seconds = (Date.parse(session.expire) - Date.now()) / 1000
    expect(seconds).toBeGreaterThan(590)
    expect(seconds).toBeLessThanOrEqual(600)
    for (let i = 0; i < 2; i++) await sessionClient(server.endpoint).account.createEmailPasswordSession({ email: 'limited@example.com', password: 'password123' })
    expect((await admin.users.listSessions({ userId: 'limited' })).total).toBe(2)
  })

  test('the user limit stops sign-ups once reached', async () => {
    const count = server.db.sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM _users').get()!.n
    await project.updateUserLimitPolicy({ total: count + 1 })
    const guest = sessionClient(server.endpoint)
    await guest.account.create({ userId: 'first', email: 'first@example.com', password: 'password123' })
    expect(await failure(guest.account.create({ userId: 'second', email: 'second@example.com', password: 'password123' }))).toMatchObject({ code: 400, type: 'user_count_exceeded' })
    await project.updateUserLimitPolicy({ total: 0 })
    await guest.account.create({ userId: 'second', email: 'second@example.com', password: 'password123' })
  })

  test('the personal-data policy refuses passwords containing the name, email or ID', async () => {
    const guest = sessionClient(server.endpoint)
    await guest.account.create({ userId: 'before', email: 'grace@example.com', password: 'grace-1234' })
    await project.updatePasswordPersonalDataPolicy({ enabled: true })
    expect(await failure(guest.account.create({ userId: 'ada', email: 'ada@example.com', password: 'my-ada-password', name: 'Ada' }))).toMatchObject({ code: 400, type: 'password_personal_data' })
    expect(await failure(guest.account.create({ userId: ID.unique(), email: 'lin@example.com', password: 'xlovelacex', name: 'Lovelace' }))).toMatchObject({ type: 'password_personal_data' })
    await guest.account.create({ userId: 'ada', email: 'ada@example.com', password: 'unrelated-secret', name: 'Ada' })
    const admin = adminClient(server.endpoint)
    expect(await failure(admin.users.updatePassword({ userId: 'ada', password: 'ada.example.com' }))).toMatchObject({ type: 'password_personal_data' })
    await project.updatePasswordPersonalDataPolicy({ enabled: false })
  })

  test('mock phone numbers: create, read, update, delete', async () => {
    expect(await project.createMockPhone({ number: '+15555550100', otp: '123456' })).toMatchObject({ number: '+15555550100', otp: '123456' })
    expect(await failure(project.createMockPhone({ number: '+15555550100', otp: '000000' }))).toMatchObject({ code: 409, type: 'mock_number_already_exists' })
    expect(await failure(project.createMockPhone({ number: '5555550100', otp: '123456' }))).toMatchObject({ code: 400 })
    expect(await failure(project.createMockPhone({ number: '+15555550101', otp: '12' }))).toMatchObject({ code: 400 })
    await project.updateMockPhone({ number: '+15555550100', otp: '654321' })
    expect((await project.getMockPhone({ number: '+15555550100' })).otp).toBe('654321')
    expect((await project.listMockPhones()).mockNumbers.map((m: any) => m.number)).toEqual(['+15555550100'])
    await project.deleteMockPhone({ number: '+15555550100' })
    expect(await failure(project.getMockPhone({ number: '+15555550100' }))).toMatchObject({ code: 404, type: 'mock_number_not_found' })
  })
})

describe('Webhooks', () => {
  let server: TestServer
  let webhooks: any
  let receiver: ReturnType<typeof Bun.serve>
  const hits: { path: string; headers: Headers; body: string }[] = []

  beforeAll(() => {
    server = startServer()
    webhooks = new Webhooks(keyClient(server))
    receiver = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        hits.push({ path, headers: request.headers, body: await request.text() })
        return new Response(path === '/broken' ? 'nope' : 'ok', { status: path === '/broken' ? 500 : 200 })
      },
    })
  })
  afterAll(() => {
    receiver.stop(true)
    server.stop()
  })

  const url = (path: string) => `http://localhost:${receiver.port}${path}`
  const createNote = (id: string) => adminClient(server.endpoint).databases.createDocument({ databaseId: DB, collectionId: 'notes', documentId: id, data: { text: id } })

  test('create, read, list, update, rotate the secret, delete', async () => {
    const hook = await webhooks.create({ webhookId: 'w1', name: 'One', url: url('/one'), events: ['databases.*.collections.*.documents.*.create'] })
    expect(hook).toMatchObject({ $id: 'w1', name: 'One', enabled: true, tls: true, attempts: 0, logs: '', authUsername: '' })
    expect(hook.secret).toMatch(/^[0-9a-f]{128}$/)
    expect(await failure(webhooks.create({ webhookId: 'w1', name: 'Again', url: url('/x'), events: [] }))).toMatchObject({ code: 409, type: 'webhook_already_exists' })
    expect(await failure(webhooks.create({ webhookId: 'w2', name: 'Bad', url: 'ftp://example.com', events: [] }))).toMatchObject({ code: 400 })
    expect(await failure(webhooks.create({ webhookId: 'w2', name: 'Bad', url: url('/x'), events: ['not an event!'] }))).toMatchObject({ code: 400 })

    await webhooks.create({ webhookId: 'w2', name: 'Two', url: url('/two'), events: [], secret: 'my-secret' })
    expect((await webhooks.get({ webhookId: 'w2' })).secret).toBe('my-secret')
    expect((await webhooks.list()).webhooks.map((w: any) => w.$id)).toEqual(['w1', 'w2'])
    expect((await webhooks.list({ queries: [Query.limit(1), Query.offset(1)] })).webhooks.map((w: any) => w.$id)).toEqual(['w2'])
    expect((await call(server, 'GET', '/webhooks?search=two', { headers: { 'x-appwrite-key': KEY } })).body.webhooks.map((w: any) => w.$id)).toEqual(['w2'])

    const updated = await webhooks.update({ webhookId: 'w2', name: 'Second', url: url('/two'), events: ['databases.*.collections.*.documents.*'], enabled: false, tls: false, authUsername: 'bob', authPassword: 'pw' })
    expect(updated).toMatchObject({ name: 'Second', enabled: false, tls: false, authUsername: 'bob', authPassword: 'pw', secret: 'my-secret' })
    const rotated = await webhooks.updateSecret({ webhookId: 'w2' })
    expect(rotated.secret).not.toBe('my-secret')
    expect((await webhooks.updateSecret({ webhookId: 'w2', secret: 'chosen' })).secret).toBe('chosen')

    await webhooks.delete({ webhookId: 'w2' })
    expect(await failure(webhooks.get({ webhookId: 'w2' }))).toMatchObject({ code: 404, type: 'webhook_not_found' })
  })

  test('only API keys and console admins may manage webhooks', async () => {
    expect((await call(server, 'GET', '/webhooks')).status).toBe(401)
    const user = makeUser(server.db)
    expect((await call(server, 'POST', '/webhooks', { headers: { 'x-appwrite-session': user.secret }, body: { webhookId: 'x', name: 'x', url: url('/x'), events: [] } })).status).toBe(401)
  })

  test('only subscribed events are delivered, signed, with basic auth when set', async () => {
    await webhooks.create({ webhookId: 'auth', name: 'Auth', url: url('/auth'), events: ['databases.main.collections.notes.documents.*.update'], authUsername: 'bob', authPassword: 'pw', secret: 's3cret' })
    hits.length = 0
    await createNote('d1')
    await server.services.webhooks.idle()
    expect(hits.map((h) => h.path)).toEqual(['/one'])

    hits.length = 0
    await adminClient(server.endpoint).databases.updateDocument({ databaseId: DB, collectionId: 'notes', documentId: 'd1', data: { text: 'changed' } })
    await server.services.webhooks.idle()
    expect(hits.map((h) => h.path)).toEqual(['/auth'])
    const [hit] = hits
    expect(hit!.headers.get('authorization')).toBe(`Basic ${btoa('bob:pw')}`)
    expect(hit!.headers.get('x-appwrite-webhook-signature')).toBe(webhookSignature(url('/auth'), hit!.body, 's3cret'))
    expect(hit!.headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(hit!.body)).toMatchObject({ $id: 'd1', text: 'changed' })
  })

  test('the signed-in user is named in the delivery', async () => {
    const user = makeUser(server.db)
    hits.length = 0
    await sessionClient(server.endpoint, user.secret).databases.createDocument({ databaseId: DB, collectionId: 'notes', documentId: 'd2', data: { text: 'mine' }, permissions: [] })
    await server.services.webhooks.idle()
    expect(hits.find((h) => h.path === '/one')!.headers.get('x-appwrite-webhook-user-id')).toBe(user.id)
  })

  test('failures are counted and logged; ten in a row turn the webhook off', async () => {
    await webhooks.create({ webhookId: 'broken', name: 'Broken', url: url('/broken'), events: ['databases.*.collections.*.documents.*.create'] })
    await createNote('f1')
    await server.services.webhooks.idle()
    let broken = await webhooks.get({ webhookId: 'broken' })
    expect(broken.attempts).toBe(1)
    expect(broken.logs).toContain('500')

    for (let i = 2; i <= 10; i++) await createNote(`f${i}`)
    await server.services.webhooks.idle()
    broken = await webhooks.get({ webhookId: 'broken' })
    expect([broken.attempts, broken.enabled]).toEqual([10, false])

    // Turning it back on starts the count again; a success clears the log.
    await webhooks.update({ webhookId: 'broken', name: 'Fixed', url: url('/fixed'), events: ['databases.*.collections.*.documents.*.create'], enabled: true })
    expect((await webhooks.get({ webhookId: 'broken' })).attempts).toBe(0)
    await createNote('f11')
    await server.services.webhooks.idle()
    expect(await webhooks.get({ webhookId: 'broken' })).toMatchObject({ attempts: 0, logs: '', enabled: true })
  })

  test('a failed request delivers nothing', async () => {
    hits.length = 0
    expect(await failure(createNote('d1'))).toMatchObject({ code: 409 })
    await server.services.webhooks.idle()
    expect(hits).toEqual([])
  })
})

describe('Messaging topics', () => {
  let server: TestServer
  let messaging: any
  beforeAll(() => {
    server = startServer()
    messaging = new Messaging(keyClient(server))
  })
  afterAll(() => server.stop())

  test('create, read, list, search, update, delete', async () => {
    expect(await messaging.createTopic({ topicId: 'news', name: 'News' })).toMatchObject({ $id: 'news', name: 'News', subscribe: ['users'], emailTotal: 0, smsTotal: 0, pushTotal: 0 })
    expect(await failure(messaging.createTopic({ topicId: 'news', name: 'Again' }))).toMatchObject({ code: 409, type: 'topic_already_exists' })
    await messaging.createTopic({ topicId: ID.unique(), name: 'Offers', subscribe: ['team:vip'] })
    expect((await messaging.listTopics()).total).toBe(2)
    expect((await messaging.listTopics({ search: 'off' })).topics.map((t: any) => t.name)).toEqual(['Offers'])
    expect((await messaging.listTopics({ queries: [Query.equal('name', 'News')] })).topics.map((t: any) => t.$id)).toEqual(['news'])
    expect(await messaging.updateTopic({ topicId: 'news', name: 'Newsletter' })).toMatchObject({ name: 'Newsletter', subscribe: ['users'] })
    expect(await messaging.updateTopic({ topicId: 'news', subscribe: ['any'] })).toMatchObject({ name: 'Newsletter', subscribe: ['any'] })
    expect(await failure(messaging.updateTopic({ topicId: 'news', subscribe: 'users' as any }))).toMatchObject({ code: 400 })
    await messaging.deleteTopic({ topicId: 'news' })
    expect(await failure(messaging.getTopic({ topicId: 'news' }))).toMatchObject({ code: 404, type: 'topic_not_found' })
  })

  test('only API keys and console admins may manage topics', async () => {
    expect((await call(server, 'GET', '/messaging/topics')).status).toBe(401)
  })
})

describe('Storage buckets', () => {
  let server: TestServer
  let storage: any
  beforeAll(() => {
    server = startServer()
    storage = new Storage(keyClient(server))
  })
  afterAll(() => server.stop())

  test('create uses Appwrite defaults; update changes only what is sent', async () => {
    const created = await storage.createBucket({ bucketId: 'docs', name: 'Docs' })
    expect(created).toMatchObject({ $id: 'docs', name: 'Docs', enabled: true, fileSecurity: false, maximumFileSize: 30_000_000, allowedFileExtensions: [], compression: 'none', encryption: true, antivirus: true, transformations: true })
    expect(await failure(storage.createBucket({ bucketId: 'docs', name: 'Again' }))).toMatchObject({ code: 409, type: 'storage_bucket_already_exists' })
    expect(await failure(storage.createBucket({ bucketId: 'zip', name: 'Zip', compression: 'brotli' as any }))).toMatchObject({ code: 400 })

    const updated = await storage.updateBucket({ bucketId: 'docs', name: 'Documents', allowedFileExtensions: ['.PDF'], compression: 'zstd', encryption: false })
    expect(updated).toMatchObject({ name: 'Documents', allowedFileExtensions: ['pdf'], compression: 'zstd', encryption: false, antivirus: true, maximumFileSize: 30_000_000 })
    expect(await failure(storage.updateBucket({ bucketId: 'missing', name: 'x' }))).toMatchObject({ code: 404 })
  })

  test('lists page and search like Appwrite', async () => {
    await storage.createBucket({ bucketId: ID.unique(), name: 'Avatars' })
    await storage.createBucket({ bucketId: 'covers', name: 'Covers' })
    expect((await storage.listBuckets()).total).toBe(3)
    const page = await storage.listBuckets({ queries: [Query.limit(1), Query.offset(1)] })
    expect([page.total, page.buckets.length]).toEqual([3, 1])
    expect((await storage.listBuckets({ search: 'cover' })).buckets.map((b: any) => b.$id)).toEqual(['covers'])
    expect((await storage.listBuckets({ queries: [Query.cursorAfter('docs')] })).buckets.map((b: any) => b.name)).toEqual(['Avatars', 'Covers'])
  })

  test('deleting a bucket removes its files', async () => {
    await storage.createFile({ bucketId: 'covers', fileId: 'c1', file: new File(['hello'], 'hello.txt', { type: 'text/plain' }) })
    await storage.deleteBucket({ bucketId: 'covers' })
    expect(await failure(storage.getBucket({ bucketId: 'covers' }))).toMatchObject({ code: 404 })
    expect(server.db.sqlite.query("SELECT count(*) AS n FROM _files WHERE bucket_id = 'covers'").get()).toEqual({ n: 0 })
  })

  test('bucket writes need an API key', async () => {
    expect((await call(server, 'POST', '/storage/buckets', { body: { bucketId: 'x', name: 'x' } })).status).toBe(401)
    expect((await call(server, 'DELETE', '/storage/buckets/docs')).status).toBe(401)
  })
})

describe('console API for the CLI', () => {
  let server: TestServer
  let cookie: string
  const consoleCall = (method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) =>
    call(server, method, path, { ...init, headers: { 'x-appwrite-project': 'console', ...(cookie ? { cookie } : {}), ...init.headers } })

  beforeAll(async () => {
    server = startServer()
    await new ConsoleAuth(server.db).upsert('admin@example.com', 'admin-password')
  })
  afterAll(() => server.stop())

  test('sign in sets the a_session_console cookie; GET /account then names the admin', async () => {
    cookie = ''
    expect((await consoleCall('GET', '/account')).body).toMatchObject({ code: 401, type: 'general_unauthorized_scope', message: expect.stringContaining('role: guests') })
    expect((await consoleCall('POST', '/account/sessions/email', { body: { email: 'admin@example.com', password: 'wrong-password' } })).body.type).toBe('user_invalid_credentials')

    const login = await consoleCall('POST', '/account/sessions/email', { body: { email: 'admin@example.com', password: 'admin-password' } })
    expect(login.status).toBe(201)
    const setCookie = login.headers.get('set-cookie')!
    expect(setCookie).toMatch(/^a_session_console=[0-9a-f]+; Expires=.+; Path=\/; HttpOnly; SameSite=Strict$/)
    cookie = setCookie.split(';')[0]!
    expect((await consoleCall('GET', '/account')).body).toMatchObject({ email: 'admin@example.com', emailVerification: true, status: true })
  })

  test('organizations and projects', async () => {
    expect((await consoleCall('GET', '/teams')).body.teams).toEqual([expect.objectContaining({ $id: 'org_test' })])
    expect((await consoleCall('GET', `/projects/${PROJECT}`)).body).toMatchObject({ $id: PROJECT, teamId: 'org_test' })
    expect((await consoleCall('GET', '/organization/projects')).body).toMatchObject({ total: 1, projects: [{ $id: PROJECT }] })
    expect((await consoleCall('GET', `/organization/projects/${PROJECT}`, { headers: { 'x-appwrite-organization': 'other' } })).status).toBe(404)
    expect((await consoleCall('GET', '/organization/projects', { headers: { 'x-appwrite-organization': 'other' } })).status).toBe(400)
    expect((await consoleCall('GET', '/projects/missing')).body.type).toBe('project_not_found')

    const renamed = await consoleCall('PATCH', `/organization/projects/${PROJECT}`, { body: { name: 'Shop' } })
    expect(renamed.body.name).toBe('Shop')
    expect(server.config.projectName).toBe('Shop')
    expect((await consoleCall('PATCH', `/organization/projects/${PROJECT}`, { body: { name: '' } })).status).toBe(400)
    expect((await consoleCall('DELETE', `/organization/projects/${PROJECT}`)).status).toBe(400)
  })

  test('project calls with the cookie act as the admin only in admin mode', async () => {
    const asAdmin = await call(server, 'GET', '/webhooks', { headers: { cookie, 'x-appwrite-mode': 'admin' } })
    expect(asAdmin.status).toBe(200)
    expect((await call(server, 'GET', '/webhooks', { headers: { cookie } })).status).toBe(401)
    // A project user's own session cookie is not a console session.
    const user = makeUser(server.db)
    expect((await call(server, 'GET', '/webhooks', { headers: { cookie: `a_session_console=${user.secret}`, 'x-appwrite-mode': 'admin' } })).status).toBe(401)
  })

  test('console calls are refused without a session', async () => {
    const saved = cookie
    cookie = ''
    for (const [method, path] of [['GET', '/teams'], ['GET', `/projects/${PROJECT}`], ['GET', '/organization/projects']] as const) {
      expect((await consoleCall(method, path)).status).toBe(401)
    }
    cookie = saved
  })

  test('signing out ends the session for the cookie', async () => {
    expect((await consoleCall('DELETE', '/account/sessions/some-cli-local-id')).status).toBe(204)
    expect((await consoleCall('GET', '/account')).status).toBe(401)
    expect((await call(server, 'GET', '/webhooks', { headers: { cookie, 'x-appwrite-mode': 'admin' } })).status).toBe(401)
  })

  test('sign-in attempts are rate limited per address', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      statuses.push((await call(server, 'POST', '/account/sessions/email', { headers: { 'x-appwrite-project': 'console', 'x-forwarded-for': '203.0.113.9' }, body: { email: 'admin@example.com', password: 'wrong-password' } })).status)
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true)
    expect(statuses[10]).toBe(429)
  })
})

describe('function deployments for pull', () => {
  let server: TestServer
  beforeAll(() => {
    server = startServer()
  })
  afterAll(() => server.stop())

  test('downloads of unknown deployments are not found; sites list is empty', async () => {
    const functions = adminClient(server.endpoint).functions
    await functions.create({ functionId: 'f', name: 'f', runtime: 'node-22' })
    expect((await call(server, 'GET', '/functions/f/deployments/nope/download', { headers: { 'x-appwrite-key': KEY } })).body.type).toBe('deployment_not_found')
    expect((await call(server, 'GET', '/functions/f/deployments/nope/download')).status).toBe(401)
    expect((await call(server, 'GET', '/sites', { headers: { 'x-appwrite-key': KEY } })).body).toEqual({ total: 0, sites: [] })
    const listed = await functions.list({ queries: [Query.limit(1)] })
    expect([listed.total, listed.functions.length]).toEqual([1, 1])
  })
})
