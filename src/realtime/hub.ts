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

import { sessionCaller, type Caller } from '~/auth/caller'
import { accountModel, type UserRowFull } from '~/auth/models'
import { grants } from '~/auth/permissions'
import type { Db } from '~/db/connection'
import type { DocEvent } from '~/documents/store'
import { now } from '~/lib/datetime'
import type { Collection } from '~/schema/types'
import { RealtimeBus, type BusEvent } from './bus'

export interface SocketData {
  caller: Caller
  subscriptions: Map<string, string[]>
  projectId: string
}

export type Socket = ServerWebSocket<SocketData>

/** Keep one abusive client from turning the subscribe message into a memory sink. */
const MAX_SUBSCRIPTIONS = 1000
const MAX_CHANNELS_PER_SUBSCRIPTION = 1000
const MAX_CHANNELS_PER_SOCKET = 2000
const MAX_CHANNEL_LENGTH = 512
const MAX_SUBSCRIPTION_ID_LENGTH = 128

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
  if (caller.privileged || grants(e.collection.permissions, 'read', caller.roles)) return true
  return e.collection.documentSecurity && grants((e.document.$permissions as string[]) ?? [], 'read', caller.roles)
}

export interface RealtimeHubOptions {
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
  private readonly bus: RealtimeBus | null
  private readonly collectionOf: ((databaseId: string, collectionId: string) => Collection | null) | undefined

  /** channel -> sockets subscribed to it, so fan-out never scans unrelated sockets. */
  private readonly channelIndex = new Map<string, Set<Socket>>()
  /** socket -> every channel it currently subscribes to, for cheap re-indexing. */
  private readonly socketChannels = new Map<Socket, Set<string>>()

  private queue: DocEvent[] = []
  private queueHead = 0
  private busQueue: DocEvent[] = []
  private drainScheduled = false
  private droppedEvents = 0
  private lastDropWarning = 0

  constructor(
    private db: Db,
    options: RealtimeHubOptions = {},
  ) {
    this.collectionOf = options.collectionOf
    this.bus = options.bus
      ? new RealtimeBus(db, options.bus.projectId, options.bus.pollMs, (events) => this.deliver(events))
      : null
  }

  open(ws: Socket): void {
    this.sockets.add(ws)
    // A socket may arrive with subscriptions already populated (or from a test
    // harness), so index them before the first event.
    this.reindex(ws)
    this.bus?.setSockets(this.sockets.size)
    send(ws, 'connected', { channels: [], user: userOf(ws.data.caller) })
  }

  close(ws: Socket): void {
    this.sockets.delete(ws)
    this.unindex(ws)
    this.socketChannels.delete(ws)
    this.bus?.setSockets(this.sockets.size)
  }

  message(ws: Socket, raw: string | Buffer): void {
    let message: { type?: string; data?: any }
    try {
      message = JSON.parse(String(raw))
    } catch {
      send(ws, 'error', { code: 1003, message: 'Message format is not valid.' })
      return
    }
    switch (message.type) {
      case 'ping':
        send(ws, 'pong', null)
        return
      case 'authentication': {
        const secret = message.data?.session
        const caller = typeof secret === 'string' ? sessionCaller(this.db, secret) : null
        if (!caller) {
          send(ws, 'error', { code: 1003, message: 'Session is not valid.' })
          return
        }
        ws.data.caller = caller
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
        for (const [id, channels] of next) ws.data.subscriptions.set(id, channels)
        this.reindex(ws)
        send(ws, 'response', { to: 'subscribe', success: true })
        return
      }
      case 'unsubscribe':
        for (const row of Array.isArray(message.data) ? message.data : []) {
          if (typeof row?.subscriptionId === 'string') ws.data.subscriptions.delete(row.subscriptionId)
        }
        this.reindex(ws)
        send(ws, 'response', { to: 'unsubscribe', success: true })
        return
      default:
        send(ws, 'error', { code: 1003, message: 'Message type is not valid.' })
    }
  }

  publish(events: DocEvent[]): void {
    if (events.length === 0) return
    // Other workers need these events even when this process has no sockets.
    this.busQueue.push(...events)
    this.enqueue(events)
  }

  /** Delivery from another worker's bus row: fan out locally, never re-publish. */
  private deliver(events: BusEvent[]): void {
    const local: DocEvent[] = []
    for (const event of events) {
      const collection = this.collectionOf?.(event.databaseId, event.collectionId)
      // The collection may have been deleted since the writer saw it.
      if (!collection) continue
      local.push({ collection, action: event.action, document: event.document })
    }
    if (local.length) this.enqueue(local)
  }

  /** Stop timers and release every socket reference; called when a project runtime closes. */
  stop(): void {
    this.bus?.stop()
    this.sockets.clear()
    this.channelIndex.clear()
    this.socketChannels.clear()
    this.queue = []
    this.queueHead = 0
    this.busQueue = []
  }

  /** The database was replaced; ignore sequence numbers from the old one. */
  resetBus(): void {
    this.bus?.reset()
  }

  /** Drop expired bus rows; runs with the leader's cleanup. */
  pruneBus(): void {
    this.bus?.prune()
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

  private scheduleDrain(): void {
    if (this.drainScheduled) return
    this.drainScheduled = true
    // setImmediate (not queueMicrotask) lets the HTTP response leave before the fan-out runs.
    setImmediate(() => this.drain())
  }

  private drain(): void {
    this.drainScheduled = false
    const deadline = performance.now() + DRAIN_BUDGET_MS

    // Tell other workers first; they may have sockets this process cannot see.
    if (this.busQueue.length > 0) {
      const batch = this.busQueue
      this.busQueue = []
      this.bus?.send(batch)
    }

    while (this.queueHead < this.queue.length) {
      const event = this.queue[this.queueHead++]!
      try {
        this.fanout(event)
      } catch (error) {
        // One malformed event must not stall every later subscription.
        console.error('[realtime] could not fan out an event:', error)
      }
      if (performance.now() >= deadline) break
    }

    if (this.queueHead >= this.queue.length) {
      this.queue.length = 0
      this.queueHead = 0
    } else if (this.queueHead > 1024) {
      // Compact instead of letting the head offset grow forever.
      this.queue = this.queue.slice(this.queueHead)
      this.queueHead = 0
    }
    if (this.queueHead < this.queue.length) this.scheduleDrain()
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
