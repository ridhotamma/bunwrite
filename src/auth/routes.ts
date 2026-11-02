import type { AppContext } from '~/app'
import { sessionCookieName } from '~/lib/compat'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { bool, json, list, noContent, num, str } from '~/lib/http'
import { assertRedirect, withQuery } from '~/lib/origins'
import type { RouteContext, Router } from '~/lib/router'
import { signJwt } from './jwt'
import { callerHasScope } from './caller'
import { accountModel, membershipModel, sessionModel, tokenModel, userModel, type IdentityRow, type SessionRow, type UserRowFull } from './models'
import { verifyPassword } from './passwords'
import { otpCode, requestInfo, validEmail, validPhone, type TokenRowFull } from './service'
import { FailedAttempts, RateLimiter } from '~/lib/limits'
import type { AuthMethodId } from '~/settings/access'

/** Appwrite's abuse limit for public auth endpoints: `limit` per hour per IP and subject. API keys are exempt. */
async function limit(route: { ctx: AppContext; request: Request }, name: string, subject: unknown, max = 10): Promise<void> {
  if (route.ctx.caller.privileged) return
  await new RateLimiter(route.ctx.db).hit(`${name}:${requestInfo(route.request).ip}:${String(subject ?? '').toLowerCase()}`, max, 3600)
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
async function me(ctx: AppContext): Promise<UserRowFull> {
  if (!ctx.caller.user) missingScope(ctx, 'account')
  return ctx.auth.user(ctx.caller.user.id)
}

export function requireKey(ctx: AppContext, scope: string): void {
  if (!ctx.caller.privileged) missingScope(ctx, scope)
  if (!callerHasScope(ctx.caller, scope)) missingScope(ctx, scope)
}

/**
 * Enforce a scope for API-key callers only. Routes that users may also call
 * keep their normal permission checks; a key must still hold the scope.
 */
export function requireScope(ctx: AppContext, scope: string): void {
  if (ctx.caller.kind === 'key' && !callerHasScope(ctx.caller, scope)) missingScope(ctx, scope)
}

const cookieName = (ctx: AppContext, request: Request) => sessionCookieName(ctx.config, request, ctx.config.projectId)

/**
 * A new session. API keys get its secret in the body (the app stores it in its
 * own cookie); browsers get it as the session cookie instead: `bw_session_<project>`,
 * or `a_session_<project>` for a request made with Appwrite's headers.
 */
function sessionResponse(route: RouteContext<AppContext>, session: SessionRow, secret: string): Response {
  const { ctx } = route
  const country = requestInfo(route.request).country
  if (ctx.caller.privileged) return json(sessionModel(session, { secret, country }), 201)
  const secure = ctx.config.publicEndpoint.startsWith('https') ? '; Secure; SameSite=None' : '; SameSite=Lax'
  const cookie = `${cookieName(ctx, route.request)}=${encodeURIComponent(secret)}; Expires=${new Date(session.expire).toUTCString()}; Path=/; HttpOnly${secure}`
  return json(sessionModel(session, { current: true, country }), 201, {
    'set-cookie': cookie,
    'x-fallback-cookies': JSON.stringify({ [cookieName(ctx, route.request)]: secret }),
  })
}

/** Only callers without a session may create one (API keys always may). */
function assertNoSession(ctx: AppContext): void {
  if (!ctx.caller.privileged && ctx.caller.sessionId) throw err('user_session_already_exists')
}

async function sessionFromToken(route: RouteContext<AppContext>, user: UserRowFull, token: TokenRowFull): Promise<Response> {
  const { ctx } = route
  const info = requestInfo(route.request)
  const provider = token.type === 'oauth2' ? (token.provider ?? 'oauth2') : token.type === 'generic' ? 'token' : token.type
  const factors = token.type === 'email' || token.type === 'magic-url' ? ['email'] : token.type === 'oauth2' ? ['email', 'oauth2'] : ['token']
  const identity = token.type === 'oauth2' ? await ctx.oauth.identity(user.id, provider) : null
  await ctx.auth.deleteToken(token.id)
  if (token.type === 'email' || token.type === 'magic-url') await ctx.auth.updateUser(user.id, { email_verification: 1 })
  const { session, secret } = await ctx.auth.createSession(user.id, {
    provider,
    factors,
    info,
    providerUid: identity?.provider_uid ?? undefined,
    providerAccessToken: identity?.provider_access_token ?? undefined,
    providerRefreshToken: identity?.provider_refresh_token ?? undefined,
    providerAccessTokenExpiry: identity?.provider_access_token_expiry ?? undefined,
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
  router.get('/account', async ({ ctx }) => json(accountModel(await me(ctx))))

  router.post('/account', async (route) => {
    const { ctx, params } = route
    requireScope(ctx, 'users.write')
    assertNoSession(ctx)
    method(ctx, 'email-password')
    await limit(route, 'account-create', '')
    await ctx.access.assertUserLimit()
    ctx.access.assertPasswordPersonalData(params.password, { id: params.userId, name: params.name, email: params.email })
    const user = await ctx.auth.createUser({ id: params.userId, email: params.email, password: params.password ?? '', name: params.name })
    return json(accountModel(user), 201)
  })

  router.patch('/account/name', async ({ ctx, params }) => {
    const user = await me(ctx)
    return json(accountModel(await ctx.auth.updateUser(user.id, { name: String(params.name ?? '').slice(0, 128) })))
  })

  router.patch('/account/password', async ({ ctx, params }) => {
    const user = await me(ctx)
    if (user.password && !(await verifyPassword(String(params.oldPassword ?? ''), user.password, user.hash, JSON.parse(user.hash_options)))) {
      throw err('user_invalid_credentials')
    }
    ctx.access.assertPasswordPersonalData(params.password, user)
    const saved = await ctx.auth.setPassword(user.id, params.password)
    // A stolen session or JWT must not survive the owner changing the password.
    await ctx.auth.revokeSessions(user.id, ctx.caller.sessionId)
    return json(accountModel(saved))
  })

  router.patch('/account/email', async ({ ctx, params }) => {
    const user = await me(ctx)
    if (user.password && !(await verifyPassword(String(params.password ?? ''), user.password, user.hash, JSON.parse(user.hash_options)))) {
      throw err('user_invalid_credentials')
    }
    return json(accountModel(await ctx.auth.updateUser(user.id, { email: validEmail(params.email), email_verification: 0 })))
  })

  router.get('/account/prefs', async ({ ctx }) => json(JSON.parse((await me(ctx)).prefs)))
  router.patch('/account/prefs', async ({ ctx, params }) => {
    const user = await me(ctx)
    return json(accountModel(await ctx.auth.updateUser(user.id, { prefs: JSON.stringify(prefsObject(params.prefs)) })))
  })

  router.patch('/account/status', async ({ ctx }) => {
    const user = await me(ctx)
    const updated = await ctx.auth.updateUser(user.id, { status: 0 })
    await ctx.auth.deleteSessions(user.id)
    return json(accountModel(updated))
  })

  router.get('/account/sessions', async ({ ctx }) => {
    const user = await me(ctx)
    const sessions = (await ctx.auth.sessions(user.id)).map((s) => sessionModel(s, { current: s.id === ctx.caller.sessionId }))
    return json({ total: sessions.length, sessions })
  })

  router.delete('/account/sessions', async ({ ctx }) => {
    await ctx.auth.deleteSessions((await me(ctx)).id)
    return noContent()
  })

  const sessionIdOf = (ctx: AppContext, id: string) => (id === 'current' ? (ctx.caller.sessionId ?? '') : id)

  router.get('/account/sessions/:sessionId', async ({ ctx, path }) => {
    const user = await me(ctx)
    const id = sessionIdOf(ctx, path.sessionId!)
    const session = await ctx.auth.session(id)
    if (!session || session.user_id !== user.id) throw err('user_session_not_found')
    return json(sessionModel(session, { current: id === ctx.caller.sessionId }))
  })

  router.patch('/account/sessions/:sessionId', async ({ ctx, path }) => {
    const user = await me(ctx)
    const id = sessionIdOf(ctx, path.sessionId!)
    const session = await ctx.auth.session(id)
    if (!session || session.user_id !== user.id) throw err('user_session_not_found')
    return json(sessionModel(session, { current: id === ctx.caller.sessionId }))
  })

  router.delete('/account/sessions/:sessionId', async ({ ctx, path, request }) => {
    const user = await me(ctx)
    const id = sessionIdOf(ctx, path.sessionId!)
    await ctx.auth.deleteSession(user.id, id)
    const headers = id === ctx.caller.sessionId ? { 'set-cookie': `${cookieName(ctx, request)}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly` } : {}
    return new Response(null, { status: 204, headers })
  })

  router.post('/account/sessions/email', async (route) => {
    const { ctx, params } = route
    requireScope(ctx, 'users.write')
    assertNoSession(ctx)
    method(ctx, 'email-password')
    await limit(route, 'sessions-email', params.email)
    const email = typeof params.email === 'string' ? params.email.toLowerCase() : ''
    const user = email ? await ctx.auth.userByEmail(email) : null
    const ok = user && (await verifyPassword(String(params.password ?? ''), user.password, user.hash, JSON.parse(user.hash_options)))
    if (!user || !ok) throw err('user_invalid_credentials')
    if (!user.status) throw err('user_blocked')
    const { session, secret } = await ctx.auth.createSession(user.id, { provider: 'email', factors: ['password'], info: requestInfo(route.request) })
    return sessionResponse(route, session, secret)
  })

  // Exchange any login token (email code, OAuth, users.createToken) for a session.
  router.post('/account/sessions/token', async (route) => {
    const { ctx, params } = route
    requireScope(ctx, 'users.write')
    assertNoSession(ctx)
    const userId = str(params.userId) ?? ''
    await limit(route, 'sessions-token', userId)
    const user = await ctx.auth.findUser(userId)
    if (!user) throw err('user_invalid_token')
    const failures = new FailedAttempts(ctx.db)
    let token: TokenRowFull
    try {
      token = await ctx.auth.verifyToken(userId, params.secret, ['email', 'magic-url', 'oauth2', 'generic'])
    } catch (error) {
      // A 6-digit code must not be guessable: ten wrong tries burn every outstanding code.
      if (await failures.fail(userId)) {
        await ctx.db.driver.run("DELETE FROM _tokens WHERE user_id = ? AND type IN ('email', 'magic-url')", [userId])
        await failures.clear(userId)
      }
      throw error
    }
    await failures.clear(userId)
    if (!user.status) throw err('user_blocked')
    return sessionFromToken(route, user, token)
  })

  router.post('/account/tokens/email', async (route) => {
    const { ctx, params } = route
    requireScope(ctx, 'users.write')
    method(ctx, 'email-otp')
    await limit(route, 'tokens-email', params.email)
    if (!ctx.mailer.enabled) throw err('general_smtp_disabled', 'SMTP disabled')
    const email = validEmail(params.email)
    const user = (await ctx.auth.userByEmail(email)) ?? (await ctx.auth.createUser({ id: params.userId, email }))
    if (!user.status) throw err('user_blocked')
    const code = otpCode()
    const phrase = bool(params.phrase, false) ? `${pick(ADJECTIVES)} ${pick(NOUNS)}` : ''
    const { token } = await ctx.auth.createToken(user.id, 'email', { secret: code, ttl: OTP_TTL })
    await ctx.mailer.send(ctx.templates.render('otpSession', email, { user: user.name || email, otp: code, phrase }))
    return json(tokenModel(token, ctx.caller.privileged ? code : '', phrase), 201)
  })

  router.get('/account/tokens/oauth2/:provider', async ({ ctx, params, path }) => {
    const location = await ctx.oauth.authorizeUrl(path.provider!, params.success, params.failure, params.scopes)
    return new Response(null, { status: 301, headers: { location, 'cache-control': 'no-store' } })
  })

  const oauthCallback = async ({ ctx, params, path }: RouteContext<AppContext>) => {
    if (path.projectId !== ctx.config.projectId) throw err('project_not_found')
    const location = await ctx.oauth.callback(path.provider!, params)
    return new Response(null, { status: 301, headers: { location, 'cache-control': 'no-store' } })
  }

  router.get('/account/sessions/oauth2/callback/:provider/:projectId', oauthCallback)
  // Apple posts the callback (response_mode=form_post); the state is signed either way.
  router.post('/account/sessions/oauth2/callback/:provider/:projectId', oauthCallback)

  router.post('/account/jwts', async ({ ctx, params }) => {
    method(ctx, 'jwt')
    const user = await me(ctx)
    return json(await jwtFor(ctx, user.id, ctx.caller.sessionId ?? '', num(params.duration, 900)!), 201)
  })

  router.post('/account/recovery', async (route) => {
    const { ctx, params } = route
    requireScope(ctx, 'users.write')
    await limit(route, 'recovery', params.email)
    const email = validEmail(params.email)
    const url = assertRedirect(params.url, ctx.sites.allowedOrigins(), 'url')
    if (!ctx.mailer.enabled) throw err('general_smtp_disabled', 'SMTP Disabled')
    const user = await ctx.auth.userByEmail(email)
    if (!user) throw err('user_not_found')
    if (!user.status) throw err('user_blocked')
    const { token, secret } = await ctx.auth.createToken(user.id, 'recovery', { ttl: RECOVERY_TTL })
    const link = withQuery(url, { userId: user.id, secret, expire: token.expire })
    await ctx.mailer.send(ctx.templates.render('recovery', email, { user: user.name || email, redirect: link }))
    return json(tokenModel(token, ctx.caller.privileged ? secret : ''), 201)
  })

  router.put('/account/recovery', async (route) => {
    const { ctx, params } = route
    requireScope(ctx, 'users.write')
    await limit(route, 'recovery-update', params.userId)
    const user = await ctx.auth.findUser(str(params.userId) ?? '')
    if (!user) throw err('user_not_found')
    const token = await ctx.auth.verifyToken(user.id, params.secret, ['recovery'])
    ctx.access.assertPasswordPersonalData(params.password, user)
    await ctx.auth.setPassword(user.id, params.password)
    // Recovery means the old password may be compromised: end every session.
    await ctx.auth.revokeSessions(user.id)
    await ctx.auth.updateUser(user.id, { email_verification: 1 })
    await ctx.auth.deleteToken(token.id)
    return json(tokenModel(token))
  })

  router.post('/account/verifications/email', async ({ ctx, params }) => {
    const user = await me(ctx)
    const url = assertRedirect(params.url, ctx.sites.allowedOrigins(), 'url')
    if (!ctx.mailer.enabled) throw err('general_smtp_disabled', 'SMTP Disabled')
    if (!user.email) throw err('user_email_not_found')
    const { token, secret } = await ctx.auth.createToken(user.id, 'verification', { ttl: VERIFICATION_TTL })
    const link = withQuery(url, { userId: user.id, secret, expire: token.expire })
    await ctx.mailer.send(ctx.templates.render('verification', user.email, { user: user.name || user.email, redirect: link }))
    return json(tokenModel(token), 201)
  })

  router.put('/account/verifications/email', async ({ ctx, params }) => {
    const user = await ctx.auth.findUser(str(params.userId) ?? '')
    if (!user) throw err('user_not_found')
    const token = await ctx.auth.verifyToken(user.id, params.secret, ['verification'])
    await ctx.auth.updateUser(user.id, { email_verification: 1 })
    await ctx.auth.deleteToken(token.id)
    return json(tokenModel(token))
  })
}

export function userRoutes(router: Router<AppContext>): void {
  const user = async (ctx: AppContext, id: string) => {
    requireKey(ctx, 'users.read')
    return ctx.auth.user(id)
  }
  const done = async (ctx: AppContext, id: string) => json(userModel(await ctx.auth.user(id)))
  /** Mutating user routes need `users.write`, not only `users.read`. */
  const writable = async (ctx: AppContext, id: string) => {
    requireKey(ctx, 'users.write')
    return ctx.auth.user(id)
  }

  // Linked OAuth accounts. Registered before /users/:userId so "identities" is not taken as an ID.
  router.get('/users/identities', async ({ ctx, params }) => {
    requireKey(ctx, 'users.read')
    let limit = 25
    let offset = 0
    let after = 0
    for (const raw of list(params.queries)) {
      const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
      const query = parsed && typeof parsed === 'object' ? (parsed as { method?: unknown; values?: unknown[] }) : null
      if (query?.method === 'limit') limit = Number(query.values?.[0] ?? 25)
      if (query?.method === 'offset') offset = Number(query.values?.[0] ?? 0)
      if (query?.method === 'cursorAfter') {
        const row = await ctx.db.driver.get<{ seq: number }>('SELECT seq FROM _identities WHERE id = ?', [String(query.values?.[0])])
        after = row?.seq ?? 0
      }
    }
    const rows = await ctx.db.driver.all<IdentityRow>('SELECT * FROM _identities WHERE seq > ? ORDER BY seq LIMIT ? OFFSET ?', [after, limit, offset])
    const total = Number((await ctx.db.driver.get<{ n: number }>('SELECT count(*) AS n FROM _identities'))?.n ?? 0)
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

  router.get('/users', async ({ ctx, params }) => {
    requireKey(ctx, 'users.read')
    const { total, users } = await ctx.auth.listUsers(list(params.queries), str(params.search), bool(params.total, true))
    return json({ total, users: users.map(userModel) })
  })

  router.post('/users', async ({ ctx, params }) => {
    requireKey(ctx, 'users.write')
    ctx.access.assertPasswordPersonalData(params.password, { id: params.userId, name: params.name, email: params.email, phone: params.phone })
    const created = await ctx.auth.createUser({ id: params.userId, email: params.email, phone: params.phone, password: params.password, name: params.name })
    return json(userModel(created), 201)
  })

  router.get('/users/:userId', async ({ ctx, path }) => json(userModel(await user(ctx, path.userId!))))

  router.delete('/users/:userId', async ({ ctx, path }) => {
    requireKey(ctx, 'users.write')
    await ctx.auth.deleteUser(path.userId!)
    return noContent()
  })

  router.patch('/users/:userId/name', async ({ ctx, path, params }) => {
    await writable(ctx, path.userId!)
    await ctx.auth.updateUser(path.userId!, { name: String(params.name ?? '').slice(0, 128) })
    return done(ctx, path.userId!)
  })

  router.patch('/users/:userId/email', async ({ ctx, path, params }) => {
    await writable(ctx, path.userId!)
    const email = params.email === '' ? null : validEmail(params.email)
    await ctx.auth.updateUser(path.userId!, { email, email_verification: 0 })
    return done(ctx, path.userId!)
  })

  router.patch('/users/:userId/phone', async ({ ctx, path, params }) => {
    await writable(ctx, path.userId!)
    const phone = params.number === '' ? null : validPhone(params.number)
    await ctx.auth.updateUser(path.userId!, { phone, phone_verification: 0 })
    return done(ctx, path.userId!)
  })

  router.patch('/users/:userId/password', async ({ ctx, path, params }) => {
    const target = await writable(ctx, path.userId!)
    if (params.password !== '') ctx.access.assertPasswordPersonalData(params.password, target)
    if (params.password === '') await ctx.auth.updateUser(path.userId!, { password: null, password_update: now() })
    else await ctx.auth.setPassword(path.userId!, params.password)
    return done(ctx, path.userId!)
  })

  router.patch('/users/:userId/status', async ({ ctx, path, params }) => {
    await writable(ctx, path.userId!)
    await ctx.auth.updateUser(path.userId!, { status: bool(params.status, true) ? 1 : 0 })
    return done(ctx, path.userId!)
  })

  router.patch('/users/:userId/verification', async ({ ctx, path, params }) => {
    await writable(ctx, path.userId!)
    await ctx.auth.updateUser(path.userId!, { email_verification: bool(params.emailVerification, false) ? 1 : 0 })
    return done(ctx, path.userId!)
  })

  router.patch('/users/:userId/verification/phone', async ({ ctx, path, params }) => {
    await writable(ctx, path.userId!)
    await ctx.auth.updateUser(path.userId!, { phone_verification: bool(params.phoneVerification, false) ? 1 : 0 })
    return done(ctx, path.userId!)
  })

  router.put('/users/:userId/labels', async ({ ctx, path, params }) => {
    await writable(ctx, path.userId!)
    const labels = list(params.labels)
    if (labels.length > 1000 || labels.some((l) => typeof l !== 'string' || !/^[a-zA-Z0-9]{1,36}$/.test(l))) {
      throw err(
        'general_argument_invalid',
        'Invalid `labels` param: Value must be a valid array and each element must be alphanumeric and no longer than 36 chars.',
      )
    }
    await ctx.auth.updateUser(path.userId!, { labels: JSON.stringify([...new Set(labels)]) })
    return done(ctx, path.userId!)
  })

  router.get('/users/:userId/prefs', async ({ ctx, path }) => json(JSON.parse((await user(ctx, path.userId!)).prefs)))
  router.patch('/users/:userId/prefs', async ({ ctx, path, params }) => {
    await writable(ctx, path.userId!)
    const prefs = prefsObject(params.prefs)
    await ctx.auth.updateUser(path.userId!, { prefs: JSON.stringify(prefs) })
    return json(prefs)
  })

  router.get('/users/:userId/memberships', async ({ ctx, path, params }) => {
    await user(ctx, path.userId!)
    const { total, memberships } = await ctx.teams.listMemberships({ userId: path.userId! }, list(params.queries), str(params.search), bool(params.total, true))
    return json({ total, memberships: memberships.map(membershipModel) })
  })

  router.get('/users/:userId/sessions', async ({ ctx, path }) => {
    await user(ctx, path.userId!)
    const sessions = (await ctx.auth.sessions(path.userId!)).map((s) => sessionModel(s))
    return json({ total: sessions.length, sessions })
  })

  router.post('/users/:userId/sessions', async (route) => {
    const { ctx, path } = route
    await writable(ctx, path.userId!)
    const { session, secret } = await ctx.auth.createSession(path.userId!, { provider: 'server', factors: ['server'], info: requestInfo(route.request) })
    return json(sessionModel(session, { secret }), 201)
  })

  router.delete('/users/:userId/sessions', async ({ ctx, path }) => {
    await writable(ctx, path.userId!)
    await ctx.auth.deleteSessions(path.userId!)
    return noContent()
  })

  router.delete('/users/:userId/sessions/:sessionId', async ({ ctx, path }) => {
    await writable(ctx, path.userId!)
    await ctx.auth.deleteSession(path.userId!, path.sessionId!)
    return noContent()
  })

  router.post('/users/:userId/tokens', async ({ ctx, path, params }) => {
    await writable(ctx, path.userId!)
    const { token, secret } = await ctx.auth.createGenericToken(path.userId!, num(params.length, 6), num(params.expire, 900))
    return json(tokenModel(token, secret), 201)
  })

  router.post('/users/:userId/jwts', async ({ ctx, path, params }) => {
    await writable(ctx, path.userId!)
    let sessionId = str(params.sessionId) ?? ''
    if (!sessionId || sessionId === 'recent') sessionId = (await ctx.auth.sessions(path.userId!)).at(-1)?.id ?? ''
    else if ((await ctx.auth.session(sessionId))?.user_id !== path.userId) throw err('user_session_not_found')
    return json(await jwtFor(ctx, path.userId!, sessionId, num(params.duration, 900)!), 201)
  })
}
