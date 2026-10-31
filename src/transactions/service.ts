/**
 * Appwrite database transactions.
 *
 * Writes sent with a `transactionId` are validated and staged in
 * `_transaction_logs`; nothing touches the collections until commit. Commit
 * replays every operation inside one transaction and fails with
 * `transaction_conflict` when a document changed after its operation was
 * staged — the optimistic check inventory-style apps rely on.
 *
 * Reads sent with a `transactionId` see the staged writes: the operations are
 * replayed inside a savepoint, the read runs, and the savepoint is rolled back.
 *
 * Replay lives in `replay.ts`; the store carries the transaction implicitly,
 * so the normal write methods join the commit transaction.
 */
import { assertCallerScope, type Caller } from '~/auth/caller'
import { aggregatePermissions, grants, parsePermission } from '~/auth/permissions'
import type { SqlDatabase } from '~/db/driver'
import { addSeconds, now } from '~/lib/datetime'
import { BunwriteError, err } from '~/lib/errors'
import { resolveId, uniqueId } from '~/lib/ids'
import { encodeAttributes, type Doc } from '~/documents/codec'
import { ConflictError, type DocumentBackend } from '~/documents/store'
import type { Registry } from '~/schema/registry'
import type { Collection } from '~/schema/types'
import { documentsOf, numberOf, queriesOf, recordOf, stringOf } from './payload'
import { commitLogs, replayStaged } from './replay'

export const TTL_MIN = 60
export const TTL_MAX = 3600
export const TTL_DEFAULT = 300
export const MAX_OPERATIONS = 1000

export type Action = 'create' | 'update' | 'upsert' | 'delete' | 'increment' | 'decrement' | 'bulkCreate' | 'bulkUpdate' | 'bulkUpsert' | 'bulkDelete'

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

export interface LogRow {
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
  /** Payload from the request; each action narrows the fields it uses. */
  data: Record<string, unknown>
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
    private db: SqlDatabase,
    private registry: Registry,
    private store: DocumentBackend,
  ) {}

  private async find(caller: Caller, id: string): Promise<TxRow> {
    const row = await this.db.driver.get<TxRow>('SELECT * FROM _transactions WHERE id = ?', [id])
    if (!row || (!caller.privileged && row.user_id !== (caller.user?.id ?? null))) {
      throw err('transaction_not_found', undefined, [id])
    }
    return row
  }

  async create(caller: Caller, ttl: number = TTL_DEFAULT) {
    assertCallerScope(caller, 'documents.write')
    if (!Number.isInteger(ttl) || ttl < TTL_MIN || ttl > TTL_MAX) {
      throw err('general_argument_invalid', `Invalid \`ttl\` param: Value must be a valid range between ${TTL_MIN} and ${TTL_MAX.toLocaleString('en-US')}`)
    }
    if (!caller.privileged && !caller.user) throw err('user_unauthorized')
    const stamp = now()
    const row = await this.db.driver.get<TxRow>(
      `INSERT INTO _transactions (id, status, operations, expires_at, user_id, created_at, updated_at)
       VALUES (?, 'pending', 0, ?, ?, ?, ?) RETURNING *`,
      [uniqueId(), addSeconds(ttl), caller.user?.id ?? null, stamp, stamp],
    )
    return txModel(row!)
  }

  async get(caller: Caller, id: string) {
    assertCallerScope(caller, 'documents.read')
    return txModel(await this.find(caller, id))
  }

  async list(caller: Caller) {
    assertCallerScope(caller, 'documents.read')
    const rows = caller.privileged
      ? await this.db.driver.all<TxRow>('SELECT * FROM _transactions ORDER BY seq')
      : await this.db.driver.all<TxRow>('SELECT * FROM _transactions WHERE user_id = ? ORDER BY seq', [caller.user?.id ?? ''])
    return { total: rows.length, transactions: rows.map(txModel) }
  }

  async delete(caller: Caller, id: string): Promise<void> {
    assertCallerScope(caller, 'documents.write')
    const row = await this.find(caller, id)
    await this.db.driver.run('DELETE FROM _transactions WHERE seq = ?', [row.seq])
  }

  private async pending(caller: Caller, id: string): Promise<TxRow> {
    const row = await this.find(caller, id)
    if (row.status !== 'pending') throw err('transaction_not_ready')
    if (row.expires_at < now()) throw err('transaction_expired')
    return row
  }

  private async logs(tx: TxRow): Promise<LogRow[]> {
    return this.db.driver.all<LogRow>('SELECT * FROM _transaction_logs WHERE transaction_seq = ? ORDER BY seq', [tx.seq])
  }

  private async stagedCreate(tx: TxRow, collection: Collection, documentId: string): Promise<boolean> {
    return (await this.logs(tx)).some(
      (l) =>
        l.database_id === collection.databaseId &&
        l.collection_id === collection.id &&
        (l.action === 'create' || l.action === 'upsert') &&
        l.document_id === documentId,
    )
  }

  /**
   * Validate an operation as the caller and store it in a form that commit can
   * replay with full privileges: IDs and permissions are resolved now.
   */
  async stage(caller: Caller, transactionId: string, input: StageInput): Promise<void> {
    assertCallerScope(caller, 'documents.write')
    const tx = await this.pending(caller, transactionId)
    if (tx.operations + 1 > MAX_OPERATIONS) {
      throw err('transaction_limit_exceeded', `Transaction already has ${tx.operations} operations, adding 1 would exceed the maximum of ${MAX_OPERATIONS}`)
    }
    const collection = this.registry.collection(input.databaseId, input.collectionId, caller.privileged)
    const data = await this.prepare(caller, tx, collection, input)
    const stamp = now()
    await this.db.driver.transaction(async (db) => {
      await db.run(
        `INSERT INTO _transaction_logs (transaction_seq, database_id, collection_id, document_id, action, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [tx.seq, input.databaseId, input.collectionId, input.documentId ?? null, input.action, JSON.stringify(data), stamp],
      )
      await db.run('UPDATE _transactions SET operations = operations + 1, updated_at = ? WHERE seq = ?', [stamp, tx.seq])
    })
  }

  private async prepare(caller: Caller, tx: TxRow, collection: Collection, input: StageInput): Promise<Record<string, unknown>> {
    const { action, data } = input
    const stripDates = (d: Record<string, unknown>) => {
      if (caller.privileged) return d
      const { $createdAt, $updatedAt, ...rest } = d
      return rest
    }
    const userDefaults = () =>
      caller.privileged || !caller.user ? [] : [`read("user:${caller.user.id}")`, `update("user:${caller.user.id}")`, `delete("user:${caller.user.id}")`]
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
    const requireExisting = async (type: 'update' | 'delete') => {
      const id = input.documentId!
      const doc = await this.store.checkStagedWrite(caller, collection, id, type)
      if (!doc && !(await this.stagedCreate(tx, collection, id))) throw err('document_not_found', undefined, [id])
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
        const payload = stripDates(recordOf(data.data))
        encodeAttributes(collection, payload, 'create')
        return { data: payload, permissions: resolvePerms(data.permissions) ?? userDefaults() }
      }
      case 'update': {
        await requireExisting('update')
        const payload = stripDates(recordOf(data.data))
        encodeAttributes(collection, payload, 'update')
        return { data: payload, permissions: resolvePerms(data.permissions) }
      }
      case 'upsert': {
        const existing = await this.store.checkStagedWrite(caller, collection, input.documentId!, 'update')
        if (!existing) canCreate()
        const payload = stripDates(recordOf(data.data))
        encodeAttributes(collection, payload, existing ? 'update' : 'create')
        return { data: payload, permissions: resolvePerms(data.permissions) ?? (existing ? null : userDefaults()) }
      }
      case 'delete':
        await requireExisting('delete')
        return {}
      case 'increment':
      case 'decrement':
        await requireExisting('update')
        return { attribute: stringOf(data.attribute), value: numberOf(data.value) ?? 1, bound: numberOf(data.bound) }
      case 'bulkCreate':
      case 'bulkUpsert':
        bulkOnly()
        return {
          documents: documentsOf(data.documents).map((d) => {
            const id = action === 'bulkCreate' ? resolveId(d.$id ?? 'unique()', 'Document ID') : d.$id
            const { $id, $permissions, ...rest } = d
            encodeAttributes(collection, rest, action === 'bulkCreate' ? 'create' : 'update')
            return { ...rest, $id: id, $permissions: $permissions ?? null }
          }),
        }
      case 'bulkUpdate':
        bulkOnly()
        encodeAttributes(collection, recordOf(data.data), 'update')
        return { data: recordOf(data.data), queries: queriesOf(data.queries) }
      case 'bulkDelete':
        bulkOnly()
        return { queries: queriesOf(data.queries) }
    }
  }

  /** Run `read` with the transaction's staged writes visible. */
  async withStaged<T>(caller: Caller, transactionId: string | undefined, read: () => Promise<T> | T): Promise<T> {
    if (!transactionId) return read()
    const tx = await this.find(caller, transactionId)
    const logs = tx.status === 'pending' ? await this.logs(tx) : []
    if (logs.length === 0) return read()
    return replayStaged(this.registry, this.store, logs, read)
  }

  private async setStatus(seq: number, status: string): Promise<TxRow> {
    return (await this.db.driver.get<TxRow>('UPDATE _transactions SET status = ?, updated_at = ? WHERE seq = ? RETURNING *', [status, now(), seq]))!
  }

  async update(caller: Caller, id: string, commit: boolean, rollback: boolean) {
    assertCallerScope(caller, 'documents.write')
    if (commit === rollback) {
      throw err('general_argument_invalid', 'Exactly one of `commit` or `rollback` must be true.')
    }
    const tx = await this.find(caller, id)

    if (rollback) {
      if (tx.status !== 'pending' && tx.status !== 'failed') throw err('transaction_not_ready')
      await this.db.driver.run('DELETE FROM _transaction_logs WHERE transaction_seq = ?', [tx.seq])
      return txModel(await this.setStatus(tx.seq, 'rolledBack'))
    }

    if (tx.status !== 'pending') throw err('transaction_not_ready')
    if (tx.expires_at < now()) throw err('transaction_expired')

    const logs = await this.logs(tx)
    try {
      await commitLogs(this.registry, this.store, logs)
    } catch (error) {
      await this.setStatus(tx.seq, 'failed')
      if (error instanceof ConflictError) throw err('transaction_conflict')
      if (error instanceof BunwriteError) throw error
      throw error
    }
    await this.db.driver.run('DELETE FROM _transaction_logs WHERE transaction_seq = ?', [tx.seq])
    return txModel(await this.setStatus(tx.seq, 'committed'))
  }

  /** Remove transactions that expired or finished more than an hour ago. */
  async prune(): Promise<number> {
    const cutoff = addSeconds(-TTL_MAX)
    const result = await this.db.driver.run('DELETE FROM _transactions WHERE expires_at < ? OR (status != ? AND updated_at < ?)', [cutoff, 'pending', cutoff])
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
    $revision: 0,
    ...(base ?? {}),
    ...rest,
  } as Doc
}
