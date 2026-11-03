/**
 * Request logs for the console. Writes are batched so the request path stays
 * cheap, and the table is pruned to the configured retention.
 *
 * `record()` stays synchronous (it only queues in memory); everything that
 * touches the database goes through the driver port so the service can run on
 * SQLite or Postgres.
 */
import type { Config } from '~/config'
import type { SqlDatabase } from '~/db/driver'
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
  /** Only logs for this project. */
  project?: string
}

export interface HourlyBandwidth {
  hour: string
  inbound: number
  outbound: number
}

export interface BandwidthConsumer {
  path: string
  bytes: number
}

export interface HourlyRequests {
  hour: string
  count: number
}

const STATUS_RANGES: Record<string, [number, number]> = {
  '2xx': [200, 300],
  '3xx': [300, 400],
  '4xx': [400, 500],
  '5xx': [500, 600],
}

const BATCH_SIZE = 100
const FLUSH_MS = 1000
/** Hard cap while the database is slower than request traffic; oldest lines go first. */
const MAX_QUEUED = 10_000
const COLUMNS = 'seq, id, method, path, status, duration_ms, request_bytes, response_bytes, ip, project, auth, referer, user_agent, error, created_at'

export class RequestLogService {
  private queue: PendingLog[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Serialises flushes so two callers cannot write the same queue twice. */
  private flushing: Promise<void> | null = null

  constructor(
    private db: SqlDatabase,
    private config: Config,
  ) {}

  get retentionDays(): number {
    return this.config.logRetentionDays
  }

  /** Queue one line. Synchronous: the write happens on the next flush. */
  record(entry: RequestLog): void {
    // Drop a chunk, not one entry per request: shifting a full 10k array on
    // every request would make the overload worse.
    if (this.queue.length >= MAX_QUEUED) this.queue.splice(0, Math.max(1, Math.floor(MAX_QUEUED / 10)))
    this.queue.push({ ...entry, createdAt: now() })
    if (this.queue.length >= BATCH_SIZE) void this.flush()
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_MS)
      this.timer.unref?.()
    }
  }

  /** Write queued lines now. Also called before reads so the page is up to date. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.queue.length) return Promise.resolve()
    // A flush already in progress owns the queue; wait for it, then write what
    // arrived meanwhile.
    if (this.flushing) return this.flushing.then(() => this.flush())
    const rows = this.queue
    this.queue = []
    this.flushing = this.write(rows).finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  private async write(rows: PendingLog[]): Promise<void> {
    try {
      await this.db.driver.transaction(async (tx) => {
        for (const row of rows) {
          await tx.run(
            `INSERT INTO _request_logs (id, method, path, status, duration_ms, request_bytes, response_bytes, ip, project, auth, referer, user_agent, error, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
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
            ],
          )
        }
      })
    } catch (error) {
      console.error('[logs] failed to store request logs:', error)
    }
  }

  async list(filter: RequestLogFilter): Promise<{ total: number; logs: RequestLogRow[] }> {
    await this.flush()
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
    if (filter.project) {
      where.push('project = ?')
      params.push(filter.project)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = await this.db.driver.get<{ n: number }>(`SELECT count(*) AS n FROM _request_logs ${clause}`, params)
    const logs = await this.db.driver.all<RequestLogRow>(`SELECT ${COLUMNS} FROM _request_logs ${clause} ORDER BY seq DESC LIMIT ? OFFSET ?`, [
      ...params,
      filter.limit,
      (Math.max(1, filter.page) - 1) * filter.limit,
    ])
    return { total: Number(total?.n ?? 0), logs }
  }

  async get(seq: number, project?: string): Promise<RequestLogRow | null> {
    await this.flush()
    const where = project ? 'WHERE seq = ? AND project = ?' : 'WHERE seq = ?'
    const params: (string | number)[] = project ? [seq, project] : [seq]
    return this.db.driver.get<RequestLogRow>(`SELECT ${COLUMNS} FROM _request_logs ${where}`, params)
  }

  /** Request and response bytes per hour since `since`, an ISO timestamp. */
  async bandwidthByHour(since: string): Promise<HourlyBandwidth[]> {
    await this.flush()
    const rows = await this.db.driver.all<HourlyBandwidth>(
      `SELECT substr(created_at, 1, 13) AS hour, coalesce(sum(request_bytes), 0) AS inbound, coalesce(sum(response_bytes), 0) AS outbound
       FROM _request_logs WHERE created_at >= ? GROUP BY hour`,
      [since],
    )
    return rows.map((row) => ({ hour: row.hour, inbound: Number(row.inbound), outbound: Number(row.outbound) }))
  }

  /** Request count per hour since `since`, optionally for one project. */
  async requestsByHour(since: string, project?: string): Promise<HourlyRequests[]> {
    await this.flush()
    const where = project ? 'created_at >= ? AND project = ?' : 'created_at >= ?'
    const params: string[] = project ? [since, project] : [since]
    const rows = await this.db.driver.all<HourlyRequests>(
      `SELECT substr(created_at, 1, 13) AS hour, count(*) AS count FROM _request_logs WHERE ${where} GROUP BY hour`,
      params,
    )
    return rows.map((row) => ({ hour: row.hour, count: Number(row.count) }))
  }

  /** Paths with the most traffic since `since`, largest first. */
  async topConsumers(since: string, limit = 6): Promise<BandwidthConsumer[]> {
    await this.flush()
    const rows = await this.db.driver.all<BandwidthConsumer>(
      `SELECT path, coalesce(sum(request_bytes + response_bytes), 0) AS bytes
       FROM _request_logs WHERE created_at >= ? GROUP BY path ORDER BY bytes DESC LIMIT ?`,
      [since, limit],
    )
    return rows.map((row) => ({ path: row.path, bytes: Number(row.bytes) }))
  }

  async clear(project?: string): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.queue = []
    if (this.flushing) await this.flushing
    if (project) await this.db.driver.run('DELETE FROM _request_logs WHERE project = ?', [project])
    else await this.db.driver.run('DELETE FROM _request_logs')
  }

  async prune(): Promise<void> {
    await this.flush()
    if (this.retentionDays <= 0) return
    await this.db.driver.run('DELETE FROM _request_logs WHERE created_at < ?', [addSeconds(-this.retentionDays * 86400)])
  }
}
