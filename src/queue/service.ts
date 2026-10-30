/**
 * The built-in job queue: a durable, SQLite-backed message table that SDK
 * workers claim over HTTP (see docs/QUEUE.md). Bunwrite stores the state and
 * leases; the handler runs in the worker's own process.
 *
 * Semantics are at-least-once: a claim moves the message to `processing` with
 * a lease, and a worker that dies before acking loses the lease, so the
 * message is delivered again. Handlers should be idempotent.
 */
import { isLeader } from '~/cluster/role'
import type { Db } from '~/db/connection'
import { addSeconds, formatDate, now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { resolveId } from '~/lib/ids'

export interface QueueMessageRow {
  seq: number
  id: string
  queue: string
  status: string
  data: string
  attempts: number
  max_attempts: number
  available_at: string
  lease_until: string | null
  idempotency_key: string | null
  result: string
  errors: string
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface EnqueueInput {
  data?: unknown
  /** Message ID; `unique()` or omitted for a new one. */
  id?: unknown
  /** Seconds to wait before the message is claimable. */
  delay?: number
  maxAttempts?: number
  /** Enqueueing the same key twice returns the first message instead of a second one. */
  idempotencyKey?: string
}

export interface ClaimOptions {
  count?: number
  /** Lease length in seconds; the worker must heartbeat or ack before it ends. */
  lease?: number
}

const QUEUE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** Queues Bunwrite itself uses, such as `_render`. The public API cannot reach them. */
const SYSTEM_QUEUE = /^_[a-z][a-z0-9_-]{0,62}$/
const MAX_LEASE = 86_400
const MAX_DELAY = 7 * 86_400
const DEFAULT_LIST_LIMIT = 25
const MAX_LIST_LIMIT = 5000

/** Queue model field → SQLite column, for list filters and ordering. */
const LIST_FIELDS: Record<string, string> = {
  $id: 'id',
  $createdAt: 'created_at',
  $updatedAt: 'updated_at',
  $sequence: 'seq',
  seq: 'seq',
  queue: 'queue',
  status: 'status',
  attempts: 'attempts',
  maxAttempts: 'max_attempts',
  availableAt: 'available_at',
  leaseUntil: 'lease_until',
  completedAt: 'completed_at',
  idempotencyKey: 'idempotency_key',
}

interface ListQuery {
  method: string
  attribute?: string
  values?: unknown[]
}

function listQuery(raw: unknown): ListQuery {
  try {
    const query = (typeof raw === 'string' ? JSON.parse(raw) : raw) as ListQuery
    if (!query || typeof query.method !== 'string') throw new Error()
    return query
  } catch {
    throw err('general_argument_invalid', `Invalid \`queries\` param: ${String(raw)}`)
  }
}

/** The claim token: the message's `attempts` value returned by `claim`. */
function claimAttempt(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw err('general_argument_invalid', 'Param "attempt" must be the claimed message\'s attempts value.')
  }
  return value
}

export function queueModel(m: QueueMessageRow) {
  let data: unknown = m.data
  try {
    data = JSON.parse(m.data)
  } catch {
    // A plain string payload is stored as-is.
  }
  return {
    $id: m.id,
    $createdAt: m.created_at,
    $updatedAt: m.updated_at,
    queue: m.queue,
    status: m.status,
    attempts: m.attempts,
    maxAttempts: m.max_attempts,
    availableAt: m.available_at,
    leaseUntil: m.lease_until,
    completedAt: m.completed_at,
    idempotencyKey: m.idempotency_key,
    data,
    result: m.result,
    errors: m.errors,
  }
}

/** Reject names the public API may not use: invalid ones and system queues. */
export function publicQueueName(value: string): string {
  if (!QUEUE_NAME.test(value)) {
    throw err('general_argument_invalid', 'Queue names must be 1 to 64 characters: letters, digits, dot, hyphen or underscore, starting with a letter or digit.')
  }
  return value
}

function name(value: string): string {
  if (!QUEUE_NAME.test(value) && !SYSTEM_QUEUE.test(value)) {
    throw err('general_argument_invalid', 'Queue names must be 1 to 64 characters: letters, digits, dot, hyphen or underscore, starting with a letter or digit.')
  }
  return value
}

function integer(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) {
    throw err('general_argument_invalid', `Param "${label}" must be an integer between ${min} and ${max}.`)
  }
  return value
}

export class QueueService {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private db: Db) {}

  private get sql() {
    return this.db.sqlite
  }

  private get(queueName: string, id: string): QueueMessageRow {
    const row = this.sql
      .query<QueueMessageRow, [string, string]>('SELECT * FROM _queue_messages WHERE queue = ? AND id = ?')
      .get(queueName, id)
    if (!row) throw err('queue_message_not_found')
    return row
  }

  enqueue(queueName: string, input: EnqueueInput): { message: QueueMessageRow; created: boolean } {
    queueName = name(queueName)
    const id = resolveId(input.id, 'Message ID')
    const delay = integer(input.delay, 0, 0, MAX_DELAY, 'delay')
    const maxAttempts = integer(input.maxAttempts, 3, 1, 100, 'maxAttempts')
    const stamp = now()
    const data = JSON.stringify(input.data ?? null)
    const key = input.idempotencyKey?.trim() || null
    if (key !== null && key.length > 128) throw err('general_argument_invalid', 'Param "idempotencyKey" must be at most 128 characters.')
    if (this.sql.query('SELECT 1 FROM _queue_messages WHERE id = ?').get(id)) {
      throw err('general_argument_invalid', `A message with ID "${id}" already exists.`)
    }
    const result = this.sql
      .query(
        `INSERT INTO _queue_messages (id, queue, status, data, attempts, max_attempts, available_at, idempotency_key, created_at, updated_at)
         VALUES (?, ?, 'waiting', ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(id, queueName, data, maxAttempts, addSeconds(delay), key, stamp, stamp)
    if (Number(result.changes ?? 0) === 0) {
      // The idempotency key already exists: return the message that won.
      const existing = key
        ? this.sql
            .query<QueueMessageRow, [string, string]>('SELECT * FROM _queue_messages WHERE queue = ? AND idempotency_key = ?')
            .get(queueName, key)
        : null
      if (existing) return { message: existing, created: false }
      throw err('general_argument_invalid', `A message with ID "${id}" already exists in queue "${queueName}".`)
    }
    return { message: this.get(queueName, id), created: true }
  }

  /**
   * Claim up to `count` due messages, in one atomic UPDATE.
   *
   * `attempts` moves forward at claim time, so a worker crash still counts as
   * an attempt and a poison message cannot loop forever.
   */
  claim(queueName: string, options: ClaimOptions = {}): QueueMessageRow[] {
    queueName = name(queueName)
    const count = integer(options.count, 1, 1, 100, 'count')
    const lease = integer(options.lease, 60, 1, MAX_LEASE, 'lease')
    const stamp = now()
    return this.sql
      .query<QueueMessageRow, [string, string, string, string, number]>(
        `UPDATE _queue_messages SET status = 'processing', attempts = attempts + 1, lease_until = ?, updated_at = ?
         WHERE seq IN (
           SELECT seq FROM _queue_messages
           WHERE queue = ? AND status = 'waiting' AND available_at <= ?
           ORDER BY seq
           LIMIT ?
         )
         RETURNING *`,
      )
      .all(addSeconds(lease), stamp, queueName, stamp, count)
  }

  /** Extend a running message's lease; the attempt must still be the one this worker claimed. */
  heartbeat(queueName: string, id: string, attempt: number, lease = 60): QueueMessageRow {
    const seconds = integer(lease, 60, 1, MAX_LEASE, 'lease')
    const claimed = claimAttempt(attempt)
    const row = this.sql
      .query<QueueMessageRow, [string, string, string, string, number]>(
        "UPDATE _queue_messages SET lease_until = ?, updated_at = ? WHERE queue = ? AND id = ? AND status = 'processing' AND attempts = ? RETURNING *",
      )
      .get(addSeconds(seconds), now(), name(queueName), id, claimed)
    if (!row) this.leaseError(queueName, id, claimed)
    return row
  }

  /** Mark a claimed message done. A late ack from an expired lease gets 409. */
  ack(queueName: string, id: string, attempt: number, result?: unknown): QueueMessageRow {
    const stamp = now()
    const claimed = claimAttempt(attempt)
    const text = result === undefined ? '' : typeof result === 'string' ? result : JSON.stringify(result)
    const row = this.sql
      .query<QueueMessageRow, (string | number)[]>(
        "UPDATE _queue_messages SET status = 'completed', result = ?, lease_until = NULL, completed_at = ?, updated_at = ? WHERE queue = ? AND id = ? AND status = 'processing' AND attempts = ? RETURNING *",
      )
      .get(text, stamp, stamp, name(queueName), id, claimed)
    if (!row) this.leaseError(queueName, id, claimed)
    return row
  }

  /**
   * Mark a claimed message failed. It is retried with backoff until it runs
   * out of attempts, then it stays `failed` for inspection. `final` skips the
   * retries, for errors another attempt cannot fix. The conditional UPDATE
   * re-checks the status and attempt, so a stale worker cannot overwrite the
   * message after a requeue or a new claim.
   */
  fail(queueName: string, id: string, attempt: number, message?: string, delay?: number, final = false): QueueMessageRow {
    const claimed = claimAttempt(attempt)
    const current = this.get(name(queueName), id)
    if (current.status !== 'processing' || current.attempts !== claimed) this.leaseError(queueName, id, claimed)
    const stamp = now()
    const retry = !final && current.attempts < current.max_attempts
    const backoff = delay ?? Math.min(300, 2 ** current.attempts)
    const row = this.sql
      .query<QueueMessageRow, (string | number | null)[]>(
        `UPDATE _queue_messages SET status = ?, errors = ?, available_at = ?, lease_until = NULL, completed_at = ?, updated_at = ?
         WHERE queue = ? AND id = ? AND status = 'processing' AND attempts = ? RETURNING *`,
      )
      .get(
        retry ? 'waiting' : 'failed',
        message ?? 'The worker reported a failure.',
        retry ? addSeconds(integer(backoff, 0, 0, MAX_DELAY, 'delay')) : current.available_at,
        retry ? null : stamp,
        stamp,
        name(queueName),
        id,
        claimed,
      )
    if (!row) this.leaseError(queueName, id, claimed)
    return row
  }

  /**
   * Requeue claims whose lease expired, so a dead worker does not hold a
   * message forever. One conditional UPDATE: a heartbeat that extended the
   * lease, or a claim that took the message, no longer matches and is left
   * alone.
   */
  reap(): string[] {
    // Requeuing is a scheduler job: only one process does it, or every stale
    // message would be touched once per worker.
    if (!isLeader()) return []
    const stamp = now()
    const rows = this.sql
      .query<{ id: string }, [string, string, string, string]>(
        `UPDATE _queue_messages
         SET status = CASE WHEN attempts < max_attempts THEN 'waiting' ELSE 'failed' END,
             available_at = CASE WHEN attempts < max_attempts THEN ? ELSE available_at END,
             completed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE ? END,
             errors = CASE WHEN attempts < max_attempts THEN errors ELSE 'The worker did not finish before its lease expired.' END,
             lease_until = NULL,
             updated_at = ?
         WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?
         RETURNING id`,
      )
      .all(stamp, stamp, stamp, stamp)
    return rows.map((row) => row.id)
  }

  /** Replace a message's payload, for example to drop a large input once it is done. */
  replaceData(queueName: string, id: string, data: unknown): void {
    this.sql.query('UPDATE _queue_messages SET data = ? WHERE queue = ? AND id = ?').run(JSON.stringify(data ?? null), name(queueName), id)
  }

  getMessage(queueName: string, id: string) {
    return this.get(name(queueName), id)
  }

  /** One SQL page; never loads the whole queue. Supports the list queries the SDK sends. */
  listMessages(queueName: string, rawQueries: unknown[], status?: string) {
    queueName = name(queueName)
    const filters: string[] = ['queue = ?']
    const params: (string | number | null)[] = [queueName]
    let limit = DEFAULT_LIST_LIMIT
    let offset = 0
    let order = 'seq DESC'
    let ordered = false
    let after: string | undefined
    let before: string | undefined

    if (status) {
      filters.push('status = ?')
      params.push(status)
    }

    for (const raw of rawQueries) {
      const query = listQuery(raw)
      const values = query.values ?? []
      switch (query.method) {
        case 'limit':
          limit = Math.min(MAX_LIST_LIMIT, Math.max(0, Math.floor(Number(values[0]) || 0)))
          break
        case 'offset':
          offset = Math.max(0, Math.floor(Number(values[0]) || 0))
          break
        case 'cursorAfter':
          after = String(values[0])
          break
        case 'cursorBefore':
          before = String(values[0])
          break
        case 'equal':
        case 'notEqual': {
          const column = LIST_FIELDS[query.attribute ?? '']
          if (!column) throw err('general_argument_invalid', `Invalid \`queries\` param: cannot filter queue messages by "${query.attribute}".`)
          const cast = values.map((value) => (value === null || typeof value === 'string' || typeof value === 'number' ? value : String(value)))
          const nulls = cast.some((value) => value === null)
          const nonNull = cast.filter((value): value is string | number => value !== null)
          const marks = nonNull.map(() => '?').join(', ')
          if (query.method === 'equal') {
            if (nonNull.length && nulls) filters.push(`(${column} IN (${marks}) OR ${column} IS NULL)`)
            else if (nonNull.length) filters.push(`${column} IN (${marks})`)
            else if (nulls) filters.push(`${column} IS NULL`)
            else filters.push('0')
          } else {
            const parts: string[] = []
            if (nonNull.length) parts.push(`${column} NOT IN (${marks})`)
            if (nulls) parts.push(`${column} IS NOT NULL`)
            if (parts.length) filters.push(parts.join(' AND '))
          }
          params.push(...nonNull)
          break
        }
        case 'orderAsc':
        case 'orderDesc': {
          const column = LIST_FIELDS[query.attribute ?? '$createdAt']
          if (!column) throw err('general_argument_invalid', `Invalid \`queries\` param: cannot order queue messages by "${query.attribute}".`)
          order = `${column} ${query.method === 'orderAsc' ? 'ASC' : 'DESC'}, seq ${query.method === 'orderAsc' ? 'ASC' : 'DESC'}`
          ordered = true
          break
        }
        default:
          throw err('general_argument_invalid', `Invalid \`queries\` param: the ${query.method} query is not supported here.`)
      }
    }

    // The default order is newest first by sequence; a cursor is tied to it.
    if ((after !== undefined || before !== undefined) && ordered) {
      throw err('general_argument_invalid', 'Cursors use the default sequence order; do not combine them with orderAsc or orderDesc.')
    }

    const where = filters.join(' AND ')
    const total = Number(
      this.sql
        .query<{ n: number }, (string | number | null)[]>(`SELECT count(*) AS n FROM _queue_messages WHERE ${where}`)
        .get(...params)?.n ?? 0,
    )

    const pageFilters = [...filters]
    const pageParams = [...params]
    if (after !== undefined || before !== undefined) {
      const cursorId = (after ?? before)!
      const cursor = this.sql
        .query<{ seq: number }, (string | number | null)[]>(`SELECT seq FROM _queue_messages WHERE ${where} AND id = ?`)
        .get(...params, cursorId)
      if (!cursor) throw err('general_cursor_not_found')
      pageFilters.push(`seq ${after !== undefined ? '<' : '>'} ?`)
      pageParams.push(cursor.seq)
    }

    const rows = this.sql
      .query<QueueMessageRow, (string | number | null)[]>(
        `SELECT * FROM _queue_messages WHERE ${pageFilters.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...pageParams, limit, offset)
    return { total, messages: rows.map(queueModel) }
  }

  stats(queueName: string): Record<string, number> {
    queueName = name(queueName)
    const rows = this.sql
      .query<{ status: string; n: number }, [string]>('SELECT status, count(*) AS n FROM _queue_messages WHERE queue = ? GROUP BY status')
      .all(queueName)
    const counts: Record<string, number> = { waiting: 0, processing: 0, completed: 0, failed: 0 }
    for (const row of rows) counts[row.status] = row.n
    counts.total = rows.reduce((sum, row) => sum + row.n, 0)
    return counts
  }

  deleteMessage(queueName: string, id: string): void {
    this.get(name(queueName), id)
    this.sql.query('DELETE FROM _queue_messages WHERE queue = ? AND id = ?').run(queueName, id)
  }

  /** Delete every message in a queue, or only those in one status. */
  purge(queueName: string, status?: string): number {
    queueName = name(queueName)
    const result = status
      ? this.sql.query('DELETE FROM _queue_messages WHERE queue = ? AND status = ?').run(queueName, status)
      : this.sql.query('DELETE FROM _queue_messages WHERE queue = ?').run(queueName)
    return Number(result.changes ?? 0)
  }

  /** Keep completed and failed messages for `days`, like executions. */
  prune(days = 30): number {
    const cutoff = formatDate(new Date(Date.now() - days * 86400_000))
    return Number(
      this.sql
        .query("DELETE FROM _queue_messages WHERE completed_at IS NOT NULL AND completed_at < ?").run(cutoff).changes ?? 0,
    )
  }

  /** Requeue messages whose worker stopped heartbeating, every 15 seconds. */
  start(): void {
    if (this.timer) return
    this.reap()
    this.timer = setInterval(() => this.reap(), 15_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** A queue-wide lease error: not found, or claimed by someone else / already finished. */
  private leaseError(queueName: string, id: string, attempt?: number): never {
    let row: QueueMessageRow | undefined
    try {
      row = this.get(queueName, id)
    } catch {
      row = undefined
    }
    if (!row) throw err('queue_message_not_found')
    if (attempt !== undefined && row.status === 'processing' && row.attempts !== attempt) {
      throw err(
        'queue_message_conflict',
        `Message "${id}" is processing under attempt ${row.attempts}, not ${attempt}. Claim it again or check its lease.`,
      )
    }
    throw err('queue_message_conflict', `Message "${id}" is ${row.status}, not processing. Claim it again or check its lease.`)
  }
}
