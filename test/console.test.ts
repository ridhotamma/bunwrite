/**
 * The console drives the same services as the API, so each test makes a
 * change through a console form and checks it through the Appwrite SDK.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Query } from 'node-appwrite'

import { ConsoleAuth } from '~/console/auth'
import { adminClient, DB, PROJECT, startServer, type TestServer } from './helpers'

let server: TestServer
let base: string
let cookie = ''

async function form(path: string, fields: Record<string, string | string[]>, headers: Record<string, string> = {}) {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(fields)) for (const one of ([] as string[]).concat(v)) body.append(k, one)
  return fetch(`${base}${path}`, { method: 'POST', body, redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers } })
}

const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' })
const flash = (res: Response) => new URL(res.headers.get('location') ?? '/', base).searchParams

beforeAll(async () => {
  server = startServer()
  base = server.endpoint.replace(/\/v1$/, '')
  await new ConsoleAuth(server.db).upsert('admin@example.com', 'console-password')
})
afterAll(() => server.stop())

describe('console access', () => {
  test('signed-out visitors go to the sign-in page', async () => {
    const res = await fetch(`${base}/console/databases`, { redirect: 'manual' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/console/login')
  })

  test('wrong password is refused; the right one sets a strict cookie', async () => {
    const bad = await form('/console/login', { email: 'admin@example.com', password: 'nope-nope' })
    expect(bad.status).toBe(401)
    const ok = await form('/console/login', { email: 'admin@example.com', password: 'console-password' })
    expect(ok.status).toBe(303)
    const set = ok.headers.get('set-cookie')!
    expect(set).toContain('HttpOnly')
    expect(set).toContain('SameSite=Strict')
    expect(set).toContain('Path=/console')
    cookie = set.split(';')[0]!
    const home = await get('/console')
    expect(home.status).toBe(200)
    expect(await home.text()).toContain('Recent function runs')
  })

  test('forms posted from another site are refused', async () => {
    const res = await form('/console/databases', { id: 'evil', name: 'Evil' }, { origin: 'https://evil.example' })
    expect(res.status).toBe(403)
  })

  test('htmx requests get an HX-Location instead of a redirect', async () => {
    const res = await form('/console/databases', { id: 'hx', name: 'Hx' }, { 'hx-request': 'true' })
    expect(res.status).toBe(204)
    expect(JSON.parse(res.headers.get('hx-location')!).path).toStartWith('/console/databases/hx')
  })
})

describe('schema through the console', () => {
  test('create a collection, add attributes and an index, then use it through the API', async () => {
    expect((await form('/console/databases', { id: 'shop', name: 'Shop' })).status).toBe(303)
    expect((await form('/console/databases/shop/collections', { id: 'orders', name: 'Orders', documentSecurity: 'on', permissions: '' })).status).toBe(303)
    await form('/console/databases/shop/collections/orders/attributes', { key: 'code', type: 'string', size: '32', required: 'on' })
    await form('/console/databases/shop/collections/orders/attributes', { key: 'total', type: 'integer', min: '0', default: '0' })
    await form('/console/databases/shop/collections/orders/attributes', { key: 'state', type: 'enum', elements: 'new, paid', default: 'new' })
    const idx = await form('/console/databases/shop/collections/orders/indexes', { key: 'idx_code', type: 'unique', attributes: ['code'] })
    expect(flash(idx).get('ok')).toBe('Index added')

    const db = adminClient(server.endpoint).databases
    const doc = await db.createDocument({ databaseId: 'shop', collectionId: 'orders', documentId: 'o1', data: { code: 'A1' } })
    expect([doc.total, doc.state]).toEqual([0, 'new'])
    const dup = await db.createDocument({ databaseId: 'shop', collectionId: 'orders', documentId: 'o2', data: { code: 'A1' } }).catch((e: any) => e.type)
    expect(dup).toBe('document_unique_constraint_violation')
  })

  test('a bad attribute comes back as an error message', async () => {
    const res = await form('/console/databases/shop/collections/orders/attributes', { key: 'code', type: 'string' }, { referer: `${base}/console/databases/shop/collections/orders/attributes/new` })
    expect(flash(res).get('err')).toContain('already exists')
  })

  test('retyping an attribute keeps the data', async () => {
    await form('/console/databases/shop/collections/orders/attributes/total', { key: 'total', type: 'double', default: '0' })
    const doc = await adminClient(server.endpoint).databases.getDocument({ databaseId: 'shop', collectionId: 'orders', documentId: 'o1' })
    expect(doc.total).toBe(0)
  })

  test('documents can be edited and deleted', async () => {
    const saved = await form('/console/databases/shop/collections/orders/documents/o1', { data: JSON.stringify({ code: 'A1', total: 12.5, state: 'paid' }), permissions: 'read("any")' })
    expect(flash(saved).get('ok')).toBe('Saved')
    const doc = await adminClient(server.endpoint).databases.getDocument({ databaseId: 'shop', collectionId: 'orders', documentId: 'o1' })
    expect([doc.total, doc.state, doc.$permissions]).toEqual([12.5, 'paid', ['read("any")']])
    const list = await get(`/console/databases/shop/collections/orders/documents?q=${encodeURIComponent('{"method":"equal","attribute":"state","values":["paid"]}')}`)
    expect(await list.text()).toContain('>o1</a>')
    await form('/console/databases/shop/collections/orders/documents/o1/delete', {})
    expect((await adminClient(server.endpoint).databases.listDocuments({ databaseId: 'shop', collectionId: 'orders' })).total).toBe(0)
  })

  test('export, then preview and apply an import', async () => {
    const exported = (await (await get('/console/schema/export.json')).json()) as any
    const orders = exported.tables.find((t: any) => t.$id === 'orders')
    expect(orders.columns.map((c: any) => c.key)).toEqual(['code', 'total', 'state'])
    orders.columns.push({ key: 'note', type: 'string', size: 200, required: false, array: false, default: null })

    const body = new FormData()
    body.set('file', new File([JSON.stringify(exported)], 'appwrite.config.json', { type: 'application/json' }))
    const preview = await fetch(`${base}/console/schema/preview`, { method: 'POST', body, headers: { cookie } })
    const html = await preview.text()
    expect(html).toContain('collection orders: + note')
    // The preview changed nothing.
    expect(server.services.registry.collection('shop', 'orders', true).attributeMap.has('note')).toBe(false)

    const config = /name="config" value="([^"]*)"/.exec(html)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    const applied = await form('/console/schema/apply', { config, baseDir: '' })
    expect(flash(applied).get('ok')).toBe('Applied 1 change')
    expect(server.services.registry.collection('shop', 'orders', true).attributeMap.has('note')).toBe(true)
  })

  test('collections and databases can be deleted', async () => {
    await form('/console/databases/shop/collections/orders/delete', {})
    await form('/console/databases/shop/delete', {})
    expect(server.services.registry.databases.has('shop')).toBe(false)
  })
})

describe('auth through the console', () => {
  test('create, edit, block and delete a user', async () => {
    const created = await form('/console/auth/users', { name: 'Rina', email: 'rina@example.com', password: 'password-123' })
    const id = created.headers.get('location')!.split('/').pop()!.split('?')[0]!
    await form(`/console/auth/users/${id}`, { name: 'Rina S', email: 'rina@example.com', phone: '+6281112345', labels: 'vip, staff', emailVerification: 'on' })
    const users = adminClient(server.endpoint).users
    const u = await users.get({ userId: id })
    expect([u.name, u.phone, u.labels, u.emailVerification]).toEqual(['Rina S', '+6281112345', ['vip', 'staff'], true])
    await form(`/console/auth/users/${id}/status`, { status: '' })
    expect((await users.get({ userId: id })).status).toBe(false)
    await form(`/console/auth/users/${id}/password`, { password: 'new-password-1' })
    await form(`/console/auth/users/${id}/status`, { status: 'on' })
    expect((await adminClient(server.endpoint).account.createEmailPasswordSession('rina@example.com', 'new-password-1')).userId).toBe(id)
    await form(`/console/auth/users/${id}/sessions/delete`, {})
    expect((await users.listSessions({ userId: id })).total).toBe(0)
    await form(`/console/auth/users/${id}/delete`, {})
    expect(await users.get({ userId: id }).catch((e: any) => e.code)).toBe(404)
  })

  test('teams: create, add a member by email, change roles, remove', async () => {
    await adminClient(server.endpoint).users.create({ userId: 'member1', email: 'member1@example.com' })
    const created = await form('/console/auth/teams', { name: 'Toko Baru', id: 'toko-baru' })
    expect(created.headers.get('location')).toStartWith('/console/auth/teams/toko-baru')
    await form('/console/auth/teams/toko-baru/members', { who: 'member1@example.com', roles: 'owner' })
    const teams = adminClient(server.endpoint).teams
    const m = (await teams.listMemberships({ teamId: 'toko-baru' })).memberships[0]
    expect([m.userId, m.roles, m.confirm]).toEqual(['member1', ['owner'], true])
    await form(`/console/auth/teams/toko-baru/members/${m.$id}`, { roles: 'admin, staff' })
    expect((await teams.getMembership({ teamId: 'toko-baru', membershipId: m.$id })).roles).toEqual(['admin', 'staff'])
    await form(`/console/auth/teams/toko-baru/members/${m.$id}/delete`, {})
    expect((await teams.listMemberships({ teamId: 'toko-baru' })).total).toBe(0)
  })
})

describe('settings through the console', () => {
  test('project settings apply at once and can go back to env', async () => {
    await form('/console/settings/project', { projectName: 'Toko Saya', allowedOrigins: 'shop.example.com', sessionDays: '30', sessionsLimit: '3' })
    expect([server.config.projectName, server.config.allowedOrigins, server.config.sessionDuration, server.config.sessionsLimit]).toEqual(['Toko Saya', ['shop.example.com'], 2592000, 3])
    const cors = await fetch(`${server.endpoint}/health`, { headers: { origin: 'https://shop.example.com' } })
    expect(cors.headers.get('access-control-allow-origin')).toBe('https://shop.example.com')
    await form('/console/settings/project/reset', {})
    expect(server.config.projectName).toBe('Pesanle')
  })

  test('SMTP settings switch email on; the password is kept when left blank', async () => {
    await form('/console/settings/smtp', { host: 'smtp.example.com', port: '465', user: 'u', password: 'p', senderEmail: 'hi@example.com', senderName: 'Hi', secure: 'on' })
    expect(server.config.smtp).toMatchObject({ host: 'smtp.example.com', port: 465, secure: true, password: 'p' })
    await form('/console/settings/smtp', { host: 'smtp2.example.com', port: '587', user: 'u', password: '', senderEmail: 'hi@example.com', senderName: 'Hi' })
    expect(server.config.smtp).toMatchObject({ host: 'smtp2.example.com', password: 'p' })
    const page = await (await get('/console/settings')).text()
    expect(page).not.toContain('value="p"')
    await form('/console/settings/smtp', { disable: '1' })
    expect(server.config.smtp).toBeNull()
  })

  test('Google sign-in can be set up from the console', async () => {
    await form('/console/settings/google', { clientId: 'gid', clientSecret: 'gsecret' })
    const res = await fetch(`${server.endpoint}/account/tokens/oauth2/google?project=${PROJECT}&success=${encodeURIComponent('https://dashboard.pesanle.com/cb')}`, { redirect: 'manual' })
    expect(res.status).toBe(301)
    expect(new URL(res.headers.get('location')!).searchParams.get('client_id')).toBe('gid')
  })

  test('API keys: shown once, work with the SDK, stop working when revoked', async () => {
    const res = await form('/console/settings/keys', { name: 'CI', expire: '' })
    const html = await res.text()
    const secret = /(standard_[0-9a-f]{128})/.exec(html)![1]!
    const list = await (await get('/console/settings')).text()
    expect(list).not.toContain(secret)
    const client = adminClient(server.endpoint)
    client.client.setKey(secret)
    expect((await client.databases.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.limit(1)] })).total).toBeGreaterThanOrEqual(0)
    const id = server.services.settings.listKeys()[0]!.id
    await form(`/console/settings/keys/${id}/delete`, {})
    expect(await client.databases.listDocuments({ databaseId: DB, collectionId: 'products' }).catch((e: any) => e.code)).toBe(401)
  })

  test('admins: add one, but never remove the last', async () => {
    await form('/console/settings/admins', { email: 'second@example.com', password: 'second-password' })
    const admins = new ConsoleAuth(server.db).list()
    expect(admins.map((a) => a.email)).toEqual(['admin@example.com', 'second@example.com'])
    await form(`/console/settings/admins/${admins[1]!.seq}/delete`, {})
    const last = await form(`/console/settings/admins/${admins[0]!.seq}/delete`, {})
    expect(flash(last).get('err')).toBe('The last admin cannot be removed.')
  })

  test('signing out ends the session', async () => {
    await form('/console/logout', {})
    const res = await get('/console')
    expect(res.status).toBe(303)
  })
})

describe('pages outside the API', () => {
  const html = { accept: 'text/html,application/xhtml+xml' }

  test('the bare host goes to the console', async () => {
    const res = await fetch(`${base}/`, { redirect: 'manual', headers: html })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/console')
  })

  test('a browser gets a 404 page; SDK calls and /v1 keep the JSON error', async () => {
    const page = await fetch(`${base}/nope`, { headers: html })
    expect(page.status).toBe(404)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('Page not found')

    for (const [path, headers] of [['/v1/nope', html], ['/nope', { accept: 'application/json' }]] as const) {
      const res = await fetch(`${base}${path}`, { headers: { ...headers, 'x-appwrite-project': PROJECT } })
      expect(res.status).toBe(404)
      expect(((await res.json()) as any).type).toBe('general_route_not_found')
    }
  })

  test('with the console off, / says the API is up and 404s do not link to it', async () => {
    server.config.consoleEnabled = false
    try {
      const home = await fetch(`${base}/`, { redirect: 'manual', headers: html })
      expect(home.status).toBe(200)
      expect(await home.text()).toContain('API is running')
      const missing = await (await fetch(`${base}/nope`, { headers: html })).text()
      expect(missing).not.toContain('Go to console')
      expect((await fetch(`${base}/console`, { redirect: 'manual' })).status).toBe(404)
    } finally {
      server.config.consoleEnabled = true
    }
  })
})
