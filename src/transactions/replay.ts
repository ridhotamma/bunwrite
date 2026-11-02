/**
 * Replaying a transaction's staged operations.
 *
 * Commit and staged reads share the same replay: each log row is applied with
 * the normal store write methods (the store carries the transaction), and the
 * caller decides whether to commit or roll back.
 */
import { keyCaller } from '~/auth/caller'
import type { DocEvent, DocumentBackend, Guard } from '~/documents/store'
import type { Registry } from '~/schema/registry'
import { documentsOf, numberOf, queriesOf, recordOf, stringOf } from './payload'
import type { LogRow } from './service'

/** Apply one staged operation inside the current transaction. */
export async function applyLog(
  registry: Registry,
  store: DocumentBackend,
  log: LogRow,
  guard?: Guard,
  events?: DocEvent[],
): Promise<void> {
  const caller = keyCaller()
  const collection = registry.collection(log.database_id, log.collection_id, true)
  const data = recordOf(JSON.parse(log.data ?? '{}'))
  const id = log.document_id!
  // A preview must not append to the shared event buffer: a concurrent real
  // write would then be truncated away by the caller.
  const options = events ? { guard, events } : { guard }
  switch (log.action) {
    case 'create':
      await store.createDocument(caller, collection, { id, data: recordOf(data.data), permissions: data.permissions }, options)
      break
    case 'update':
      await store.updateDocument(caller, collection, id, recordOf(data.data), data.permissions, options)
      break
    case 'upsert':
      await store.upsertDocument(caller, collection, id, recordOf(data.data), data.permissions, options)
      break
    case 'delete':
      await store.deleteDocument(caller, collection, id, options)
      break
    case 'increment':
    case 'decrement':
      await store.incrementAttribute(
        caller,
        collection,
        id,
        stringOf(data.attribute) ?? '',
        numberOf(data.value) ?? 1,
        numberOf(data.bound),
        log.action === 'increment' ? 1 : -1,
        options,
      )
      break
    case 'bulkCreate':
      await store.createDocuments(caller, collection, documentsOf(data.documents), options)
      break
    case 'bulkUpsert':
      await store.upsertDocuments(caller, collection, documentsOf(data.documents), options)
      break
    case 'bulkUpdate':
      await store.updateDocuments(caller, collection, recordOf(data.data), queriesOf(data.queries), options)
      break
    case 'bulkDelete':
      await store.deleteDocuments(caller, collection, queriesOf(data.queries), options)
      break
  }
}

/** Replay every operation inside one transaction. */
export async function commitLogs(registry: Registry, store: DocumentBackend, logs: LogRow[]): Promise<void> {
  await store.runInTransaction(async () => {
    const touched = new Set<string>()
    for (const log of logs) await applyLog(registry, store, log, { before: log.created_at, touched })
  })
}

/**
 * Run `read` with the transaction's staged writes visible, then roll them back.
 * A staged write that cannot apply yet is simply not visible.
 */
export async function replayStaged<T>(registry: Registry, store: DocumentBackend, logs: LogRow[], read: () => Promise<T> | T): Promise<T> {
  // A staged write is not real: never fill (or read) the list cache here, and
  // collect its events privately instead of touching the process-wide buffer.
  const events: DocEvent[] = []
  store.beginStagedRead()
  try {
    return await store.preview(async () => {
      for (const log of logs) {
        try {
          await applyLog(registry, store, log, undefined, events)
        } catch {
          // Not visible yet.
        }
      }
      return await read()
    })
  } finally {
    store.endStagedRead()
  }
}
