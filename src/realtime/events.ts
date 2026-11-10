/**
 * Event shapes shared by the realtime hub and the cross-process bus.
 *
 * A document change, a custom publish and a presence change all travel over
 * the same bus, so every worker fans out the same kind of payload to its own
 * sockets.
 */
import type { Doc } from '~/documents/codec'
import type { DocEvent } from '~/documents/store'

/** One document change. */
export interface DocumentBusEvent {
  kind: 'document'
  databaseId: string
  collectionId: string
  action: DocEvent['action']
  document: Doc
}

/** A server-published custom event. */
export interface CustomEvent {
  channels: string[]
  events: string[]
  payload: unknown
  timestamp: string
  /** History sequence, present once the event has been persisted. */
  seq?: number
}

export interface CustomBusEvent extends CustomEvent {
  kind: 'custom'
}

/** A custom event as returned by the replay endpoint. */
export interface StoredCustomEvent extends CustomEvent {
  seq: number
}

/** A presence row in the shape the browser SDK expects (`RealtimePresence`). */
export interface PresenceRecord {
  $id: string
  $createdAt: string
  $updatedAt: string
  $permissions: string[]
  userInternalId: string
  userId: string
  status: string
  source: string
  metadata?: Record<string, unknown>
}

export interface PresenceEvent {
  action: 'create' | 'update' | 'delete'
  presence: PresenceRecord
}

/** A presence row with its expiry, for the console and admin views. */
export interface PresenceListItem extends PresenceRecord {
  $expiresAt: string
}

export interface PresenceBusEvent extends PresenceEvent {
  kind: 'presence'
}

export type BusEvent = DocumentBusEvent | CustomBusEvent | PresenceBusEvent
