/**
 * A database lease that names one process as the leader. Workers renew it on a
 * timer; when the leader stops (or crashes and its lease runs out), another
 * worker takes over.
 *
 * The lease lives in `_cluster_leases` on both SQLite and Postgres. A single
 * conditional upsert decides the winner, so no extra advisory lock is needed.
 */
import type { SqlDatabase } from '~/db/driver'
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

const UPSERT_LEASE = `INSERT INTO _cluster_leases (name, owner, expires_at) VALUES (?, ?, ?)
  ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
  WHERE _cluster_leases.expires_at < ? OR _cluster_leases.owner = excluded.owner`

export class LeaderLease {
  readonly owner: string
  private readonly name: string
  private readonly ttlMs: number
  private readonly heartbeatMs: number
  private readonly onChange: (leader: boolean) => void
  private timer: ReturnType<typeof setInterval> | null = null
  private leading = false

  constructor(
    private db: SqlDatabase,
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
    void this.acquire()
    if (this.timer) return
    this.timer = setInterval(() => void this.acquire(), this.heartbeatMs)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // Hand over at once instead of making the next worker wait for the TTL.
    try {
      await this.db.driver.run('DELETE FROM _cluster_leases WHERE name = ? AND owner = ?', [this.name, this.owner])
    } catch {
      /* the database may already be closed */
    }
    this.setLeading(false)
  }

  /** Take or renew the lease; public so tests can drive it without timers. */
  async acquire(): Promise<boolean> {
    const stamp = Date.now()
    let won = false
    try {
      await this.db.driver.run(UPSERT_LEASE, [this.name, this.owner, stamp + this.ttlMs, stamp])
      const row = await this.db.driver.get<{ owner: string }>('SELECT owner FROM _cluster_leases WHERE name = ?', [this.name])
      won = row?.owner === this.owner
    } catch (error) {
      console.error('[cluster] leader lease failed:', error)
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
