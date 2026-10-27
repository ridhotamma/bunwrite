/**
 * Appwrite's abuse limits, in memory: a fixed window per key. API-key callers
 * are exempt, as on Appwrite. Trusted backend servers call these endpoints with
 * the key and keep their own login limits and captcha.
 */
import { err } from './errors'

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>()

  /** Count one hit; throw general_rate_limit_exceeded past `limit` within `windowSeconds`. */
  hit(key: string, limit: number, windowSeconds: number): void {
    const now = Date.now()
    const entry = this.hits.get(key)
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowSeconds * 1000 })
      if (this.hits.size > 50_000) this.sweep(now)
      return
    }
    entry.count++
    if (entry.count > limit) throw err('general_rate_limit_exceeded')
  }

  private sweep(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k)
  }
}

/** Wrong guesses at a token secret per user; past the limit the user's login codes are burned. */
export class FailedAttempts {
  private counts = new Map<string, { count: number; resetAt: number }>()

  constructor(private limit = 10, private windowSeconds = 15 * 60) {}

  /** Record a failure; returns true when the limit is reached. */
  fail(userId: string): boolean {
    const now = Date.now()
    const entry = this.counts.get(userId)
    if (!entry || entry.resetAt <= now) {
      this.counts.set(userId, { count: 1, resetAt: now + this.windowSeconds * 1000 })
      return false
    }
    entry.count++
    return entry.count >= this.limit
  }

  clear(userId: string): void {
    this.counts.delete(userId)
  }
}
