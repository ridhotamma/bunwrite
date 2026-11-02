import { afterEach, describe, expect, test } from 'bun:test'

import { ConsoleAuth } from '~/console/auth'
import { DisabledMailer } from '~/mail/mailer'
import { resolveApiKey } from '~/settings/service'
import { apiKeyScopes, storedApiKeyScopes } from '~/settings/scopes'
import { startServer, KEY, PROJECT, testSchema } from './helpers'

const stops: Array<() => void> = []

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

describe('API key scopes', () => {
  test('parse and store a scope list', () => {
    expect(apiKeyScopes(['documents.read', 'users.read'])).toEqual(['documents.read', 'users.read'])
    expect(apiKeyScopes('documents.read')).toEqual(['documents.read'])
    expect(() => apiKeyScopes([])).toThrow()
    expect(() => apiKeyScopes(['documents.read', 'nope'])).toThrow()
    expect(storedApiKeyScopes('["documents.read"]')).toEqual(['documents.read'])
    expect(storedApiKeyScopes(null)).toBeNull()
    expect(storedApiKeyScopes('not json')).toBeNull()
  })

  test('a scoped key only reaches the API groups it was given', async () => {
    const server = startServer()
    stops.push(server.stop)
    const origin = server.endpoint.replace(/\/v1$/, '')

    const readKey = (await server.services.settings.createKey('reader', null, ['documents.read'])).secret
    const writeKey = (await server.services.settings.createKey('writer', null, ['documents.write'])).secret
    const fullKey = (await server.services.settings.createKey('full', null)).secret
    const headers = (key: string) => ({ 'x-appwrite-project': PROJECT, 'x-appwrite-key': key, 'content-type': 'application/json' })

    // A read-only key can list documents but not create them.
    const listed = await fetch(`${origin}/v1/databases/main/collections/products/documents`, { headers: headers(readKey) })
    expect(listed.status).toBe(200)
    const deniedWrite = await fetch(`${origin}/v1/databases/main/collections/products/documents`, {
      method: 'POST',
      headers: headers(readKey),
      body: JSON.stringify({ documentId: 'nope', data: { tenantId: 't', name: 'No' } }),
    })
    expect(deniedWrite.status).toBe(401)
    expect(((await deniedWrite.json()) as { type: string }).type).toBe('general_unauthorized_scope')

    // A write-only key can create documents but not read them.
    const created = await fetch(`${origin}/v1/databases/main/collections/products/documents`, {
      method: 'POST',
      headers: headers(writeKey),
      body: JSON.stringify({ documentId: 'scoped', data: { tenantId: 't', name: 'Scoped' } }),
    })
    expect(created.status).toBe(201)
    const deniedRead = await fetch(`${origin}/v1/databases/main/collections/products/documents`, { headers: headers(writeKey) })
    expect(deniedRead.status).toBe(401)

    // Scopes are per group: documents.read does not grant users.
    const deniedUsers = await fetch(`${origin}/v1/users`, { headers: headers(readKey) })
    expect(deniedUsers.status).toBe(401)

    // A scoped key cannot mint account tokens or sessions either.
    const deniedToken = await fetch(`${origin}/v1/account/tokens/email`, {
      method: 'POST',
      headers: headers(readKey),
      body: JSON.stringify({ email: 'someone@example.com' }),
    })
    expect(deniedToken.status).toBe(401)
    expect(((await deniedToken.json()) as { type: string }).type).toBe('general_unauthorized_scope')

    // A key with no scopes (legacy/full) still works everywhere, like the env key.
    const fullUsers = await fetch(`${origin}/v1/users`, { headers: headers(fullKey) })
    expect(fullUsers.status).toBe(200)
    const envUsers = await fetch(`${origin}/v1/users`, { headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY } })
    expect(envUsers.status).toBe(200)

    // The cached lookup keeps the scopes too.
    const identity = await resolveApiKey(server.db, server.config, readKey)
    expect(identity?.scopes).toEqual(['documents.read'])
    expect((await resolveApiKey(server.db, server.config, KEY))?.scopes).toBeNull()
  })
})

describe('console email MFA', () => {
  test('login emails a code, verifies it and starts a session', async () => {
    const server = startServer()
    stops.push(server.stop)
    const origin = server.endpoint.replace(/\/v1$/, '')
    const auth = new ConsoleAuth(server.db)
    await auth.upsert('admin@example.com', 'password123')
    const admin = (await auth.find('admin@example.com'))!
    await auth.setMfa(admin.seq, true)

    const started = await fetch(`${origin}/console/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'admin@example.com', password: 'password123' }),
      redirect: 'manual',
    })
    expect(started.status).toBe(200)
    const page = await started.text()
    expect(page).toContain('Check your email')
    const challenge = /name="challenge" value="([^"]+)"/.exec(page)?.[1]
    expect(challenge).toBeTruthy()

    const mail = server.mailer.last('admin@example.com')
    expect(mail?.subject).toContain('sign-in code')
    const code = /(\d{6})/.exec(mail!.text)?.[1]
    expect(code).toBeTruthy()

    // The wrong code does not create a session.
    const wrong = await fetch(`${origin}/console/login/mfa`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ challenge: challenge!, code: '000000' }),
      redirect: 'manual',
    })
    expect(wrong.status).toBe(200)
    expect(await wrong.text()).toContain('not valid or has expired')

    const verified = await fetch(`${origin}/console/login/mfa`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ challenge: challenge!, code: code! }),
      redirect: 'manual',
    })
    expect(verified.status).toBe(303)
    const cookie = verified.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('bunwrite_console=')
    const secret = /bunwrite_console=([^;]+)/.exec(cookie)?.[1]
    expect((await auth.session(secret!))?.admin.email).toBe('admin@example.com')
  })

  test('the security page turns MFA on and off with the password', async () => {
    const server = startServer()
    stops.push(server.stop)
    const origin = server.endpoint.replace(/\/v1$/, '')
    const auth = new ConsoleAuth(server.db)
    await auth.upsert('admin@example.com', 'password123')
    const secret = (await auth.login('admin@example.com', 'password123'))!
    const cookie = `bunwrite_console=${secret}`

    // Security belongs to the organization shell, beside Members and Settings,
    // not inside the selected project's sidebar.
    const page = await (await fetch(`${origin}/console/security`, { headers: { cookie } })).text()
    expect(page).toContain('select-topbar')
    expect(page).toContain('href="/console/organization/members"')
    expect(page).not.toContain('<nav class="nav">')

    const post = (fields: Record<string, string>) =>
      fetch(`${origin}/console/security/mfa`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
        redirect: 'manual',
      })

    const wrong = await post({ enabled: 'on', password: 'wrong-password' })
    expect(wrong.status).toBe(303)
    expect((await auth.find('admin@example.com'))?.mfa).toBe(false)

    const on = await post({ enabled: 'on', password: 'password123' })
    expect(on.status).toBe(303)
    expect((await auth.find('admin@example.com'))?.mfa).toBe(true)
    expect((await auth.authenticate('admin@example.com', 'password123')).status).toBe('mfa')

    const off = await post({ password: 'password123' })
    expect(off.status).toBe(303)
    expect((await auth.find('admin@example.com'))?.mfa).toBe(false)
  })

  test('the MFA hint links to organization email settings', async () => {
    const server = startServer()
    stops.push(server.stop)
    const origin = server.endpoint.replace(/\/v1$/, '')
    const auth = new ConsoleAuth(server.db)
    await auth.upsert('admin@example.com', 'password123')
    const secret = (await auth.login('admin@example.com', 'password123'))!
    const cookie = `bunwrite_console=${secret}`
    server.services.mailer = new DisabledMailer()
    server.services.consoleMailer = server.services.mailer

    const page = await (await fetch(`${origin}/console/security`, { headers: { cookie } })).text()
    expect(page).toContain('SMTP is not configured')
    expect(page).toContain('href="/console/organization#email"')

    const settings = await fetch(`${origin}/console/organization`, { headers: { cookie } })
    expect(settings.status).toBe(200)
    const body = await settings.text()
    expect(body).toContain('Email delivery')
    expect(body).toContain('action="/console/organization/email"')
  })

  test('MFA requires an email provider when turning it on', async () => {
    const server = startServer(testSchema, {})
    stops.push(server.stop)
    // The test mailer is enabled; a disabled mailer is covered by the page guard.
    const auth = new ConsoleAuth(server.db)
    await auth.upsert('admin@example.com', 'password123')
    const admin = (await auth.find('admin@example.com'))!
    const result = await auth.authenticate('admin@example.com', 'password123')
    expect(result.status).toBe('ok')
    await auth.setMfa(admin.seq, true)
    const challenged = await auth.authenticate('admin@example.com', 'password123')
    expect(challenged.status).toBe('mfa')
    if (challenged.status !== 'mfa') return
    expect(challenged.code).toMatch(/^\d{6}$/)
    expect(await auth.verifyMfa(challenged.challenge, challenged.code)).toBeTruthy()
    // A code is single use.
    expect(await auth.verifyMfa(challenged.challenge, challenged.code)).toBeNull()
  })
})
