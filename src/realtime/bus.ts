/**
 * Cross-process realtime fan-out. A document write in one worker is appended
 * to `_realtime_events`; every other worker that has WebSocket clients polls
 * the table and delivers the event to its own sockets.
 *
 * The writer delivers to its own sockets directly, and pollers skip their own
 * rows, so an event is sent once per socket. Writes are only appended when
 * some process has a socket: the presence table makes the common case (no
 * realtime clients) cost one indexed SELECT instead of an INSERT.
 */
import type { Db } from '~/db/connection'
import type { Doc } from '~/documents/codec'
import type { DocEvent } from '~/documents/store'
import { now } from '~/lib/datetime'

export interface BusEvent {
  databaseId: string
  collectionId: string
  action: DocEvent['action']
  document: Doc
}

const PRESENCE_HEARTBEAT_MS = 10_000
const PRESENCE_STALE_MS = 60_000
const EVENT_RETENTION_MS = 5 * 60_000
const PRUNE_INTERVAL_MS = 60_000
const POLL_BATCH = 200

export class RealtimeBus {
  private readonly id = crypto.randomUUID()
  private readonly startedAt = now()
  private lastSeq = 0
  private sockets = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private lastHeartbeat = 0
  private lastPrune = 0

  constructor(
    private db: Db,
    private projectId: string,
    private pollMs: number,
    private onEvents: (events: BusEvent[]) => void,
  ) {
    this.pollMs = Math.max(10, pollMs)
  }

  /** Add or remove this process's sockets; starts and stops polling. */
  setSockets(count: number): void {
    const before = this.sockets
    this.sockets = Math.max(0, count)
    if (this.sockets > 0) {
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
      this.removePresence()
      this.stopPolling()
      this.prune()
    }
  }

  /** Append our events for the other processes, if any of them can use them. */
  send(events: DocEvent[]): void {
    if (events.length === 0) return
    try {
      if (!this.wanted()) return
      const payload = JSON.stringify(
        events.map((event) => ({
          databaseId: event.collection.databaseId,
          collectionId: event.collection.id,
          action: event.action,
          document: event.document,
        })),
      )
      this.db.sqlite
        .query('INSERT INTO _realtime_events (origin, project_id, payload, created_at) VALUES (?, ?, ?, ?)')
        .run(this.id, this.projectId, payload, now())
    } catch (error) {
      console.error('[realtime] could not publish to the other processes:', error)
    }
  }

  /** Delete expired events and presence rows left by dead processes. */
  prune(): void {
    const stamp = Date.now()
    this.lastPrune = stamp
    try {
      this.db.sqlite
        .query('DELETE FROM _realtime_events WHERE created_at < ?')
        .run(new Date(stamp - EVENT_RETENTION_MS).toISOString())
      this.db.sqlite
        .query('DELETE FROM _cluster_processes WHERE heartbeat_at < ?')
        .run(new Date(stamp - PRESENCE_STALE_MS).toISOString())
    } catch {
      /* the database may be closing */
    }
  }

  stop(): void {
    this.removePresence()
    this.stopPolling()
  }

  /** Skip events from before a database restore, whose sequence numbers started over. */
  reset(): void {
    this.lastSeq = this.maxSeq()
  }

  private wanted(): boolean {
    // With a local socket, the bus is also how other processes reach it.
    if (this.sockets > 0) return true
    return Boolean(
      this.db.sqlite
        .query<{ one: number }, [string]>('SELECT 1 AS one FROM _cluster_processes WHERE sockets > 0 AND id != ? LIMIT 1')
        .get(this.id),
    )
  }

  private maxSeq(): number {
    const row = this.db.sqlite.query<{ seq: number | null }, []>('SELECT max(seq) AS seq FROM _realtime_events').get()
    return Number(row?.seq ?? 0)
  }

  private poll(): void {
    const stamp = Date.now()
    if (stamp - this.lastHeartbeat >= PRESENCE_HEARTBEAT_MS) this.presence()
    if (stamp - this.lastPrune >= PRUNE_INTERVAL_MS) this.prune()

    let rows: { seq: number; payload: string }[]
    try {
      rows = this.db.sqlite
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
        if (Array.isArray(parsed)) {
          for (const event of parsed) {
            if (event && typeof event === 'object' && typeof (event as BusEvent).databaseId === 'string') {
              events.push(event as BusEvent)
            }
          }
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
    this.lastHeartbeat = Date.now()
    try {
      this.db.sqlite
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
    try {
      this.db.sqlite.query('DELETE FROM _cluster_processes WHERE id = ?').run(this.id)
    } catch {
      /* the database may be closing */
    }
  }
}
