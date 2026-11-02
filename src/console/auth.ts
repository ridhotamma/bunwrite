/**
 * Console sign-in. Admins are separate from project users (as in Appwrite);
 * sessions are random secrets in an HttpOnly, SameSite=Lax cookie scoped to
 * /console, stored as sha256. Lax (not Strict) so the cookie is sent when a
 * GitHub round trip lands back on the console; Lax still withholds it from
 * cross-site POSTs, and the console checks Origin as well.
 *
 * Everything goes through the database port so the console can run on a
 * network backend as well as SQLite.
 */
import { timingSafeEqual } from 'node:crypto'

import type { SqlDatabase } from '~/db/driver'
import { addSeconds, now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { randomSecret, sha256 } from '~/lib/ids'
import { hashPassword, validatePassword } from '~/auth/passwords'
import { validEmail } from '~/auth/service'
import { parseCookies } from '~/auth/caller'

export const CONSOLE_COOKIE = 'bunwrite_console'
const SESSION_TTL = 7 * 24 * 3600
const MFA_TTL = 10 * 60
const MFA_ATTEMPTS = 5

export interface Admin {
  seq: number
  email: string
  mfa: boolean
}

export type LoginResult = { status: 'ok'; secret: string } | { status: 'mfa'; challenge: string; code: string; email: string } | { status: 'invalid' }

interface AdminRow {
  seq: number
  email: string
  mfa: number
  created_at: string
}

const toAdmin = (row: AdminRow) => ({ ...row, mfa: Boolean(row.mfa) })

export class ConsoleAuth {
  constructor(private db: SqlDatabase) {}

  async count(): Promise<number> {
    return Number((await this.db.driver.get<{ n: number }>('SELECT count(*) AS n FROM _console_admins'))?.n ?? 0)
  }

  async list(): Promise<(Admin & { created_at: string })[]> {
    const rows = await this.db.driver.all<AdminRow>('SELECT seq, email, mfa, created_at FROM _console_admins ORDER BY seq')
    return rows.map(toAdmin)
  }

  async find(email: string): Promise<(Admin & { created_at: string }) | null> {
    const row = await this.db.driver.get<AdminRow>('SELECT seq, email, mfa, created_at FROM _console_admins WHERE email = ?', [email.trim().toLowerCase()])
    return row ? toAdmin(row) : null
  }

  /** Create an admin, or reset the password of an existing one. */
  async upsert(email: string, password: string): Promise<void> {
    const address = validEmail(email)
    const hash = await hashPassword(validatePassword(password))
    const stamp = now()
    await this.db.driver.run(
      `INSERT INTO _console_admins (email, password, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET password = excluded.password, updated_at = excluded.updated_at`,
      [address, hash, stamp, stamp],
    )
    // Rotating an admin password ends existing console sessions, including a
    // stolen one. Signing in again creates a fresh row.
    await this.db.driver.run('DELETE FROM _console_sessions WHERE admin_id = (SELECT seq FROM _console_admins WHERE email = ?)', [address])
  }

  async remove(seq: number): Promise<void> {
    // Count and delete in one statement: two concurrent removals must not
    // both observe two admins and leave the instance with none.
    const result = await this.db.driver.run(
      'DELETE FROM _console_admins WHERE seq = ? AND (SELECT count(*) FROM _console_admins) > 1',
      [seq],
    )
    if (result.changes === 0) throw err('general_argument_invalid', 'The last admin cannot be removed.')
  }

  /** Whether this admin must enter an emailed code after the password. */
  async mfaEnabled(email: string): Promise<boolean> {
    const row = await this.db.driver.get<{ mfa: number }>('SELECT mfa FROM _console_admins WHERE email = ?', [email.trim().toLowerCase()])
    return Boolean(row?.mfa)
  }

  /** Turn email MFA on or off for one admin. */
  async setMfa(seq: number, enabled: boolean): Promise<void> {
    await this.db.driver.run('UPDATE _console_admins SET mfa = ?, updated_at = ? WHERE seq = ?', [enabled ? 1 : 0, now(), seq])
  }

  /** Re-check the password for a sensitive console action. */
  async verifyPassword(seq: number, password: string): Promise<boolean> {
    const admin = await this.db.driver.get<{ password: string }>('SELECT password FROM _console_admins WHERE seq = ?', [seq])
    if (!admin) return false
    return Bun.password.verify(password, admin.password).catch(() => false)
  }

  private async newSession(adminSeq: number): Promise<string> {
    const secret = randomSecret(32)
    await this.db.driver.run('INSERT INTO _console_sessions (admin_id, secret_hash, expire, created_at) VALUES (?, ?, ?, ?)', [
      adminSeq,
      sha256(secret),
      addSeconds(SESSION_TTL),
      now(),
    ])
    await this.db.driver.run('DELETE FROM _console_sessions WHERE expire < ?', [now()])
    return secret
  }

  /**
   * Start an email challenge for an admin. Only the latest challenge per admin
   * is kept; returns the random challenge secret and the six-digit code to mail.
   */
  async startMfaChallenge(adminSeq: number): Promise<{ challenge: string; code: string }> {
    const challenge = randomSecret(32)
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0')
    const stamp = now()
    await this.db.driver.run('DELETE FROM _console_mfa_challenges WHERE admin_id = ? OR expire < ?', [adminSeq, stamp])
    await this.db.driver.run('INSERT INTO _console_mfa_challenges (admin_id, secret_hash, code_hash, expire, created_at) VALUES (?, ?, ?, ?, ?)', [
      adminSeq,
      sha256(challenge),
      sha256(code),
      addSeconds(MFA_TTL),
      stamp,
    ])
    return { challenge, code }
  }

  /** Spend one challenge row: true (and deletes it) for the right, live code. */
  private async consumeChallenge(row: { seq: number; code_hash: string; attempts: number; expire: string } | null, code: string): Promise<boolean> {
    if (!row || row.expire < now()) {
      if (row) await this.db.driver.run('DELETE FROM _console_mfa_challenges WHERE seq = ?', [row.seq])
      return false
    }
    if (row.attempts >= MFA_ATTEMPTS) {
      await this.db.driver.run('DELETE FROM _console_mfa_challenges WHERE seq = ?', [row.seq])
      return false
    }
    const provided = Buffer.from(sha256(code.trim()))
    const expected = Buffer.from(row.code_hash)
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      await this.db.driver.run('UPDATE _console_mfa_challenges SET attempts = attempts + 1 WHERE seq = ?', [row.seq])
      return false
    }
    await this.db.driver.run('DELETE FROM _console_mfa_challenges WHERE seq = ?', [row.seq])
    return true
  }

  /**
   * Check a password. When the admin has email MFA on, this returns a pending
   * challenge with a one-time code to email instead of a session.
   */
  async authenticate(email: string, password: string): Promise<LoginResult> {
    const admin = await this.db.driver.get<{ seq: number; password: string; mfa: number }>('SELECT seq, password, mfa FROM _console_admins WHERE email = ?', [
      email.trim().toLowerCase(),
    ])
    // Verify against a dummy hash when the email is unknown so timing does not tell.
    const ok = await Bun.password
      .verify(password, admin?.password ?? '$argon2id$v=19$m=7168,t=5,p=1$c2FsdHNhbHRzYWx0$Zq3U7Wo3l1nq5y3V5i0l0g')
      .catch(() => false)
    if (!admin || !ok) return { status: 'invalid' }
    if (!admin.mfa) return { status: 'ok', secret: await this.newSession(admin.seq) }
    const { challenge, code } = await this.startMfaChallenge(admin.seq)
    return { status: 'mfa', challenge, code, email: email.trim().toLowerCase() }
  }

  /** Complete an email challenge; returns the session secret, or null for a wrong or expired code. */
  async verifyMfa(challenge: string, code: string): Promise<string | null> {
    const row = await this.db.driver.get<{ seq: number; admin_id: number; code_hash: string; attempts: number; expire: string }>(
      'SELECT seq, admin_id, code_hash, attempts, expire FROM _console_mfa_challenges WHERE secret_hash = ?',
      [sha256(challenge)],
    )
    if (!(await this.consumeChallenge(row, code))) return null
    return this.newSession(row!.admin_id)
  }

  /**
   * Verify a code for the latest challenge an admin started, without creating a
   * session. Used to confirm sensitive actions such as deleting a project.
   */
  async verifyMfaForAdmin(adminSeq: number, code: string): Promise<boolean> {
    const row = await this.db.driver.get<{ seq: number; code_hash: string; attempts: number; expire: string }>(
      'SELECT seq, code_hash, attempts, expire FROM _console_mfa_challenges WHERE admin_id = ? ORDER BY seq DESC LIMIT 1',
      [adminSeq],
    )
    return this.consumeChallenge(row, code)
  }

  /** Returns the session secret, or null for wrong credentials. Throws when MFA is required. */
  async login(email: string, password: string): Promise<string | null> {
    const result = await this.authenticate(email, password)
    if (result.status === 'mfa') {
      throw err('general_unauthorized_scope', 'This admin uses email MFA. Sign in at /console to enter the emailed code.')
    }
    return result.status === 'ok' ? result.secret : null
  }

  async admin(request: Request): Promise<Admin | null> {
    const secret = parseCookies(request.headers.get('cookie') ?? '')[CONSOLE_COOKIE]
    return secret ? ((await this.session(secret))?.admin ?? null) : null
  }

  /** The live session behind a secret (the console cookie, or the API's `a_session_console`). */
  async session(secret: string): Promise<{ seq: number; expire: string; createdAt: string; admin: Admin & { created_at: string } } | null> {
    const row = await this.db.driver.get<{
      session_seq: number
      expire: string
      session_created: string
      seq: number
      email: string
      mfa: number
      created_at: string
    }>(
      `SELECT s.seq AS session_seq, s.expire, s.created_at AS session_created, a.seq, a.email, a.mfa, a.created_at
       FROM _console_sessions s JOIN _console_admins a ON a.seq = s.admin_id
       WHERE s.secret_hash = ? AND s.expire > ?`,
      [sha256(secret), now()],
    )
    if (!row) return null
    return {
      seq: row.session_seq,
      expire: row.expire,
      createdAt: row.session_created,
      admin: { seq: row.seq, email: row.email, mfa: Boolean(row.mfa), created_at: row.created_at },
    }
  }

  async endSession(secret: string): Promise<void> {
    await this.db.driver.run('DELETE FROM _console_sessions WHERE secret_hash = ?', [sha256(secret)])
  }

  async logout(request: Request): Promise<void> {
    const secret = parseCookies(request.headers.get('cookie') ?? '')[CONSOLE_COOKIE]
    if (secret) await this.db.driver.run('DELETE FROM _console_sessions WHERE secret_hash = ?', [sha256(secret)])
  }

  cookie(secret: string, secure: boolean): string {
    return `${CONSOLE_COOKIE}=${secret}; Path=/console; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}${secure ? '; Secure' : ''}`
  }

  clearCookie(): string {
    return `${CONSOLE_COOKIE}=; Path=/console; HttpOnly; SameSite=Lax; Max-Age=0`
  }
}
