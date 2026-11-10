/**
 * Appwrite Realtime over Bun WebSockets, enough for the common
 * subscriptions (merchant notifications, AI-run progress).
 *
 * Protocol (web SDK 27): connect to `/v1/realtime?project=..&jwt=..`; the
 * server sends `connected`; the client sends `subscribe` with
 * `{ subscriptionId, channels }` rows, `ping`, or `authentication` with a
 * session secret. Events go out as `{ type: 'event', data: { events,
 * channels, timestamp, payload, subscriptions } }`, only to callers allowed to
 * read the document.
 *
 * Fan-out is queued instead of running inside the document-write request.
 * PocketBase uses one goroutine + buffered channel per client; Bun has one
 * event loop, so the closest equivalent is to serialize the event once, index
 * sockets by channel, and drain the broadcast queue in small time slices. That
 * keeps a slow or very large fan-out from delaying the HTTP response that
 * caused the event.
 */
import type { ServerWebSocket } from 'bun'

import { callerHasScope, sessionCaller, type Caller } from '~/auth/caller'
import { accountModel, type UserRowFull } from '~/auth/models'
import { formatPermission, grants, parsePermission } from '~/auth/permissions'
import type { SqlDatabase } from '~/db/driver'
import type { DocEvent } from '~/documents/store'
import { addSeconds, now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import type { Collection } from '~/schema/types'
import { RealtimeBus } from './bus'
import type {
  BusEvent,
  CustomEvent,
  DocumentBusEvent,
  PresenceEvent,
  PresenceListItem,
  PresenceRecord,
  StoredCustomEvent,
} from './events'

export interface SocketData {
  caller: Caller
  subscriptions: Map<string, string[]>
  projectId: string
}

export type Socket = ServerWebSocket<SocketData>

/** Keep one abusive client from turning the subscribe message into a memory sink. */
const MAX_SOCKETS = 10_000
const MAX_SUBSCRIPTIONS = 1000
const MAX_CHANNELS_PER_SUBSCRIPTION = 1000
const MAX_CHANNELS_PER_SOCKET = 2000
const MAX_CHANNEL_LENGTH = 512
const MAX_SUBSCRIPTION_ID_LENGTH = 128
const MAX_CUSTOM_CHANNELS = 100
const MAX_CUSTOM_EVENTS = 100
const MAX_CUSTOM_PAYLOAD_BYTES = 64 * 1024
const MAX_PRESENCE_ID_LENGTH = 128
const MAX_PRESENCE_STATUS_LENGTH = 128
const MAX_PRESENCE_METADATA_BYTES = 4 * 1024
const MAX_PRESENCE_PER_SOCKET = 10
const MAX_PRESENCE_PERMISSIONS = 100
const MAX_PRESENCE_SNAPSHOT = 1000
/** The SDK pings every 20s; a minute of silence means the socket is gone. */
const PRESENCE_TTL_MS = 60_000
const PRESENCE_SWEEP_MS = 30_000
/** Per-socket abuse limits; a normal SDK sends a handful of messages per minute. */
const SOCKET_WINDOW_MS = 10_000
const MAX_SOCKET_MESSAGES = 300
const MAX_PRESENCE_UPDATES = 60
/** Do not write the presence row on every ping; the SDK pings every 20s. */
const PRESENCE_TOUCH_INTERVAL_MS = 10_000

/** A stored presence row, as it sits in `_realtime_presence`. */
interface PresenceRow {
  presence_id: string
  user_id: string
  user_internal_id: string
  socket_id: string
  status: string
  metadata: string | null
  permissions: string
  source: string
  created_at: string
  updated_at: string
  expires_at: string
}

/** Per-socket presence bookkeeping kept outside the public SocketData shape. */
interface SocketState {
  connectionId: string
  ids: Set<string>
  closed: boolean
  /** Sliding fixed-window counters for per-socket abuse limits. */
  messageWindowStart: number
  messageCount: number
  presenceWindowStart: number
  presenceCount: number
  lastPresenceTouch: number
}

/** Broadcast work budget per event-loop turn, and the safety valve if consumers fall behind. */
const DRAIN_BUDGET_MS = 8
const MAX_QUEUED_EVENTS = 10_000

const send = (ws: Socket, type: string, data: unknown) => ws.send(JSON.stringify({ type, data }))

function userOf(caller: Caller) {
  return caller.user ? accountModel(caller.user as unknown as UserRowFull) : null
}

export function eventNames(e: DocEvent): string[] {
  const { databaseId: db, id: coll } = e.collection
  const doc = e.document.$id
  const names: string[] = []
  for (const d of [db, '*']) {
    for (const c of [coll, '*']) {
      for (const id of [doc, '*']) {
        names.push(`databases.${d}.collections.${c}.documents.${id}.${e.action}`, `databases.${d}.collections.${c}.documents.${id}`)
        names.push(`databases.${d}.tables.${c}.rows.${id}.${e.action}`, `databases.${d}.tables.${c}.rows.${id}`)
      }
    }
  }
  return names
}

function channelsOf(e: DocEvent): string[] {
  const { databaseId: db, id: coll } = e.collection
  const doc = e.document.$id
  return [
    'documents',
    `databases.${db}.collections.${coll}.documents`,
    `databases.${db}.collections.${coll}.documents.${doc}`,
    'rows',
    `databases.${db}.tables.${coll}.rows`,
    `databases.${db}.tables.${coll}.rows.${doc}`,
  ]
}

function canRead(caller: Caller, e: DocEvent): boolean {
  if (caller.kind === 'key' && !callerHasScope(caller, 'documents.read')) return false
  if (caller.privileged || grants(e.collection.permissions, 'read', caller.roles)) return true
  return e.collection.documentSecurity && grants((e.document.$permissions as string[]) ?? [], 'read', caller.roles)
}

/**
 * Custom channels carry their own ACL in the name, so a subscription can be
 * rejected before an event is ever published:
 *
 *   custom.public.<topic>         anyone
 *   custom.authenticated.<topic>  signed-in users
 *   custom.user.<userId>          that user
 *   custom.team.<teamId>          that team
 *   custom.label.<label>          users with that label
 *
 * Document channels are filtered at delivery like before; this only applies to
 * the `custom.` namespace.
 */
function customChannelAllowed(caller: Caller, channel: string): boolean {
  if (!channel.startsWith('custom.')) return true
  if (caller.kind === 'key' && !callerHasScope(caller, 'realtime.read')) return false
  if (caller.privileged) return true
  // Split only at the first dot after `custom.`: user, team and label IDs may
  // themselves contain dots.
  const rest = channel.slice('custom.'.length)
  const dot = rest.indexOf('.')
  const scope = dot < 0 ? rest : rest.slice(0, dot)
  const value = dot < 0 ? '' : rest.slice(dot + 1)
  switch (scope) {
    case 'public':
      return true
    case 'authenticated':
      return caller.kind === 'user'
    case 'user':
      return Boolean(value && caller.user?.id === value)
    case 'team':
      return Boolean(value && caller.roles.has(`team:${value}`))
    case 'label':
      return Boolean(value && caller.roles.has(`label:${value}`))
    default:
      return false
  }
}

function canSeePresence(caller: Caller, presence: PresenceRecord): boolean {
  if (caller.kind === 'key' && !callerHasScope(caller, 'presences.read')) return false
  if (caller.privileged) return true
  if (caller.user?.id === presence.userId) return true
  return grants(presence.$permissions, 'read', caller.roles)
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function presenceModel(row: PresenceRow): PresenceRecord {
  const metadata = parseJson<Record<string, unknown> | null>(row.metadata, null)
  return {
    $id: row.presence_id,
    $createdAt: row.created_at,
    $updatedAt: row.updated_at,
    $permissions: parseJson<string[]>(row.permissions, []),
    userInternalId: row.user_internal_id,
    userId: row.user_id,
    status: row.status,
    source: row.source,
    ...(metadata ? { metadata } : {}),
  }
}

/** The SDK sends `{ status, presenceId, permissions?, metadata? }`. */
function presencePermissions(value: unknown): string[] {
  if (value === undefined) return [formatPermission('read', 'users')]
  if (!Array.isArray(value)) throw err('general_argument_invalid', 'Presence `permissions` must be an array.')
  if (value.length > MAX_PRESENCE_PERMISSIONS) {
    throw err('general_argument_invalid', `Presence \`permissions\` may have at most ${MAX_PRESENCE_PERMISSIONS} entries.`)
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    const parsed = parsePermission(raw)
    const permission = formatPermission(parsed.type, parsed.role)
    if (seen.has(permission)) continue
    seen.add(permission)
    out.push(permission)
  }
  return out
}

export interface RealtimeHubOptions {
  /** The project this hub serves; presence rows and events are scoped to it. */
  projectId?: string
  /** How long custom events stay available for replay. `0` disables history. */
  realtimeEventRetentionSeconds?: number
  /** Enabled when several processes serve the same project database. */
  bus?: {
    projectId: string
    pollMs: number
  }
  /** Turns a bus event back into a collection from this process's registry. */
  collectionOf?: (databaseId: string, collectionId: string) => Collection | null
}

export class RealtimeHub {
  sockets = new Set<Socket>()
  private readonly projectId: string
  private readonly realtimeEventRetentionSeconds: number
  private readonly bus: RealtimeBus | null
  private readonly collectionOf: ((databaseId: string, collectionId: string) => Collection | null) | undefined

  /** channel -> sockets subscribed to it, so fan-out never scans unrelated sockets. */
  private readonly channelIndex = new Map<string, Set<Socket>>()
  /** socket -> every channel it currently subscribes to, for cheap re-indexing. */
  private readonly socketChannels = new Map<Socket, Set<string>>()

  private queue: DocEvent[] = []
  private queueHead = 0
  private customQueue: CustomEvent[] = []
  private customHead = 0
  private presenceQueue: PresenceEvent[] = []
  private presenceHead = 0
  private busQueue: BusEvent[] = []
  private readonly socketStates = new WeakMap<Socket, SocketState>()
  private presenceTimer: ReturnType<typeof setInterval> | null = null
  private drainScheduled = false
  private stopped = false
  private droppedEvents = 0
  private lastDropWarning = 0

  constructor(
    private db: SqlDatabase,
    options: RealtimeHubOptions = {},
  ) {
    this.projectId = options.projectId ?? options.bus?.projectId ?? ''
    this.realtimeEventRetentionSeconds = Math.max(0, options.realtimeEventRetentionSeconds ?? 3600)
    this.collectionOf = options.collectionOf
    this.bus = options.bus ? new RealtimeBus(db, options.bus.projectId, options.bus.pollMs, (events) => this.deliver(events)) : null
  }

  open(ws: Socket): void {
    // One guest must not be able to exhaust descriptors or hub memory.
    if (this.sockets.size >= MAX_SOCKETS) {
      ws.close(1013, 'The realtime server is at capacity.')
      return
    }
    this.sockets.add(ws)
    // A socket may arrive with subscriptions already populated (or from a test
    // harness), so index them before the first event.
    this.reindex(ws)
    const nowMs = Date.now()
    this.socketStates.set(ws, {
      connectionId: crypto.randomUUID(),
      ids: new Set(),
      closed: false,
      messageWindowStart: nowMs,
      messageCount: 0,
      presenceWindowStart: nowMs,
      presenceCount: 0,
      lastPresenceTouch: 0,
    })
    this.startPresenceTimer()
    this.bus?.setSockets(this.sockets.size)
    send(ws, 'connected', { channels: [], user: userOf(ws.data.caller) })
  }

  close(ws: Socket): void {
    this.sockets.delete(ws)
    this.unindex(ws)
    this.socketChannels.delete(ws)
    const meta = this.socketStates.get(ws)
    if (meta) {
      meta.closed = true
      void this.removePresence(meta)
    }
    if (this.sockets.size === 0) this.stopPresenceTimer()
    this.bus?.setSockets(this.sockets.size)
  }

  async message(ws: Socket, raw: string | Buffer): Promise<void> {
    const state = this.socketState(ws)
    const nowMs = Date.now()
    if (nowMs - state.messageWindowStart >= SOCKET_WINDOW_MS) {
      state.messageWindowStart = nowMs
      state.messageCount = 0
    }
    if (++state.messageCount > MAX_SOCKET_MESSAGES) {
      send(ws, 'error', { code: 1008, message: 'Too many WebSocket messages.' })
      ws.close(1008, 'Too many WebSocket messages.')
      return
    }
    let message: { type?: string; data?: unknown }
    try {
      message = JSON.parse(String(raw))
    } catch {
      send(ws, 'error', { code: 1003, message: 'Message format is not valid.' })
      return
    }
    switch (message.type) {
      case 'ping':
        void this.touchPresence(ws)
        send(ws, 'pong', null)
        return
      case 'authentication': {
        const data = message.data && typeof message.data === 'object' ? (message.data as Record<string, unknown>) : {}
        const secret = data.session
        const caller = typeof secret === 'string' ? await sessionCaller(this.db, secret) : null
        if (!caller) {
          send(ws, 'error', { code: 1003, message: 'Session is not valid.' })
          return
        }
        // A socket that switches accounts must not keep the previous user's
        // presence alive under the new identity.
        const previous = ws.data.caller.user?.id
        ws.data.caller = caller
        if (previous && previous !== caller.user?.id) void this.clearPresence(ws)
        send(ws, 'response', { to: 'authentication', success: true, user: userOf(ws.data.caller) })
        return
      }
      case 'subscribe': {
        const rows = Array.isArray(message.data) ? message.data : []
        if (rows.length > MAX_SUBSCRIPTIONS) {
          send(ws, 'error', { code: 1008, message: 'Too many subscriptions.' })
          return
        }
        const next = new Map<string, string[]>()
        let totalChannels = 0
        for (const row of rows) {
          if (typeof row?.subscriptionId !== 'string' || row.subscriptionId.length === 0) continue
          if (row.subscriptionId.length > MAX_SUBSCRIPTION_ID_LENGTH) {
            send(ws, 'error', { code: 1008, message: 'Subscription ID is too long.' })
            return
          }
          if (!Array.isArray(row.channels)) continue
          if (row.channels.length > MAX_CHANNELS_PER_SUBSCRIPTION) {
            send(ws, 'error', { code: 1008, message: 'Too many channels in a subscription.' })
            return
          }
          const channels: string[] = []
          for (const value of row.channels) {
            if (typeof value !== 'string' || value.length === 0) continue
            if (value.length > MAX_CHANNEL_LENGTH) {
              send(ws, 'error', { code: 1008, message: 'Channel name is too long.' })
              return
            }
            if (!customChannelAllowed(ws.data.caller, value)) {
              send(ws, 'error', { code: 1008, message: `Channel "${value}" is not allowed for this caller.` })
              return
            }
            channels.push(value)
          }
          totalChannels += channels.length
          if (totalChannels > MAX_CHANNELS_PER_SOCKET) {
            send(ws, 'error', { code: 1008, message: 'Too many channels on one connection.' })
            return
          }
          next.set(row.subscriptionId, channels)
        }
        // Apply only after the whole message passed validation.
        const presenceBefore = this.presenceChannels(ws)
        for (const [id, channels] of next) ws.data.subscriptions.set(id, channels)
        this.reindex(ws)
        send(ws, 'response', { to: 'subscribe', success: true })
        const presenceAfter = this.presenceChannels(ws)
        if ([...presenceAfter].some((channel) => !presenceBefore.has(channel))) {
          void this.sendPresenceSnapshot(ws)
        }
        return
      }
      case 'unsubscribe':
        for (const row of Array.isArray(message.data) ? message.data : []) {
          if (typeof row?.subscriptionId === 'string') ws.data.subscriptions.delete(row.subscriptionId)
        }
        this.reindex(ws)
        send(ws, 'response', { to: 'unsubscribe', success: true })
        return
      case 'presence': {
        const data = message.data && typeof message.data === 'object' ? (message.data as Record<string, unknown>) : {}
        await this.upsertPresence(ws, data)
        return
      }
      default:
        send(ws, 'error', { code: 1003, message: 'Message type is not valid.' })
    }
  }

  publish(events: DocEvent[]): void {
    if (events.length === 0 || this.stopped) return
    // Other workers need these events even when this process has no sockets.
    for (const event of events) {
      const busEvent: DocumentBusEvent = {
        kind: 'document',
        databaseId: event.collection.databaseId,
        collectionId: event.collection.id,
        action: event.action,
        document: event.document,
      }
      this.busQueue.push(busEvent)
    }
    this.enqueue(events)
  }

  /**
   * Publish a custom event to every subscriber of `channels`. Server-side only:
   * the HTTP route requires an API key with `realtime.write`.
   */
  async publishCustom(channels: string[], payload: unknown, events?: string[]): Promise<CustomEvent> {
    if (this.stopped) throw err('general_unknown', 'Realtime is shutting down.')
    if (!Array.isArray(channels) || channels.length === 0) {
      throw err('general_argument_invalid', 'Param "channels" must be a non-empty array.')
    }
    if (channels.length > MAX_CUSTOM_CHANNELS) {
      throw err('general_argument_invalid', `A custom event may target at most ${MAX_CUSTOM_CHANNELS} channels.`)
    }
    const cleanChannels: string[] = []
    for (const channel of channels) {
      if (typeof channel !== 'string' || channel.length === 0 || channel.length > MAX_CHANNEL_LENGTH) {
        throw err('general_argument_invalid', 'Every custom channel must be a non-empty string of at most 512 characters.')
      }
      if (!channel.startsWith('custom.')) {
        throw err('general_argument_invalid', 'Custom events may only target channels in the "custom." namespace.')
      }
      const rest = channel.slice('custom.'.length)
      const dot = rest.indexOf('.')
      const scope = dot < 0 ? rest : rest.slice(0, dot)
      const value = dot < 0 ? '' : rest.slice(dot + 1)
      if (!['public', 'authenticated', 'user', 'team', 'label'].includes(scope)) {
        throw err('general_argument_invalid', `Unknown custom channel scope "${scope}".`)
      }
      if ((scope === 'user' || scope === 'team' || scope === 'label') && value.length === 0) {
        throw err('general_argument_invalid', `Channel "${channel}" needs an ID after "custom.${scope}.".`)
      }
      if (!cleanChannels.includes(channel)) cleanChannels.push(channel)
    }
    const names = events && events.length > 0 ? events : cleanChannels
    if (names.length > MAX_CUSTOM_EVENTS) {
      throw err('general_argument_invalid', `A custom event may carry at most ${MAX_CUSTOM_EVENTS} event names.`)
    }
    const cleanEvents: string[] = []
    for (const name of names) {
      if (typeof name !== 'string' || name.length === 0 || name.length > MAX_CHANNEL_LENGTH) {
        throw err('general_argument_invalid', 'Every event name must be a non-empty string of at most 512 characters.')
      }
      if (!cleanEvents.includes(name)) cleanEvents.push(name)
    }
    const body = payload === undefined || payload === null ? {} : payload
    if (typeof body !== 'object') {
      throw err('general_argument_invalid', 'Param "payload" must be a JSON object.')
    }
    let encoded: string
    try {
      encoded = JSON.stringify(body)
    } catch {
      throw err('general_argument_invalid', 'The event payload must be JSON-serializable.')
    }
    if (Buffer.byteLength(encoded) > MAX_CUSTOM_PAYLOAD_BYTES) {
      throw err('general_argument_invalid', `A custom event payload may be at most ${MAX_CUSTOM_PAYLOAD_BYTES} bytes.`)
    }
    const event: CustomEvent = { channels: cleanChannels, events: cleanEvents, payload: body, timestamp: now() }
    const seq = await this.persistCustomEvent(event)
    if (seq !== undefined) event.seq = seq
    if (this.stopped) return event
    this.busQueue.push({ kind: 'custom', ...event })
    this.enqueueCustom(event)
    return event
  }

  /** Store an event for replay; returns its sequence, or undefined when history is off. */
  private async persistCustomEvent(event: CustomEvent): Promise<number | undefined> {
    if (this.realtimeEventRetentionSeconds <= 0) return undefined
    const expiresAt = addSeconds(this.realtimeEventRetentionSeconds)
    try {
      if (this.db.dialect === 'postgres') {
        const row = await this.db.driver.get<{ seq: number }>(
          `INSERT INTO _realtime_custom_events (project_id, channels, events, payload, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING seq`,
          [
            this.projectId,
            JSON.stringify(event.channels),
            JSON.stringify(event.events),
            JSON.stringify(event.payload),
            event.timestamp,
            expiresAt,
          ],
        )
        return Number(row?.seq ?? 0) || undefined
      }
      const result = await this.db.driver.run(
        `INSERT INTO _realtime_custom_events (project_id, channels, events, payload, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          this.projectId,
          JSON.stringify(event.channels),
          JSON.stringify(event.events),
          JSON.stringify(event.payload),
          event.timestamp,
          expiresAt,
        ],
      )
      return Number(result.lastInsertId ?? 0) || undefined
    } catch (error) {
      console.error('[realtime] could not persist a custom event:', error)
      throw err('general_unknown', 'Could not store the realtime event for replay.')
    }
  }

  /**
   * Replay custom events newer than `after`. Callers only see channels their
   * role may subscribe to; API keys need the `realtime.read` scope.
   */
  async listCustomEvents(
    caller: Caller,
    options: { channels?: string[]; after?: number; limit?: number } = {},
  ): Promise<StoredCustomEvent[]> {
    if (caller.kind === 'key' && !callerHasScope(caller, 'realtime.read')) {
      throw err('general_unauthorized_scope', 'User (role: applications) missing scopes (["realtime.read"])')
    }
    const limit = Math.min(500, Math.max(1, options.limit ?? 100))
    const after = Math.max(0, Math.floor(options.after ?? 0))
    const requested = options.channels && options.channels.length > 0 ? new Set(options.channels) : null
    let rows: Array<{ seq: number; channels: string; events: string; payload: string; created_at: string }>
    try {
      rows = await this.db.driver.all(
        `SELECT seq, channels, events, payload, created_at
           FROM _realtime_custom_events
          WHERE project_id = ? AND seq > ? AND expires_at > ?
          ORDER BY seq ASC
          LIMIT ?`,
        [this.projectId, after, now(), Math.min(5000, limit * 20)],
      )
    } catch (error) {
      console.error('[realtime] could not read custom event history:', error)
      throw err('general_unknown', 'Could not read the realtime event history.')
    }
    const out: StoredCustomEvent[] = []
    for (const row of rows) {
      const channels = parseJson<string[]>(row.channels, [])
      const events = parseJson<string[]>(row.events, [])
      if (requested && !channels.some((channel) => requested.has(channel))) continue
      if (!caller.privileged && !channels.some((channel) => customChannelAllowed(caller, channel))) continue
      let payload: unknown
      try {
        payload = JSON.parse(row.payload)
      } catch {
        continue
      }
      out.push({ seq: Number(row.seq), channels, events, payload, timestamp: row.created_at })
      if (out.length >= limit) break
    }
    return out
  }

  /** Current presence rows, for the console. */
  async listPresence(limit = 100): Promise<PresenceListItem[]> {
    let rows: PresenceRow[]
    try {
      rows = await this.db.driver.all<PresenceRow>(
        `SELECT * FROM _realtime_presence
          WHERE project_id = ? AND expires_at > ?
          ORDER BY updated_at DESC
          LIMIT ?`,
        [this.projectId, now(), Math.min(500, Math.max(1, limit))],
      )
    } catch {
      return []
    }
    return rows.map((row) => ({ ...presenceModel(row), $expiresAt: row.expires_at }))
  }

  /** Remove one presence row from the console; returns false when it is gone. */
  async removePresenceById(presenceId: string): Promise<boolean> {
    let row: PresenceRow | null
    try {
      row = await this.db.driver.get<PresenceRow>(
        'SELECT * FROM _realtime_presence WHERE project_id = ? AND presence_id = ?',
        [this.projectId, presenceId],
      )
    } catch {
      return false
    }
    if (!row) return false
    const result = await this.db.driver.run('DELETE FROM _realtime_presence WHERE project_id = ? AND presence_id = ?', [
      this.projectId,
      presenceId,
    ])
    if (result.changes > 0) this.publishPresence('delete', presenceModel(row))
    return result.changes > 0
  }

  /** Delivery from another worker's bus row: fan out locally, never re-publish. */
  private deliver(events: BusEvent[]): void {
    const local: DocEvent[] = []
    for (const event of events) {
      if (event.kind === 'custom') {
        this.enqueueCustom({
          channels: event.channels,
          events: event.events,
          payload: event.payload,
          timestamp: event.timestamp,
          seq: event.seq,
        })
        continue
      }
      if (event.kind === 'presence') {
        this.enqueuePresence({ action: event.action, presence: event.presence })
        continue
      }
      const collection = this.collectionOf?.(event.databaseId, event.collectionId)
      // The collection may have been deleted since the writer saw it.
      if (!collection) continue
      local.push({ collection, action: event.action, document: event.document })
    }
    if (local.length) this.enqueue(local)
  }

  /** Stop timers and release every socket reference; called when a project runtime closes. */
  stop(): void {
    this.stopped = true
    this.bus?.stop()
    for (const ws of this.sockets) {
      const meta = this.socketStates.get(ws)
      if (meta) {
        meta.closed = true
        void this.removePresence(meta)
      }
    }
    this.stopPresenceTimer()
    this.sockets.clear()
    this.channelIndex.clear()
    this.socketChannels.clear()
    this.queue = []
    this.queueHead = 0
    this.customQueue = []
    this.customHead = 0
    this.presenceQueue = []
    this.presenceHead = 0
    this.busQueue = []
  }

  /** The database was replaced; ignore sequence numbers from the old one. */
  resetBus(): void {
    this.bus?.reset()
  }

  /** Drop expired bus rows, history and presence rows; runs with the leader's cleanup. */
  pruneBus(): void {
    this.bus?.prune()
    void this.prunePresence()
    void this.pruneCustomEvents()
  }

  private async pruneCustomEvents(): Promise<void> {
    if (this.realtimeEventRetentionSeconds <= 0) return
    try {
      await this.db.driver.run('DELETE FROM _realtime_custom_events WHERE project_id = ? AND expires_at < ?', [
        this.projectId,
        now(),
      ])
    } catch {
      /* the database may be closing */
    }
  }

  private enqueue(events: DocEvent[]): void {
    const queued = this.queue.length - this.queueHead
    if (queued + events.length > MAX_QUEUED_EVENTS) {
      this.droppedEvents += events.length
      this.warnDropped()
      return
    }
    for (const event of events) this.queue.push(event)
    this.scheduleDrain()
  }

  private enqueueCustom(event: CustomEvent): void {
    if (this.customQueue.length - this.customHead + 1 > MAX_QUEUED_EVENTS) {
      this.droppedEvents++
      this.warnDropped()
      return
    }
    this.customQueue.push(event)
    this.scheduleDrain()
  }

  private enqueuePresence(event: PresenceEvent): void {
    if (this.presenceQueue.length - this.presenceHead + 1 > MAX_QUEUED_EVENTS) {
      this.droppedEvents++
      this.warnDropped()
      return
    }
    this.presenceQueue.push(event)
    this.scheduleDrain()
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.stopped) return
    this.drainScheduled = true
    // setImmediate (not queueMicrotask) lets the HTTP response leave before the fan-out runs.
    setImmediate(() => this.drain())
  }

  private drain(): void {
    this.drainScheduled = false
    if (this.stopped) return
    const deadline = performance.now() + DRAIN_BUDGET_MS

    // Tell other workers first; they may have sockets this process cannot see.
    if (this.busQueue.length > 0) {
      const batch = this.busQueue
      this.busQueue = []
      this.bus?.send(batch)
    }

    while (performance.now() < deadline) {
      try {
        if (this.queueHead < this.queue.length) {
          this.fanout(this.queue[this.queueHead++]!)
        } else if (this.customHead < this.customQueue.length) {
          this.fanoutCustom(this.customQueue[this.customHead++]!)
        } else if (this.presenceHead < this.presenceQueue.length) {
          this.fanoutPresence(this.presenceQueue[this.presenceHead++]!)
        } else {
          break
        }
      } catch (error) {
        // One malformed event must not stall every later subscription.
        console.error('[realtime] could not fan out an event:', error)
      }
    }

    this.compact(this.queue, 'queue')
    this.compact(this.customQueue, 'custom')
    this.compact(this.presenceQueue, 'presence')
    if (this.hasQueued()) this.scheduleDrain()
  }

  /** Reset a fully-drained queue, or drop the consumed prefix of a large one. */
  private compact(queue: unknown[], kind: 'queue' | 'custom' | 'presence'): void {
    const head = kind === 'queue' ? this.queueHead : kind === 'custom' ? this.customHead : this.presenceHead
    if (head >= queue.length) {
      queue.length = 0
      if (kind === 'queue') this.queueHead = 0
      else if (kind === 'custom') this.customHead = 0
      else this.presenceHead = 0
    } else if (head > 1024) {
      const next = queue.slice(head)
      queue.length = 0
      queue.push(...next)
      if (kind === 'queue') this.queueHead = 0
      else if (kind === 'custom') this.customHead = 0
      else this.presenceHead = 0
    }
  }

  private hasQueued(): boolean {
    return (
      this.queueHead < this.queue.length ||
      this.customHead < this.customQueue.length ||
      this.presenceHead < this.presenceQueue.length
    )
  }

  private matchedSubscriptions(ws: Socket, channelSet: Set<string>): string[] {
    const matched: string[] = []
    for (const [id, subscribed] of ws.data.subscriptions) {
      for (const channel of subscribed) {
        if (channelSet.has(channel)) {
          matched.push(id)
          break
        }
      }
    }
    return matched
  }

  private emit(
    ws: Socket,
    channels: string[],
    events: string[],
    timestamp: string,
    payload: unknown,
    subscriptions: string[],
    seq?: number,
  ): void {
    if (ws.readyState === 3) return
    ws.send(JSON.stringify({ type: 'event', data: { events, channels, timestamp, payload, subscriptions, ...(seq === undefined ? {} : { seq }) } }))
  }

  private fanoutCustom(e: CustomEvent): void {
    const targets = new Set<Socket>()
    for (const channel of e.channels) {
      const sockets = this.channelIndex.get(channel)
      if (sockets) for (const ws of sockets) targets.add(ws)
    }
    // The payload is identical for every socket, so serialize it once and only
    // append the per-socket channel list and subscription IDs.
    const eventsJson = JSON.stringify(e.events)
    const timestampJson = JSON.stringify(e.timestamp)
    const payloadJson = JSON.stringify(e.payload)
    const seqJson = e.seq === undefined ? '' : `,"seq":${e.seq}`
    const channelJson = new Map<string, string>()
    for (const ws of targets) {
      if (ws.readyState === 3) continue
      // Roles and team membership can change during a long-lived socket; check
      // again at delivery instead of trusting the subscribe-time decision.
      const visible = e.channels.filter((channel) => customChannelAllowed(ws.data.caller, channel))
      if (visible.length === 0) continue
      const matched = this.matchedSubscriptions(ws, new Set(visible))
      if (matched.length === 0) continue
      const key = visible.join('\u0000')
      let channelsJson = channelJson.get(key)
      if (channelsJson === undefined) {
        channelsJson = JSON.stringify(visible)
        channelJson.set(key, channelsJson)
      }
      const head = `{"type":"event","data":{"events":${eventsJson},"channels":${channelsJson},"timestamp":${timestampJson},"payload":${payloadJson}${seqJson},"subscriptions":`
      ws.send(head + JSON.stringify(matched) + '}}')
    }
  }

  private fanoutPresence(e: PresenceEvent): void {
    const id = e.presence.$id
    const channels = ['presences', `presences.${id}`]
    const channelSet = new Set(channels)
    const targets = new Set<Socket>()
    for (const channel of channels) {
      const sockets = this.channelIndex.get(channel)
      if (sockets) for (const ws of sockets) targets.add(ws)
    }
    const events = [`presences.${id}.${e.action}`, `presences.${id}`]
    for (const ws of targets) {
      if (!canSeePresence(ws.data.caller, e.presence)) continue
      const matched = this.matchedSubscriptions(ws, channelSet)
      if (matched.length === 0) continue
      this.emit(ws, channels, events, now(), e.presence, matched)
    }
  }

  private fanout(e: DocEvent): void {
    const channels = channelsOf(e)
    const channelSet = new Set(channels)

    // Union only the sockets subscribed to one of this event's channels.
    const targets = new Set<Socket>()
    for (const channel of channels) {
      const sockets = this.channelIndex.get(channel)
      if (sockets) for (const ws of sockets) targets.add(ws)
    }
    if (targets.size === 0) return

    // The event name/channel/payload JSON is identical for every socket, so
    // serialize it once and only append the per-socket subscription IDs.
    const head =
      '{"type":"event","data":{"events":' +
      JSON.stringify(eventNames(e)) +
      ',"channels":' +
      JSON.stringify(channels) +
      ',"timestamp":' +
      JSON.stringify(now()) +
      ',"payload":' +
      JSON.stringify(e.document) +
      ',"subscriptions":'
    const subscriptionsJson = new Map<string, string>()

    for (const ws of targets) {
      if (ws.readyState === 3) continue
      if (!canRead(ws.data.caller, e)) continue

      const matched: string[] = []
      for (const [id, subscribed] of ws.data.subscriptions) {
        for (const channel of subscribed) {
          if (channelSet.has(channel)) {
            matched.push(id)
            break
          }
        }
      }
      if (matched.length === 0) continue

      const key = matched.join('\u0000')
      let suffix = subscriptionsJson.get(key)
      if (suffix === undefined) {
        suffix = JSON.stringify(matched)
        subscriptionsJson.set(key, suffix)
      }
      ws.send(head + suffix + '}}')
    }
  }

  // ------------------------------------------------------------ presence

  private socketState(ws: Socket): SocketState {
    let meta = this.socketStates.get(ws)
    if (!meta) {
      const nowMs = Date.now()
      meta = {
        connectionId: crypto.randomUUID(),
        ids: new Set(),
        closed: false,
        messageWindowStart: nowMs,
        messageCount: 0,
        presenceWindowStart: nowMs,
        presenceCount: 0,
        lastPresenceTouch: 0,
      }
      this.socketStates.set(ws, meta)
    }
    return meta
  }

  private async upsertPresence(ws: Socket, data: Record<string, unknown>): Promise<void> {
    const user = ws.data.caller.user
    if (!user) {
      send(ws, 'error', { code: 1008, message: 'Presence requires a user session.' })
      return
    }
    const presenceId = typeof data.presenceId === 'string' ? data.presenceId.trim() : ''
    if (!presenceId || presenceId.length > MAX_PRESENCE_ID_LENGTH) {
      send(ws, 'error', { code: 1008, message: 'Presence `presenceId` is required and must be at most 128 characters.' })
      return
    }
    const status = typeof data.status === 'string' ? data.status.trim() : ''
    if (!status || status.length > MAX_PRESENCE_STATUS_LENGTH) {
      send(ws, 'error', { code: 1008, message: 'Presence `status` is required and must be at most 128 characters.' })
      return
    }
    let permissions: string[]
    try {
      permissions = presencePermissions(data.permissions)
    } catch (error) {
      send(ws, 'error', { code: 1008, message: error instanceof Error ? error.message : 'Presence permissions are not valid.' })
      return
    }
    let metadata: Record<string, unknown> | undefined
    if (data.metadata !== undefined) {
      if (!data.metadata || typeof data.metadata !== 'object' || Array.isArray(data.metadata)) {
        send(ws, 'error', { code: 1008, message: 'Presence `metadata` must be an object.' })
        return
      }
      const encoded = JSON.stringify(data.metadata)
      if (Buffer.byteLength(encoded) > MAX_PRESENCE_METADATA_BYTES) {
        send(ws, 'error', { code: 1008, message: 'Presence `metadata` may be at most 4 kB.' })
        return
      }
      metadata = data.metadata as Record<string, unknown>
    }
    const meta = this.socketState(ws)
    if (meta.closed) return
    const nowMs = Date.now()
    if (nowMs - meta.presenceWindowStart >= SOCKET_WINDOW_MS) {
      meta.presenceWindowStart = nowMs
      meta.presenceCount = 0
    }
    if (++meta.presenceCount > MAX_PRESENCE_UPDATES) {
      send(ws, 'error', { code: 1008, message: 'Too many presence updates.' })
      return
    }
    if (!meta.ids.has(presenceId) && meta.ids.size >= MAX_PRESENCE_PER_SOCKET) {
      send(ws, 'error', { code: 1008, message: `A socket may publish at most ${MAX_PRESENCE_PER_SOCKET} presences.` })
      return
    }
    let existing: { user_id: string; created_at: string } | null
    try {
      existing = await this.db.driver.get<{ user_id: string; created_at: string }>(
        'SELECT user_id, created_at FROM _realtime_presence WHERE project_id = ? AND presence_id = ?',
        [this.projectId, presenceId],
      )
    } catch (error) {
      console.error('[realtime] could not read presence:', error)
      send(ws, 'error', { code: 1011, message: 'Could not read presence.' })
      return
    }
    if (existing && existing.user_id !== user.id) {
      send(ws, 'error', { code: 1008, message: `Presence "${presenceId}" is already in use by another user.` })
      return
    }
    const stamp = now()
    const createdAt = existing?.created_at ?? stamp
    const expiresAt = addSeconds(PRESENCE_TTL_MS / 1000)
    const row: PresenceRow = {
      presence_id: presenceId,
      user_id: user.id,
      user_internal_id: String(user.seq),
      socket_id: meta.connectionId,
      status,
      metadata: metadata ? JSON.stringify(metadata) : null,
      permissions: JSON.stringify(permissions),
      source: 'client',
      created_at: createdAt,
      updated_at: stamp,
      expires_at: expiresAt,
    }
    try {
      await this.db.driver.run(
        `INSERT INTO _realtime_presence
           (project_id, presence_id, user_id, user_internal_id, socket_id, status, metadata, permissions, source, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, presence_id) DO UPDATE SET
           user_id = excluded.user_id,
           user_internal_id = excluded.user_internal_id,
           socket_id = excluded.socket_id,
           status = excluded.status,
           metadata = excluded.metadata,
           permissions = excluded.permissions,
           source = excluded.source,
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at`,
        [
          this.projectId,
          row.presence_id,
          row.user_id,
          row.user_internal_id,
          row.socket_id,
          row.status,
          row.metadata,
          row.permissions,
          row.source,
          row.created_at,
          row.updated_at,
          row.expires_at,
        ],
      )
    } catch (error) {
      console.error('[realtime] could not write presence:', error)
      send(ws, 'error', { code: 1011, message: 'Could not save presence.' })
      return
    }
    // The socket may have closed while the write was in flight.
    if (meta.closed) {
      await this.deletePresence(meta)
      return
    }
    meta.ids.add(presenceId)
    this.publishPresence(existing ? 'update' : 'create', presenceModel(row))
    send(ws, 'response', { to: 'presence', success: true })
  }

  private async touchPresence(ws: Socket): Promise<void> {
    const meta = this.socketStates.get(ws)
    if (!meta || meta.closed || meta.ids.size === 0) return
    const nowMs = Date.now()
    if (nowMs - meta.lastPresenceTouch < PRESENCE_TOUCH_INTERVAL_MS) return
    meta.lastPresenceTouch = nowMs
    const expiresAt = addSeconds(PRESENCE_TTL_MS / 1000)
    try {
      await this.db.driver.run('UPDATE _realtime_presence SET expires_at = ? WHERE project_id = ? AND socket_id = ?', [
        expiresAt,
        this.projectId,
        meta.connectionId,
      ])
    } catch {
      /* a closed database during shutdown */
    }
  }

  /** Remove this socket's presence without closing the socket (account switch). */
  private async clearPresence(ws: Socket): Promise<void> {
    const meta = this.socketStates.get(ws)
    if (!meta) return
    meta.ids.clear()
    await this.deletePresence(meta)
  }

  private async removePresence(meta: SocketState): Promise<void> {
    meta.ids.clear()
    await this.deletePresence(meta)
  }

  private async deletePresence(meta: SocketState): Promise<void> {
    let rows: PresenceRow[]
    try {
      rows = await this.db.driver.all<PresenceRow>('SELECT * FROM _realtime_presence WHERE project_id = ? AND socket_id = ?', [
        this.projectId,
        meta.connectionId,
      ])
    } catch {
      return
    }
    for (const row of rows) {
      try {
        const result = await this.db.driver.run(
          'DELETE FROM _realtime_presence WHERE project_id = ? AND presence_id = ? AND socket_id = ?',
          [this.projectId, row.presence_id, meta.connectionId],
        )
        if (result.changes > 0) this.publishPresence('delete', presenceModel(row))
      } catch {
        /* the database may be closing */
      }
    }
  }

  private presenceChannels(ws: Socket): Set<string> {
    const channels = new Set<string>()
    for (const subscribed of ws.data.subscriptions.values()) {
      for (const channel of subscribed) {
        if (channel === 'presences' || channel.startsWith('presences.')) channels.add(channel)
      }
    }
    return channels
  }

  private async sendPresenceSnapshot(ws: Socket): Promise<void> {
    const channels = this.presenceChannels(ws)
    if (channels.size === 0) return
    let rows: PresenceRow[]
    try {
      rows = await this.db.driver.all<PresenceRow>(
        'SELECT * FROM _realtime_presence WHERE project_id = ? AND expires_at > ? ORDER BY created_at LIMIT ?',
        [this.projectId, now(), MAX_PRESENCE_SNAPSHOT],
      )
    } catch {
      return
    }
    for (const row of rows) {
      const presence = presenceModel(row)
      if (!canSeePresence(ws.data.caller, presence)) continue
      const matched = this.matchedSubscriptions(ws, new Set(['presences', `presences.${presence.$id}`]))
      if (matched.length === 0) continue
      const id = presence.$id
      this.emit(ws, ['presences', `presences.${id}`], [`presences.${id}.create`, `presences.${id}`], now(), presence, matched)
    }
  }

  private async prunePresence(): Promise<void> {
    const stamp = now()
    let rows: PresenceRow[]
    try {
      rows = await this.db.driver.all<PresenceRow>(
        'SELECT * FROM _realtime_presence WHERE project_id = ? AND expires_at < ? LIMIT ?',
        [this.projectId, stamp, MAX_PRESENCE_SNAPSHOT],
      )
    } catch {
      return
    }
    for (const row of rows) {
      try {
        const result = await this.db.driver.run(
          'DELETE FROM _realtime_presence WHERE project_id = ? AND presence_id = ? AND expires_at < ?',
          [this.projectId, row.presence_id, stamp],
        )
        if (result.changes > 0) this.publishPresence('delete', presenceModel(row))
      } catch {
        /* the database may be closing */
      }
    }
  }

  private publishPresence(action: PresenceEvent['action'], presence: PresenceRecord): void {
    if (this.stopped) return
    const event: PresenceEvent = { action, presence }
    this.busQueue.push({ kind: 'presence', ...event })
    this.enqueuePresence(event)
  }

  private startPresenceTimer(): void {
    if (this.presenceTimer) return
    this.presenceTimer = setInterval(() => {
      void this.prunePresence().catch((error) => console.error('[realtime] could not prune presence:', error))
    }, PRESENCE_SWEEP_MS)
    this.presenceTimer.unref?.()
  }

  private stopPresenceTimer(): void {
    if (!this.presenceTimer) return
    clearInterval(this.presenceTimer)
    this.presenceTimer = null
  }

  /** Rebuild this socket's entries in the channel index after (un)subscribe. */
  private reindex(ws: Socket): void {
    this.unindex(ws)
    const next = new Set<string>()
    for (const channels of ws.data.subscriptions.values()) {
      for (const channel of channels) next.add(channel)
    }
    for (const channel of next) {
      let sockets = this.channelIndex.get(channel)
      if (!sockets) {
        sockets = new Set()
        this.channelIndex.set(channel, sockets)
      }
      sockets.add(ws)
    }
    this.socketChannels.set(ws, next)
  }

  private unindex(ws: Socket): void {
    const previous = this.socketChannels.get(ws)
    if (!previous) return
    for (const channel of previous) {
      const sockets = this.channelIndex.get(channel)
      if (!sockets) continue
      sockets.delete(ws)
      if (sockets.size === 0) this.channelIndex.delete(channel)
    }
    this.socketChannels.set(ws, new Set())
  }

  private warnDropped(): void {
    const stamp = Date.now()
    if (stamp - this.lastDropWarning < 5000) return
    this.lastDropWarning = stamp
    console.warn(
      `[realtime] event queue full (${MAX_QUEUED_EVENTS}); dropped ${this.droppedEvents} events. ` +
        `A slow consumer or an event burst is outrunning the fan-out loop.`,
    )
  }
}
