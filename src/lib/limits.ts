/**
 * Appwrite's abuse limits. Counters live in the database so every worker sees
 * the same window; API-key callers are exempt, as on Appwrite. Trusted backend
 * servers call these endpoints with the key and keep their own login limits
 * and captcha.
 */
import type { SqlDatabase } from '~/db/driver'
import { err } from './errors'

interface CountRow {
  count: number
}

/**
 * Add one hit to `key` and return the count in the current window. The upsert
 * resets the window and count in one statement, so two workers cannot both
 * start a fresh window and let a caller through twice.
 */
async function count(db: SqlDatabase, key: string, resetAt: number): Promise<number> {
  const stamp = Date.now()
  const row = await db.driver.get<CountRow>(
    `INSERT INTO _rate_limits (key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN _rate_limits.reset_at <= ? THEN 1 ELSE _rate_limits.count + 1 END,
       reset_at = CASE WHEN _rate_limits.reset_at <= ? THEN excluded.reset_at ELSE _rate_limits.reset_at END
     RETURNING count`,
    [key, resetAt, stamp, stamp],
  )
  return Number(row?.count ?? 1)
}

export class RateLimiter {
  constructor(private db: SqlDatabase) {}

  /** Count one hit; throw general_rate_limit_exceeded past `limit` within `windowSeconds`. */
  async hit(key: string, limit: number, windowSeconds: number): Promise<void> {
    if ((await count(this.db, `rate:${key}`, Date.now() + Math.max(1, windowSeconds) * 1000)) > limit) {
      throw err('general_rate_limit_exceeded')
    }
  }
}

/** Wrong guesses at a token secret per user; past the limit the user's login codes are burned. */
export class FailedAttempts {
  constructor(
    private db: SqlDatabase,
    private limit = 10,
    private windowSeconds = 15 * 60,
  ) {}

  /** Record a failure; returns true when the limit is reached. */
  async fail(userId: string): Promise<boolean> {
    return (await count(this.db, `token:${userId}`, Date.now() + this.windowSeconds * 1000)) >= this.limit
  }

  async clear(userId: string): Promise<void> {
    await this.db.driver.run('DELETE FROM _rate_limits WHERE key = ?', [`token:${userId}`])
  }
}

/** Drop windows that have already reset; the leader runs this with its pruning. */
export async function pruneRateLimits(db: SqlDatabase): Promise<void> {
  await db.driver.run('DELETE FROM _rate_limits WHERE reset_at <= ?', [Date.now()])
}
