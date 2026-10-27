/**
 * Who is making a request, and which Appwrite roles that gives them.
 *
 * - API key: privileged, bypasses every permission check.
 * - Session (header, cookie or fallback cookie) or JWT: a user, with
 *   `any`, `users`, `user:ID`, verified variants, team and label roles.
 * - Nothing: a guest, with `any` and `guests`.
 */
import type { Db } from '../db/connection'
import { now } from '../lib/datetime'
import { err } from '../lib/errors'
import { sha256 } from '../lib/ids'
import type { Config } from '../config'
import { verifyJwt } from './jwt'
import { apiKeyValid } from '../settings/service'

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
}

export function guestCaller(): Caller {
  return { kind: 'guest', privileged: false, user: null, sessionId: null, roles: new Set(['any', 'guests']) }
}

export function keyCaller(): Caller {
  return { kind: 'key', privileged: true, user: null, sessionId: null, roles: new Set(['any']) }
}

export function rolesForUser(db: Db, user: UserRow): Set<string> {
  const verified = Boolean(user.email_verification) || Boolean(user.phone_verification)
  const dimension = verified ? 'verified' : 'unverified'
  const roles = new Set<string>(['any', 'users', `users/${dimension}`, `user:${user.id}`, `user:${user.id}/${dimension}`])
  const memberships = db.sqlite
    .query<{ id: string; team_id: string; roles: string }, [string]>(
      'SELECT id, team_id, roles FROM _memberships WHERE user_id = ? AND confirm = 1',
    )
    .all(user.id)
  for (const m of memberships) {
    roles.add(`team:${m.team_id}`)
    roles.add(`member:${m.id}`)
    for (const r of JSON.parse(m.roles) as string[]) roles.add(`team:${m.team_id}/${r}`)
  }
  for (const label of JSON.parse(user.labels || '[]') as string[]) roles.add(`label:${label}`)
  return roles
}

export function userCaller(db: Db, user: UserRow, sessionId: string | null): Caller {
  return { kind: 'user', privileged: false, user, sessionId, roles: rolesForUser(db, user) }
}

/** Read the session secret from the header, the `a_session_<project>` cookie, or X-Fallback-Cookies. */
export function sessionSecret(request: Request, projectId: string): string | null {
  const header = request.headers.get('x-appwrite-session')
  if (header) return header
  const name = `a_session_${projectId.toLowerCase()}`
  const cookies = parseCookies(request.headers.get('cookie') ?? '')
  if (cookies[name]) return cookies[name]!
  const fallback = request.headers.get('x-fallback-cookies')
  if (fallback) {
    try {
      const parsed = JSON.parse(fallback) as Record<string, string>
      if (parsed[name]) return parsed[name]!
    } catch {
      /* ignore malformed fallback cookies */
    }
  }
  return null
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

export function findSessionUser(db: Db, secret: string): { user: UserRow; sessionId: string } | null {
  const row = db.sqlite
    .query<any, [string, string]>(
      `SELECT s.id AS session_id, u.* FROM _sessions s JOIN _users u ON u.id = s.user_id
       WHERE s.secret_hash = ? AND s.expire > ?`,
    )
    .get(sha256(secret), now())
  if (!row) return null
  const { session_id, ...user } = row
  return { user: user as UserRow, sessionId: session_id }
}

function findUser(db: Db, id: string): UserRow | null {
  return db.sqlite.query<any, [string]>('SELECT * FROM _users WHERE id = ?').get(id) ?? null
}

/** A user from a JWT; its session (when it names one) must still be live. */
export async function jwtCaller(db: Db, config: Config, jwt: string): Promise<Caller | null> {
  const claims = await verifyJwt(jwt, config.secret)
  if (!claims) return null
  if (claims.sessionId) {
    const session = db.sqlite
      .query<any, [string, string, string]>('SELECT id FROM _sessions WHERE id = ? AND user_id = ? AND expire > ?')
      .get(claims.sessionId, claims.userId, now())
    if (!session) return null
  }
  const user = findUser(db, claims.userId)
  if (!user) return null
  if (!user.status) throw err('user_blocked')
  return userCaller(db, user, claims.sessionId || null)
}

export async function resolveCaller(db: Db, config: Config, request: Request): Promise<Caller> {
  const key = request.headers.get('x-appwrite-key')
  if (key) {
    if (!apiKeyValid(db, config, key)) throw err('general_unauthorized_scope', 'Invalid API key.')
    return keyCaller()
  }

  // A JWT in the query string is accepted for the realtime socket only, as on Appwrite.
  const url = new URL(request.url)
  const jwt = request.headers.get('x-appwrite-jwt') ?? (url.pathname.endsWith('/realtime') ? url.searchParams.get('jwt') : null)
  if (jwt) {
    const caller = await jwtCaller(db, config, jwt)
    if (!caller) throw err('user_jwt_invalid')
    return caller
  }

  const secret = sessionSecret(request, config.projectId)
  if (secret) {
    const found = findSessionUser(db, secret)
    // An unknown or expired session is treated as a guest, like Appwrite.
    if (found) {
      if (!found.user.status) throw err('user_blocked')
      return userCaller(db, found.user, found.sessionId)
    }
  }
  return guestCaller()
}
