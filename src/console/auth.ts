/**
 * Console sign-in. Admins are separate from project users (as in Appwrite);
 * sessions are random secrets in an HttpOnly, SameSite=Lax cookie scoped to
 * /console, stored as sha256. Lax (not Strict) so the cookie is sent when a
 * GitHub round trip lands back on the console; Lax still withholds it from
 * cross-site POSTs, and the console checks Origin as well.
 */
import type { Db } from '~/db/connection'
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

export type LoginResult =
  | { status: 'ok'; secret: string }
  | { status: 'mfa'; challenge: string; code: string; email: string }
  | { status: 'invalid' }

export class ConsoleAuth {
  constructor(private db: Db) {}

  count(): number {
    return (this.db.sqlite.query('SELECT count(*) AS n FROM _console_admins').get() as { n: number }).n
  }

  list(): (Admin & { created_at: string })[] {
    return this.db.sqlite
      .query<Omit<Admin, 'mfa'> & { mfa: number; created_at: string }, []>('SELECT seq, email, mfa, created_at FROM _console_admins ORDER BY seq')
      .all()
      .map((row) => ({ ...row, mfa: Boolean(row.mfa) }))
  }

  find(email: string): (Admin & { created_at: string }) | null {
    const row = this.db.sqlite
      .query<Omit<Admin, 'mfa'> & { mfa: number; created_at: string }, [string]>(
        'SELECT seq, email, mfa, created_at FROM _console_admins WHERE email = ?',
      )
      .get(email.trim().toLowerCase())
    return row ? { ...row, mfa: Boolean(row.mfa) } : null
  }

  /** Create an admin, or reset the password of an existing one. */
  async upsert(email: string, password: string): Promise<void> {
    const address = validEmail(email)
    const hash = await hashPassword(validatePassword(password))
    const stamp = now()
    this.db.sqlite
      .query(
        `INSERT INTO _console_admins (email, password, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET password = excluded.password, updated_at = excluded.updated_at`,
      )
      .run(address, hash, stamp, stamp)
  }

  remove(seq: number): void {
    if (this.count() <= 1) throw err('general_argument_invalid', 'The last admin cannot be removed.')
    this.db.sqlite.query('DELETE FROM _console_admins WHERE seq = ?').run(seq)
  }

  /** Whether this admin must enter an emailed code after the password. */
  mfaEnabled(email: string): boolean {
    return Boolean(
      this.db.sqlite
        .query<{ mfa: number }, [string]>('SELECT mfa FROM _console_admins WHERE email = ?')
        .get(email.trim().toLowerCase())?.mfa,
    )
  }

  /** Turn email MFA on or off for one admin. */
  setMfa(seq: number, enabled: boolean): void {
    this.db.sqlite.query('UPDATE _console_admins SET mfa = ?, updated_at = ? WHERE seq = ?').run(enabled ? 1 : 0, now(), seq)
  }

  /** Re-check the password for a sensitive console action. */
  async verifyPassword(seq: number, password: string): Promise<boolean> {
    const admin = this.db.sqlite.query<{ password: string }, [number]>('SELECT password FROM _console_admins WHERE seq = ?').get(seq)
    if (!admin) return false
    return Bun.password.verify(password, admin.password).catch(() => false)
  }

  private newSession(adminSeq: number): string {
    const secret = randomSecret(32)
    this.db.sqlite
      .query('INSERT INTO _console_sessions (admin_id, secret_hash, expire, created_at) VALUES (?, ?, ?, ?)')
      .run(adminSeq, sha256(secret), addSeconds(SESSION_TTL), now())
    this.db.sqlite.query('DELETE FROM _console_sessions WHERE expire < ?').run(now())
    return secret
  }

  /**
   * Check a password. When the admin has email MFA on, this returns a pending
   * challenge with a one-time code to email instead of a session.
   */
  async authenticate(email: string, password: string): Promise<LoginResult> {
    const admin = this.db.sqlite
      .query<{ seq: number; password: string; mfa: number }, [string]>(
        'SELECT seq, password, mfa FROM _console_admins WHERE email = ?',
      )
      .get(email.trim().toLowerCase())
    // Verify against a dummy hash when the email is unknown so timing does not tell.
    const ok = await Bun.password.verify(password, admin?.password ?? '$argon2id$v=19$m=7168,t=5,p=1$c2FsdHNhbHRzYWx0$Zq3U7Wo3l1nq5y3V5i0l0g').catch(() => false)
    if (!admin || !ok) return { status: 'invalid' }
    if (!admin.mfa) return { status: 'ok', secret: this.newSession(admin.seq) }
    const challenge = randomSecret(32)
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0')
    const stamp = now()
    this.db.sqlite.query('DELETE FROM _console_mfa_challenges WHERE admin_id = ? OR expire < ?').run(admin.seq, stamp)
    this.db.sqlite
      .query('INSERT INTO _console_mfa_challenges (admin_id, secret_hash, code_hash, expire, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(admin.seq, sha256(challenge), sha256(code), addSeconds(MFA_TTL), stamp)
    return { status: 'mfa', challenge, code, email: email.trim().toLowerCase() }
  }

  /** Complete an email challenge; returns the session secret, or null for a wrong or expired code. */
  verifyMfa(challenge: string, code: string): string | null {
    const row = this.db.sqlite
      .query<{ seq: number; admin_id: number; code_hash: string; attempts: number; expire: string }, [string]>(
        'SELECT seq, admin_id, code_hash, attempts, expire FROM _console_mfa_challenges WHERE secret_hash = ?',
      )
      .get(sha256(challenge))
    if (!row || row.expire < now()) {
      if (row) this.db.sqlite.query('DELETE FROM _console_mfa_challenges WHERE seq = ?').run(row.seq)
      return null
    }
    if (row.attempts >= MFA_ATTEMPTS) {
      this.db.sqlite.query('DELETE FROM _console_mfa_challenges WHERE seq = ?').run(row.seq)
      return null
    }
    if (row.code_hash !== sha256(code.trim())) {
      this.db.sqlite.query('UPDATE _console_mfa_challenges SET attempts = attempts + 1 WHERE seq = ?').run(row.seq)
      return null
    }
    this.db.sqlite.query('DELETE FROM _console_mfa_challenges WHERE seq = ?').run(row.seq)
    return this.newSession(row.admin_id)
  }

  /** Returns the session secret, or null for wrong credentials. Throws when MFA is required. */
  async login(email: string, password: string): Promise<string | null> {
    const result = await this.authenticate(email, password)
    if (result.status === 'mfa') {
      throw err('general_unauthorized_scope', 'This admin uses email MFA. Sign in at /console to enter the emailed code.')
    }
    return result.status === 'ok' ? result.secret : null
  }

  admin(request: Request): Admin | null {
    const secret = parseCookies(request.headers.get('cookie') ?? '')[CONSOLE_COOKIE]
    return secret ? (this.session(secret)?.admin ?? null) : null
  }

  /** The live session behind a secret (the console cookie, or the API's `a_session_console`). */
  session(secret: string): { seq: number; expire: string; createdAt: string; admin: Admin & { created_at: string } } | null {
    const row = this.db.sqlite
      .query<{ session_seq: number; expire: string; session_created: string; seq: number; email: string; mfa: number; created_at: string }, [string, string]>(
        `SELECT s.seq AS session_seq, s.expire, s.created_at AS session_created, a.seq, a.email, a.mfa, a.created_at
         FROM _console_sessions s JOIN _console_admins a ON a.seq = s.admin_id
         WHERE s.secret_hash = ? AND s.expire > ?`,
      )
      .get(sha256(secret), now())
    if (!row) return null
    return {
      seq: row.session_seq,
      expire: row.expire,
      createdAt: row.session_created,
      admin: { seq: row.seq, email: row.email, mfa: Boolean(row.mfa), created_at: row.created_at },
    }
  }

  endSession(secret: string): void {
    this.db.sqlite.query('DELETE FROM _console_sessions WHERE secret_hash = ?').run(sha256(secret))
  }

  logout(request: Request): void {
    const secret = parseCookies(request.headers.get('cookie') ?? '')[CONSOLE_COOKIE]
    if (secret) this.db.sqlite.query('DELETE FROM _console_sessions WHERE secret_hash = ?').run(sha256(secret))
  }

  cookie(secret: string, secure: boolean): string {
    return `${CONSOLE_COOKIE}=${secret}; Path=/console; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}${secure ? '; Secure' : ''}`
  }

  clearCookie(): string {
    return `${CONSOLE_COOKIE}=; Path=/console; HttpOnly; SameSite=Lax; Max-Age=0`
  }
}
