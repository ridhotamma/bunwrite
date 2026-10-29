import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ID, Permission, Query, Role } from 'node-appwrite'

import { DisabledMailer } from '~/mail/mailer'
import { adminClient, DB, failure, jwtClient, PROJECT, sessionClient, startServer, type TestServer } from './helpers'

let server: TestServer
let admin: ReturnType<typeof adminClient>
let guest: ReturnType<typeof sessionClient>

beforeAll(() => {
  server = startServer()
  admin = adminClient(server.endpoint)
  guest = sessionClient(server.endpoint)
})
afterAll(() => server.stop())

const codeFrom = (text: string) => /\b(\d{6})\b/.exec(text)?.[1]
const linkFrom = (text: string) => new URL(/https?:\/\/\S+/.exec(text)![0])

describe('password sign-in (dashboard flow)', () => {
  let userId: string

  test('users.create then createEmailPasswordSession with the API key returns a usable secret', async () => {
    const user = await admin.users.create({ userId: ID.unique(), email: 'Seller@Example.com', password: 'correct horse', name: 'Seller' })
    userId = user.$id
    expect(user.email).toBe('seller@example.com')
    expect(user.hash).toBe('argon2')
    expect(user.hashOptions).toEqual({ type: 'argon2', memory_cost: 7168, time_cost: 5, threads: 1 })
    expect(user.password).toStartWith('$argon2id$')

    const session = await admin.account.createEmailPasswordSession('seller@example.com', 'correct horse')
    expect(session.userId).toBe(userId)
    expect(session.provider).toBe('email')
    expect(session.factors).toEqual(['password'])
    expect(session.secret.length).toBeGreaterThan(32)
    expect(new Date(session.expire).getTime() - Date.now()).toBeGreaterThan(364 * 86400_000)

    const me = await sessionClient(server.endpoint, session.secret).account.get()
    expect(me.$id).toBe(userId)
    expect(me).not.toHaveProperty('password')
    expect(me.emailCanonical).toBe('seller@example.com')

    await admin.users.deleteSession({ userId, sessionId: session.$id })
    const after = await failure(sessionClient(server.endpoint, session.secret).account.get())
    expect(after.code).toBe(401)
  })

  test('wrong password and unknown email are the same 401', async () => {
    const wrong = await failure(admin.account.createEmailPasswordSession('seller@example.com', 'nope nope'))
    expect(wrong).toEqual({ code: 401, type: 'user_invalid_credentials', message: 'Invalid credentials. Please check the email and password.' })
    const unknown = await failure(admin.account.createEmailPasswordSession('ghost@example.com', 'whatever1'))
    expect(unknown.type).toBe('user_invalid_credentials')
  })

  test('blocked users cannot sign in', async () => {
    await admin.users.updateStatus({ userId, status: false })
    expect((await failure(admin.account.createEmailPasswordSession('seller@example.com', 'correct horse'))).type).toBe('user_blocked')
    await admin.users.updateStatus({ userId, status: true })
  })

  test('a browser sign-in gets a cookie instead of a secret in the body', async () => {
    const res = await fetch(`${server.endpoint}/account/sessions/email`, {
      method: 'POST',
      headers: { 'x-appwrite-project': PROJECT, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'seller@example.com', password: 'correct horse' }),
    })
    const body: any = await res.json()
    expect(res.status).toBe(201)
    expect(body.secret).toBe('')
    expect(body.current).toBe(true)
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toStartWith(`a_session_${PROJECT}=`)
    const me = await fetch(`${server.endpoint}/account`, { headers: { 'x-appwrite-project': PROJECT, cookie: cookie.split(';')[0]! } })
    expect(((await me.json()) as any).$id).toBe(userId)
    const logout = await fetch(`${server.endpoint}/account/sessions/current`, { method: 'DELETE', headers: { 'x-appwrite-project': PROJECT, cookie: cookie.split(';')[0]! } })
    expect(logout.status).toBe(204)
  })

  test('a guest asking for the account gets Appwrite\'s scope error', async () => {
    expect(await failure(guest.account.get())).toEqual({
      code: 401,
      type: 'general_unauthorized_scope',
      message: 'User (role: guests) missing scopes (["account"])',
    })
    expect((await failure(guest.account.deleteSession('current'))).code).toBe(401)
  })

  test('only the newest 10 sessions are kept', async () => {
    const ids: string[] = []
    for (let i = 0; i < 12; i++) ids.push((await admin.users.createSession({ userId })).$id)
    const left = await admin.users.listSessions({ userId })
    expect(left.total).toBe(10)
    expect(left.sessions.map((s: any) => s.$id)).toEqual(ids.slice(2))
  })
})

describe('email one-time code (verification.ts flow)', () => {
  test('code is mailed, exchanged once for a session, and verifies the email', async () => {
    const created = await admin.users.create({ userId: ID.unique(), email: 'otp@example.com', password: 'longenough1' })
    const found = await admin.users.list({ queries: [Query.equal('email', 'otp@example.com'), Query.limit(1)] })
    expect(found.users[0].$id).toBe(created.$id)

    const token = await admin.account.createEmailToken({ userId: created.$id, email: 'otp@example.com' })
    expect(token.userId).toBe(created.$id)
    const mail = server.mailer.last('otp@example.com')!
    expect(mail.subject).toBe('OTP for Test Project Login')
    const code = codeFrom(mail.text)!
    expect(token.secret).toBe(code)

    const session = await admin.account.createSession(created.$id, code)
    expect(session.secret.length).toBeGreaterThan(32)
    expect((await admin.users.get({ userId: created.$id })).emailVerification).toBe(true)

    const again = await failure(admin.account.createSession(created.$id, code))
    expect(again).toEqual({ code: 401, type: 'user_invalid_token', message: 'Invalid token passed in the request.' })
  })

  test('a new address gets an account; the public client never sees the code', async () => {
    const token = await guest.account.createEmailToken({ userId: 'newbie', email: 'newbie@example.com' })
    expect(token.userId).toBe('newbie')
    expect(token.secret).toBe('')
    expect((await admin.users.get({ userId: 'newbie' })).email).toBe('newbie@example.com')
  })

  test('without SMTP the endpoint fails like Appwrite', async () => {
    const other = startServer(undefined)
    other.services.mailer = new DisabledMailer()
    const e = await failure(adminClient(other.endpoint).account.createEmailToken({ userId: ID.unique(), email: 'x@example.com' }))
    expect([e.type, e.message]).toEqual(['general_smtp_disabled', 'SMTP disabled'])
    other.stop()
  })
})

describe('abuse protection', () => {
  test('ten wrong codes burn the real one', async () => {
    const user = await admin.users.create({ userId: 'guessme', email: 'guessme@example.com' })
    await admin.account.createEmailToken({ userId: user.$id, email: 'guessme@example.com' })
    const code = codeFrom(server.mailer.last('guessme@example.com')!.text)!
    for (let i = 0; i < 10; i++) {
      const wrong = String((Number(code) + 1 + i) % 1_000_000).padStart(6, '0')
      expect((await failure(admin.account.createSession(user.$id, wrong))).type).toBe('user_invalid_token')
    }
    expect((await failure(admin.account.createSession(user.$id, code))).type).toBe('user_invalid_token')
  })

  test('browsers get Appwrite\'s 429 after 10 sign-in attempts an hour; API keys do not', async () => {
    const res = async () =>
      fetch(`${server.endpoint}/account/sessions/email`, {
        method: 'POST',
        headers: { 'x-appwrite-project': PROJECT, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify({ email: 'limit@example.com', password: 'wrong password' }),
      })
    for (let i = 0; i < 10; i++) expect((await res()).status).toBe(401)
    const blocked = await res()
    expect(blocked.status).toBe(429)
    expect(((await blocked.json()) as any).type).toBe('general_rate_limit_exceeded')
    for (let i = 0; i < 12; i++) expect((await failure(admin.account.createEmailPasswordSession('limit@example.com', 'wrong password'))).code).toBe(401)
  })

  test('a JWT in the query string is ignored outside realtime', async () => {
    await admin.users.create({ userId: 'qjwt', email: 'qjwt@example.com' })
    const { jwt } = await admin.users.createJWT({ userId: 'qjwt' })
    const res = await fetch(`${server.endpoint}/account?jwt=${jwt}`, { headers: { 'x-appwrite-project': PROJECT } })
    expect(res.status).toBe(401)
  })
})

describe('server-minted sessions (storefront mintSession)', () => {
  test('users.createToken + account.createSession', async () => {
    const user = await admin.users.create({ userId: ID.unique(), email: 'shopper@example.com' })
    const token = await admin.users.createToken({ userId: user.$id, length: 64, expire: 60 })
    expect(token.secret).toHaveLength(64)
    const session = await admin.account.createSession(token.userId, token.secret)
    expect(session.provider).toBe('token')
    expect(session.secret.length).toBeGreaterThan(32)
    const bad = await failure(admin.users.createToken({ userId: user.$id, length: 2 }))
    expect(bad.code).toBe(400)
  })

  test('users.createSession (packages/session mintSession)', async () => {
    const user = await admin.users.create({ userId: ID.unique(), email: 'direct@example.com' })
    const session = await admin.users.createSession({ userId: user.$id })
    expect(session.provider).toBe('server')
    expect((await sessionClient(server.endpoint, session.secret).account.get()).$id).toBe(user.$id)
  })
})

describe('password recovery', () => {
  test('mail a link, reset with it, then sign in with the new password', async () => {
    await admin.users.create({ userId: 'rec', email: 'recover@example.com', password: 'old password' })
    const token = await guest.account.createRecovery({ email: 'recover@example.com', url: 'https://dashboard.example.com/reset?x=1' })
    expect(token.secret).toBe('')
    const mail = server.mailer.last('recover@example.com')!
    expect(mail.subject).toBe('Password Reset for Test Project')
    const link = linkFrom(mail.text)
    expect(link.origin + link.pathname).toBe('https://dashboard.example.com/reset')
    expect(link.searchParams.get('x')).toBe('1')
    expect(link.searchParams.get('userId')).toBe('rec')

    const bad = await failure(guest.account.updateRecovery({ userId: 'rec', secret: 'nope', password: 'new password' }))
    expect([bad.code, bad.type]).toEqual([401, 'user_invalid_token'])
    await guest.account.updateRecovery({ userId: 'rec', secret: link.searchParams.get('secret')!, password: 'new password' })
    const session = await admin.account.createEmailPasswordSession('recover@example.com', 'new password')
    expect(session.userId).toBe('rec')
    const reused = await failure(guest.account.updateRecovery({ userId: 'rec', secret: link.searchParams.get('secret')!, password: 'other password' }))
    expect(reused.type).toBe('user_invalid_token')
  })

  test('unknown email is 404; foreign redirect host is 400', async () => {
    expect((await failure(guest.account.createRecovery({ email: 'nobody@example.com', url: 'https://dashboard.example.com/reset' }))).type).toBe('user_not_found')
    const host = await failure(guest.account.createRecovery({ email: 'recover@example.com', url: 'https://evil.example/reset' }))
    expect([host.code, host.type]).toEqual([400, 'general_argument_invalid'])
  })
})

describe('JWT (realtime token flow)', () => {
  test('users.createJWT works as a caller with the user\'s roles', async () => {
    const user = await admin.users.create({ userId: 'jwtuser', email: 'jwt@example.com' })
    await admin.users.createSession({ userId: user.$id })
    await admin.databases.createDocument({
      databaseId: DB,
      collectionId: 'products',
      documentId: 'jwt-doc',
      data: { tenantId: 'jwt', name: 'Mine' },
      permissions: [Permission.read(Role.user('jwtuser'))],
    })
    const { jwt } = await admin.users.createJWT({ userId: user.$id, duration: 900 })
    expect(jwt.split('.')).toHaveLength(3)
    const asUser = jwtClient(server.endpoint, jwt)
    expect((await asUser.account.get()).$id).toBe('jwtuser')
    const docs = await asUser.databases.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.equal('tenantId', 'jwt')] })
    expect(docs.documents.map((d: any) => d.$id)).toEqual(['jwt-doc'])
    const forged = await failure(jwtClient(server.endpoint, jwt.slice(0, -2) + 'xx').account.get())
    expect([forged.code, forged.type]).toEqual([401, 'user_jwt_invalid'])
  })
})

describe('users admin (developer app)', () => {
  test('create, conflict, update every field, list, delete', async () => {
    const u = await admin.users.create({ userId: 'u-admin', email: 'staff@example.com', password: 'password123', name: 'Staff', phone: '+6281234567890' })
    expect(u.phone).toBe('+6281234567890')
    expect((await failure(admin.users.create({ userId: ID.unique(), email: 'staff@example.com' }))).type).toBe('user_already_exists')
    expect((await failure(admin.users.create({ userId: ID.unique(), email: 'x@example.com', password: 'short' }))).type).toBe('general_argument_invalid')

    await admin.users.updateName({ userId: 'u-admin', name: 'Staff Two' })
    await admin.users.updateEmail({ userId: 'u-admin', email: 'staff2@example.com' })
    await admin.users.updatePhone({ userId: 'u-admin', number: '+6281111111111' })
    await admin.users.updatePassword({ userId: 'u-admin', password: 'another pass' })
    await admin.users.updateEmailVerification({ userId: 'u-admin', emailVerification: true })
    await admin.users.updatePhoneVerification({ userId: 'u-admin', phoneVerification: true })
    await admin.users.updateLabels({ userId: 'u-admin', labels: ['superadmin'] })
    const prefs = await admin.users.updatePrefs({ userId: 'u-admin', prefs: { theme: 'dark' } })
    expect(prefs).toEqual({ theme: 'dark' })
    const got = await admin.users.get({ userId: 'u-admin' })
    expect([got.name, got.email, got.phone, got.emailVerification, got.phoneVerification, got.labels, got.prefs]).toEqual([
      'Staff Two', 'staff2@example.com', '+6281111111111', true, true, ['superadmin'], { theme: 'dark' },
    ])
    expect((await admin.account.createEmailPasswordSession('staff2@example.com', 'another pass')).userId).toBe('u-admin')

    const taken = await failure(admin.users.updateEmail({ userId: 'u-admin', email: 'seller@example.com' }))
    expect([taken.code, taken.type]).toEqual([409, 'user_email_already_exists'])
    expect((await failure(admin.users.updatePhone({ userId: 'u-admin', number: '0812' }))).code).toBe(400)

    const page = await admin.users.list({ queries: [Query.orderDesc('$createdAt'), Query.limit(2), Query.offset(0)] })
    expect(page.users).toHaveLength(2)
    expect(page.total).toBeGreaterThan(3)
    const searched = await admin.users.list({ search: 'Staff Two' })
    expect(searched.users.map((x: any) => x.$id)).toEqual(['u-admin'])
    const labelled = await admin.users.list({ queries: [Query.contains('labels', 'superadmin')] })
    expect(labelled.users.map((x: any) => x.$id)).toEqual(['u-admin'])
    const badQuery = await failure(admin.users.list({ queries: [Query.equal('nope', 'x')] }))
    expect(badQuery).toEqual({ code: 400, type: 'general_argument_invalid', message: 'Invalid `queries` param: Invalid query: Attribute not found in schema: nope' })

    await admin.users.deleteSessions({ userId: 'u-admin' })
    expect((await admin.users.listSessions({ userId: 'u-admin' })).total).toBe(0)
    await admin.users.delete({ userId: 'u-admin' })
    expect(await failure(admin.users.get({ userId: 'u-admin' }))).toEqual({ code: 404, type: 'user_not_found', message: 'User with the requested ID could not be found.' })
  })

  test('labels become roles', async () => {
    await admin.users.create({ userId: 'labelled', email: 'labelled@example.com' })
    await admin.users.updateLabels({ userId: 'labelled', labels: ['support'] })
    await admin.databases.createDocument({ databaseId: DB, collectionId: 'products', documentId: 'label-doc', data: { tenantId: 'labels', name: 'L' }, permissions: [Permission.read(Role.label('support'))] })
    const { secret } = await admin.users.createSession({ userId: 'labelled' })
    const docs = await sessionClient(server.endpoint, secret).databases.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.equal('tenantId', 'labels')] })
    expect(docs.total).toBe(1)
  })

  test('users endpoints need an API key', async () => {
    expect(await failure(guest.users.list())).toEqual({ code: 401, type: 'general_unauthorized_scope', message: 'User (role: guests) missing scopes (["users.read"])' })
  })
})

describe('teams', () => {
  test('shop team lifecycle with the API key (tenancy/api.ts)', async () => {
    const owner = await admin.users.create({ userId: 'owner1', email: 'owner1@example.com' })
    const staff = await admin.users.create({ userId: 'staff1', email: 'staff1@example.com', name: 'Staff One' })
    const team = await admin.teams.create({ teamId: ID.unique(), name: 'Toko A (toko-a)' })
    expect(team.total).toBe(0)

    const m1 = await admin.teams.createMembership({ teamId: team.$id, roles: ['owner'], userId: owner.$id, name: 'Owner' })
    expect([m1.confirm, m1.roles, m1.userEmail, m1.teamName]).toEqual([true, ['owner'], 'owner1@example.com', 'Toko A (toko-a)'])
    expect(m1.joined).toBe(m1.invited)
    const m2 = await admin.teams.createMembership({ teamId: team.$id, roles: ['cashier'], email: 'staff1@example.com', url: 'https://dashboard.example.com/invite' })
    expect(m2.userId).toBe(staff.$id)
    expect(m2.confirm).toBe(true)
    expect(server.mailer.last('staff1@example.com')).toBeUndefined()
    expect((await failure(admin.teams.createMembership({ teamId: team.$id, roles: [], userId: staff.$id }))).type).toBe('membership_already_exists')

    expect((await admin.teams.get({ teamId: team.$id })).total).toBe(2)
    const byUser = await admin.teams.listMemberships({ teamId: team.$id, queries: [Query.equal('userId', 'staff1'), Query.limit(1)] })
    expect(byUser.memberships.map((m: any) => m.$id)).toEqual([m2.$id])
    const userSide = await admin.users.listMemberships({ userId: 'owner1', queries: [Query.limit(1)] })
    expect(userSide.memberships[0].teamId).toBe(team.$id)

    const updated = await admin.teams.updateMembership({ teamId: team.$id, membershipId: m2.$id, roles: ['manager'] })
    expect(updated.roles).toEqual(['manager'])
    expect((await admin.teams.getMembership({ teamId: team.$id, membershipId: m2.$id })).roles).toEqual(['manager'])

    // Team roles open documents.
    await admin.databases.createDocument({ databaseId: DB, collectionId: 'products', documentId: 'team-doc', data: { tenantId: 'teamdocs', name: 'T' }, permissions: [Permission.read(Role.team(team.$id, 'manager'))] })
    const { secret } = await admin.users.createSession({ userId: 'staff1' })
    const visible = await sessionClient(server.endpoint, secret).databases.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.equal('tenantId', 'teamdocs')] })
    expect(visible.total).toBe(1)

    await admin.teams.deleteMembership({ teamId: team.$id, membershipId: m2.$id })
    const gone = await sessionClient(server.endpoint, secret).databases.listDocuments({ databaseId: DB, collectionId: 'products', queries: [Query.equal('tenantId', 'teamdocs')] })
    expect(gone.total).toBe(0)

    await admin.teams.delete({ teamId: team.$id })
    expect(await failure(admin.teams.get({ teamId: team.$id }))).toEqual({ code: 404, type: 'team_not_found', message: 'Team with the requested ID could not be found.' })
  })

  test('a signed-in owner invites by email; the invitee accepts with the secret', async () => {
    await admin.users.create({ userId: 'boss', email: 'boss@example.com', name: 'Boss' })
    const { secret } = await admin.users.createSession({ userId: 'boss' })
    const asBoss = sessionClient(server.endpoint, secret)
    const team = await asBoss.teams.create({ teamId: 'boss-team', name: 'Boss Team' })
    expect(team.total).toBe(1)
    const listed = await asBoss.teams.list()
    expect(listed.teams.map((t: any) => t.$id)).toEqual(['boss-team'])

    const invite = await asBoss.teams.createMembership({ teamId: 'boss-team', roles: ['staff'], email: 'invitee@example.com', url: 'https://dashboard.example.com/invite' })
    expect(invite.confirm).toBe(false)
    const mail = server.mailer.last('invitee@example.com')!
    expect(mail.subject).toBe('Invitation to Boss Team Team at Test Project')
    const link = linkFrom(mail.text)
    const accepted = await guest.teams.updateMembershipStatus({
      teamId: 'boss-team',
      membershipId: link.searchParams.get('membershipId')!,
      userId: link.searchParams.get('userId')!,
      secret: link.searchParams.get('secret')!,
    })
    expect(accepted.confirm).toBe(true)
    expect((await asBoss.teams.get({ teamId: 'boss-team' })).total).toBe(2)

    // A plain member cannot manage the team.
    const { secret: inviteeSecret } = await admin.users.createSession({ userId: accepted.userId })
    const asInvitee = sessionClient(server.endpoint, inviteeSecret)
    expect((await asInvitee.teams.get({ teamId: 'boss-team' })).name).toBe('Boss Team')
    expect((await failure(asInvitee.teams.updateMembership({ teamId: 'boss-team', membershipId: accepted.$id, roles: ['owner'] }))).code).toBe(401)
  })
})

describe('Google sign-in', () => {
  let google: ReturnType<typeof Bun.serve>
  let oauthServer: TestServer
  let sub = 'google-sub-1'
  let email = 'google.user@gmail.com'

  beforeAll(() => {
    google = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/token') {
          const form = await req.formData()
          if (form.get('code') !== 'good-code' || form.get('client_secret') !== 'gsecret') return Response.json({ error: 'invalid_grant' }, { status: 400 })
          return Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
        }
        if (url.pathname === '/userinfo') return Response.json({ sub, email, email_verified: true, name: 'Google User' })
        return new Response('not found', { status: 404 })
      },
    })
    const base = `http://localhost:${google.port}`
    oauthServer = startServer(undefined, {
      oauth: { google: { clientId: 'gid', clientSecret: 'gsecret', authUrl: `${base}/auth`, tokenUrl: `${base}/token`, userinfoUrl: `${base}/userinfo` } },
    })
  })
  afterAll(() => {
    google.stop(true)
    oauthServer.stop()
  })

  async function signIn(code = 'good-code') {
    const a = adminClient(oauthServer.endpoint)
    const redirect = await a.account.createOAuth2Token('google', 'https://dashboard.example.com/api/oauth/callback?next=%2Fx', 'https://dashboard.example.com/login')
    const auth = new URL(redirect)
    expect(auth.pathname).toBe('/auth')
    expect(auth.searchParams.get('redirect_uri')).toBe(`${oauthServer.endpoint}/account/sessions/oauth2/callback/google/${PROJECT}`)
    expect(auth.searchParams.get('scope')).toContain('userinfo.email')
    // Google sends the browser back to our callback.
    const back = await fetch(`${auth.searchParams.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(auth.searchParams.get('state')!)}`, { redirect: 'manual' })
    expect(back.status).toBe(301)
    return new URL(back.headers.get('location')!)
  }

  test('a new Google account becomes a verified user and gets a session', async () => {
    const success = await signIn()
    expect(success.origin + success.pathname).toBe('https://dashboard.example.com/api/oauth/callback')
    expect(success.searchParams.get('next')).toBe('/x')
    const a = adminClient(oauthServer.endpoint)
    const session = await a.account.createSession(success.searchParams.get('userId')!, success.searchParams.get('secret')!)
    expect(session.provider).toBe('google')
    expect(session.providerUid).toBe('google-sub-1')
    const user = await a.users.get({ userId: session.userId })
    expect([user.email, user.name, user.emailVerification]).toEqual(['google.user@gmail.com', 'Google User', true])

    const again = await signIn()
    expect(again.searchParams.get('userId')).toBe(session.userId)
  })

  test('an existing email account is linked, not duplicated', async () => {
    const a = adminClient(oauthServer.endpoint)
    const existing = await a.users.create({ userId: 'has-password', email: 'linked@example.com', password: 'password123' })
    sub = 'google-sub-2'
    email = 'linked@example.com'
    const success = await signIn()
    expect(success.searchParams.get('userId')).toBe(existing.$id)
  })

  test('a failed exchange goes to the failure URL with an error', async () => {
    const failed = await signIn('bad-code')
    expect(failed.origin + failed.pathname).toBe('https://dashboard.example.com/login')
    expect(JSON.parse(failed.searchParams.get('error')!).type).toBe('user_oauth2_provider_error')
  })

  test('redirects to other hosts are refused; disabled provider is reported', async () => {
    const a = adminClient(oauthServer.endpoint)
    const bad = await failure(a.account.createOAuth2Token('google', 'https://evil.example/cb', 'https://evil.example/f'))
    expect(bad.code).toBe(400)
    // The SDK reports any non-redirect as "Invalid redirect" with the HTTP status, as with Appwrite.
    const off = await failure(admin.account.createOAuth2Token('google', 'https://dashboard.example.com/cb', 'https://dashboard.example.com/f'))
    expect(off.message).toBe('Invalid redirect')
    const raw = await fetch(`${server.endpoint}/account/tokens/oauth2/google?project=${PROJECT}&success=https://dashboard.example.com/cb`, { redirect: 'manual' })
    expect(((await raw.json()) as any).type).toBe('project_provider_disabled')
  })
})

describe('Apple, Facebook and GitHub sign-in', () => {
  let provider: ReturnType<typeof Bun.serve>
  let oauthServer: TestServer
  let appleKeys: CryptoKeyPair
  let facebookUid = 'fb-user-1'
  let facebookEmail = 'fb.user@example.com'
  const githubEmails = [
    { email: 'old@example.com', primary: false, verified: false },
    { email: 'octo@example.com', primary: true, verified: true },
  ]
  const appleClaims = { sub: 'apple-sub-1', email: 'apple.user@example.com', email_verified: 'true' }

  const pem = (der: ArrayBuffer) => {
    const body = Buffer.from(der).toString('base64').match(/.{1,64}/g)!.join('\n')
    return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`
  }

  beforeAll(async () => {
    appleKeys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
    provider = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/facebook/token') return Response.json({ access_token: 'fb-token', token_type: 'bearer', expires_in: 3600 })
        if (url.pathname === '/facebook/me') return Response.json({ id: facebookUid, email: facebookEmail, name: 'Facebook User' })
        if (url.pathname === '/github/token') {
          const form = await req.formData()
          if (form.get('code') !== 'github-code') return Response.json({ error: 'bad_verification_code' }, { status: 400 })
          return Response.json({ access_token: 'gh-token', token_type: 'bearer' })
        }
        if (url.pathname === '/github/user/emails') return Response.json(githubEmails)
        if (url.pathname === '/github/user') return Response.json({ id: 4242, login: 'octocat', name: 'Octo Cat', email: null })
        if (url.pathname === '/apple/token') {
          const form = await req.formData()
          const [header, claims, signature] = String(form.get('client_secret')).split('.')
          if (!header || !claims || !signature) return Response.json({ error: 'invalid_client' }, { status: 400 })
          const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString())
          const parsedClaims = JSON.parse(Buffer.from(claims, 'base64url').toString())
          const valid = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            appleKeys.publicKey,
            Uint8Array.from(Buffer.from(signature, 'base64url')),
            new TextEncoder().encode(`${header}.${claims}`),
          )
          if (!valid || parsedHeader.kid !== 'apple-key' || parsedClaims.iss !== 'apple-team' || parsedClaims.sub !== 'apple-client' || parsedClaims.aud !== 'https://appleid.apple.com') {
            return Response.json({ error: 'invalid_client' }, { status: 400 })
          }
          const idToken = `e30.${Buffer.from(JSON.stringify(appleClaims)).toString('base64url')}.signature`
          return Response.json({ access_token: 'apple-token', refresh_token: 'apple-refresh', expires_in: 3600, id_token: idToken })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const base = `http://localhost:${provider.port}`
    oauthServer = startServer(undefined, {
      oauth: {
        apple: {
          clientId: 'apple-client',
          clientSecret: '',
          teamId: 'apple-team',
          keyId: 'apple-key',
          privateKey: pem(await crypto.subtle.exportKey('pkcs8', appleKeys.privateKey)),
          authUrl: `${base}/apple/auth`,
          tokenUrl: `${base}/apple/token`,
        },
        facebook: {
          clientId: 'fb-client',
          clientSecret: 'fb-secret',
          authUrl: `${base}/facebook/auth`,
          tokenUrl: `${base}/facebook/token`,
          userinfoUrl: `${base}/facebook/me`,
        },
        github: {
          clientId: 'gh-client',
          clientSecret: 'gh-secret',
          authUrl: `${base}/github/auth`,
          tokenUrl: `${base}/github/token`,
          userinfoUrl: `${base}/github/user`,
        },
      },
    })
  })
  afterAll(() => {
    provider.stop(true)
    oauthServer.stop()
  })

  const callbackUrl = (id: string) => `${oauthServer.endpoint}/account/sessions/oauth2/callback/${id}/${PROJECT}`

  async function authorize(id: string) {
    const client = adminClient(oauthServer.endpoint)
    const redirect = await client.account.createOAuth2Token(id as any, 'https://dashboard.example.com/ok', 'https://dashboard.example.com/fail')
    const url = new URL(redirect)
    return { client, url, state: url.searchParams.get('state')! }
  }

  async function signIn(id: string, code: string) {
    const { client, url, state } = await authorize(id)
    const back = await fetch(`${callbackUrl(id)}?code=${code}&state=${encodeURIComponent(state)}`, { redirect: 'manual' })
    expect(back.status).toBe(301)
    return { client, url, location: new URL(back.headers.get('location')!) }
  }

  test('Facebook signs in a new account; its email stays unverified', async () => {
    const { client, url, location } = await signIn('facebook', 'fb-code')
    expect(url.pathname).toBe('/facebook/auth')
    expect(url.searchParams.get('client_id')).toBe('fb-client')
    expect(url.searchParams.get('redirect_uri')).toBe(callbackUrl('facebook'))
    expect(url.searchParams.get('scope')).toBe('email')
    expect(location.origin + location.pathname).toBe('https://dashboard.example.com/ok')

    const session = await client.account.createSession(location.searchParams.get('userId')!, location.searchParams.get('secret')!)
    expect(session.provider).toBe('facebook')
    expect(session.providerUid).toBe('fb-user-1')
    const user = await client.users.get({ userId: session.userId })
    expect([user.email, user.name, user.emailVerification]).toEqual(['fb.user@example.com', 'Facebook User', false])

    // Signing in again finds the identity instead of creating another account.
    const again = await signIn('facebook', 'fb-code')
    expect(again.location.searchParams.get('userId')).toBe(session.userId)
  })

  test('an unverified provider email never attaches to an existing account', async () => {
    const client = adminClient(oauthServer.endpoint)
    await client.users.create({ userId: 'taken-email', email: 'taken@example.com', password: 'password123' })
    facebookUid = 'fb-user-2'
    facebookEmail = 'taken@example.com'
    const { location } = await signIn('facebook', 'fb-code')
    expect(location.origin + location.pathname).toBe('https://dashboard.example.com/fail')
    expect(JSON.parse(location.searchParams.get('error')!).type).toBe('general_bad_request')
  })

  test('GitHub uses the primary verified email and the profile name', async () => {
    const { client, url, location } = await signIn('github', 'github-code')
    expect(url.pathname).toBe('/github/auth')
    expect(url.searchParams.get('scope')).toBe('user:email')
    expect(location.origin + location.pathname).toBe('https://dashboard.example.com/ok')

    const session = await client.account.createSession(location.searchParams.get('userId')!, location.searchParams.get('secret')!)
    expect(session.provider).toBe('github')
    expect(session.providerUid).toBe('4242')
    const user = await client.users.get({ userId: session.userId })
    expect([user.email, user.name, user.emailVerification]).toEqual(['octo@example.com', 'Octo Cat', true])
  })

  test('Apple posts the callback and accepts the signed client secret', async () => {
    const { client, url, state } = await authorize('apple')
    expect(url.pathname).toBe('/apple/auth')
    expect(url.searchParams.get('response_mode')).toBe('form_post')
    expect(url.searchParams.get('scope')).toBe('name email')

    const back = await fetch(callbackUrl('apple'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: 'apple-code',
        state,
        user: JSON.stringify({ name: { firstName: 'Apple', lastName: 'User' }, email: 'apple.user@example.com' }),
      }),
      redirect: 'manual',
    })
    expect(back.status).toBe(301)
    const location = new URL(back.headers.get('location')!)
    expect(location.origin + location.pathname).toBe('https://dashboard.example.com/ok')

    const session = await client.account.createSession(location.searchParams.get('userId')!, location.searchParams.get('secret')!)
    expect(session.provider).toBe('apple')
    expect(session.providerUid).toBe('apple-sub-1')
    const user = await client.users.get({ userId: session.userId })
    expect([user.email, user.name, user.emailVerification]).toEqual(['apple.user@example.com', 'Apple User', true])
  })
})

describe('realtime (web SDK 27)', () => {
  test('a JWT subscriber hears creates it may read, and nothing else', async () => {
    // The web SDK expects a browser; give it the little it touches.
    const g = globalThis as any
    g.window ??= { localStorage: { getItem: () => null, setItem: () => {} }, setTimeout, clearTimeout, setInterval, clearInterval, location: undefined }
    const { Client } = await import('appwrite')

    await admin.users.create({ userId: 'rt-user', email: 'rt@example.com' })
    await admin.users.createSession({ userId: 'rt-user' })
    const { jwt } = await admin.users.createJWT({ userId: 'rt-user' })
    const client = new Client().setEndpoint(server.endpoint).setProject(PROJECT).setJWT(jwt)
    const events: any[] = []
    const unsubscribe = client.subscribe(`databases.${DB}.collections.products.documents`, (e: any) => events.push(e))
    await Bun.sleep(300)

    await admin.databases.createDocument({ databaseId: DB, collectionId: 'products', documentId: 'rt-visible', data: { tenantId: 'rt', name: 'Yes' }, permissions: [Permission.read(Role.user('rt-user'))] })
    await admin.databases.createDocument({ databaseId: DB, collectionId: 'products', documentId: 'rt-hidden', data: { tenantId: 'rt', name: 'No' } })
    await admin.databases.updateDocument({ databaseId: DB, collectionId: 'products', documentId: 'rt-visible', data: { name: 'Yes!' } })
    // A staged write must stay silent until commit.
    const tx = await admin.databases.createTransaction()
    await admin.databases.updateDocument({ databaseId: DB, collectionId: 'products', documentId: 'rt-visible', data: { name: 'Staged' }, transactionId: tx.$id })
    await admin.databases.getDocument({ databaseId: DB, collectionId: 'products', documentId: 'rt-visible', transactionId: tx.$id })
    await Bun.sleep(300)

    expect(events.map((e) => [e.payload.$id, e.payload.name])).toEqual([['rt-visible', 'Yes'], ['rt-visible', 'Yes!']])
    expect(events[0].events.some((n: string) => n.endsWith('.create'))).toBe(true)
    expect(events[1].events).toContain(`databases.${DB}.collections.products.documents.rt-visible.update`)

    await admin.databases.updateTransaction({ transactionId: tx.$id, commit: true })
    await Bun.sleep(300)
    expect(events.at(-1).payload.name).toBe('Staged')
    unsubscribe()
  })
})
