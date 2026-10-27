/**
 * Console sign-in. Admins are separate from project users (as in Appwrite);
 * sessions are random secrets in an HttpOnly, SameSite=Strict cookie scoped to
 * /console, stored as sha256.
 */
import type { Db } from '../db/connection'
import { addSeconds, now } from '../lib/datetime'
import { err } from '../lib/errors'
import { randomSecret, sha256 } from '../lib/ids'
import { hashPassword, validatePassword } from '../auth/passwords'
import { validEmail } from '../auth/service'
import { parseCookies } from '../auth/caller'

export const CONSOLE_COOKIE = 'pesanle_console'
const SESSION_TTL = 7 * 24 * 3600

export interface Admin {
  seq: number
  email: string
}

export class ConsoleAuth {
  constructor(private db: Db) {}

  count(): number {
    return (this.db.sqlite.query('SELECT count(*) AS n FROM _console_admins').get() as { n: number }).n
  }

  list(): (Admin & { created_at: string })[] {
    return this.db.sqlite.query<Admin & { created_at: string }, []>('SELECT seq, email, created_at FROM _console_admins ORDER BY seq').all()
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

  /** Returns the session secret, or null for wrong credentials. */
  async login(email: string, password: string): Promise<string | null> {
    const admin = this.db.sqlite
      .query<{ seq: number; password: string }, [string]>('SELECT seq, password FROM _console_admins WHERE email = ?')
      .get(email.trim().toLowerCase())
    // Verify against a dummy hash when the email is unknown so timing does not tell.
    const ok = await Bun.password.verify(password, admin?.password ?? '$argon2id$v=19$m=7168,t=5,p=1$c2FsdHNhbHRzYWx0$Zq3U7Wo3l1nq5y3V5i0l0g').catch(() => false)
    if (!admin || !ok) return null
    const secret = randomSecret(32)
    this.db.sqlite
      .query('INSERT INTO _console_sessions (admin_id, secret_hash, expire, created_at) VALUES (?, ?, ?, ?)')
      .run(admin.seq, sha256(secret), addSeconds(SESSION_TTL), now())
    this.db.sqlite.query('DELETE FROM _console_sessions WHERE expire < ?').run(now())
    return secret
  }

  admin(request: Request): Admin | null {
    const secret = parseCookies(request.headers.get('cookie') ?? '')[CONSOLE_COOKIE]
    if (!secret) return null
    return (
      this.db.sqlite
        .query<Admin, [string, string]>(
          `SELECT a.seq, a.email FROM _console_sessions s JOIN _console_admins a ON a.seq = s.admin_id
           WHERE s.secret_hash = ? AND s.expire > ?`,
        )
        .get(sha256(secret), now()) ?? null
    )
  }

  logout(request: Request): void {
    const secret = parseCookies(request.headers.get('cookie') ?? '')[CONSOLE_COOKIE]
    if (secret) this.db.sqlite.query('DELETE FROM _console_sessions WHERE secret_hash = ?').run(sha256(secret))
  }

  cookie(secret: string, secure: boolean): string {
    return `${CONSOLE_COOKIE}=${secret}; Path=/console; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}${secure ? '; Secure' : ''}`
  }

  clearCookie(): string {
    return `${CONSOLE_COOKIE}=; Path=/console; HttpOnly; SameSite=Strict; Max-Age=0`
  }
}
