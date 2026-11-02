/**
 * Who is making a request, and which Appwrite roles that gives them.
 *
 * - API key: privileged, bypasses every permission check.
 * - Session (header, cookie or fallback cookie) or JWT: a user, with
 *   `any`, `users`, `user:ID`, verified variants, team and label roles.
 * - Nothing: a guest, with `any` and `guests`.
 *
 * Lookups go through the database port, so the same code runs on SQLite and
 * Postgres. The session/role cache keeps the per-request cost at one query for
 * the first request in each 30-second window.
 */
import type { VersionMonitor } from '~/cluster/versions'
import type { SqlDatabase } from '~/db/driver'
import { apiHeader, sessionFromCookies } from '~/lib/compat'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { sha256 } from '~/lib/ids'
import type { Config } from '~/config'
import { verifyJwt } from './jwt'
import { resolveApiKey } from '~/settings/service'

export interface UserRow {
  seq: number
  id: string
  name: string
  email: string | null
  phone: string | null
  status: number | boolean
  labels: string
  email_verification: number | boolean
  phone_verification: number | boolean
  [key: string]: unknown
}

export interface Caller {
  kind: 'key' | 'user' | 'guest'
  privileged: boolean
  user: UserRow | null
  sessionId: string | null
  roles: Set<string>
  /** API-key scopes; null means every scope (env keys, console admins, internal calls). */
  scopes: Set<string> | null
}

export function guestCaller(): Caller {
  return { kind: 'guest', privileged: false, user: null, sessionId: null, roles: new Set(['any', 'guests']), scopes: null }
}

export function keyCaller(scopes: string[] | null = null): Caller {
  return { kind: 'key', privileged: true, user: null, sessionId: null, roles: new Set(['any']), scopes: scopes ? new Set(scopes) : null }
}

/** Whether a caller may use a scope. Non-key callers are handled by their own permission checks. */
export function callerHasScope(caller: Caller, scope: string): boolean {
  return caller.scopes === null || caller.scopes.has(scope)
}

/** Refuse a scoped API key that lacks `scope`; users and guests keep their own checks. */
export function assertCallerScope(caller: Caller, scope: string): void {
  if (caller.kind !== 'key' || callerHasScope(caller, scope)) return
  throw err('general_unauthorized_scope', `User (role: applications) missing scopes (["${scope}"])`)
}

export async function rolesForUser(db: SqlDatabase, user: UserRow): Promise<Set<string>> {
  const verified = Boolean(user.email_verification) || Boolean(user.phone_verification)
  const dimension = verified ? 'verified' : 'unverified'
  const roles = new Set<string>(['any', 'users', `users/${dimension}`, `user:${user.id}`, `user:${user.id}/${dimension}`])
  const memberships = await db.driver.all<{ id: string; team_id: string; roles: string }>(
    'SELECT id, team_id, roles FROM _memberships WHERE user_id = ? AND confirm = 1',
    [user.id],
  )
  for (const m of memberships) {
    roles.add(`team:${m.team_id}`)
    roles.add(`member:${m.id}`)
    for (const r of JSON.parse(m.roles) as string[]) roles.add(`team:${m.team_id}/${r}`)
  }
  for (const label of JSON.parse(user.labels || '[]') as string[]) roles.add(`label:${label}`)
  return roles
}

export async function userCaller(db: SqlDatabase, user: UserRow, sessionId: string | null): Promise<Caller> {
  return { kind: 'user', privileged: false, user, sessionId, roles: await rolesForUser(db, user), scopes: null }
}

/** Read the session secret from the session header, the project's session cookie, or X-Fallback-Cookies (either naming). */
export function sessionSecret(request: Request, projectId: string): string | null {
  const header = apiHeader(request, 'session')
  if (header) return header
  return sessionFromCookies(parseCookies(request.headers.get('cookie') ?? ''), request.headers.get('x-fallback-cookies'), projectId)
}

export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const key = part.slice(0, i).trim()
    const value = part.slice(i + 1).trim()
    try {
      out[key] = decodeURIComponent(value)
    } catch {
      out[key] = value
    }
  }
  return out
}

export async function findSessionUser(db: SqlDatabase, secret: string, authVersion?: number): Promise<{ user: UserRow; sessionId: string } | null> {
  const found = await cachedSession(db, secret, authVersion)
  return found ? { user: found.user, sessionId: found.sessionId } : null
}

const SESSION_TTL_MS = 30_000
const SESSION_CACHE_MAX = 10_000

interface CachedSession {
  user: UserRow
  sessionId: string
  expire: string
  roles: string[]
  at: number
}

interface SessionCache {
  version: number
  entries: Map<string, CachedSession>
}

/**
 * One cache per database connection (one per project runtime). The first
 * request reads the session and its roles; later requests in the next 30
 * seconds use the cache. `_meta.auth` is bumped by triggers on sessions, users,
 * memberships and teams, so a logout, block, label change or team change is
 * visible in every worker on the next request, not after the TTL.
 */
const sessionCaches = new WeakMap<object, SessionCache>()

/** Fallback for callers without a VersionMonitor, such as tests and the realtime hub. */
async function readAuthVersion(db: SqlDatabase): Promise<number> {
  try {
    const row = await db.driver.get<{ value: number }>('SELECT value FROM _meta WHERE key = ?', ['auth'])
    return Number(row?.value ?? 0)
  } catch {
    return 0
  }
}

async function sessionCache(db: SqlDatabase, version?: number): Promise<SessionCache> {
  const resolved = version ?? (await readAuthVersion(db))
  let cache = sessionCaches.get(db.driver)
  if (!cache) {
    cache = { version: resolved, entries: new Map() }
    sessionCaches.set(db.driver, cache)
  }
  if (cache.version !== resolved) {
    cache.entries.clear()
    cache.version = resolved
  }
  return cache
}

async function cachedSession(db: SqlDatabase, secret: string, authVersion?: number): Promise<CachedSession | null> {
  const hash = sha256(secret)
  const cache = await sessionCache(db, authVersion)
  const hit = cache.entries.get(hash)
  if (hit && hit.expire > now() && Date.now() - hit.at < SESSION_TTL_MS) return hit

  const row = await db.driver.get<UserRow & { session_id: string; session_expire: string }>(
    `SELECT s.id AS session_id, s.expire AS session_expire, u.* FROM _sessions s JOIN _users u ON u.id = s.user_id
     WHERE s.secret_hash = ? AND s.expire > ?`,
    [hash, now()],
  )
  if (!row) {
    cache.entries.delete(hash)
    return null
  }
  const { session_id, session_expire, ...user } = row
  const entry: CachedSession = {
    user: user as UserRow,
    sessionId: row.session_id,
    expire: row.session_expire,
    roles: [...(await rolesForUser(db, user as UserRow))],
    at: Date.now(),
  }
  if (cache.entries.size >= SESSION_CACHE_MAX) cache.entries.clear()
  cache.entries.set(hash, entry)
  return entry
}

/** A session as a caller, including the roles computed when the session was cached. */
export async function sessionCaller(db: SqlDatabase, secret: string, authVersion?: number): Promise<Caller | null> {
  const found = await cachedSession(db, secret, authVersion)
  if (!found) return null
  // Blocked users keep their session rows; every authentication path must
  // still refuse them (including realtime re-authentication).
  if (!found.user.status) return null
  return { kind: 'user', privileged: false, user: found.user, sessionId: found.sessionId, roles: new Set(found.roles), scopes: null }
}

async function findUser(db: SqlDatabase, id: string): Promise<UserRow | null> {
  return db.driver.get<UserRow>('SELECT * FROM _users WHERE id = ?', [id])
}

/** A user from a JWT; its session (when it names one) must still be live. */
export async function jwtCaller(db: SqlDatabase, config: Config, jwt: string): Promise<Caller | null> {
  const claims = await verifyJwt(jwt, config.secret)
  if (!claims) return null
  if (claims.sessionId) {
    const session = await db.driver.get<{ id: string }>('SELECT id FROM _sessions WHERE id = ? AND user_id = ? AND expire > ?', [
      claims.sessionId,
      claims.userId,
      now(),
    ])
    if (!session) return null
  }
  const user = await findUser(db, claims.userId)
  if (!user) return null
  if (!user.status) throw err('user_blocked')
  return userCaller(db, user, claims.sessionId || null)
}

export async function resolveCaller(db: SqlDatabase, config: Config, request: Request, versions?: VersionMonitor): Promise<Caller> {
  const key = apiHeader(request, 'key')
  if (key) {
    const identity = await resolveApiKey(db, config, key, versions)
    if (!identity) throw err('general_unauthorized_scope', 'Invalid API key.')
    return keyCaller(identity.scopes)
  }

  // A JWT in the query string is accepted for the realtime socket only, as on Appwrite.
  const url = new URL(request.url)
  const jwt = apiHeader(request, 'jwt') ?? (url.pathname.endsWith('/realtime') ? url.searchParams.get('jwt') : null)
  if (jwt) {
    const caller = await jwtCaller(db, config, jwt)
    if (!caller) throw err('user_jwt_invalid')
    return caller
  }

  const secret = sessionSecret(request, config.projectId)
  if (secret) {
    const caller = await sessionCaller(db, secret, versions?.authVersion())
    // An unknown or expired session is treated as a guest, like Appwrite.
    if (caller) {
      if (!caller.user!.status) throw err('user_blocked')
      return caller
    }
  }
  return guestCaller()
}
