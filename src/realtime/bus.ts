/**
 * Cross-process realtime fan-out.
 *
 * SQLite has no server-side notification channel, so a document write is
 * appended to `_realtime_events`; every other worker with WebSocket clients
 * polls the table. Postgres uses `LISTEN`/`NOTIFY` instead: a write publishes
 * one payload per batch and the database delivers it to every listening
 * process.
 *
 * The writer delivers to its own sockets directly, and the bus skips its own
 * origin, so an event is sent once per socket. SQLite still records presence
 * so the common case (no realtime clients anywhere) costs one indexed SELECT
 * instead of an INSERT. Postgres publishes unconditionally: NOTIFY is cheap
 * and only listening processes receive it.
 */
import type { Database } from 'bun:sqlite'

import type { SqlDatabase } from '~/db/driver'
import { now } from '~/lib/datetime'
import { sha256 } from '~/lib/ids'
import type { BusEvent, CustomBusEvent, DocumentBusEvent, PresenceBusEvent } from './events'

const PRESENCE_HEARTBEAT_MS = 10_000
const PRESENCE_STALE_MS = 60_000
const EVENT_RETENTION_MS = 5 * 60_000
const PRUNE_INTERVAL_MS = 60_000
const POLL_BATCH = 200

/**
 * Old workers only published document events and had no `kind` field. Accept
 * both shapes during a rolling upgrade, then normalize to the new union.
 */
function normalizeBusEvent(event: unknown): BusEvent | null {
  if (!event || typeof event !== 'object') return null
  const value = event as Record<string, unknown>
  if (value.kind === 'custom') {
    return Array.isArray(value.channels) && Array.isArray(value.events) && typeof value.timestamp === 'string'
      ? (value as unknown as CustomBusEvent)
      : null
  }
  if (value.kind === 'presence') {
    return (value.action === 'create' || value.action === 'update' || value.action === 'delete') &&
      value.presence &&
      typeof value.presence === 'object'
      ? (value as unknown as PresenceBusEvent)
      : null
  }
  if (
    typeof value.databaseId === 'string' &&
    typeof value.collectionId === 'string' &&
    typeof value.action === 'string' &&
    value.document &&
    typeof value.document === 'object'
  ) {
    return {
      kind: 'document',
      databaseId: value.databaseId,
      collectionId: value.collectionId,
      action: value.action as DocumentBusEvent['action'],
      document: value.document as DocumentBusEvent['document'],
    }
  }
  return null
}

export class RealtimeBus {
  private readonly id = crypto.randomUUID()
  private readonly startedAt = now()
  private readonly postgres: boolean
  private readonly channel: string
  private lastSeq = 0
  private sockets = 0
  private stopped = false
  private timer: ReturnType<typeof setInterval> | null = null
  private lastHeartbeat = 0
  private lastPrune = 0
  private listening: Promise<void> | null = null
  private unsubscribe: (() => Promise<void>) | null = null
  private polling = false

  constructor(
    private db: SqlDatabase,
    private readonly projectId: string,
    private pollMs: number,
    private onEvents: (events: BusEvent[]) => void,
  ) {
    this.pollMs = Math.max(10, pollMs)
    this.postgres = db.dialect === 'postgres'
    this.channel = `bunwrite_rt_${sha256(projectId).slice(0, 16)}`
  }

  /** The SQLite event table. */
  private get sqlite(): Database {
    if (!this.db.sqlite) throw new Error('The SQLite realtime event bus is only available on SQLite.')
    return this.db.sqlite
  }

  /** Add or remove this process's sockets; starts and stops the listener. */
  setSockets(count: number): void {
    const before = this.sockets
    this.sockets = Math.max(0, count)
    if (this.sockets > 0) {
      if (this.postgres) {
        void this.startPostgres()
        return
      }
      this.presence()
      if (!this.timer) {
        // Only events published from now on matter to a new socket.
        this.lastSeq = this.maxSeq()
        this.timer = setInterval(() => this.poll(), this.pollMs)
        this.timer.unref?.()
      }
      return
    }
    if (before > 0) {
      if (this.postgres) {
        void this.stopPostgres()
        return
      }
      this.removePresence()
      this.stopPolling()
      this.prune()
    }
  }

  /** Append our events for the other processes, if any of them can use them. */
  send(events: BusEvent[]): void {
    if (events.length === 0 || this.stopped) return
    if (this.postgres) {
      void this.publishPostgres(events)
      return
    }
    try {
      if (!this.wanted()) return
      this.sqlite
        .query('INSERT INTO _realtime_events (origin, project_id, payload, created_at) VALUES (?, ?, ?, ?)')
        .run(this.id, this.projectId, JSON.stringify(events), now())
    } catch (error) {
      console.error('[realtime] could not publish to the other processes:', error)
    }
  }

  /** Delete expired events and presence rows left by dead processes. */
  prune(): void {
    if (this.postgres) {
      void this.prunePostgres()
      return
    }
    const stamp = Date.now()
    this.lastPrune = stamp
    try {
      this.sqlite
        .query('DELETE FROM _realtime_events WHERE created_at < ?')
        .run(new Date(stamp - EVENT_RETENTION_MS).toISOString())
      this.sqlite
        .query('DELETE FROM _cluster_processes WHERE heartbeat_at < ?')
        .run(new Date(stamp - PRESENCE_STALE_MS).toISOString())
    } catch {
      /* the database may be closing */
    }
  }

  stop(): void {
    this.stopped = true
    if (this.postgres) {
      void this.stopPostgres()
      return
    }
    this.removePresence()
    this.stopPolling()
  }

  /** Skip events from before a database restore, whose sequence numbers started over. */
  reset(): void {
    if (this.postgres) return
    this.lastSeq = this.maxSeq()
  }

  // ------------------------------------------------------------ Postgres

  private async startPostgres(): Promise<void> {
    if (this.listening || this.stopped || !this.db.driver.listen) return
    this.listening = (async () => {
      try {
        // Skip rows written before this listener existed.
        this.lastSeq = await this.maxSeqPostgres()
        const unsubscribe = await this.db.driver.listen!(this.channel, () => void this.pollPostgres())
        if (this.stopped || this.sockets === 0) {
          await unsubscribe().catch(() => {})
          return
        }
        this.unsubscribe = unsubscribe
        // Catch rows published between the max(seq) read and LISTEN.
        await this.pollPostgres()
      } catch (error) {
        console.error('[realtime] could not listen on Postgres:', error)
      } finally {
        this.listening = null
      }
    })()
    await this.listening
  }

  private async stopPostgres(): Promise<void> {
    const unsubscribe = this.unsubscribe
    this.unsubscribe = null
    if (unsubscribe) await unsubscribe().catch(() => {})
  }

  /**
   * NOTIFY payloads are limited to 8 kB, so the event body stays in
   * `_realtime_events` and the notification only says "new rows". That keeps
   * large documents intact and reuses the SQLite table layout.
   */
  private async publishPostgres(events: BusEvent[]): Promise<void> {
    try {
      const row = await this.db.driver.get<{ seq: number }>(
        'INSERT INTO _realtime_events (origin, project_id, payload, created_at) VALUES (?, ?, ?, ?) RETURNING seq',
        [this.id, this.projectId, JSON.stringify(events), now()],
      )
      if (row?.seq !== undefined) await this.db.driver.run('SELECT pg_notify(?, ?)', [this.channel, String(row.seq)])
    } catch (error) {
      console.error('[realtime] could not publish the Postgres notification:', error)
    }
  }

  private async maxSeqPostgres(): Promise<number> {
    const row = await this.db.driver.get<{ seq: number | null }>('SELECT max(seq) AS seq FROM _realtime_events')
    return Number(row?.seq ?? 0)
  }

  private async pollPostgres(): Promise<void> {
    if (this.polling || this.stopped) return
    this.polling = true
    try {
      const rows = await this.db.driver.all<{ seq: number; payload: string }>(
        'SELECT seq, payload FROM _realtime_events WHERE seq > ? AND origin != ? ORDER BY seq LIMIT ?',
        [this.lastSeq, this.id, POLL_BATCH],
      )
      if (rows.length === 0) return
      this.lastSeq = rows[rows.length - 1]!.seq
      const events = rows.flatMap((row) => {
        try {
          const parsed = JSON.parse(row.payload) as unknown
          if (!Array.isArray(parsed)) return []
          return parsed.map(normalizeBusEvent).filter((event): event is BusEvent => event !== null)
        } catch {
          return []
        }
      })
      if (events.length) this.onEvents(events)
    } catch (error) {
      console.error('[realtime] could not read the Postgres notification:', error)
    } finally {
      this.polling = false
    }
  }

  private async prunePostgres(): Promise<void> {
    const stamp = Date.now()
    if (stamp - this.lastPrune < PRUNE_INTERVAL_MS) return
    this.lastPrune = stamp
    try {
      await this.db.driver.run('DELETE FROM _realtime_events WHERE created_at < ?', [new Date(stamp - EVENT_RETENTION_MS).toISOString()])
    } catch {
      /* the database may be closing */
    }
  }

  // ------------------------------------------------------------ SQLite

  private wanted(): boolean {
    // With a local socket, the bus is also how other processes reach it.
    if (this.sockets > 0) return true
    return Boolean(
      this.sqlite
        .query<{ one: number }, [string]>('SELECT 1 AS one FROM _cluster_processes WHERE sockets > 0 AND id != ? LIMIT 1')
        .get(this.id),
    )
  }

  private maxSeq(): number {
    const row = this.sqlite.query<{ seq: number | null }, []>('SELECT max(seq) AS seq FROM _realtime_events').get()
    return Number(row?.seq ?? 0)
  }

  private poll(): void {
    if (this.postgres) return
    const stamp = Date.now()
    if (stamp - this.lastHeartbeat >= PRESENCE_HEARTBEAT_MS) this.presence()
    if (stamp - this.lastPrune >= PRUNE_INTERVAL_MS) this.prune()

    let rows: { seq: number; payload: string }[]
    try {
      rows = this.sqlite
        .query<{ seq: number; payload: string }, [number, string, number]>(
          'SELECT seq, payload FROM _realtime_events WHERE seq > ? AND origin != ? ORDER BY seq LIMIT ?',
        )
        .all(this.lastSeq, this.id, POLL_BATCH)
    } catch (error) {
      console.error('[realtime] could not read events from the other processes:', error)
      return
    }
    if (rows.length === 0) return
    this.lastSeq = rows[rows.length - 1]!.seq

    const events: BusEvent[] = []
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as unknown
        if (!Array.isArray(parsed)) continue
        for (const event of parsed) {
          const normalized = normalizeBusEvent(event)
          if (normalized) events.push(normalized)
        }
      } catch {
        /* a truncated row; skip it */
      }
    }
    if (events.length) this.onEvents(events)
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private presence(): void {
    if (this.postgres) return
    this.lastHeartbeat = Date.now()
    try {
      this.sqlite
        .query(
          `INSERT INTO _cluster_processes (id, sockets, started_at, heartbeat_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET sockets = excluded.sockets, heartbeat_at = excluded.heartbeat_at`,
        )
        .run(this.id, this.sockets, this.startedAt, now())
    } catch (error) {
      console.error('[realtime] could not record this process:', error)
    }
  }

  private removePresence(): void {
    if (this.postgres) return
    try {
      this.sqlite.query('DELETE FROM _cluster_processes WHERE id = ?').run(this.id)
    } catch {
      /* the database may be closing */
    }
  }
}
