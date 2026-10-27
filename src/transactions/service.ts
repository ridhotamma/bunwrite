/**
 * Appwrite database transactions.
 *
 * Writes sent with a `transactionId` are validated and staged in
 * `_transaction_logs`; nothing touches the collections until commit. Commit
 * replays every operation inside one SQLite transaction and fails with
 * `transaction_conflict` when a document changed after its operation was
 * staged — the optimistic check pesanle's stock code relies on.
 *
 * Reads sent with a `transactionId` see the staged writes: the operations are
 * replayed inside a savepoint, the read runs, and the savepoint is rolled back.
 */
import { keyCaller, type Caller } from '../auth/caller'
import { aggregatePermissions, grants, parsePermission } from '../auth/permissions'
import type { Db } from '../db/connection'
import { addSeconds, now } from '../lib/datetime'
import { AppwriteError, err } from '../lib/errors'
import { resolveId, uniqueId } from '../lib/ids'
import { encodeAttributes, type Doc } from '../documents/codec'
import { ConflictError, DocumentStore, type Guard } from '../documents/store'
import type { Registry } from '../schema/registry'
import type { Collection } from '../schema/types'

export const TTL_MIN = 60
export const TTL_MAX = 3600
export const TTL_DEFAULT = 300
export const MAX_OPERATIONS = 1000

export type Action =
  | 'create'
  | 'update'
  | 'upsert'
  | 'delete'
  | 'increment'
  | 'decrement'
  | 'bulkCreate'
  | 'bulkUpdate'
  | 'bulkUpsert'
  | 'bulkDelete'

interface TxRow {
  seq: number
  id: string
  status: string
  operations: number
  expires_at: string
  user_id: string | null
  created_at: string
  updated_at: string
}

interface LogRow {
  seq: number
  database_id: string
  collection_id: string
  document_id: string | null
  action: Action
  data: string | null
  created_at: string
}

export interface StageInput {
  databaseId: string
  collectionId: string
  documentId?: string | null
  action: Action
  data: Record<string, any>
}

export function txModel(row: TxRow) {
  return {
    $id: row.id,
    $createdAt: row.created_at,
    $updatedAt: row.updated_at,
    status: row.status,
    operations: row.operations,
    expiresAt: row.expires_at,
  }
}

export class TransactionService {
  constructor(
    private db: Db,
    private registry: Registry,
    private store: DocumentStore,
  ) {}

  private find(caller: Caller, id: string): TxRow {
    const row = this.db.sqlite.query<TxRow, [string]>('SELECT * FROM _transactions WHERE id = ?').get(id)
    if (!row || (!caller.privileged && row.user_id !== (caller.user?.id ?? null))) {
      throw err('transaction_not_found', undefined, [id])
    }
    return row
  }

  create(caller: Caller, ttl: number = TTL_DEFAULT) {
    if (!Number.isInteger(ttl) || ttl < TTL_MIN || ttl > TTL_MAX) {
      throw err('general_argument_invalid', `Invalid \`ttl\` param: Value must be a valid range between ${TTL_MIN} and ${TTL_MAX.toLocaleString('en-US')}`)
    }
    if (!caller.privileged && !caller.user) throw err('user_unauthorized')
    const stamp = now()
    const row = this.db.sqlite
      .query<TxRow, any[]>(
        `INSERT INTO _transactions (id, status, operations, expires_at, user_id, created_at, updated_at)
         VALUES (?, 'pending', 0, ?, ?, ?, ?) RETURNING *`,
      )
      .get(uniqueId(), addSeconds(ttl), caller.user?.id ?? null, stamp, stamp)!
    return txModel(row)
  }

  get(caller: Caller, id: string) {
    return txModel(this.find(caller, id))
  }

  list(caller: Caller) {
    const rows = caller.privileged
      ? this.db.sqlite.query<TxRow, []>('SELECT * FROM _transactions ORDER BY seq').all()
      : this.db.sqlite.query<TxRow, [string]>('SELECT * FROM _transactions WHERE user_id = ? ORDER BY seq').all(caller.user?.id ?? '')
    return { total: rows.length, transactions: rows.map(txModel) }
  }

  delete(caller: Caller, id: string): void {
    const row = this.find(caller, id)
    this.db.sqlite.query('DELETE FROM _transactions WHERE seq = ?').run(row.seq)
  }

  private pending(caller: Caller, id: string): TxRow {
    const row = this.find(caller, id)
    if (row.status !== 'pending') throw err('transaction_not_ready')
    if (row.expires_at < now()) throw err('transaction_expired')
    return row
  }

  private logs(tx: TxRow): LogRow[] {
    return this.db.sqlite.query<LogRow, [number]>('SELECT * FROM _transaction_logs WHERE transaction_seq = ? ORDER BY seq').all(tx.seq)
  }

  private stagedCreate(tx: TxRow, collection: Collection, documentId: string): boolean {
    return this.logs(tx).some(
      (l) =>
        l.database_id === collection.databaseId &&
        l.collection_id === collection.id &&
        ((l.action === 'create' || l.action === 'upsert') && l.document_id === documentId),
    )
  }

  /**
   * Validate an operation as the caller and store it in a form that commit can
   * replay with full privileges: IDs and permissions are resolved now.
   */
  stage(caller: Caller, transactionId: string, input: StageInput): void {
    const tx = this.pending(caller, transactionId)
    if (tx.operations + 1 > MAX_OPERATIONS) {
      throw err(
        'transaction_limit_exceeded',
        `Transaction already has ${tx.operations} operations, adding 1 would exceed the maximum of ${MAX_OPERATIONS}`,
      )
    }
    const collection = this.registry.collection(input.databaseId, input.collectionId, caller.privileged)
    const data = this.prepare(caller, tx, collection, input)
    const stamp = now()
    this.db.sqlite.transaction(() => {
      this.db.sqlite
        .query(
          `INSERT INTO _transaction_logs (transaction_seq, database_id, collection_id, document_id, action, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(tx.seq, input.databaseId, input.collectionId, input.documentId ?? null, input.action, JSON.stringify(data), stamp)
      this.db.sqlite.query('UPDATE _transactions SET operations = operations + 1, updated_at = ? WHERE seq = ?').run(stamp, tx.seq)
    })()
  }

  private prepare(caller: Caller, tx: TxRow, collection: Collection, input: StageInput): Record<string, any> {
    const { action, data } = input
    const stripDates = (d: Record<string, any>) => {
      if (caller.privileged) return d
      const { $createdAt, $updatedAt, ...rest } = d
      return rest
    }
    const userDefaults = () =>
      caller.privileged || !caller.user
        ? []
        : [`read("user:${caller.user.id}")`, `update("user:${caller.user.id}")`, `delete("user:${caller.user.id}")`]
    const resolvePerms = (p: unknown) => {
      const list = aggregatePermissions(p)
      if (list && !caller.privileged) {
        for (const perm of list) {
          if (!caller.roles.has(parsePermission(perm).role)) {
            throw err('user_unauthorized', `Permissions must be one of: (${[...caller.roles].join(', ')})`)
          }
        }
      }
      return list
    }
    const requireExisting = (type: 'update' | 'delete') => {
      const id = input.documentId!
      const doc = this.store.checkStagedWrite(caller, collection, id, type)
      if (!doc && !this.stagedCreate(tx, collection, id)) throw err('document_not_found', undefined, [id])
    }
    const canCreate = () => {
      if (!caller.privileged && !grants(collection.permissions, 'create', caller.roles)) throw err('user_unauthorized')
    }
    const bulkOnly = () => {
      if (!caller.privileged) throw err('general_unauthorized_scope')
    }

    switch (action) {
      case 'create': {
        canCreate()
        const id = resolveId(input.documentId, 'Document ID')
        input.documentId = id
        const payload = stripDates(data.data ?? {})
        encodeAttributes(collection, payload, 'create')
        return { data: payload, permissions: resolvePerms(data.permissions) ?? userDefaults() }
      }
      case 'update': {
        requireExisting('update')
        const payload = stripDates(data.data ?? {})
        encodeAttributes(collection, payload, 'update')
        return { data: payload, permissions: resolvePerms(data.permissions) }
      }
      case 'upsert': {
        const existing = this.store.checkStagedWrite(caller, collection, input.documentId!, 'update')
        if (!existing) canCreate()
        const payload = stripDates(data.data ?? {})
        encodeAttributes(collection, payload, existing ? 'update' : 'create')
        return { data: payload, permissions: resolvePerms(data.permissions) ?? (existing ? null : userDefaults()) }
      }
      case 'delete':
        requireExisting('delete')
        return {}
      case 'increment':
      case 'decrement':
        requireExisting('update')
        return { attribute: data.attribute, value: data.value ?? 1, bound: data.bound ?? null }
      case 'bulkCreate':
      case 'bulkUpsert':
        bulkOnly()
        return {
          documents: (data.documents ?? []).map((d: Record<string, any>) => {
            const id = action === 'bulkCreate' ? resolveId(d.$id ?? 'unique()', 'Document ID') : d.$id
            const { $id, $permissions, ...rest } = d
            encodeAttributes(collection, rest, action === 'bulkCreate' ? 'create' : 'update')
            return { ...rest, $id: id, $permissions: $permissions ?? null }
          }),
        }
      case 'bulkUpdate':
        bulkOnly()
        encodeAttributes(collection, data.data ?? {}, 'update')
        return { data: data.data ?? {}, queries: data.queries ?? [] }
      case 'bulkDelete':
        bulkOnly()
        return { queries: data.queries ?? [] }
    }
  }

  /** Apply one staged operation. */
  private apply(log: LogRow, guard?: Guard): void {
    const caller = keyCaller()
    const collection = this.registry.collection(log.database_id, log.collection_id, true)
    const data = JSON.parse(log.data ?? '{}')
    const id = log.document_id!
    const options = { guard }
    const store = this.store
    switch (log.action) {
      case 'create':
        store.createDocument(caller, collection, { id, data: data.data, permissions: data.permissions }, options)
        break
      case 'update':
        store.updateDocument(caller, collection, id, data.data, data.permissions, options)
        break
      case 'upsert':
        store.upsertDocument(caller, collection, id, data.data, data.permissions, options)
        break
      case 'delete':
        store.deleteDocument(caller, collection, id, options)
        break
      case 'increment':
      case 'decrement':
        store.incrementAttribute(caller, collection, id, data.attribute, data.value, data.bound, log.action === 'increment' ? 1 : -1, options)
        break
      case 'bulkCreate':
        store.createDocuments(caller, collection, data.documents, options)
        break
      case 'bulkUpsert':
        store.upsertDocuments(caller, collection, data.documents, options)
        break
      case 'bulkUpdate':
        store.updateDocuments(caller, collection, data.data, data.queries, options)
        break
      case 'bulkDelete':
        store.deleteDocuments(caller, collection, data.queries, options)
        break
    }
  }

  /** Run `read` with the transaction's staged writes visible. */
  withStaged<T>(caller: Caller, transactionId: string | undefined, read: () => T): T {
    if (!transactionId) return read()
    const tx = this.find(caller, transactionId)
    const logs = tx.status === 'pending' ? this.logs(tx) : []
    if (logs.length === 0) return read()
    const sqlite = this.db.sqlite
    const events = this.store.events.length
    sqlite.run('SAVEPOINT staged_read')
    try {
      for (const log of logs) {
        try {
          this.apply(log)
        } catch {
          // A staged write that cannot apply (yet) is simply not visible.
        }
      }
      return read()
    } finally {
      sqlite.run('ROLLBACK TO staged_read')
      sqlite.run('RELEASE staged_read')
      // Replayed writes were never real; nobody may hear about them.
      this.store.events.length = events
    }
  }

  private setStatus(seq: number, status: string): TxRow {
    return this.db.sqlite
      .query<TxRow, [string, string, number]>('UPDATE _transactions SET status = ?, updated_at = ? WHERE seq = ? RETURNING *')
      .get(status, now(), seq)!
  }

  update(caller: Caller, id: string, commit: boolean, rollback: boolean) {
    if (commit === rollback) {
      throw err('general_argument_invalid', 'Exactly one of `commit` or `rollback` must be true.')
    }
    const tx = this.find(caller, id)

    if (rollback) {
      if (tx.status !== 'pending' && tx.status !== 'failed') throw err('transaction_not_ready')
      this.db.sqlite.query('DELETE FROM _transaction_logs WHERE transaction_seq = ?').run(tx.seq)
      return txModel(this.setStatus(tx.seq, 'rolledBack'))
    }

    if (tx.status !== 'pending') throw err('transaction_not_ready')
    if (tx.expires_at < now()) throw err('transaction_expired')

    const logs = this.logs(tx)
    try {
      this.db.sqlite
        .transaction(() => {
          const touched = new Set<string>()
          for (const log of logs) this.apply(log, { before: log.created_at, touched })
        })
        .immediate()
    } catch (error) {
      this.setStatus(tx.seq, 'failed')
      if (error instanceof ConflictError) throw err('transaction_conflict')
      if (error instanceof AppwriteError) throw error
      throw error
    }
    this.db.sqlite.query('DELETE FROM _transaction_logs WHERE transaction_seq = ?').run(tx.seq)
    return txModel(this.setStatus(tx.seq, 'committed'))
  }

  /** Remove transactions that expired or finished more than an hour ago. */
  prune(): number {
    const cutoff = addSeconds(-TTL_MAX)
    const result = this.db.sqlite
      .query("DELETE FROM _transactions WHERE expires_at < ? OR (status != 'pending' AND updated_at < ?)")
      .run(cutoff, cutoff)
    return result.changes
  }
}

/**
 * The mock document Appwrite returns for a staged write: system fields it
 * cannot know yet are empty, then `base` (the current document, for updates)
 * and the staged data on top.
 */
export function mockDocument(collection: Collection, id: string, data: Record<string, unknown>, base?: Doc | null): Doc {
  const { $permissions, ...rest } = data
  return {
    $id: id,
    $sequence: '',
    $collectionId: collection.id,
    $databaseId: collection.databaseId,
    $createdAt: '',
    $updatedAt: '',
    $permissions: [],
    ...(base ?? {}),
    ...rest,
  } as Doc
}
