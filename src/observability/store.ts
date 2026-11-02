/**
 * A bounded, local copy of recent telemetry for the console.
 *
 * Exporters are the system of record; this store exists so the Observability
 * pages work without a provider and without querying a vendor. Spans are
 * sampled (`OBSERVABILITY_CONSOLE_SAMPLE_RATE` in the facade), events are
 * low-volume document writes, and both are capped and pruned. Writes are
 * buffered so the request path never waits on SQLite.
 */
import type { SqlDatabase } from '~/db/driver'
import { now } from '~/lib/datetime'

export interface TelemetryOptions {
  /** Rows kept per project; older rows are pruned on flush. */
  maxSpans: number
  maxEvents: number
  retentionDays: number
  /** How long records stay in memory before the batch is written. */
  flushMs: number
}

export interface SpanInput {
  traceId: string
  spanId: string
  parentSpanId?: string
  requestId?: string
  name: string
  method: string
  route: string
  status: number
  durationMs: number
  project: string
  auth?: string
  error?: string
  attributes: Record<string, unknown>
}

export interface EventInput {
  event: string
  distinctId: string
  project: string
  database: string
  collection: string
  documentId: string
  properties: Record<string, unknown>
}

export interface SpanRow {
  seq: number
  trace_id: string
  span_id: string
  parent_span_id: string
  request_id: string
  name: string
  method: string
  route: string
  status: number
  duration_ms: number
  project: string
  auth: string
  error: string
  attributes: string
  created_at: string
}

export interface EventRow {
  seq: number
  event: string
  distinct_id: string
  project: string
  database: string
  collection: string
  document_id: string
  properties: string
  created_at: string
}

export interface SpanFilter {
  page: number
  limit: number
  project: string
  search?: string
  /** '', 2xx, 4xx or 5xx. */
  status?: string
}

export interface EventFilter {
  page: number
  limit: number
  project: string
  search?: string
  event?: string
}

export interface EventCount {
  event: string
  n: number
}

export interface MinutePoint {
  minute: string
  requests: number
  errors: number
  avg: number
}

export interface MetricSummary {
  requests: number
  errors: number
  avg: number
  p50: number
  p95: number
  p99: number
}

export interface RouteCount {
  route: string
  requests: number
  errors: number
  avg: number
}

interface MinuteRow {
  project: string
  minute: string
  requests: number
  errors: number
  durationSum: number
  durationCount: number
  buckets: number[]
}

interface MinuteDbRow {
  requests: number
  errors: number
  duration_sum: number
  duration_count: number
  [key: string]: number
}

/** Latency buckets in milliseconds; the last bucket is the overflow. */
const BOUNDS = [10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000]
const BUCKET_COLUMNS = ['b10', 'b25', 'b50', 'b100', 'b250', 'b500', 'b1000', 'b2500', 'b5000', 'b10000', 'bover'] as const

const bucketOf = (milliseconds: number): number => {
  const index = BOUNDS.findIndex((bound) => milliseconds <= bound)
  return index === -1 ? BOUNDS.length : index
}

const DEFAULTS: TelemetryOptions = { maxSpans: 2_000, maxEvents: 5_000, retentionDays: 7, flushMs: 5_000 }

const STATUS_RANGES: Record<string, [number, number]> = {
  '2xx': [200, 300],
  '3xx': [300, 400],
  '4xx': [400, 500],
  '5xx': [500, 600],
}

type PendingSpan = SpanRow & { pending: true }
type PendingEvent = EventRow & { pending: true }

let pendingSeq = 0
const pending = (): number => --pendingSeq

export class TelemetryStore {
  private readonly options: TelemetryOptions
  private spans: PendingSpan[] = []
  private events: PendingEvent[] = []
  private minuteRows = new Map<string, MinuteRow>()
  private minuteClock = { minute: '', at: 0 }
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing: Promise<void> | null = null
  private lastPrune = 0
  private lastWarning = 0
  private closed = false

  constructor(
    private readonly db: SqlDatabase,
    options: Partial<TelemetryOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options }
  }

  /** Apply console-managed retention and sampling limits without a restart. */
  configure(options: Partial<TelemetryOptions>): void {
    Object.assign(this.options, options)
  }

  recordSpan(input: SpanInput): void {
    if (this.closed) return
    this.spans.push({
      pending: true,
      seq: pending(),
      trace_id: input.traceId,
      span_id: input.spanId,
      parent_span_id: input.parentSpanId ?? '',
      request_id: input.requestId ?? '',
      name: input.name,
      method: input.method,
      route: input.route,
      status: input.status,
      duration_ms: input.durationMs,
      project: input.project,
      auth: input.auth ?? '',
      error: input.error ?? '',
      attributes: JSON.stringify(input.attributes),
      created_at: now(),
    })
    if (this.spans.length >= 200) void this.flush()
    else this.schedule()
  }

  recordEvent(input: EventInput): void {
    if (this.closed) return
    this.events.push({
      pending: true,
      seq: pending(),
      event: input.event,
      distinct_id: input.distinctId,
      project: input.project,
      database: input.database,
      collection: input.collection,
      document_id: input.documentId,
      properties: JSON.stringify(input.properties),
      created_at: now(),
    })
    if (this.events.length >= 200) void this.flush()
    else this.schedule()
  }

  /**
   * Every request, not just the sampled traces: the minute rollup powers the
   * overview charts. It stays in memory and is upserted once per flush.
   */
  recordRequest(project: string, durationMs: number, status: number, at = Date.now()): void {
    if (this.closed) return
    const minute = this.minuteOf(at)
    const key = `${project}|${minute}`
    let row = this.minuteRows.get(key)
    if (!row) {
      row = { project, minute, requests: 0, errors: 0, durationSum: 0, durationCount: 0, buckets: new Array(BOUNDS.length + 1).fill(0) as number[] }
      this.minuteRows.set(key, row)
    }
    row.requests++
    row.errors += status >= 500 ? 1 : 0
    row.durationSum += durationMs
    row.durationCount++
    row.buckets[bucketOf(durationMs)]!++
    this.schedule()
  }

  /** `YYYY-MM-DDTHH:MM`, recomputed at most once a second. */
  private minuteOf(at: number): string {
    if (at - this.minuteClock.at < 1_000) return this.minuteClock.minute
    this.minuteClock = { at, minute: new Date(at).toISOString().slice(0, 16) }
    return this.minuteClock.minute
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.options.flushMs)
    this.timer.unref?.()
  }

  /** Write queued rows. Safe to call from the console before reading. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    if (this.spans.length === 0 && this.events.length === 0 && this.minuteRows.size === 0) return Promise.resolve()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const spans = this.spans
    const events = this.events
    const minutes = [...this.minuteRows.values()]
    this.spans = []
    this.events = []
    this.minuteRows.clear()
    this.flushing = this.write(spans, events, minutes).finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  private async write(spans: PendingSpan[], events: PendingEvent[], minutes: MinuteRow[]): Promise<void> {
    try {
      if (spans.length > 0 || events.length > 0 || minutes.length > 0) {
        await this.db.driver.transaction(async (tx) => {
          for (const span of spans) {
            await tx.run(
              `INSERT INTO _telemetry_spans
               (trace_id, span_id, parent_span_id, request_id, name, method, route, status, duration_ms, project, auth, error, attributes, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                span.trace_id,
                span.span_id,
                span.parent_span_id,
                span.request_id,
                span.name,
                span.method,
                span.route,
                span.status,
                span.duration_ms,
                span.project,
                span.auth,
                span.error,
                span.attributes,
                span.created_at,
              ],
            )
          }
          for (const event of events) {
            await tx.run(
              `INSERT INTO _telemetry_events
               (event, distinct_id, project, database, collection, document_id, properties, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [event.event, event.distinct_id, event.project, event.database, event.collection, event.document_id, event.properties, event.created_at],
            )
          }
          for (const row of minutes) {
            await tx.run(
              `INSERT INTO _telemetry_minutes
               (project, minute, requests, errors, duration_sum, duration_count, ${BUCKET_COLUMNS.join(', ')})
               VALUES (?, ?, ?, ?, ?, ?, ${BUCKET_COLUMNS.map(() => '?').join(', ')})
               ON CONFLICT(project, minute) DO UPDATE SET
                 requests = requests + excluded.requests,
                 errors = errors + excluded.errors,
                 duration_sum = duration_sum + excluded.duration_sum,
                 duration_count = duration_count + excluded.duration_count,
                 ${BUCKET_COLUMNS.map((column) => `${column} = ${column} + excluded.${column}`).join(', ')}`,
              [row.project, row.minute, row.requests, row.errors, row.durationSum, row.durationCount, ...row.buckets],
            )
          }
        })
      }
      await this.prune()
    } catch (error) {
      // Console telemetry is best-effort. A closed or deleted project database
      // must not turn into a retry loop, so drop the failed batch and warn at
      // most once a minute.
      const at = Date.now()
      if (at - this.lastWarning > 60_000) {
        this.lastWarning = at
        console.warn('[telemetry] could not store console telemetry:', error instanceof Error ? error.message : error)
      }
    }
  }

  private async prune(): Promise<void> {
    const at = Date.now()
    if (at - this.lastPrune < 60_000) return
    this.lastPrune = at
    const cutoff = new Date(at - this.options.retentionDays * 86_400_000).toISOString()
    await this.db.driver.run('DELETE FROM _telemetry_spans WHERE created_at < ?', [cutoff])
    await this.db.driver.run('DELETE FROM _telemetry_events WHERE created_at < ?', [cutoff])
    await this.db.driver.run('DELETE FROM _telemetry_minutes WHERE minute < ?', [cutoff.slice(0, 16)])
    await this.trim('_telemetry_spans', this.options.maxSpans)
    await this.trim('_telemetry_events', this.options.maxEvents)
  }

  private async trim(table: '_telemetry_spans' | '_telemetry_events', keep: number): Promise<void> {
    const row = await this.db.driver.get<{ max: number | null }>(`SELECT max(seq) AS max FROM ${table}`)
    const max = Number(row?.max ?? 0)
    if (max > keep) await this.db.driver.run(`DELETE FROM ${table} WHERE seq <= ?`, [max - keep])
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush()
    if (this.flushing) await this.flushing
    await this.flush()
  }

  private whereSpans(filter: SpanFilter): { clause: string; params: Array<string | number> } {
    const clauses = ['project = ?']
    const params: Array<string | number> = [filter.project]
    if (filter.search) {
      clauses.push('(route LIKE ? OR name LIKE ? OR trace_id LIKE ? OR request_id LIKE ?)')
      const like = `%${filter.search}%`
      params.push(like, like, like, like)
    }
    const range = filter.status ? STATUS_RANGES[filter.status] : undefined
    if (range) {
      clauses.push('status >= ? AND status < ?')
      params.push(range[0], range[1])
    }
    return { clause: `WHERE ${clauses.join(' AND ')}`, params }
  }

  async listSpans(filter: SpanFilter): Promise<{ total: number; spans: SpanRow[] }> {
    await this.flush()
    const { clause, params } = this.whereSpans(filter)
    const count = await this.db.driver.get<{ n: number }>(`SELECT count(*) AS n FROM _telemetry_spans ${clause}`, params)
    const spans = await this.db.driver.all<SpanRow>(`SELECT * FROM _telemetry_spans ${clause} ORDER BY seq DESC LIMIT ? OFFSET ?`, [
      ...params,
      filter.limit,
      (filter.page - 1) * filter.limit,
    ])
    return { total: Number(count?.n ?? 0), spans }
  }

  async getSpan(seq: number, project: string): Promise<SpanRow | null> {
    await this.flush()
    return this.db.driver.get<SpanRow>('SELECT * FROM _telemetry_spans WHERE seq = ? AND project = ?', [seq, project])
  }

  private whereEvents(filter: EventFilter): { clause: string; params: Array<string | number> } {
    const clauses = ['project = ?']
    const params: Array<string | number> = [filter.project]
    if (filter.search) {
      clauses.push('(event LIKE ? OR distinct_id LIKE ? OR collection LIKE ? OR document_id LIKE ?)')
      const like = `%${filter.search}%`
      params.push(like, like, like, like)
    }
    if (filter.event) {
      clauses.push('event = ?')
      params.push(filter.event)
    }
    return { clause: `WHERE ${clauses.join(' AND ')}`, params }
  }

  async listEvents(filter: EventFilter): Promise<{ total: number; events: EventRow[] }> {
    await this.flush()
    const { clause, params } = this.whereEvents(filter)
    const count = await this.db.driver.get<{ n: number }>(`SELECT count(*) AS n FROM _telemetry_events ${clause}`, params)
    const events = await this.db.driver.all<EventRow>(`SELECT * FROM _telemetry_events ${clause} ORDER BY seq DESC LIMIT ? OFFSET ?`, [
      ...params,
      filter.limit,
      (filter.page - 1) * filter.limit,
    ])
    return { total: Number(count?.n ?? 0), events }
  }

  async eventNames(project: string): Promise<string[]> {
    const rows = await this.db.driver.all<{ event: string }>(
      'SELECT event FROM _telemetry_events WHERE project = ? GROUP BY event ORDER BY count(*) DESC LIMIT 20',
      [project],
    )
    return rows.map((row) => row.event)
  }

  async eventSummary(project: string, since: string): Promise<EventCount[]> {
    const rows = await this.db.driver.all<{ event: string; n: number }>(
      'SELECT event, count(*) AS n FROM _telemetry_events WHERE project = ? AND created_at >= ? GROUP BY event ORDER BY n DESC LIMIT 12',
      [project, since],
    )
    return rows.map((row) => ({ event: row.event, n: Number(row.n) }))
  }

  /** Events per hour (`YYYY-MM-DDTHH`), for the analytics chart. */
  async eventsByHour(project: string, since: string): Promise<Array<{ hour: string; n: number }>> {
    const rows = await this.db.driver.all<{ hour: string; n: number }>(
      'SELECT substr(created_at, 1, 13) AS hour, count(*) AS n FROM _telemetry_events WHERE project = ? AND created_at >= ? GROUP BY hour ORDER BY hour ASC',
      [project, since],
    )
    return rows.map((row) => ({ hour: row.hour, n: Number(row.n) }))
  }

  async distinctIds(project: string, since: string): Promise<number> {
    const row = await this.db.driver.get<{ n: number }>(
      'SELECT count(DISTINCT distinct_id) AS n FROM _telemetry_events WHERE project = ? AND created_at >= ?',
      [project, since],
    )
    return Number(row?.n ?? 0)
  }

  async counts(project: string): Promise<{ spans: number; events: number }> {
    const [spans, events] = await Promise.all([
      this.db.driver.get<{ n: number }>('SELECT count(*) AS n FROM _telemetry_spans WHERE project = ?', [project]),
      this.db.driver.get<{ n: number }>('SELECT count(*) AS n FROM _telemetry_events WHERE project = ?', [project]),
    ])
    return { spans: Number(spans?.n ?? 0), events: Number(events?.n ?? 0) }
  }

  /** Totals and approximate latency percentiles from the minute rollup. */
  async summary(project: string, sinceMinute: string): Promise<MetricSummary> {
    await this.flush()
    const rows = await this.db.driver.all<MinuteDbRow>(
      `SELECT requests, errors, duration_sum, duration_count, ${BUCKET_COLUMNS.join(', ')}
       FROM _telemetry_minutes WHERE project = ? AND minute >= ?`,
      [project, sinceMinute],
    )
    let requests = 0
    let errors = 0
    let durationSum = 0
    let durationCount = 0
    const buckets = new Array(BOUNDS.length + 1).fill(0) as number[]
    for (const row of rows) {
      requests += Number(row.requests)
      errors += Number(row.errors)
      durationSum += Number(row.duration_sum)
      durationCount += Number(row.duration_count)
      for (let index = 0; index < BUCKET_COLUMNS.length; index++) buckets[index]! += Number(row[BUCKET_COLUMNS[index]!] ?? 0)
    }
    const percentile = (fraction: number): number => {
      if (requests === 0) return 0
      const target = Math.ceil(requests * fraction)
      let seen = 0
      for (let index = 0; index < buckets.length; index++) {
        seen += buckets[index] ?? 0
        if (seen >= target) return BOUNDS[index] ?? BOUNDS[BOUNDS.length - 1]!
      }
      return BOUNDS[BOUNDS.length - 1]!
    }
    return {
      requests,
      errors,
      avg: durationCount > 0 ? durationSum / durationCount : 0,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
    }
  }

  /** One point per minute for the traffic chart. */
  async minutePoints(project: string, sinceMinute: string): Promise<MinutePoint[]> {
    await this.flush()
    const rows = await this.db.driver.all<{
      minute: string
      requests: number
      errors: number
      duration_sum: number
      duration_count: number
    }>(
      `SELECT minute, requests, errors, duration_sum, duration_count
       FROM _telemetry_minutes WHERE project = ? AND minute >= ? ORDER BY minute ASC`,
      [project, sinceMinute],
    )
    return rows.map((row) => ({
      minute: row.minute,
      requests: Number(row.requests),
      errors: Number(row.errors),
      avg: Number(row.duration_count) > 0 ? Number(row.duration_sum) / Number(row.duration_count) : 0,
    }))
  }

  /** Recent routes from the sampled spans; a fast approximation, labelled as such. */
  async topRoutes(project: string, since: string, limit = 6): Promise<RouteCount[]> {
    await this.flush()
    const rows = await this.db.driver.all<{ route: string; requests: number; errors: number | null; avg: number | null }>(
      `SELECT route, count(*) AS requests, sum(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS errors, avg(duration_ms) AS avg
       FROM _telemetry_spans WHERE project = ? AND created_at >= ? GROUP BY route ORDER BY requests DESC LIMIT ?`,
      [project, since, limit],
    )
    return rows.map((row) => ({
      route: row.route,
      requests: Number(row.requests),
      errors: Number(row.errors ?? 0),
      avg: Number(row.avg ?? 0),
    }))
  }

  async clearSpans(project: string): Promise<void> {
    await this.flush()
    await this.db.driver.run('DELETE FROM _telemetry_spans WHERE project = ?', [project])
  }

  async clearEvents(project: string): Promise<void> {
    await this.flush()
    await this.db.driver.run('DELETE FROM _telemetry_events WHERE project = ?', [project])
  }
}
