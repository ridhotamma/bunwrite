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

  test('wrong password is refused; the right one sets a Lax cookie', async () => {
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
    expect(set).toContain('SameSite=Lax')
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

describe('webhooks through the console', () => {
  test('the list, create page and menu entry render', async () => {
    const list = await (await get('/console/webhooks')).text()
    expect(list).toContain('Webhooks')
    expect(list).toContain('No webhooks yet')
    expect(list).toContain('href="/console/webhooks/new"')

    const form = await (await get('/console/webhooks/new')).text()
    expect(form).toContain('Create webhook')
    expect(form).toContain('All databases and collections')
    // Events come from the schema, so the common ones are checkboxes.
    expect(form).toContain('databases.main.collections.products.documents.*.create')
    expect(form).toContain('name="customEvents"')
    // The name and ID fields appear once each, and the ID follows the name.
    expect(form.match(/name="name"/g)).toHaveLength(1)
    expect(form.match(/name="id"/g)).toHaveLength(1)
    expect(form).toContain('data-slug-from="name"')

    expect(await (await get('/console/overview')).text()).toContain('href="/console/webhooks"')
  })

  test('create, edit, rotate the secret and delete', async () => {
    const created = await form('/console/webhooks', {
      name: 'Order events',
      id: 'order-events',
      url: 'https://example.com/hooks/orders',
      enabled: 'on',
      tls: 'on',
      events: ['databases.main.collections.products.documents.*.create', 'databases.main.collections.products.documents.*.update'],
      customEvents: 'databases.main.collections.products.documents.n1.update',
      authUsername: 'bob',
      authPassword: 'letmein',
      secret: 'first-secret',
    })
    expect(created.status).toBe(303)
    expect(created.headers.get('location')).toBe('/console/webhooks/order-events?ok=Webhook+created')
    let hook = server.services.webhooks.get('order-events')
    expect(JSON.parse(hook.events)).toEqual([
      'databases.main.collections.products.documents.*.create',
      'databases.main.collections.products.documents.*.update',
      'databases.main.collections.products.documents.n1.update',
    ])
    expect([hook.name, hook.url, hook.enabled, hook.tls, hook.auth_username, hook.auth_password, hook.secret]).toEqual([
      'Order events',
      'https://example.com/hooks/orders',
      1,
      1,
      'bob',
      'letmein',
      'first-secret',
    ])

    const detail = await (await get('/console/webhooks/order-events')).text()
    expect(detail).toContain('https://example.com/hooks/orders')
    expect(detail).toContain('databases.main.collections.products.documents.n1.update')
    expect(detail).toContain('>Settings</a>')
    expect(detail).toContain('X-Appwrite-Webhook-Signature')

    const settings = await (await get('/console/webhooks/order-events/settings')).text()
    expect(settings).toContain('id="webhook-secret"')
    expect(settings).toContain('data-confirm=')
    expect(settings).toContain('databases.main.collections.products.documents.*.create" checked')
    // A pattern that is not a schema preset stays in the textarea.
    expect(settings).toContain('databases.main.collections.products.documents.n1.update</textarea>')

    // Saving the general card leaves events and the secret alone; a blank password keeps it.
    await form('/console/webhooks/order-events/settings', {
      name: 'Order events v2',
      url: 'https://example.com/hooks/v2',
      tls: '',
      authUsername: 'alice',
      authPassword: '',
    })
    hook = server.services.webhooks.get('order-events')
    expect([hook.name, hook.url, hook.enabled, hook.tls, hook.auth_username, hook.auth_password]).toEqual([
      'Order events v2',
      'https://example.com/hooks/v2',
      0,
      0,
      'alice',
      'letmein',
    ])
    expect(JSON.parse(hook.events)).toHaveLength(3)

    const events = await form('/console/webhooks/order-events/events', {
      events: ['databases.*.collections.*.documents.*'],
      customEvents: 'databases.main.collections.products.documents.n1.update',
    })
    expect(flash(events).get('ok')).toBe('Events saved')
    expect(JSON.parse(server.services.webhooks.get('order-events').events)).toEqual([
      'databases.*.collections.*.documents.*',
      'databases.main.collections.products.documents.n1.update',
    ])

    // Bad input comes back on the form with the typed values kept.
    const bad = await form('/console/webhooks', { name: 'Bad', url: 'ftp://example.com', events: ['databases.*'] })
    expect(bad.status).toBe(200)
    expect(await bad.text()).toContain('valid http or https URL')
    const empty = await form('/console/webhooks', { name: 'Empty', url: 'https://example.com/empty' })
    expect(empty.status).toBe(200)
    expect(await empty.text()).toContain('Choose at least one event.')

    // A rotated secret is shown once in a dialog and never stored in the URL.
    const rotated = await form('/console/webhooks/order-events/secret', {})
    expect(rotated.status).toBe(200)
    const rotatedHtml = await rotated.text()
    expect(rotatedHtml).toContain('id="webhook-secret-dialog"')
    hook = server.services.webhooks.get('order-events')
    expect(hook.secret).not.toBe('first-secret')
    expect(rotatedHtml).toContain(hook.secret)

    // Failures show up on the detail page; the list says the webhook is off.
    server.db.sqlite
      .query('UPDATE _webhooks SET attempts = 3, logs = ? WHERE id = ?')
      .run('2026-10-27 10:00 n1.create: 500 Internal Server Error', 'order-events')
    const failing = await (await get('/console/webhooks/order-events')).text()
    expect(failing).toContain('3 of 10')
    expect(failing).toContain('500 Internal Server Error')
    expect(await (await get('/console/webhooks')).text()).toContain('Disabled')

    // Turning it back on resets the failure count.
    await form('/console/webhooks/order-events/settings', {
      name: 'Order events v2',
      url: 'https://example.com/hooks/v2',
      enabled: 'on',
      tls: 'on',
      authUsername: 'alice',
    })
    hook = server.services.webhooks.get('order-events')
    expect([hook.enabled, hook.attempts, hook.tls]).toEqual([1, 0, 1])

    // While enabled, recent failures show as failing; ten turn it off for good.
    server.db.sqlite.query('UPDATE _webhooks SET attempts = 2 WHERE id = ?').run('order-events')
    expect(await (await get('/console/webhooks')).text()).toContain('Failing')
    expect(await (await get('/console/webhooks/order-events')).text()).toContain('2 of 10')
    server.db.sqlite.query('UPDATE _webhooks SET attempts = 10, enabled = 0 WHERE id = ?').run('order-events')
    expect(await (await get('/console/webhooks')).text()).toContain('Off after failures')
    expect(await (await get('/console/webhooks/order-events')).text()).toContain('Deliveries stopped after 10 failures')

    await form('/console/webhooks/order-events/delete', {})
    expect(() => server.services.webhooks.get('order-events')).toThrow()
    expect(await (await get('/console/webhooks')).text()).toContain('No webhooks yet')
  })

  test('the test button sends one signed delivery and never counts a failure', async () => {
    const hits: { headers: Headers; body: string }[] = []
    let status = 200
    const receiver = Bun.serve({
      port: 0,
      async fetch(request) {
        hits.push({ headers: request.headers, body: await request.text() })
        return new Response('ok', { status })
      },
    })
    try {
      const url = `http://localhost:${receiver.port}/hook`
      await form('/console/webhooks', { name: 'Tester', id: 'tester', url, enabled: 'on', tls: 'on', events: ['databases.*.collections.*.documents.*.create'], secret: 'test-secret' })
      const page = await (await get('/console/webhooks/tester')).text()
      expect(page).toContain('Send test event')

      const ok = await form('/console/webhooks/tester/test', {})
      expect(flash(ok).get('ok')).toBe('The endpoint accepted the test delivery.')
      expect(hits).toHaveLength(1)
      expect(hits[0]!.headers.get('x-appwrite-webhook-id')).toBe('tester')
      expect(hits[0]!.headers.get('x-appwrite-webhook-events')).toBe('test')
      expect(JSON.parse(hits[0]!.body)).toMatchObject({ $id: 'test', test: true, webhookId: 'tester' })

      status = 500
      const failed = await form('/console/webhooks/tester/test', {})
      expect(flash(failed).get('err')).toContain('500')
      expect(hits).toHaveLength(2)
      // A test never adds to the failure count or turns the webhook off.
      expect(server.services.webhooks.get('tester')).toMatchObject({ attempts: 0, enabled: 1 })
    } finally {
      receiver.stop(true)
      await form('/console/webhooks/tester/delete', {})
    }
  })
})

describe('settings through the console', () => {
  test('settings use a grouped section nav, with the old URL redirecting', async () => {
    const root = await get('/console/settings')
    expect(root.status).toBe(303)
    expect(root.headers.get('location')).toBe('/console/settings/general')
    const general = await (await get('/console/settings/general')).text()
    expect(general).toContain('Project')
    expect(general).toContain('class="settings-nav"')
    expect(general).toContain('Infrastructure')
    expect(general).toContain('Platform')
    expect(general).not.toContain('Global function variables')
    expect(general).not.toContain('/console/settings/access')
    const functions = await (await get('/console/settings/functions')).text()
    expect(functions).toContain('Global function variables')
    expect(functions).not.toContain('id="keys"')
    // Access moved to the dedicated API page.
    const access = await get('/console/settings/access')
    expect(access.status).toBe(303)
    expect(access.headers.get('location')).toBe('/console/api')
  })

  test('project settings apply at once and can reset to their defaults', async () => {
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

  test('global function variables can be added, edited and removed', async () => {
    await form('/console/settings/functions/variables', { key: 'BUNWRITE_GLOBAL_TEST', value: 'global-value', secret: 'on' })
    expect(server.services.functions.globalVariables()).toMatchObject([
      { key: 'BUNWRITE_GLOBAL_TEST', value: 'global-value', secret: 1, function_id: '*' },
    ])
    const page = await (await get('/console/settings/functions')).text()
    expect(page).toContain('BUNWRITE_GLOBAL_TEST')
    expect(page).toContain('Delete all')
    expect(page).toContain('data-dialog-open="#bulk-global-vars"')
    expect(page).toContain('id="bulk-global-vars"')
    expect(page).toContain('hx-post="/console/settings/functions/variables/bulk"')
    // Editing keeps the stored value when the secret field is left blank.
    await form('/console/settings/functions/variables', { key: 'BUNWRITE_GLOBAL_TEST', value: '' })
    expect(server.services.functions.globalVariables()).toMatchObject([{ key: 'BUNWRITE_GLOBAL_TEST', value: 'global-value', secret: 1 }])
    await form('/console/settings/functions/variables', { key: 'BUNWRITE_GLOBAL_TEST', value: 'new-value', secret: 'on' })
    expect(server.services.functions.globalVariables()).toMatchObject([{ key: 'BUNWRITE_GLOBAL_TEST', value: 'new-value', secret: 1 }])
    // Unhiding a secret clears the flag.
    await form('/console/settings/functions/variables', { key: 'BUNWRITE_GLOBAL_TEST', value: 'shown' })
    expect(server.services.functions.globalVariables()).toMatchObject([{ key: 'BUNWRITE_GLOBAL_TEST', value: 'shown', secret: 0 }])
    await form('/console/settings/functions/variables/delete', { key: 'BUNWRITE_GLOBAL_TEST' })
    expect(server.services.functions.globalVariables()).toEqual([])
  })

  test('global variables can all be deleted at once', async () => {
    await form('/console/settings/functions/variables', { key: 'WIPE_A', value: 'one' })
    await form('/console/settings/functions/variables', { key: 'WIPE_B', value: 'two' })
    expect(server.services.functions.globalVariables()).toHaveLength(2)
    const cleared = await form('/console/settings/functions/variables/clear', {})
    expect(flash(cleared).get('ok')).toBe('Removed 2 variables')
    expect(server.services.functions.globalVariables()).toEqual([])
    const empty = await form('/console/settings/functions/variables/clear', {})
    expect(flash(empty).get('ok')).toBe('No variables to remove')
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
      expect(backups[0]!.name).toEndWith('.sqlite.zst')
      expect(page).toContain('compressed but not encrypted')
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

    server.services.functions.deleteVariable('*', 'BULK_A')
    server.services.functions.deleteVariable('*', 'BULK_B')
  })

  test('Google sign-in can be set up from the console', async () => {
    await form('/console/settings/google', { clientId: 'gid', clientSecret: 'gsecret' })
    const res = await fetch(`${server.endpoint}/account/tokens/oauth2/google?project=${PROJECT}&success=${encodeURIComponent('https://dashboard.example.com/cb')}`, { redirect: 'manual' })
    expect(res.status).toBe(301)
    expect(new URL(res.headers.get('location')!).searchParams.get('client_id')).toBe('gid')
  })

  test('Facebook, GitHub and Apple sign-in can be set up from the console', async () => {
    await form('/console/settings/github', { clientId: 'ghid', clientSecret: 'ghsecret' })
    let res = await fetch(`${server.endpoint}/account/tokens/oauth2/github?project=${PROJECT}&success=${encodeURIComponent('https://dashboard.example.com/cb')}`, { redirect: 'manual' })
    expect(res.status).toBe(301)
    expect(new URL(res.headers.get('location')!).searchParams.get('client_id')).toBe('ghid')

    await form('/console/settings/apple', { clientId: 'aid', teamId: 'team-id', keyId: 'key-id', privateKey: 'p8-key' })
    res = await fetch(`${server.endpoint}/account/tokens/oauth2/apple?project=${PROJECT}&success=${encodeURIComponent('https://dashboard.example.com/cb')}`, { redirect: 'manual' })
    expect(res.status).toBe(301)
    const location = new URL(res.headers.get('location')!)
    expect(location.searchParams.get('client_id')).toBe('aid')
    expect(location.searchParams.get('response_mode')).toBe('form_post')
  })

  test('API keys: shown once, work with the SDK, stop working when revoked', async () => {
    const page = await (await get('/console/api')).text()
    expect(page).toContain('API keys')
    expect(page).toContain('id="api-endpoint"')
    expect(page).toContain('id="api-project-id"')
    expect(page).toContain('href="/console/api"')
    expect(page).not.toContain('Console members')

    const res = await form('/console/api/keys', { name: 'CI', expire: '' })
    const html = await res.text()
    expect(html).toContain('id="api-key-dialog"')
    expect(html).toContain('data-open')
    const secret = /(standard_[0-9a-f]{128})/.exec(html)![1]!
    const list = await (await get('/console/api')).text()
    expect(list).not.toContain(secret)
    expect(list).toContain('data-confirm=')
    expect(list).not.toContain('hx-confirm=')
    const client = adminClient(server.endpoint)
    client.client.setKey(secret)
    expect((await client.databases.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.limit(1)] })).total).toBeGreaterThanOrEqual(0)
    const id = server.services.settings.listKeys()[0]!.id
    await form(`/console/api/keys/${id}/delete`, {})
    expect(await client.databases.listDocuments({ databaseId: DB, collectionId: 'products' }).catch((e: any) => e.code)).toBe(401)
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

      // Files and Settings tabs, plus the no-JavaScript upload page
      const files = await (await get('/console/storage/page-bucket')).text()
      expect(files).toContain('hello.txt')
      expect(files).toContain('id="upload-file"')
      expect(files).toContain('Page 1 of 1 · 1 file')
      expect(files).not.toContain('Bucket permissions</h3>')
      // Private files get a signed API link that opens without a console session.
      const privateId = (server.db.sqlite.query("SELECT id FROM _files WHERE bucket_id = 'page-bucket'").get() as { id: string }).id
      const signed = new RegExp(`href="(${server.endpoint}/storage/buckets/page-bucket/files/${privateId}/view\\?project=${PROJECT}&amp;token=[^"]+)"`).exec(files)
      expect(signed).not.toBeNull()
      expect(files).toContain('Copy link')
      const signedUrl = signed![1]!.replaceAll('&amp;', '&')
      const signedView = await fetch(signedUrl, { redirect: 'manual' })
      expect(signedView.status).toBe(200)
      expect(await signedView.text()).toBe('hello')
      expect((await fetch(signedUrl.replace(/token=[^&]+/, 'token=1.bad'))).status).toBe(404)
      expect((await fetch(signedUrl.replace(/token=[^&]+/, ''))).status).toBe(404)
      // Behind a proxy, links use the public host the browser used.
      const proxied = await (await fetch(`${base}/console/storage/page-bucket`, { headers: { cookie, 'x-forwarded-host': 'files.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' } })).text()
      expect(proxied).toContain(`href="https://files.example.com/v1/storage/buckets/page-bucket/files/${privateId}/view?project=${PROJECT}&amp;token=`)
      const settingsPage = await (await get('/console/storage/page-bucket/settings')).text()
      expect(settingsPage).toContain('Delete bucket')
      expect(settingsPage).toContain('name="section" value="access"')
      expect((await get('/console/storage/page-bucket/upload')).status).toBe(200)

      // Saving one settings card keeps the other fields
      const saved = await form('/console/storage/page-bucket/settings', { section: 'access', fileSecurity: 'on', permissions: 'read("any")' })
      expect(saved.status).toBe(303)
      const bucket = server.services.storage.bucket('page-bucket', true)
      expect(bucket).toMatchObject({ name: 'Page bucket', enabled: 1, transformations: 1, file_security: 1, maximum_file_size: 5_000_000 })
      expect(JSON.parse(bucket.permissions)).toEqual(['read("any")'])

      // Public files link to the API view URL, which works without a console session.
      const publicFiles = await (await get('/console/storage/page-bucket')).text()
      const fileId = (server.db.sqlite.query("SELECT id FROM _files WHERE bucket_id = 'page-bucket'").get() as { id: string }).id
      const publicUrl = `${server.endpoint}/storage/buckets/page-bucket/files/${fileId}/view?project=${PROJECT}`
      expect(publicFiles).toContain(`href="${publicUrl}"`)
      expect(publicFiles).toContain('Copy link')
      const guestView = await fetch(publicUrl)
      expect(guestView.status).toBe(200)
      expect(await guestView.text()).toBe('hello')

      await form('/console/storage/page-bucket/delete', {})
    } finally {
      await admin.teams.delete({ teamId: 'page-team' }).catch(() => {})
      await admin.users.delete({ userId: 'page-user' })
    }
  })

  test('detail pages use tabs, sectioned settings and no-JavaScript fallbacks', async () => {
    // Database and collection pages split their content from settings.
    const database = await (await get('/console/databases/main')).text()
    expect(database).toContain('Search collections')
    expect(database).toContain('>Collections</a>')
    const databaseSettings = await (await get('/console/databases/main/settings')).text()
    expect(databaseSettings).toContain('Delete database')
    expect(databaseSettings).toContain('data-copy-target="#database-id"')

    const collectionSettings = await (await get('/console/databases/main/collections/products/settings')).text()
    expect(collectionSettings).toContain('name="section" value="general"')
    expect(collectionSettings).toContain('name="section" value="access"')

    // Saving one collection section leaves the other section alone.
    let collection = server.services.registry.collection('main', 'products', true)
    const original = { name: collection.name, enabled: collection.enabled, security: collection.documentSecurity, permissions: collection.permissions }
    await form('/console/databases/main/collections/products/settings', { section: 'general', name: 'Products renamed', enabled: 'on' })
    collection = server.services.registry.collection('main', 'products', true)
    expect([collection.name, collection.documentSecurity]).toEqual(['Products renamed', original.security])
    await form('/console/databases/main/collections/products/settings', { section: 'access', documentSecurity: 'on', permissions: 'read("any")' })
    collection = server.services.registry.collection('main', 'products', true)
    expect([collection.name, collection.documentSecurity, collection.permissions]).toEqual(['Products renamed', true, ['read("any")']])
    await form('/console/databases/main/collections/products/settings', { section: 'general', name: original.name, enabled: original.enabled ? 'on' : '' })
    await form('/console/databases/main/collections/products/settings', {
      section: 'access',
      documentSecurity: original.security ? 'on' : '',
      permissions: original.permissions.join('\n'),
    })

    const indexes = await (await get('/console/databases/main/collections/products/indexes')).text()
    expect(indexes).toContain('id="add-index"')
    expect((await get('/console/databases/main/collections/products/indexes/new')).status).toBe(200)

    // Users and teams have their own settings tab, plus dialogs with fallback pages.
    const admin = adminClient(server.endpoint)
    const user = await admin.users.create({ userId: 'detail-user', email: 'detail@example.com', name: 'Detail User' })
    const team = await admin.teams.create({ teamId: 'detail-team', name: 'Detail Team' })
    try {
      const userPage = await (await get(`/console/auth/users/${user.$id}`)).text()
      expect(userPage).toContain('>Profile</a>')
      expect(userPage).toContain('>Settings</a>')
      const userSettings = await (await get(`/console/auth/users/${user.$id}/settings`)).text()
      expect(userSettings).toContain('Delete user')
      expect(userSettings).toContain('Set password')
      const teamPage = await (await get(`/console/auth/teams/${team.$id}`)).text()
      expect(teamPage).toContain('id="add-member"')
      const teamSettings = await (await get(`/console/auth/teams/${team.$id}/settings`)).text()
      expect(teamSettings).toContain('Delete team')
      expect((await get(`/console/auth/teams/${team.$id}/members/new`)).status).toBe(200)
    } finally {
      await admin.teams.delete({ teamId: team.$id }).catch(() => {})
      await admin.users.delete({ userId: user.$id })
    }

    // Functions split runs, deployments, variables and settings into tabs.
    const fn = server.services.functions.create('tab-fn', {
      name: 'Tab function',
      runtime: 'node-22',
      execute: [],
      events: [],
      schedule: '',
      timeout: 15,
      enabled: true,
      logging: true,
      entrypoint: 'src/main.js',
      commands: '',
      scopes: [],
      buildSpecification: 's-1vcpu-512mb',
      runtimeSpecification: 's-1vcpu-512mb',
      deploymentRetention: 0,
    })
    try {
      const runs = await (await get(`/console/functions/${fn.id}`)).text()
      expect(runs).toContain(`href="/console/functions/${fn.id}/deploy"`)
      expect(runs).not.toContain('id="deploy-code"')
      expect(runs).toContain('>Deployments</a>')
      expect(await (await get(`/console/functions/${fn.id}/deployments`)).text()).toContain('No deployments')
      expect(await (await get(`/console/functions/${fn.id}/variables`)).text()).toContain('Function variables')
      expect(await (await get(`/console/functions/${fn.id}/settings`)).text()).toContain('Delete function')
      expect((await get(`/console/functions/${fn.id}/deploy`)).status).toBe(200)
    } finally {
      server.services.functions.remove(fn.id)
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

  test('serves the dark, light and adaptive logos', async () => {
    for (const [path, type] of [
      ['/logo-dark.png', 'image/png'],
      ['/logo-light.png', 'image/png'],
      ['/logo.svg', 'image/svg+xml'],
    ] as const) {
      const res = await fetch(`${base}${path}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain(type)
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
    }
    const page = await (await fetch(`${base}/nope`, { headers: html })).text()
    expect(page).toContain('<link rel="icon" type="image/svg+xml" href="/logo.svg">')
    expect(page).toContain('src="/logo-dark.png"')
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
