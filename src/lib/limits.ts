/**
 * Appwrite's abuse limits. Counters live in SQLite so every worker sees the
 * same window; API-key callers are exempt, as on Appwrite. Trusted backend
 * servers call these endpoints with the key and keep their own login limits
 * and captcha.
 */
import type { Db } from '~/db/connection'
import { err } from './errors'

interface CountRow {
  count: number
}

/**
 * Add one hit to `key` and return the count in the current window. The upsert
 * resets the window and count in one statement, so two workers cannot both
 * start a fresh window and let a caller through twice.
 */
function count(db: Db, key: string, resetAt: number): number {
  const stamp = Date.now()
  const row = db.sqlite
    .query<CountRow, [string, number, number, number]>(
      `INSERT INTO _rate_limits (key, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
         reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
       RETURNING count`,
    )
    .get(key, resetAt, stamp, stamp)
  return Number(row?.count ?? 1)
}

export class RateLimiter {
  constructor(private db: Db) {}

  /** Count one hit; throw general_rate_limit_exceeded past `limit` within `windowSeconds`. */
  hit(key: string, limit: number, windowSeconds: number): void {
    if (count(this.db, `rate:${key}`, Date.now() + Math.max(1, windowSeconds) * 1000) > limit) {
      throw err('general_rate_limit_exceeded')
    }
  }
}

/** Wrong guesses at a token secret per user; past the limit the user's login codes are burned. */
export class FailedAttempts {
  constructor(
    private db: Db,
    private limit = 10,
    private windowSeconds = 15 * 60,
  ) {}

  /** Record a failure; returns true when the limit is reached. */
  fail(userId: string): boolean {
    return count(this.db, `token:${userId}`, Date.now() + this.windowSeconds * 1000) >= this.limit
  }

  clear(userId: string): void {
    this.db.sqlite.query('DELETE FROM _rate_limits WHERE key = ?').run(`token:${userId}`)
  }
}

/** Drop windows that have already reset; the leader runs this with its pruning. */
export function pruneRateLimits(db: Db): void {
  db.sqlite.query('DELETE FROM _rate_limits WHERE reset_at <= ?').run(Date.now())
}
