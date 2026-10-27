/**
 * The console drives the same services as the API, so each test makes a
 * change through a console form and checks it through the Appwrite SDK.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    expect(bad.status).toBe(200)
    const body = await bad.text()
    expect(body).toContain('That email and password do not match an admin.')
    expect(body).toContain('value="admin@example.com"')
    expect(body).toContain('data-dismiss-alert')
    expect(body).toContain('__bunwriteDialogs')
    const ok = await form('/console/login', { email: 'admin@example.com', password: 'console-password' })
    expect(ok.status).toBe(303)
    const set = ok.headers.get('set-cookie')!
    expect(set).toContain('HttpOnly')
    expect(set).toContain('SameSite=Strict')
    expect(set).toContain('Path=/console')
    cookie = set.split(';')[0]!
    const projectsPage = await (await get('/console')).text()
    expect(projectsPage).toContain('class="org-head"')
    expect(projectsPage).toContain('Projects')
    cookie += `; console_project=${PROJECT}`
    const home = await get('/console/overview')
    expect(home.status).toBe(200)
    const homeBody = await home.text()
    expect(homeBody).toContain('Recent function runs')
    expect(homeBody).toContain('id="confirm-dialog"')
    expect(homeBody).toContain('data-dismiss-alert')
    expect(homeBody).toContain('class="icon')
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

  test('collections can be exported and imported with a review', async () => {
    const exportPage = await (await get('/console/schema/export')).text()
    expect(exportPage).toContain('orders')

    const selected = (await (await get('/console/schema/collections.json?selected=1&ids=shop/orders')).json()) as any[]
    expect(selected.map((collection) => collection.$id)).toEqual(['orders'])
    expect(selected[0].databaseId).toBe('shop')

    selected[0].name = 'Orders renamed'
    selected[0].columns.push({ key: 'extra', type: 'string', size: 20, required: false, array: false, default: null })
    const preview = await form('/console/schema/import/preview', { json: JSON.stringify(selected), prune: '' })
    expect(preview.status).toBe(200)
    const review = await preview.text()
    expect(review).toContain('Orders renamed')
    const hidden = /name="collections" value="([^"]*)"/.exec(review)![1]!
    const json = hidden.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    const applied = await form('/console/schema/import/apply', { collections: json, prune: '' })
    expect(flash(applied).get('ok')).toContain('Applied')

    const order = server.services.registry.collection('shop', 'orders', true)
    expect(order.name).toBe('Orders renamed')
    expect(order.attributeMap.has('extra')).toBe(true)

    const invalid = await form('/console/schema/import/preview', { json: '{}' })
    expect(await invalid.text()).toContain('JSON array')
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
  test('settings are grouped into tabs, with the old URL redirecting', async () => {
    const root = await get('/console/settings')
    expect(root.status).toBe(303)
    expect(root.headers.get('location')).toBe('/console/settings/general')
    const general = await (await get('/console/settings/general')).text()
    expect(general).toContain('Project')
    expect(general).not.toContain('Global function variables')
    const functions = await (await get('/console/settings/functions')).text()
    expect(functions).toContain('Global function variables')
    expect(functions).not.toContain('id="keys"') // the Access tab's API keys card
  })

  test('project settings apply at once and can go back to env', async () => {
    await form('/console/settings/project', { projectName: 'Toko Saya', allowedOrigins: 'shop.example.com', sessionDays: '30', sessionsLimit: '3' })
    expect([server.config.projectName, server.config.allowedOrigins, server.config.sessionDuration, server.config.sessionsLimit]).toEqual(['Toko Saya', ['shop.example.com'], 2592000, 3])
    const cors = await fetch(`${server.endpoint}/health`, { headers: { origin: 'https://shop.example.com' } })
    expect(cors.headers.get('access-control-allow-origin')).toBe('https://shop.example.com')
    await form('/console/settings/project/reset', {})
    expect(server.config.projectName).toBe('Test Project')
  })

  test('SMTP settings switch email on; the password is kept when left blank', async () => {
    await form('/console/settings/smtp', { host: 'smtp.example.com', port: '465', user: 'u', password: 'p', senderEmail: 'hi@example.com', senderName: 'Hi', secure: 'on' })
    expect(server.config.smtp).toMatchObject({ host: 'smtp.example.com', port: 465, secure: true, password: 'p' })
    await form('/console/settings/smtp', { host: 'smtp2.example.com', port: '587', user: 'u', password: '', senderEmail: 'hi@example.com', senderName: 'Hi' })
    expect(server.config.smtp).toMatchObject({ host: 'smtp2.example.com', password: 'p' })
    const page = await (await get('/console/settings/email')).text()
    expect(page).not.toContain('value="p"')
    expect(page).toContain('Sends to admin@example.com')
    await form('/console/settings/smtp', { disable: '1' })
    expect(server.config.smtp).toBeNull()
  })

  test('request log retention and IP logging can be changed and reset', async () => {
    await form('/console/settings/logs', { retentionDays: '2', logIp: 'on' })
    expect([server.config.logRetentionDays, server.config.logIp]).toEqual([2, true])
    await form('/console/settings/logs', { retentionDays: '0' })
    expect([server.config.logRetentionDays, server.config.logIp]).toEqual([0, false])
    await form('/console/settings/logs/reset', {})
    expect([server.config.logRetentionDays, server.config.logIp]).toEqual([7, true])
  })

  test('HTML rendering can be switched on and off', async () => {
    expect(server.config.render).toEqual({ enabled: false, allowRemote: false })
    const offPage = await (await get('/console/settings/render')).text()
    expect(offPage).toContain('Enable HTML rendering')
    expect(offPage).not.toContain('/console/settings/render/test')
    const saved = await form('/console/settings/render', { enabled: 'on' })
    expect(flash(saved).get('ok')).toBe('Rendering settings saved')
    expect(server.config.render).toEqual({ enabled: true, allowRemote: false })
    await form('/console/settings/render', { enabled: 'on', allowRemote: 'on' })
    expect(server.config.render).toEqual({ enabled: true, allowRemote: true })
    await form('/console/settings/render/reset', {})
    expect(server.config.render).toEqual({ enabled: false, allowRemote: false })
  })

  test('global function variables can be added and removed', async () => {
    await form('/console/settings/functions/variables', { key: 'BUNWRITE_GLOBAL_TEST', value: 'global-value', secret: 'on' })
    expect(server.services.functions.globalVariables()).toMatchObject([
      { key: 'BUNWRITE_GLOBAL_TEST', value: 'global-value', secret: 1, function_id: '*' },
    ])
    const page = await (await get('/console/settings/functions')).text()
    expect(page).toContain('BUNWRITE_GLOBAL_TEST')
    expect(page).toContain('data-dialog-open="#bulk-global-vars"')
    expect(page).toContain('id="bulk-global-vars"')
    expect(page).toContain('hx-post="/console/settings/functions/variables/bulk"')
    await form('/console/settings/functions/variables/delete', { key: 'BUNWRITE_GLOBAL_TEST' })
    expect(server.services.functions.globalVariables()).toEqual([])
  })

  test('S3 storage settings validate required fields and endpoints', async () => {
    const bad = await form('/console/settings/storage', { s3Enabled: 'on', s3Endpoint: 'not-a-url', s3Bucket: 'b', s3Region: 'r', s3AccessKey: 'a', s3Secret: 's' })
    expect(flash(bad).get('err')).toContain('valid URL')
    const missing = await form('/console/settings/storage', { s3Enabled: 'on' })
    expect(flash(missing).get('err')).toContain('required')
    const off = await form('/console/settings/storage', {})
    expect(flash(off).get('ok')).toBe('Storage settings saved')
    expect(server.config.s3.enabled).toBe(false)
    const storagePage = await (await get('/console/settings/storage')).text()
    expect(storagePage).toContain('Use S3 storage')
    const valid = await form('/console/settings/storage', {
      s3Enabled: 'on',
      s3Endpoint: 'https://s3.example.com/',
      s3Bucket: 'bucket',
      s3Region: 'us-east-1',
      s3AccessKey: 'key',
      s3Secret: 'secret',
    })
    expect(flash(valid).get('ok')).toBe('Storage settings saved')
    expect(server.config.s3).toMatchObject({ enabled: true, bucket: 'bucket', endpoint: 'https://s3.example.com', accessKey: 'key', secret: 'secret' })
    await form('/console/settings/s3/reset', {})
    expect(server.config.s3.enabled).toBe(false)
  })

  test('backups can be created, downloaded and deleted locally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunwrite-backups-'))
    const original = server.config.backupsPath
    server.config.backupsPath = dir
    try {
      const created = await form('/console/settings/backups/create', {})
      expect(flash(created).get('ok')).toContain('Created backup-')
      const backups = await server.services.backups.list()
      expect(backups).toHaveLength(1)
      const page = await (await get('/console/settings/backups')).text()
      expect(page).toContain(backups[0]!.name)
      const download = await get(`/console/settings/backups/${encodeURIComponent(backups[0]!.name)}/download`)
      expect(download.status).toBe(200)
      expect(download.headers.get('content-disposition')).toContain('.sqlite')
      await form(`/console/settings/backups/${encodeURIComponent(backups[0]!.name)}/delete`, {})
      expect(await server.services.backups.list()).toHaveLength(0)
    } finally {
      server.config.backupsPath = original
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('automatic backups run once a day', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunwrite-auto-backups-'))
    const originalPath = server.config.backupsPath
    const original = server.config.backups
    server.config.backupsPath = dir
    server.config.backups = { enabled: true, keep: 1, s3: original.s3 }
    try {
      const at = new Date(Date.UTC(2026, 9, 27, 2, 0))
      await server.services.backups.tick(at)
      await server.services.backups.tick(at)
      expect((await server.services.backups.list()).filter((b) => b.name.startsWith('auto-'))).toHaveLength(1)
    } finally {
      server.config.backupsPath = originalPath
      server.config.backups = original
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('global variables can be bulk imported, with validation errors in the dialog', async () => {
    const ok = await form('/console/settings/functions/variables/bulk', { env: 'BULK_A=one\nBULK_B="two words"\n# comment', secret: 'on' })
    expect(flash(ok).get('ok')).toBe('Imported 2 variables')
    expect(server.services.functions.globalVariables().map(({ key, value, secret, function_id }) => ({ key, value, secret, function_id }))).toEqual([
      { key: 'BULK_A', value: 'one', secret: 1, function_id: '*' },
      { key: 'BULK_B', value: 'two words', secret: 1, function_id: '*' },
    ])

    const bad = await form('/console/settings/functions/variables/bulk', { env: 'BULK_A=one\nBAD LINE' })
    expect(flash(bad).get('err')).toContain('Line 2')
    const inline = await form('/console/settings/functions/variables/bulk', { env: 'BAD LINE' }, { 'hx-request': 'true' })
    expect(inline.status).toBe(200)
    expect(await inline.text()).toContain('Line 1')

    server.services.functions.deleteGlobalVariable('BULK_A')
    server.services.functions.deleteGlobalVariable('BULK_B')
  })

  test('Google sign-in can be set up from the console', async () => {
    await form('/console/settings/google', { clientId: 'gid', clientSecret: 'gsecret' })
    const res = await fetch(`${server.endpoint}/account/tokens/oauth2/google?project=${PROJECT}&success=${encodeURIComponent('https://dashboard.example.com/cb')}`, { redirect: 'manual' })
    expect(res.status).toBe(301)
    expect(new URL(res.headers.get('location')!).searchParams.get('client_id')).toBe('gid')
  })

  test('API keys: shown once, work with the SDK, stop working when revoked', async () => {
    const res = await form('/console/settings/keys', { name: 'CI', expire: '' })
    const html = await res.text()
    expect(html).toContain('id="api-key-dialog"')
    expect(html).toContain('data-open')
    const secret = /(standard_[0-9a-f]{128})/.exec(html)![1]!
    const list = await (await get('/console/settings/access')).text()
    expect(list).not.toContain(secret)
    expect(list).toContain('data-confirm=')
    expect(list).not.toContain('hx-confirm=')
    const client = adminClient(server.endpoint)
    client.client.setKey(secret)
    expect((await client.databases.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.limit(1)] })).total).toBeGreaterThanOrEqual(0)
    const id = server.services.settings.listKeys()[0]!.id
    await form(`/console/settings/keys/${id}/delete`, {})
    expect(await client.databases.listDocuments({ databaseId: DB, collectionId: 'products' }).catch((e: any) => e.code)).toBe(401)
  })

  test('console access points at organization members', async () => {
    const page = await (await get('/console/settings/access')).text()
    expect(page).toContain('Console access is managed at the organization level')
    expect(page).toContain('href="/console/organization/members"')
    expect(page).not.toContain('/console/settings/admins')
  })

  test('database, user and storage pages read through their services', async () => {
    const admin = adminClient(server.endpoint)
    await admin.users.create({ userId: 'page-user', email: 'page@example.com', name: 'Page User' })
    await admin.users.updateLabels({ userId: 'page-user', labels: ['pagelabel'] })
    await admin.teams.create({ teamId: 'page-team', name: 'Page Team' })
    await admin.teams.createMembership({ teamId: 'page-team', userId: 'page-user', roles: ['pagerole'] })
    try {
      // countDocuments + collection list on the database page
      const database = await get('/console/databases/main')
      expect(database.status).toBe(200)
      expect(await database.text()).toContain('products')

      // user/team/label/role directories used by the permissions picker
      const formPage = await get('/console/databases/main/collections/products/documents/new')
      expect(formPage.status).toBe(200)
      const formHtml = await formPage.text()
      expect(formHtml).toContain('Quick add:')
      expect(formHtml).toContain('pagelabel')
      expect(formHtml).toContain('Page Team')
      expect(formHtml).toContain('pagerole')

      // identities query on the user detail page
      const userPage = await get('/console/auth/users/page-user')
      expect(userPage.status).toBe(200)
      expect(await userPage.text()).toContain('page@example.com')

      // latest-run lookup on the functions list
      const functionsPage = await get('/console/functions')
      expect(functionsPage.status).toBe(200)
      expect(await functionsPage.text()).toContain('Functions')

      // bucket usage query on the storage page
      const created = await form('/console/storage', { id: 'page-bucket', name: 'Page bucket', maxMb: '5', extensions: '', enabled: 'on', transformations: 'on', permissions: '' })
      expect(created.status).toBe(303)
      const upload = new FormData()
      upload.set('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }))
      upload.set('permissions', '')
      const uploaded = await fetch(`${base}/console/storage/page-bucket/files`, { method: 'POST', body: upload, headers: { cookie }, redirect: 'manual' })
      expect(uploaded.status).toBe(303)
      const storage = await (await get('/console/storage')).text()
      expect(storage).toContain('Page bucket')
      expect(storage).toContain('5 B')
      await form('/console/storage/page-bucket/delete', {})
    } finally {
      await admin.teams.delete({ teamId: 'page-team' }).catch(() => {})
      await admin.users.delete({ userId: 'page-user' })
    }
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

  test('serves the favicon', async () => {
    const res = await fetch(`${base}/favicon.ico`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/x-icon')
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
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
