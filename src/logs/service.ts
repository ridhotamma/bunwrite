/**
 * Request logs for the console. Writes are batched so the request path stays
 * cheap, and the table is pruned to LOG_RETENTION_DAYS.
 */
import type { Config } from '~/config'
import type { Db } from '~/db/connection'
import { addSeconds, now } from '~/lib/datetime'
import type { RequestLog } from '~/lib/log'

interface PendingLog extends RequestLog {
  createdAt: string
}

export interface RequestLogRow {
  seq: number
  id: string
  method: string
  path: string
  status: number
  duration_ms: number
  request_bytes: number
  response_bytes: number
  ip: string
  project: string
  auth: string
  referer: string
  user_agent: string
  error: string
  created_at: string
}

export interface RequestLogFilter {
  page: number
  limit: number
  search?: string
  /** '', 2xx, 3xx, 4xx or 5xx. */
  status?: string
}

const STATUS_RANGES: Record<string, [number, number]> = {
  '2xx': [200, 300],
  '3xx': [300, 400],
  '4xx': [400, 500],
  '5xx': [500, 600],
}

const BATCH_SIZE = 100
const FLUSH_MS = 1000
const COLUMNS = 'seq, id, method, path, status, duration_ms, request_bytes, response_bytes, ip, project, auth, referer, user_agent, error, created_at'

export class RequestLogService {
  private queue: PendingLog[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private db: Db,
    private config: Config,
  ) {}

  get retentionDays(): number {
    return this.config.logRetentionDays
  }

  record(entry: RequestLog): void {
    this.queue.push({ ...entry, createdAt: now() })
    if (this.queue.length >= BATCH_SIZE) this.flush()
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS)
      this.timer.unref?.()
    }
  }

  /** Write queued lines now. Also called before reads so the page is up to date. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.queue.length) return
    const rows = this.queue
    this.queue = []
    const insert = this.db.sqlite.prepare(
      `INSERT INTO _request_logs (id, method, path, status, duration_ms, request_bytes, response_bytes, ip, project, auth, referer, user_agent, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    try {
      this.db.sqlite.transaction(() => {
        for (const row of rows) {
          insert.run(
            row.id,
            row.method,
            row.path,
            row.status,
            row.durationMs,
            row.requestBytes ?? 0,
            row.responseBytes ?? 0,
            row.ip ?? '',
            row.project ?? '',
            row.auth ?? '',
            row.referer ?? '',
            row.userAgent ?? '',
            row.error ?? '',
            row.createdAt,
          )
        }
      })()
    } catch (error) {
      console.error('[logs] failed to store request logs:', error)
    }
  }

  list(filter: RequestLogFilter): { total: number; logs: RequestLogRow[] } {
    this.flush()
    const where: string[] = []
    const params: (string | number)[] = []
    const search = filter.search?.trim()
    if (search) {
      const like = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
      where.push(
        "(path LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\' OR auth LIKE ? ESCAPE '\\' OR error LIKE ? ESCAPE '\\' OR referer LIKE ? ESCAPE '\\' OR user_agent LIKE ? ESCAPE '\\')",
      )
      params.push(like, like, like, like, like, like, like, like)
    }
    const range = STATUS_RANGES[filter.status ?? '']
    if (range) {
      where.push('status >= ? AND status < ?')
      params.push(range[0], range[1])
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = (this.db.sqlite.query(`SELECT count(*) AS n FROM _request_logs ${clause}`).get(...params) as { n: number }).n
    const logs = this.db.sqlite
      .query<RequestLogRow, any[]>(
        `SELECT ${COLUMNS} FROM _request_logs ${clause} ORDER BY seq DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit, (Math.max(1, filter.page) - 1) * filter.limit)
    return { total, logs }
  }

  get(seq: number): RequestLogRow | null {
    this.flush()
    return this.db.sqlite.query<RequestLogRow, [number]>(`SELECT ${COLUMNS} FROM _request_logs WHERE seq = ?`).get(seq) ?? null
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.queue = []
    this.db.sqlite.query('DELETE FROM _request_logs').run()
  }

  prune(): void {
    this.flush()
    if (this.retentionDays <= 0) return
    this.db.sqlite.query('DELETE FROM _request_logs WHERE created_at < ?').run(addSeconds(-this.retentionDays * 86400))
  }
}
