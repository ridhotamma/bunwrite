/**
 * A database lease that names one process as the leader. Workers renew it on a
 * timer; when the leader stops (or crashes and its lease runs out), another
 * worker takes over.
 */
import type { Db } from '~/db/connection'
import { setLeader } from './role'

export interface LeaderLeaseOptions {
  name?: string
  owner?: string
  /** How long a lease survives without a heartbeat. */
  ttlMs?: number
  /** How often to renew it. */
  heartbeatMs?: number
  /** Called whenever this process gains or loses leadership. */
  onChange?: (leader: boolean) => void
}

export class LeaderLease {
  readonly owner: string
  private readonly name: string
  private readonly ttlMs: number
  private readonly heartbeatMs: number
  private readonly onChange: (leader: boolean) => void
  private timer: ReturnType<typeof setInterval> | null = null
  private leading = false

  constructor(
    private db: Db,
    options: LeaderLeaseOptions = {},
  ) {
    this.name = options.name ?? 'scheduler'
    this.owner = options.owner ?? crypto.randomUUID()
    this.ttlMs = Math.max(50, options.ttlMs ?? 10_000)
    this.heartbeatMs = Math.max(20, Math.min(options.heartbeatMs ?? 2_000, this.ttlMs / 2))
    this.onChange = options.onChange ?? setLeader
  }

  get isLeader(): boolean {
    return this.leading
  }

  start(): void {
    this.acquire()
    if (this.timer) return
    this.timer = setInterval(() => this.acquire(), this.heartbeatMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // Hand over at once instead of making the next worker wait for the TTL.
    try {
      this.db.sqlite.query('DELETE FROM _cluster_leases WHERE name = ? AND owner = ?').run(this.name, this.owner)
    } catch {
      /* the database may already be closed */
    }
    this.setLeading(false)
  }

  /** Take or renew the lease; public so tests can drive it without timers. */
  acquire(): boolean {
    const stamp = Date.now()
    try {
      // Only the leader writes on a heartbeat. A live lease held by someone
      // else is a cheap read, so followers do not contend for the write lock.
      const current = this.db.sqlite
        .query<{ owner: string; expires_at: number }, [string]>('SELECT owner, expires_at FROM _cluster_leases WHERE name = ?')
        .get(this.name)
      if (current && current.owner !== this.owner && current.expires_at >= stamp) {
        this.setLeading(false)
        return false
      }
    } catch {
      // Fall through; the transaction below reports the real error.
    }

    let won = false
    try {
      this.db.sqlite.transaction(() => {
        // Only take an expired lease or one this process already holds. The
        // first statement is a write, so it takes SQLite's write lock and the
        // read below sees a settled row.
        this.db.sqlite
          .query(
            `INSERT INTO _cluster_leases (name, owner, expires_at) VALUES (?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
             WHERE _cluster_leases.expires_at < ? OR _cluster_leases.owner = excluded.owner`,
          )
          .run(this.name, this.owner, stamp + this.ttlMs, stamp)
        const row = this.db.sqlite
          .query<{ owner: string }, [string]>('SELECT owner FROM _cluster_leases WHERE name = ?')
          .get(this.name)
        won = row?.owner === this.owner
      })()
    } catch (error) {
      console.error('[cluster] leader lease failed:', error)
      won = false
    }
    this.setLeading(won)
    return won
  }

  private setLeading(value: boolean): void {
    if (value === this.leading) return
    this.leading = value
    this.onChange(value)
  }
}
