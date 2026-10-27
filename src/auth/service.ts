/**
 * Users, sessions and tokens. Secrets are random and only their sha256 is
 * stored, so a copy of the database cannot be used to sign in.
 */
import type { Config } from '../config'
import type { Db } from '../db/connection'
import type { DocumentStore } from '../documents/store'
import { addSeconds, now } from '../lib/datetime'
import { err } from '../lib/errors'
import { randomSecret, resolveId, sha256, uniqueId } from '../lib/ids'
import { listSeqs, USERS, type ListOptions } from '../system/list'
import type { SessionRow, TokenRow, UserRowFull } from './models'
import { appwriteHashOptions, hashPassword, validatePassword } from './passwords'

export interface RequestInfo {
  ip: string
  userAgent: string
  country?: string
}

export type TokenType = 'email' | 'recovery' | 'verification' | 'magic-url' | 'oauth2' | 'generic' | 'invite'

export interface TokenRowFull extends TokenRow {
  seq: number
  type: TokenType
  provider: string | null
  secret_hash: string
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE = /^\+[1-9]\d{6,14}$/

export function requestInfo(request: Request): RequestInfo {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return {
    ip: request.headers.get('cf-connecting-ip') ?? forwarded ?? request.headers.get('x-real-ip') ?? '',
    userAgent: request.headers.get('x-forwarded-user-agent') ?? request.headers.get('user-agent') ?? '',
    country: request.headers.get('cf-ipcountry')?.toLowerCase() || undefined,
  }
}

export function validEmail(email: unknown, param = 'email'): string {
  if (typeof email !== 'string' || !EMAIL.test(email) || email.length > 320) {
    throw err('general_argument_invalid', `Invalid \`${param}\` param: Value must be a valid email address`)
  }
  return email.toLowerCase()
}

export function validPhone(phone: unknown, param = 'number'): string {
  if (typeof phone !== 'string' || !PHONE.test(phone)) {
    throw err(
      'general_argument_invalid',
      `Invalid \`${param}\` param: Phone number must start with a '+' can have a maximum of fifteen digits.`,
    )
  }
  return phone
}

/** Random string of `length` chars from [a-z0-9], for generic tokens. */
function randomCode(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

export function otpCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000
  return n.toString().padStart(6, '0')
}

export class AuthService {
  constructor(
    private db: Db,
    private config: Config,
    private store: DocumentStore,
  ) {}

  private get sql() {
    return this.db.sqlite
  }

  // ------------------------------------------------------------ users

  findUser(id: string): UserRowFull | null {
    return this.sql.query<UserRowFull, [string]>('SELECT * FROM _users WHERE id = ?').get(id) ?? null
  }

  user(id: string): UserRowFull {
    const user = this.findUser(id)
    if (!user) throw err('user_not_found')
    return user
  }

  userByEmail(email: string): UserRowFull | null {
    return this.sql.query<UserRowFull, [string]>('SELECT * FROM _users WHERE email = ?').get(email.toLowerCase()) ?? null
  }

  async createUser(input: {
    id?: unknown
    email?: unknown
    phone?: unknown
    password?: unknown
    name?: unknown
    emailVerification?: boolean
  }): Promise<UserRowFull> {
    const id = resolveId(input.id ?? 'unique()', 'User ID')
    const email = input.email ? validEmail(input.email) : null
    const phone = input.phone ? validPhone(input.phone, 'phone') : null
    const password = input.password !== undefined && input.password !== null && input.password !== '' ? await hashPassword(validatePassword(input.password)) : null
    const name = typeof input.name === 'string' ? input.name.slice(0, 128) : ''
    const stamp = now()
    try {
      this.sql
        .query(
          `INSERT INTO _users (id, name, email, phone, password, hash, hash_options, registration, password_update, email_verification, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'argon2', ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, name, email, phone, password, JSON.stringify(appwriteHashOptions()), stamp, password ? stamp : null, input.emailVerification ? 1 : 0, stamp, stamp)
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) throw err('user_already_exists')
      throw error
    }
    return this.user(id)
  }

  /** Update user columns; maps unique clashes to Appwrite's errors. */
  updateUser(id: string, fields: Record<string, string | number | null>): UserRowFull {
    this.user(id)
    const keys = Object.keys(fields)
    if (keys.length) {
      try {
        this.sql
          .query(`UPDATE _users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...keys.map((k) => fields[k]!), now(), id)
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE')) {
          if (error.message.includes('_users.email')) throw err('user_email_already_exists')
          if (error.message.includes('_users.phone')) throw err('user_phone_already_exists')
          throw err('user_already_exists')
        }
        throw error
      }
    }
    return this.user(id)
  }

  async setPassword(id: string, password: unknown): Promise<UserRowFull> {
    const hash = await hashPassword(validatePassword(password))
    return this.updateUser(id, { password: hash, hash: 'argon2', hash_options: JSON.stringify(appwriteHashOptions()), password_update: now() })
  }

  deleteUser(id: string): void {
    this.user(id)
    this.sql.transaction(() => {
      this.sql.query('DELETE FROM _sessions WHERE user_id = ?').run(id)
      this.sql.query('DELETE FROM _tokens WHERE user_id = ?').run(id)
      this.sql.query('DELETE FROM _memberships WHERE user_id = ?').run(id)
      this.sql.query('DELETE FROM _identities WHERE user_id = ?').run(id)
      this.sql.query('DELETE FROM _users WHERE id = ?').run(id)
    })()
  }

  listUsers(queries: unknown[], search?: string, includeTotal = true): { total: number; users: UserRowFull[] } {
    const options: ListOptions = { includeTotal }
    if (search) options.search = { term: search, fields: ['name', 'email', 'phone', '$id'] }
    const { total, seqs } = listSeqs(this.store, USERS, queries, options)
    return { total, users: this.bySeq<UserRowFull>('_users', seqs) }
  }

  /** Rows of `table` with these `seq`s, in the given order. */
  bySeq<T extends { seq?: number }>(table: string, seqs: number[]): T[] {
    if (seqs.length === 0) return []
    const rows = this.sql.query(`SELECT * FROM ${table} WHERE seq IN (${seqs.map(() => '?').join(', ')})`).all(...seqs) as (T & { seq: number })[]
    const bySeq = new Map(rows.map((r) => [r.seq, r]))
    return seqs.map((s) => bySeq.get(s)!).filter(Boolean)
  }

  // ------------------------------------------------------------ sessions

  createSession(
    userId: string,
    options: { provider: string; factors: string[]; info: RequestInfo; providerUid?: string; providerAccessToken?: string; providerRefreshToken?: string; providerAccessTokenExpiry?: string },
  ): { session: SessionRow; secret: string } {
    const user = this.user(userId)
    if (!user.status) throw err('user_blocked')
    const secret = randomSecret(64)
    const id = uniqueId()
    const stamp = now()
    this.sql.transaction(() => {
      this.sql
        .query(
          `INSERT INTO _sessions (id, user_id, secret_hash, provider, provider_uid, provider_access_token, provider_access_token_expiry, provider_refresh_token, ip, user_agent, factors, expire, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          userId,
          sha256(secret),
          options.provider,
          options.providerUid ?? user.email ?? '',
          options.providerAccessToken ?? '',
          options.providerAccessTokenExpiry ?? '',
          options.providerRefreshToken ?? '',
          options.info.ip,
          options.info.userAgent,
          JSON.stringify(options.factors),
          addSeconds(this.config.sessionDuration),
          stamp,
          stamp,
        )
      // Keep at most `sessionsLimit` sessions: drop the oldest.
      if (this.config.sessionsLimit > 0) {
        this.sql
          .query(
            `DELETE FROM _sessions WHERE user_id = ? AND id NOT IN
             (SELECT id FROM _sessions WHERE user_id = ? ORDER BY seq DESC LIMIT ?)`,
          )
          .run(userId, userId, this.config.sessionsLimit)
      }
      this.sql.query('UPDATE _users SET accessed_at = ? WHERE id = ?').run(stamp, userId)
    })()
    return { session: this.session(id)!, secret }
  }

  session(id: string): SessionRow | null {
    return this.sql.query<SessionRow, [string]>('SELECT * FROM _sessions WHERE id = ?').get(id) ?? null
  }

  sessions(userId: string): SessionRow[] {
    return this.sql.query<SessionRow, [string, string]>('SELECT * FROM _sessions WHERE user_id = ? AND expire > ? ORDER BY seq').all(userId, now())
  }

  deleteSession(userId: string, sessionId: string): void {
    const result = this.sql.query('DELETE FROM _sessions WHERE id = ? AND user_id = ?').run(sessionId, userId)
    if (result.changes === 0) throw err('user_session_not_found')
  }

  deleteSessions(userId: string): void {
    this.sql.query('DELETE FROM _sessions WHERE user_id = ?').run(userId)
  }

  // ------------------------------------------------------------ tokens

  createToken(userId: string, type: TokenType, options: { secret?: string; ttl: number; provider?: string }): { token: TokenRowFull; secret: string } {
    const secret = options.secret ?? randomSecret(64)
    const id = uniqueId()
    const stamp = now()
    this.sql
      .query(
        `INSERT INTO _tokens (id, user_id, type, provider, secret_hash, expire, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, type, options.provider ?? null, sha256(secret), addSeconds(options.ttl), stamp, stamp)
    return { token: this.sql.query<TokenRowFull, [string]>('SELECT * FROM _tokens WHERE id = ?').get(id)!, secret }
  }

  /** Generic token for `users.createToken`: `length` chars, `expire` seconds. */
  createGenericToken(userId: string, length = 6, expire = 900) {
    if (!Number.isInteger(length) || length < 4 || length > 128) {
      throw err('general_argument_invalid', 'Invalid `length` param: Value must be a valid range between 4 and 128')
    }
    if (!Number.isInteger(expire) || expire < 60 || expire > 31536000) {
      throw err('general_argument_invalid', 'Invalid `expire` param: Value must be a valid range between 60 and 31,536,000')
    }
    this.user(userId)
    return this.createToken(userId, 'generic', { secret: randomCode(length), ttl: expire })
  }

  /** Find a live token of one of `types` for this user and secret, or throw user_invalid_token. */
  verifyToken(userId: string, secret: unknown, types: TokenType[]): TokenRowFull {
    if (typeof secret !== 'string' || !secret) throw err('user_invalid_token')
    const token = this.sql
      .query<TokenRowFull, [string, string, string]>('SELECT * FROM _tokens WHERE user_id = ? AND secret_hash = ? AND expire > ?')
      .get(userId, sha256(secret), now())
    if (!token || !types.includes(token.type)) throw err('user_invalid_token')
    return token
  }

  deleteToken(id: string): void {
    this.sql.query('DELETE FROM _tokens WHERE id = ?').run(id)
  }

  pruneExpired(): void {
    const stamp = now()
    this.sql.query('DELETE FROM _tokens WHERE expire < ?').run(stamp)
    this.sql.query('DELETE FROM _sessions WHERE expire < ?').run(stamp)
  }
}
