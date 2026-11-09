/**
 * Magic URL sign-in: the email link, token exchange, legacy session route and
 * the public-client secret behavior.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Account, Client, ID, Project, ProjectAuthMethodId, ProjectEmailTemplateId, ProjectEmailTemplateLocale } from 'node-appwrite'

import { adminClient, failure, KEY, makeUser, PROJECT, sessionClient, startServer, type TestServer } from './helpers'

let server: TestServer
let admin: ReturnType<typeof adminClient>
let project: Project

const REDIRECT = 'http://localhost/magic'

beforeAll(() => {
  server = startServer()
  admin = adminClient(server.endpoint)
  project = new Project(new Client().setEndpoint(server.endpoint).setProject(PROJECT).setKey(KEY))
})
afterAll(() => server.stop())

const linkFrom = (text: string) => new URL(/https?:\/\/\S+/.exec(text)![0])

describe('magic URL token', () => {
  test('an API key sees the secret; the email has the link and the phrase', async () => {
    const token = await admin.account.createMagicURLToken({ userId: 'magic-user', email: 'magic@example.com', url: REDIRECT, phrase: true })
    expect(token.userId).toBe('magic-user')
    expect(token.secret.length).toBeGreaterThan(32)
    expect(token.phrase).toMatch(/^\w+ \w+$/)

    const mail = server.mailer.last('magic@example.com')!
    expect(mail.subject).toBe('Sign in to Test Project')
    expect(mail.html).toContain('Hello magic@example.com,')
    expect(mail.html).toContain(`Security phrase for this email is <strong>${token.phrase}</strong>`)
    const link = linkFrom(mail.text)
    expect(link.origin + link.pathname).toBe(REDIRECT)
    expect(link.searchParams.get('userId')).toBe('magic-user')
    expect(link.searchParams.get('secret')).toBe(token.secret)
    expect(new Date(link.searchParams.get('expire')!).getTime() - Date.now()).toBeGreaterThan(50 * 60_000)

    const session = await admin.account.createSession(token.userId, token.secret)
    expect(session.provider).toBe('magic-url')
    expect(session.factors).toEqual(['email'])
    expect((await admin.users.get({ userId: token.userId })).emailVerification).toBe(true)
    expect((await failure(admin.account.createSession(token.userId, token.secret))).type).toBe('user_invalid_token')
  })

  test('a public client never sees the secret but can use the emailed link', async () => {
    const guest = sessionClient(server.endpoint)
    const token = await guest.account.createMagicURLToken({ userId: 'public-magic', email: 'public@example.com', url: REDIRECT })
    expect(token.secret).toBe('')
    expect(token.userId).toBe('public-magic')

    const link = linkFrom(server.mailer.last('public@example.com')!.text)
    const session = await guest.account.createSession(link.searchParams.get('userId')!, link.searchParams.get('secret')!)
    expect(session.userId).toBe('public-magic')
  })

  test('an existing email keeps its account; the supplied user ID is ignored', async () => {
    await admin.users.create({ userId: 'known-magic', email: 'known@example.com', name: 'Known' })
    const token = await admin.account.createMagicURLToken({ userId: 'someone-else', email: 'known@example.com', url: REDIRECT })
    expect(token.userId).toBe('known-magic')
    expect(server.mailer.last('known@example.com')!.html).toContain('Hello Known,')
  })

  test('the legacy PUT session route exchanges a magic URL token', async () => {
    const token = await admin.account.createMagicURLToken({ userId: ID.unique(), email: 'legacy@example.com', url: REDIRECT })
    const session = await admin.account.updateMagicURLSession(token.userId, token.secret)
    expect(session.userId).toBe(token.userId)
    expect(session.provider).toBe('magic-url')
  })

  test('an absent URL falls back to the instance magic-url page', async () => {
    await admin.account.createMagicURLToken({ userId: ID.unique(), email: 'no-url@example.com' })
    expect(linkFrom(server.mailer.last('no-url@example.com')!.text).pathname).toBe('/auth/magic-url')
  })

  test('blocked users and switched-off methods are refused', async () => {
    const blocked = makeUser(server.db, 'blocked-magic')
    await admin.users.updateStatus({ userId: blocked.id, status: false })
    expect((await failure(admin.account.createMagicURLToken({ userId: blocked.id, email: `${blocked.id}@example.com`, url: REDIRECT }))).type).toBe('user_blocked')

    await project.updateAuthMethod({ methodId: ProjectAuthMethodId.Magicurl, enabled: false })
    expect((await failure(sessionClient(server.endpoint).account.createMagicURLToken({ userId: ID.unique(), email: 'off@example.com', url: REDIRECT }))).type).toBe(
      'user_auth_method_unsupported',
    )
    await project.updateAuthMethod({ methodId: ProjectAuthMethodId.Magicurl, enabled: true })
  })
})

describe('localized magic URL email', () => {
  test('the locale header selects the magicSession translation', async () => {
    await project.updateEmailTemplate({
      templateId: ProjectEmailTemplateId.MagicSession,
      locale: ProjectEmailTemplateLocale.Id,
      subject: 'Masuk ke {{project}}',
      message: '<p>Halo {{user}},</p><p><a href="{{redirect}}">Masuk sekarang</a></p><p>{{phrase}}</p>',
    })
    const client = new Client().setEndpoint(server.endpoint).setProject(PROJECT).setLocale('id')
    const guest = new Account(client)
    const token = await guest.createMagicURLToken({ userId: ID.unique(), email: 'indonesia@example.com', url: REDIRECT, phrase: true })
    const mail = server.mailer.last('indonesia@example.com')!
    expect(mail.subject).toBe('Masuk ke Test Project')
    expect(mail.html).toContain('Halo indonesia@example.com,')
    expect(mail.html).toContain(token.phrase)
  })
})
