/**
 * SQLite lock/contention helpers shared by the synchronous connection and the
 * driver port. Kept separate from `connection.ts` so the drivers can use them
 * without importing the connection module (which imports the drivers).
 */

/** SQLite's primary result codes for "another connection holds the lock". */
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6

/** Whether an error means the write lock was unavailable, not that the query was wrong. */
export function isBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = String((error as { code?: unknown }).code ?? '')
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) return true
  const errno = Number((error as { errno?: unknown }).errno)
  if (Number.isFinite(errno)) {
    const primary = errno & 0xff
    if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /\bdatabase (?:table )?is locked\b/i.test(message)
}

export interface BusyRetryOptions {
  /** Total attempts, including the first one. Default 5. */
  attempts?: number
  /** First backoff in milliseconds; doubles each attempt. Default 10. */
  baseDelayMs?: number
  /** Upper bound for the exponential part of a backoff. Default 100. */
  maxDelayMs?: number
  /** Return false to stop retrying, for example after a transaction callback ran. */
  canRetry?: () => boolean
}

/** Delay before the given retry attempt; exported so the async driver matches it. */
export function busyBackoff(attempt: number, baseDelayMs = 10, maxDelayMs = 100): number {
  const base = Math.max(0, baseDelayMs)
  const max = Math.max(base, maxDelayMs)
  return Math.min(max, base * 2 ** attempt) + Math.random() * base
}

/**
 * Run a synchronous write, retrying when SQLite reports the lock is busy.
 * `busy_timeout` already waits for ordinary contention; this covers the cases
 * where SQLite returns at once (deadlock detection, a snapshot conflict, a
 * checkpoint racing the writer). Backoff is short and jittered so a retry
 * never turns into a long stall of the process's event loop.
 */
export function withBusyRetry<T>(run: () => T, options: BusyRetryOptions = {}): T {
  const attempts = Math.max(1, Math.round(options.attempts ?? 5))
  for (let attempt = 0; ; attempt++) {
    try {
      return run()
    } catch (error) {
      const canRetry = options.canRetry ? options.canRetry() : true
      if (attempt + 1 >= attempts || !canRetry || !isBusyError(error)) throw error
      const delay = busyBackoff(attempt, options.baseDelayMs, options.maxDelayMs)
      if (delay > 0) Bun.sleepSync(Math.round(delay))
    }
  }
}
