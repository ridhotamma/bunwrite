import type { AppContext } from '~/app'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { bool, json, list, noContent, num, str } from '~/lib/http'
import { assertRedirect, withQuery } from '~/lib/origins'
import type { RouteContext, Router } from '~/lib/router'
import { signJwt } from './jwt'
import { accountModel, membershipModel, sessionModel, tokenModel, userModel, type SessionRow, type UserRowFull } from './models'
import { verifyPassword } from './passwords'
import { otpCode, requestInfo, validEmail, validPhone, type TokenRowFull } from './service'
import { FailedAttempts, RateLimiter } from '~/lib/limits'
import type { AuthMethodId } from '~/settings/access'

const limiter = new RateLimiter()
const failures = new FailedAttempts()

/** Appwrite's abuse limit for public auth endpoints: `limit` per hour per IP and subject. API keys are exempt. */
function limit(route: { ctx: AppContext; request: Request }, name: string, subject: unknown, max = 10): void {
  if (route.ctx.caller.privileged) return
  limiter.hit(`${name}:${requestInfo(route.request).ip}:${String(subject ?? '').toLowerCase()}`, max, 3600)
}

const OTP_TTL = 15 * 60
const RECOVERY_TTL = 60 * 60
const VERIFICATION_TTL = 60 * 60

const ADJECTIVES = ['Brave', 'Calm', 'Clever', 'Gentle', 'Happy', 'Kind', 'Lucky', 'Quiet', 'Swift', 'Wise']
const NOUNS = ['Badger', 'Falcon', 'Lotus', 'Mango', 'Otter', 'Panda', 'River', 'Tiger', 'Willow', 'Zebra']
const pick = (items: string[]) => items[crypto.getRandomValues(new Uint8Array(1))[0]! % items.length]!

function missingScope(ctx: AppContext, scope: string): never {
  const role = ctx.caller.user ? 'users' : ctx.caller.privileged ? 'applications' : 'guests'
  throw err('general_unauthorized_scope', `User (role: ${role}) missing scopes (["${scope}"])`)
}

/** A sign-in method switched off in the project settings refuses clients; API keys may still use it. */
function method(ctx: AppContext, id: AuthMethodId): void {
  if (!ctx.caller.privileged) ctx.access.assertAuthMethod(id)
}

/** Account routes need a signed-in user (session or JWT). */
function me(ctx: AppContext): UserRowFull {
  if (!ctx.caller.user) missingScope(ctx, 'account')
  return ctx.auth.user(ctx.caller.user.id)
}

export function requireKey(ctx: AppContext, scope: string): void {
  if (!ctx.caller.privileged) missingScope(ctx, scope)
}

const cookieName = (ctx: AppContext) => `a_session_${ctx.config.projectId.toLowerCase()}`

/**
 * A new session. API keys get its secret in the body (the app stores it in its
 * own cookie); browsers get it as the `a_session_<project>` cookie instead.
 */
function sessionResponse(route: RouteContext<AppContext>, session: SessionRow, secret: string): Response {
  const { ctx } = route
  const country = requestInfo(route.request).country
  if (ctx.caller.privileged) return json(sessionModel(session, { secret, country }), 201)
  const secure = ctx.config.publicEndpoint.startsWith('https') ? '; Secure; SameSite=None' : '; SameSite=Lax'
  const cookie = `${cookieName(ctx)}=${encodeURIComponent(secret)}; Expires=${new Date(session.expire).toUTCString()}; Path=/; HttpOnly${secure}`
  return json(sessionModel(session, { current: true, country }), 201, {
    'set-cookie': cookie,
    'x-fallback-cookies': JSON.stringify({ [cookieName(ctx)]: secret }),
  })
}

/** Only callers without a session may create one (API keys always may). */
function assertNoSession(ctx: AppContext): void {
  if (!ctx.caller.privileged && ctx.caller.sessionId) throw err('user_session_already_exists')
}

function sessionFromToken(route: RouteContext<AppContext>, user: UserRowFull, token: TokenRowFull): Response {
  const { ctx } = route
  const info = requestInfo(route.request)
  const provider = token.type === 'oauth2' ? token.provider ?? 'oauth2' : token.type === 'generic' ? 'token' : token.type
  const factors = token.type === 'email' || token.type === 'magic-url' ? ['email'] : token.type === 'oauth2' ? ['email', 'oauth2'] : ['token']
  const identity = token.type === 'oauth2' ? ctx.oauth.identity(user.id, provider) : null
  ctx.auth.deleteToken(token.id)
  if (token.type === 'email' || token.type === 'magic-url') ctx.auth.updateUser(user.id, { email_verification: 1 })
  const { session, secret } = ctx.auth.createSession(user.id, {
    provider,
    factors,
    info,
    providerUid: identity?.provider_uid,
    providerAccessToken: identity?.provider_access_token,
    providerRefreshToken: identity?.provider_refresh_token,
    providerAccessTokenExpiry: identity?.provider_access_token_expiry,
  })
  return sessionResponse(route, session, secret)
}

const prefsObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw err('general_argument_invalid', 'Invalid `prefs` param: Value must be a valid object.')
  }
  if (JSON.stringify(value).length > 65_000) throw err('general_argument_invalid', 'Invalid `prefs` param: Value is too large.')
  return value as Record<string, unknown>
}

async function jwtFor(ctx: AppContext, userId: string, sessionId: string, duration: number) {
  if (!Number.isInteger(duration) || duration < 0 || duration > 3600) {
    throw err('general_argument_invalid', 'Invalid `duration` param: Value must be a valid range between 0 and 3,600')
  }
  return { jwt: await signJwt({ userId, sessionId }, ctx.config.secret, duration || 900) }
}

export function accountRoutes(router: Router<AppContext>): void {
  router.get('/account', ({ ctx }) => json(accountModel(me(ctx))))

  router.post('/account', async (route) => {
    const { ctx, params } = route
    assertNoSession(ctx)
    method(ctx, 'email-password')
    limit(route, 'account-create', '')
    ctx.access.assertUserLimit()
    ctx.access.assertPasswordPersonalData(params.password, { id: params.userId, name: params.name, email: params.email })
    const user = await ctx.auth.createUser({ id: params.userId, email: params.email, password: params.password ?? '', name: params.name })
    return json(accountModel(user), 201)
  })

  router.patch('/account/name', ({ ctx, params }) => {
    const user = me(ctx)
    return json(accountModel(ctx.auth.updateUser(user.id, { name: String(params.name ?? '').slice(0, 128) })))
  })

  router.patch('/account/password', async ({ ctx, params }) => {
    const user = me(ctx)
    if (user.password && !(await verifyPassword(String(params.oldPassword ?? ''), user.password, user.hash, JSON.parse(user.hash_options)))) {
      throw err('user_invalid_credentials')
    }
    ctx.access.assertPasswordPersonalData(params.password, user)
    return json(accountModel(await ctx.auth.setPassword(user.id, params.password)))
  })

  router.patch('/account/email', async ({ ctx, params }) => {
    const user = me(ctx)
    if (user.password && !(await verifyPassword(String(params.password ?? ''), user.password, user.hash, JSON.parse(user.hash_options)))) {
      throw err('user_invalid_credentials')
    }
    return json(accountModel(ctx.auth.updateUser(user.id, { email: validEmail(params.email), email_verification: 0 })))
  })

  router.get('/account/prefs', ({ ctx }) => json(JSON.parse(me(ctx).prefs)))
  router.patch('/account/prefs', ({ ctx, params }) => {
    const user = me(ctx)
    return json(accountModel(ctx.auth.updateUser(user.id, { prefs: JSON.stringify(prefsObject(params.prefs)) })))
  })

  router.patch('/account/status', ({ ctx }) => {
    const user = me(ctx)
    const updated = ctx.auth.updateUser(user.id, { status: 0 })
    ctx.auth.deleteSessions(user.id)
    return json(accountModel(updated))
  })

  router.get('/account/sessions', ({ ctx }) => {
    const user = me(ctx)
    const sessions = ctx.auth.sessions(user.id).map((s) => sessionModel(s, { current: s.id === ctx.caller.sessionId }))
    return json({ total: sessions.length, sessions })
  })

  router.delete('/account/sessions', ({ ctx }) => {
    ctx.auth.deleteSessions(me(ctx).id)
    return noContent()
  })

  const sessionIdOf = (ctx: AppContext, id: string) => (id === 'current' ? ctx.caller.sessionId ?? '' : id)

  router.get('/account/sessions/:sessionId', ({ ctx, path }) => {
    const user = me(ctx)
    const id = sessionIdOf(ctx, path.sessionId!)
    const session = ctx.auth.session(id)
    if (!session || session.user_id !== user.id) throw err('user_session_not_found')
    return json(sessionModel(session, { current: id === ctx.caller.sessionId }))
  })

  router.patch('/account/sessions/:sessionId', ({ ctx, path }) => {
    const user = me(ctx)
    const id = sessionIdOf(ctx, path.sessionId!)
    const session = ctx.auth.session(id)
    if (!session || session.user_id !== user.id) throw err('user_session_not_found')
    return json(sessionModel(session, { current: id === ctx.caller.sessionId }))
  })

  router.delete('/account/sessions/:sessionId', ({ ctx, path }) => {
    const user = me(ctx)
    const id = sessionIdOf(ctx, path.sessionId!)
    ctx.auth.deleteSession(user.id, id)
    const headers = id === ctx.caller.sessionId ? { 'set-cookie': `${cookieName(ctx)}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly` } : {}
    return new Response(null, { status: 204, headers })
  })

  router.post('/account/sessions/email', async (route) => {
    const { ctx, params } = route
    assertNoSession(ctx)
    method(ctx, 'email-password')
    limit(route, 'sessions-email', params.email)
    const email = typeof params.email === 'string' ? params.email.toLowerCase() : ''
    const user = email ? ctx.auth.userByEmail(email) : null
    const ok = user && (await verifyPassword(String(params.password ?? ''), user.password, user.hash, JSON.parse(user.hash_options)))
    if (!user || !ok) throw err('user_invalid_credentials')
    if (!user.status) throw err('user_blocked')
    const { session, secret } = ctx.auth.createSession(user.id, { provider: 'email', factors: ['password'], info: requestInfo(route.request) })
    return sessionResponse(route, session, secret)
  })

  // Exchange any login token (email code, OAuth, users.createToken) for a session.
  router.post('/account/sessions/token', (route) => {
    const { ctx, params } = route
    assertNoSession(ctx)
    const userId = str(params.userId) ?? ''
    limit(route, 'sessions-token', userId)
    const user = ctx.auth.findUser(userId)
    if (!user) throw err('user_invalid_token')
    let token: TokenRowFull
    try {
      token = ctx.auth.verifyToken(userId, params.secret, ['email', 'magic-url', 'oauth2', 'generic'])
    } catch (error) {
      // A 6-digit code must not be guessable: ten wrong tries burn every outstanding code.
      if (failures.fail(userId)) {
        ctx.db.sqlite.query("DELETE FROM _tokens WHERE user_id = ? AND type IN ('email', 'magic-url')").run(userId)
        failures.clear(userId)
      }
      throw error
    }
    failures.clear(userId)
    if (!user.status) throw err('user_blocked')
    return sessionFromToken(route, user, token)
  })

  router.post('/account/tokens/email', async (route) => {
    const { ctx, params } = route
    method(ctx, 'email-otp')
    limit(route, 'tokens-email', params.email)
    if (!ctx.mailer.enabled) throw err('general_smtp_disabled', 'SMTP disabled')
    const email = validEmail(params.email)
    const user = ctx.auth.userByEmail(email) ?? (await ctx.auth.createUser({ id: params.userId, email }))
    if (!user.status) throw err('user_blocked')
    const code = otpCode()
    const phrase = bool(params.phrase, false) ? `${pick(ADJECTIVES)} ${pick(NOUNS)}` : ''
    const { token } = ctx.auth.createToken(user.id, 'email', { secret: code, ttl: OTP_TTL })
    await ctx.mailer.send(ctx.templates.render('otpSession', email, { user: user.name || email, otp: code, phrase }))
    return json(tokenModel(token, ctx.caller.privileged ? code : '', phrase), 201)
  })

  router.get('/account/tokens/oauth2/:provider', async ({ ctx, params, path }) => {
    const location = await ctx.oauth.authorizeUrl(path.provider!, params.success, params.failure, params.scopes)
    return new Response(null, { status: 301, headers: { location, 'cache-control': 'no-store' } })
  })

  router.get('/account/sessions/oauth2/callback/:provider/:projectId', async ({ ctx, url, path }) => {
    if (path.projectId !== ctx.config.projectId) throw err('project_not_found')
    const location = await ctx.oauth.callback(path.provider!, url)
    return new Response(null, { status: 301, headers: { location, 'cache-control': 'no-store' } })
  })

  router.post('/account/jwts', async ({ ctx, params }) => {
    method(ctx, 'jwt')
    const user = me(ctx)
    return json(await jwtFor(ctx, user.id, ctx.caller.sessionId ?? '', num(params.duration, 900)!), 201)
  })

  router.post('/account/recovery', async (route) => {
    const { ctx, params } = route
    limit(route, 'recovery', params.email)
    const email = validEmail(params.email)
    const url = assertRedirect(params.url, ctx.config.allowedOrigins, 'url')
    if (!ctx.mailer.enabled) throw err('general_smtp_disabled', 'SMTP Disabled')
    const user = ctx.auth.userByEmail(email)
    if (!user) throw err('user_not_found')
    if (!user.status) throw err('user_blocked')
    const { token, secret } = ctx.auth.createToken(user.id, 'recovery', { ttl: RECOVERY_TTL })
    const link = withQuery(url, { userId: user.id, secret, expire: token.expire })
    await ctx.mailer.send(ctx.templates.render('recovery', email, { user: user.name || email, redirect: link }))
    return json(tokenModel(token, ctx.caller.privileged ? secret : ''), 201)
  })

  router.put('/account/recovery', async (route) => {
    const { ctx, params } = route
    limit(route, 'recovery-update', params.userId)
    const user = ctx.auth.findUser(str(params.userId) ?? '')
    if (!user) throw err('user_not_found')
    const token = ctx.auth.verifyToken(user.id, params.secret, ['recovery'])
    ctx.access.assertPasswordPersonalData(params.password, user)
    await ctx.auth.setPassword(user.id, params.password)
    ctx.auth.updateUser(user.id, { email_verification: 1 })
    ctx.auth.deleteToken(token.id)
    return json(tokenModel(token))
  })

  router.post('/account/verifications/email', async ({ ctx, params }) => {
    const user = me(ctx)
    const url = assertRedirect(params.url, ctx.config.allowedOrigins, 'url')
    if (!ctx.mailer.enabled) throw err('general_smtp_disabled', 'SMTP Disabled')
    if (!user.email) throw err('user_email_not_found')
    const { token, secret } = ctx.auth.createToken(user.id, 'verification', { ttl: VERIFICATION_TTL })
    const link = withQuery(url, { userId: user.id, secret, expire: token.expire })
    await ctx.mailer.send(ctx.templates.render('verification', user.email, { user: user.name || user.email, redirect: link }))
    return json(tokenModel(token), 201)
  })

  router.put('/account/verifications/email', ({ ctx, params }) => {
    const user = ctx.auth.findUser(str(params.userId) ?? '')
    if (!user) throw err('user_not_found')
    const token = ctx.auth.verifyToken(user.id, params.secret, ['verification'])
    ctx.auth.updateUser(user.id, { email_verification: 1 })
    ctx.auth.deleteToken(token.id)
    return json(tokenModel(token))
  })
}

export function userRoutes(router: Router<AppContext>): void {
  const user = (ctx: AppContext, id: string) => {
    requireKey(ctx, 'users.read')
    return ctx.auth.user(id)
  }
  const done = (ctx: AppContext, id: string) => json(userModel(ctx.auth.user(id)))

  // Linked OAuth accounts. Registered before /users/:userId so "identities" is not taken as an ID.
  router.get('/users/identities', ({ ctx, params }) => {
    requireKey(ctx, 'users.read')
    let limit = 25
    let offset = 0
    let after = 0
    for (const raw of list(params.queries)) {
      const query = typeof raw === 'string' ? JSON.parse(raw) : (raw as any)
      if (query?.method === 'limit') limit = Number(query.values?.[0] ?? 25)
      if (query?.method === 'offset') offset = Number(query.values?.[0] ?? 0)
      if (query?.method === 'cursorAfter') {
        after = ctx.db.sqlite.query<{ seq: number }, [string]>('SELECT seq FROM _identities WHERE id = ?').get(String(query.values?.[0]))?.seq ?? 0
      }
    }
    const rows = ctx.db.sqlite.query<any, [number, number, number]>('SELECT * FROM _identities WHERE seq > ? ORDER BY seq LIMIT ? OFFSET ?').all(after, limit, offset)
    const total = (ctx.db.sqlite.query('SELECT count(*) AS n FROM _identities').get() as { n: number }).n
    return json({
      total,
      identities: rows.map((r) => ({
        $id: r.id,
        $createdAt: r.created_at,
        $updatedAt: r.updated_at,
        userId: r.user_id,
        provider: r.provider,
        providerUid: r.provider_uid,
        providerEmail: r.provider_email,
        providerAccessToken: r.provider_access_token,
        providerAccessTokenExpiry: r.provider_access_token_expiry,
        providerRefreshToken: r.provider_refresh_token,
      })),
    })
  })

  router.get('/users', ({ ctx, params }) => {
    requireKey(ctx, 'users.read')
    const { total, users } = ctx.auth.listUsers(list(params.queries), str(params.search), bool(params.total, true))
    return json({ total, users: users.map(userModel) })
  })

  router.post('/users', async ({ ctx, params }) => {
    requireKey(ctx, 'users.write')
    ctx.access.assertPasswordPersonalData(params.password, { id: params.userId, name: params.name, email: params.email, phone: params.phone })
    const created = await ctx.auth.createUser({ id: params.userId, email: params.email, phone: params.phone, password: params.password, name: params.name })
    return json(userModel(created), 201)
  })

  router.get('/users/:userId', ({ ctx, path }) => json(userModel(user(ctx, path.userId!))))

  router.delete('/users/:userId', ({ ctx, path }) => {
    requireKey(ctx, 'users.write')
    ctx.auth.deleteUser(path.userId!)
    return noContent()
  })

  router.patch('/users/:userId/name', ({ ctx, path, params }) => {
    user(ctx, path.userId!)
    ctx.auth.updateUser(path.userId!, { name: String(params.name ?? '').slice(0, 128) })
    return done(ctx, path.userId!)
  })

  router.patch('/users/:userId/email', ({ ctx, path, params }) => {
    user(ctx, path.userId!)
    const email = params.email === '' ? null : validEmail(params.email)
    ctx.auth.updateUser(path.userId!, { email, email_verification: 0 })
    return done(ctx, path.userId!)
  })

  router.patch('/users/:userId/phone', ({ ctx, path, params }) => {
    user(ctx, path.userId!)
    const phone = params.number === '' ? null : validPhone(params.number)
    ctx.auth.updateUser(path.userId!, { phone, phone_verification: 0 })
    return done(ctx, path.userId!)
  })

  router.patch('/users/:userId/password', async ({ ctx, path, params }) => {
    const target = user(ctx, path.userId!)
    if (params.password !== '') ctx.access.assertPasswordPersonalData(params.password, target)
    if (params.password === '') ctx.auth.updateUser(path.userId!, { password: null, password_update: now() })
    else await ctx.auth.setPassword(path.userId!, params.password)
    return done(ctx, path.userId!)
  })

  router.patch('/users/:userId/status', ({ ctx, path, params }) => {
    user(ctx, path.userId!)
    ctx.auth.updateUser(path.userId!, { status: bool(params.status, true) ? 1 : 0 })
    return done(ctx, path.userId!)
  })

  router.patch('/users/:userId/verification', ({ ctx, path, params }) => {
    user(ctx, path.userId!)
    ctx.auth.updateUser(path.userId!, { email_verification: bool(params.emailVerification, false) ? 1 : 0 })
    return done(ctx, path.userId!)
  })

  router.patch('/users/:userId/verification/phone', ({ ctx, path, params }) => {
    user(ctx, path.userId!)
    ctx.auth.updateUser(path.userId!, { phone_verification: bool(params.phoneVerification, false) ? 1 : 0 })
    return done(ctx, path.userId!)
  })

  router.put('/users/:userId/labels', ({ ctx, path, params }) => {
    user(ctx, path.userId!)
    const labels = list(params.labels)
    if (labels.length > 1000 || labels.some((l) => typeof l !== 'string' || !/^[a-zA-Z0-9]{1,36}$/.test(l))) {
      throw err('general_argument_invalid', 'Invalid `labels` param: Value must be a valid array and each element must be alphanumeric and no longer than 36 chars.')
    }
    ctx.auth.updateUser(path.userId!, { labels: JSON.stringify([...new Set(labels)]) })
    return done(ctx, path.userId!)
  })

  router.get('/users/:userId/prefs', ({ ctx, path }) => json(JSON.parse(user(ctx, path.userId!).prefs)))
  router.patch('/users/:userId/prefs', ({ ctx, path, params }) => {
    user(ctx, path.userId!)
    const prefs = prefsObject(params.prefs)
    ctx.auth.updateUser(path.userId!, { prefs: JSON.stringify(prefs) })
    return json(prefs)
  })

  router.get('/users/:userId/memberships', ({ ctx, path, params }) => {
    user(ctx, path.userId!)
    const { total, memberships } = ctx.teams.listMemberships({ userId: path.userId! }, list(params.queries), str(params.search), bool(params.total, true))
    return json({ total, memberships: memberships.map(membershipModel) })
  })

  router.get('/users/:userId/sessions', ({ ctx, path }) => {
    user(ctx, path.userId!)
    const sessions = ctx.auth.sessions(path.userId!).map((s) => sessionModel(s))
    return json({ total: sessions.length, sessions })
  })

  router.post('/users/:userId/sessions', (route) => {
    const { ctx, path } = route
    user(ctx, path.userId!)
    const { session, secret } = ctx.auth.createSession(path.userId!, { provider: 'server', factors: ['server'], info: requestInfo(route.request) })
    return json(sessionModel(session, { secret }), 201)
  })

  router.delete('/users/:userId/sessions', ({ ctx, path }) => {
    user(ctx, path.userId!)
    ctx.auth.deleteSessions(path.userId!)
    return noContent()
  })

  router.delete('/users/:userId/sessions/:sessionId', ({ ctx, path }) => {
    user(ctx, path.userId!)
    ctx.auth.deleteSession(path.userId!, path.sessionId!)
    return noContent()
  })

  router.post('/users/:userId/tokens', ({ ctx, path, params }) => {
    user(ctx, path.userId!)
    const { token, secret } = ctx.auth.createGenericToken(path.userId!, num(params.length, 6), num(params.expire, 900))
    return json(tokenModel(token, secret), 201)
  })

  router.post('/users/:userId/jwts', async ({ ctx, path, params }) => {
    user(ctx, path.userId!)
    let sessionId = str(params.sessionId) ?? ''
    if (!sessionId || sessionId === 'recent') sessionId = ctx.auth.sessions(path.userId!).at(-1)?.id ?? ''
    else if (ctx.auth.session(sessionId)?.user_id !== path.userId) throw err('user_session_not_found')
    return json(await jwtFor(ctx, path.userId!, sessionId, num(params.duration, 900)!), 201)
  })
}
