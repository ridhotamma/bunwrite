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
 */
import type { ServerWebSocket } from 'bun'

import { findSessionUser, guestCaller, userCaller, type Caller } from '~/auth/caller'
import { accountModel, type UserRowFull } from '~/auth/models'
import { grants } from '~/auth/permissions'
import type { Db } from '~/db/connection'
import type { DocEvent } from '~/documents/store'
import { now } from '~/lib/datetime'

export interface SocketData {
  caller: Caller
  subscriptions: Map<string, string[]>
}

export type Socket = ServerWebSocket<SocketData>

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

export function channelsOf(e: DocEvent): string[] {
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

export class RealtimeHub {
  sockets = new Set<Socket>()

  constructor(private db: Db) {}

  open(ws: Socket): void {
    this.sockets.add(ws)
    send(ws, 'connected', { channels: [], user: userOf(ws.data.caller) })
  }

  close(ws: Socket): void {
    this.sockets.delete(ws)
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
        const found = typeof secret === 'string' ? findSessionUser(this.db, secret) : null
        if (!found) {
          send(ws, 'error', { code: 1003, message: 'Session is not valid.' })
          return
        }
        ws.data.caller = userCaller(this.db, found.user, found.sessionId)
        send(ws, 'response', { to: 'authentication', success: true, user: userOf(ws.data.caller) })
        return
      }
      case 'subscribe':
        for (const row of Array.isArray(message.data) ? message.data : []) {
          if (typeof row?.subscriptionId === 'string' && Array.isArray(row.channels)) {
            ws.data.subscriptions.set(row.subscriptionId, row.channels.map(String))
          }
        }
        send(ws, 'response', { to: 'subscribe', success: true })
        return
      case 'unsubscribe':
        for (const row of Array.isArray(message.data) ? message.data : []) ws.data.subscriptions.delete(row?.subscriptionId)
        send(ws, 'response', { to: 'unsubscribe', success: true })
        return
      default:
        send(ws, 'error', { code: 1003, message: 'Message type is not valid.' })
    }
  }

  publish(events: DocEvent[]): void {
    if (events.length === 0 || this.sockets.size === 0) return
    for (const e of events) {
      const channels = channelsOf(e)
      const names = eventNames(e)
      const timestamp = now()
      for (const ws of this.sockets) {
        const matched: string[] = []
        for (const [id, subscribed] of ws.data.subscriptions) {
          if (subscribed.some((c) => channels.includes(c))) matched.push(id)
        }
        if (matched.length === 0 || !canRead(ws.data.caller, e)) continue
        const hit = channels.filter((c) => [...ws.data.subscriptions.values()].some((s) => s.includes(c)))
        send(ws, 'event', { events: names, channels: hit, timestamp, payload: e.document, subscriptions: matched })
      }
    }
  }
}

export { guestCaller }
