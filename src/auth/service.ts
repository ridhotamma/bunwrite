/**
 * Users, sessions and tokens. Secrets are random and only their sha256 is
 * stored, so a copy of the database cannot be used to sign in.
 *
 * Everything goes through the database port (`db.driver`), so the service runs
 * on SQLite and Postgres. The MongoDB repository lives beside it.
 */
import type { Config } from '~/config'
import type { SqlDatabase } from '~/db/driver'
import { uniqueViolation } from '~/db/driver'
import type { DocumentStore } from '~/documents/store'
import { clientIpOf } from '~/lib/client-ip'
import { addSeconds, now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { randomSecret, resolveId, sha256, uniqueId } from '~/lib/ids'
import { listSeqs, USERS, type ListOptions } from '~/system/list'
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

export interface UserSuggestion {
  id: string
  name: string
  email: string | null
}

export interface UserIdentity {
  provider: string
  provider_email: string | null
  created_at: string
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE = /^\+[1-9]\d{6,14}$/

export function requestInfo(request: Request): RequestInfo {
  return {
    ip: clientIpOf(request),
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
    throw err('general_argument_invalid', `Invalid \`${param}\` param: Phone number must start with a '+' can have a maximum of fifteen digits.`)
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

/** Whether a failed write hit the unique index on this column. */
function conflictsOn(error: unknown, column: string): boolean {
  const info = uniqueViolation(error)
  return Boolean(info && new RegExp(column, 'i').test(info.constraint ?? ''))
}

export class AuthService {
  constructor(
    private db: SqlDatabase,
    private config: Config,
    private store: DocumentStore,
  ) {}

  // ------------------------------------------------------------ users

  async findUser(id: string): Promise<UserRowFull | null> {
    return this.db.driver.get<UserRowFull>('SELECT * FROM _users WHERE id = ?', [id])
  }

  async user(id: string): Promise<UserRowFull> {
    const user = await this.findUser(id)
    if (!user) throw err('user_not_found')
    return user
  }

  async userByEmail(email: string): Promise<UserRowFull | null> {
    return this.db.driver.get<UserRowFull>('SELECT * FROM _users WHERE email = ?', [email.toLowerCase()])
  }

  /** Number of user accounts. */
  async countUsers(): Promise<number> {
    const row = await this.db.driver.get<{ n: number }>('SELECT count(*) AS n FROM _users')
    return Number(row?.n ?? 0)
  }

  /** Users for role pickers, newest first, capped so a page stays small. */
  async userDirectory(limit = 300): Promise<UserSuggestion[]> {
    return this.db.driver.all<UserSuggestion>('SELECT id, name, email FROM _users ORDER BY seq DESC LIMIT ?', [limit])
  }

  /** Distinct labels in use, capped. */
  async userLabels(limit = 100): Promise<string[]> {
    const rows = await this.db.driver.all<{ value: string }>('SELECT DISTINCT j.value AS value FROM _users, json_each(_users.labels) j LIMIT ?', [limit])
    return rows.map((row) => row.value)
  }

  /** OAuth identities linked to a user. */
  async identities(userId: string): Promise<UserIdentity[]> {
    return this.db.driver.all<UserIdentity>('SELECT provider, provider_email, created_at FROM _identities WHERE user_id = ?', [userId])
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
    const password =
      input.password !== undefined && input.password !== null && input.password !== '' ? await hashPassword(validatePassword(input.password)) : null
    const name = typeof input.name === 'string' ? input.name.slice(0, 128) : ''
    const stamp = now()
    try {
      await this.db.driver.run(
        `INSERT INTO _users (id, name, email, phone, password, hash, hash_options, registration, password_update, email_verification, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'argon2', ?, ?, ?, ?, ?, ?)`,
        [
          id,
          name,
          email,
          phone,
          password,
          JSON.stringify(appwriteHashOptions()),
          stamp,
          password ? stamp : null,
          input.emailVerification ? 1 : 0,
          stamp,
          stamp,
        ],
      )
    } catch (error) {
      if (uniqueViolation(error)) throw err('user_already_exists')
      throw error
    }
    return this.user(id)
  }

  /** Update user columns; maps unique clashes to Appwrite's errors. */
  async updateUser(id: string, fields: Record<string, string | number | null>): Promise<UserRowFull> {
    await this.user(id)
    const keys = Object.keys(fields)
    if (keys.length) {
      try {
        await this.db.driver.run(`UPDATE _users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
          ...keys.map((k) => fields[k]!),
          now(),
          id,
        ])
      } catch (error) {
        if (uniqueViolation(error)) {
          if (conflictsOn(error, 'email')) throw err('user_email_already_exists')
          if (conflictsOn(error, 'phone')) throw err('user_phone_already_exists')
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

  async deleteUser(id: string): Promise<void> {
    await this.user(id)
    await this.db.driver.transaction(async (tx) => {
      await tx.run('DELETE FROM _sessions WHERE user_id = ?', [id])
      await tx.run('DELETE FROM _tokens WHERE user_id = ?', [id])
      await tx.run('DELETE FROM _memberships WHERE user_id = ?', [id])
      await tx.run('DELETE FROM _identities WHERE user_id = ?', [id])
      await tx.run('DELETE FROM _users WHERE id = ?', [id])
    })
  }

  async listUsers(queries: unknown[], search?: string, includeTotal = true): Promise<{ total: number; users: UserRowFull[] }> {
    const options: ListOptions = { includeTotal }
    if (search) options.search = { term: search, fields: ['name', 'email', 'phone', '$id'] }
    const { total, seqs } = await listSeqs(this.store, USERS, queries, options)
    return { total, users: await this.bySeq<UserRowFull>('_users', seqs) }
  }

  /** Rows of `table` with these `seq`s, in the given order. */
  async bySeq<T extends { seq?: number }>(table: string, seqs: number[]): Promise<T[]> {
    if (seqs.length === 0) return []
    const rows = await this.db.driver.all<T & { seq: number }>(`SELECT * FROM ${table} WHERE seq IN (${seqs.map(() => '?').join(', ')})`, seqs)
    const bySeq = new Map(rows.map((r) => [r.seq, r]))
    return seqs.map((s) => bySeq.get(s)!).filter(Boolean)
  }

  // ------------------------------------------------------------ sessions

  async createSession(
    userId: string,
    options: {
      provider: string
      factors: string[]
      info: RequestInfo
      providerUid?: string
      providerAccessToken?: string
      providerRefreshToken?: string
      providerAccessTokenExpiry?: string
    },
  ): Promise<{ session: SessionRow; secret: string }> {
    const user = await this.user(userId)
    if (!user.status) throw err('user_blocked')
    const secret = randomSecret(64)
    const id = uniqueId()
    const stamp = now()
    await this.db.driver.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO _sessions (id, user_id, secret_hash, provider, provider_uid, provider_access_token, provider_access_token_expiry, provider_refresh_token, ip, user_agent, factors, expire, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
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
        ],
      )
      // Keep at most `sessionsLimit` sessions: drop the oldest.
      if (this.config.sessionsLimit > 0) {
        await tx.run(
          `DELETE FROM _sessions WHERE user_id = ? AND id NOT IN
           (SELECT id FROM _sessions WHERE user_id = ? ORDER BY seq DESC LIMIT ?)`,
          [userId, userId, this.config.sessionsLimit],
        )
      }
      await tx.run('UPDATE _users SET accessed_at = ? WHERE id = ?', [stamp, userId])
    })
    const session = await this.session(id)
    return { session: session!, secret }
  }

  async session(id: string): Promise<SessionRow | null> {
    return this.db.driver.get<SessionRow>('SELECT * FROM _sessions WHERE id = ?', [id])
  }

  async sessions(userId: string): Promise<SessionRow[]> {
    return this.db.driver.all<SessionRow>('SELECT * FROM _sessions WHERE user_id = ? AND expire > ? ORDER BY seq', [userId, now()])
  }

  async deleteSession(userId: string, sessionId: string): Promise<void> {
    const result = await this.db.driver.run('DELETE FROM _sessions WHERE id = ? AND user_id = ?', [sessionId, userId])
    if (result.changes === 0) throw err('user_session_not_found')
  }

  async deleteSessions(userId: string): Promise<void> {
    await this.db.driver.run('DELETE FROM _sessions WHERE user_id = ?', [userId])
  }

  // ------------------------------------------------------------ tokens

  async createToken(
    userId: string,
    type: TokenType,
    options: { secret?: string; ttl: number; provider?: string },
  ): Promise<{ token: TokenRowFull; secret: string }> {
    const secret = options.secret ?? randomSecret(64)
    const id = uniqueId()
    const stamp = now()
    await this.db.driver.run(
      `INSERT INTO _tokens (id, user_id, type, provider, secret_hash, expire, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, type, options.provider ?? null, sha256(secret), addSeconds(options.ttl), stamp, stamp],
    )
    const token = await this.db.driver.get<TokenRowFull>('SELECT * FROM _tokens WHERE id = ?', [id])
    return { token: token!, secret }
  }

  /** Generic token for `users.createToken`: `length` chars, `expire` seconds. */
  async createGenericToken(userId: string, length = 6, expire = 900): Promise<{ token: TokenRowFull; secret: string }> {
    if (!Number.isInteger(length) || length < 4 || length > 128) {
      throw err('general_argument_invalid', 'Invalid `length` param: Value must be a valid range between 4 and 128')
    }
    if (!Number.isInteger(expire) || expire < 60 || expire > 31536000) {
      throw err('general_argument_invalid', 'Invalid `expire` param: Value must be a valid range between 60 and 31,536,000')
    }
    await this.user(userId)
    return this.createToken(userId, 'generic', { secret: randomCode(length), ttl: expire })
  }

  /** Find a live token of one of `types` for this user and secret, or throw user_invalid_token. */
  async verifyToken(userId: string, secret: unknown, types: TokenType[]): Promise<TokenRowFull> {
    if (typeof secret !== 'string' || !secret) throw err('user_invalid_token')
    const token = await this.db.driver.get<TokenRowFull>('SELECT * FROM _tokens WHERE user_id = ? AND secret_hash = ? AND expire > ?', [
      userId,
      sha256(secret),
      now(),
    ])
    if (!token || !types.includes(token.type)) throw err('user_invalid_token')
    return token
  }

  async deleteToken(id: string): Promise<void> {
    await this.db.driver.run('DELETE FROM _tokens WHERE id = ?', [id])
  }

  async pruneExpired(): Promise<void> {
    const stamp = now()
    await this.db.driver.run('DELETE FROM _tokens WHERE expire < ?', [stamp])
    await this.db.driver.run('DELETE FROM _sessions WHERE expire < ?', [stamp])
  }
}
