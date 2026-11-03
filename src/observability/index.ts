/**
 * One observability facade per project.
 *
 * `begin()` runs at the start of a request and `end()` is called from the
 * `finally` block, so metrics, traces and shipped logs all describe the same
 * request even when the handler throws. Analytics events are captured from the
 * document events the request produced. Everything is fire-and-forget and
 * bounded: a provider outage drops data instead of slowing the API.
 */
import type { Caller } from '~/auth/caller'
import type { DocEvent } from '~/documents/store'

import { defaultObservabilityConfig, hasAnySink, type ObservabilityConfig } from './config'
import { FlagService } from './flags'
import { MetricRegistry, collectProcessMetrics } from './metrics'
import { logsPayload, metricsPayload, tracesPayload, type LogData, type SpanData } from './otlp'
import { normalizePath } from './paths'
import { BatchQueue } from './queue'
import { sendDatadogLogs, sendDatadogMetrics, sendOtlp, sendPosthogEvents, type AnalyticsEvent } from './providers'
import type { TelemetryStore } from './store'

export { normalizePath } from './paths'

export interface RequestEnd {
  method: string
  path: string
  route?: string
  status: number
  project?: string
  auth?: string
  ip?: string
  userAgent?: string
  requestBytes?: number
  responseBytes?: number
  error?: string
  id?: string
  /** The writer process handled this request; only release the in-flight slot. */
  forwarded?: boolean
  /** Project store for the console trace explorer; omit when there is no database. */
  telemetry?: TelemetryStore
}

export interface RequestObservation {
  traceId: string
  spanId: string
  setRoute(route: string): void
  end(info: RequestEnd): void
}

export interface ObservabilityOptions {
  /** Disable the periodic timers (tests flush by hand). */
  timers?: boolean
  /** Tags exported metrics with the project that owns this facade. */
  projectId?: string
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

/** Parse a W3C `traceparent`; invalid or all-zero IDs are ignored. */
export function parseTraceparent(value: string | null | undefined): { traceId: string; spanId: string; sampled: boolean } | null {
  const match = TRACEPARENT.exec((value ?? '').trim().toLowerCase())
  if (!match) return null
  const [, version, traceId, spanId, flags] = match
  if (version === 'ff' || traceId === '0'.repeat(32) || spanId === '0'.repeat(16)) return null
  return { traceId: traceId!, spanId: spanId!, sampled: (Number.parseInt(flags!, 16) & 1) === 1 }
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return Array.from(buffer, (value) => value.toString(16).padStart(2, '0')).join('')
}

const unixNano = (milliseconds: number): string => String(BigInt(Math.max(0, Math.round(milliseconds))) * 1_000_000n)

const severityOf = (status: number, error?: string): { number: number; text: string } => {
  if (status >= 500 || error) return { number: 17, text: 'ERROR' }
  if (status >= 400) return { number: 13, text: 'WARN' }
  return { number: 9, text: 'INFO' }
}

export class Observability {
  config: ObservabilityConfig
  readonly metrics = new MetricRegistry()
  flags: FlagService
  /** True when any request observation is worth creating (external sink or console). */
  enabled: boolean
  /** Keep a local copy for the console pages. */
  console: boolean
  /** Project that owns this facade; used as a metric label. */
  readonly projectId: string

  private traces: BatchQueue<SpanData> | null = null
  private logs: BatchQueue<LogData> | null = null
  private analytics: BatchQueue<AnalyticsEvent> | null = null
  private metricsSink = false
  private metricsTimer: ReturnType<typeof setInterval> | null = null
  private metricsWindowStart = Date.now()
  private metricsFlushing = false
  private inflight = 0
  private closed = false
  private lastWarning = 0

  constructor(config: ObservabilityConfig = defaultObservabilityConfig(), options: ObservabilityOptions = {}) {
    this.config = config
    this.flags = new FlagService(this.config)
    this.enabled = false
    this.console = false
    this.projectId = options.projectId ?? ''
    this.applyConfig(options.timers !== false)
  }

  /** Build queues and timers from the current config. Call after replacing `config`. */
  private applyConfig(timers: boolean): void {
    const otlp = this.config.otlp
    const datadog = this.config.datadog
    const posthog = this.config.posthog

    if (otlp?.traces && otlp.signals.has('traces')) {
      this.traces = new BatchQueue<SpanData>({
        limit: this.config.queueLimit,
        flushMs: timers ? this.config.flushMs : 0,
        startTimer: timers,
        send: (batch) => sendOtlp(otlp.traces, otlp.headers, tracesPayload(batch, this.config), this.config.timeoutMs),
        onError: (error) => this.warn('traces', error),
      })
    }

    if ((otlp?.logs && otlp.signals.has('logs')) || datadog?.logs) {
      this.logs = new BatchQueue<LogData>({
        limit: this.config.queueLimit,
        flushMs: timers ? this.config.flushMs : 0,
        startTimer: timers,
        send: async (batch) => {
          if (otlp?.logs && otlp.signals.has('logs')) {
            await sendOtlp(otlp.logs, otlp.headers, logsPayload(batch, this.config), this.config.timeoutMs)
          }
          if (datadog?.logs) {
            await sendDatadogLogs(datadog, batch, {
              service: this.config.serviceName,
              environment: this.config.environment,
              hostname: this.config.instanceId,
              timeoutMs: this.config.timeoutMs,
            })
          }
        },
        onError: (error) => this.warn('logs', error),
      })
    }

    if (posthog?.analytics) {
      this.analytics = new BatchQueue<AnalyticsEvent>({
        limit: this.config.queueLimit,
        flushMs: timers ? this.config.flushMs : 0,
        startTimer: timers,
        send: (batch) => sendPosthogEvents(posthog, batch, this.config.timeoutMs),
        onError: (error) => this.warn('analytics', error),
      })
    }

    this.metricsSink = Boolean((otlp?.metrics && otlp.signals.has('metrics')) || datadog?.metrics)
    this.console = this.config.console
    const external = this.config.enabled && hasAnySink(this.config) && Boolean(this.traces || this.logs || this.metricsSink)
    this.enabled = this.console || external

    if (timers && this.metricsSink) {
      this.metricsTimer = setInterval(() => void this.flushMetrics(), this.config.flushMs)
      this.metricsTimer.unref?.()
    }
  }

  /**
   * Apply console-managed settings without a restart. Queued data is flushed
   * before the old queues and timers are replaced.
   */
  async reconfigure(config: ObservabilityConfig, options: ObservabilityOptions = {}): Promise<void> {
    if (this.closed) return
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer)
      this.metricsTimer = null
    }
    const old = [this.traces, this.logs, this.analytics]
    this.traces = this.logs = this.analytics = null
    this.metricsSink = false
    await Promise.allSettled(old.map((queue) => queue?.close()))
    this.config = config
    this.flags = new FlagService(config)
    this.metrics.reset()
    this.metricsWindowStart = Date.now()
    this.lastWarning = 0
    this.applyConfig(options.timers !== false)
  }

  /** Start a request observation, or null when nothing is configured. */
  begin(request: Request): RequestObservation | null {
    if (!this.enabled) return null
    this.inflight++
    if (this.metricsSink) this.metrics.gauge('bunwrite.http.in_flight', this.inflight)
    const parent = parseTraceparent(request.headers.get('traceparent'))
    const sampled = parent?.sampled === true || Math.random() < this.config.sampleRate
    const consoleSampled = this.console && Math.random() < this.config.consoleSampleRate
    const traceId = parent?.traceId ?? randomHex(16)
    const spanId = randomHex(8)
    const startMono = performance.now()
    const startWall = Date.now()
    let route = ''

    return {
      traceId,
      spanId,
      setRoute: (value) => {
        route = value
      },
      end: (info) => {
        try {
          this.finish({
            traceId,
            spanId,
            parentSpanId: parent?.spanId,
            sampled,
            consoleSampled,
            startMono,
            startWall,
            route: route || info.route || normalizePath(info.path),
            info,
          })
        } catch (error) {
          this.warn('request', error)
        }
      },
    }
  }

  private finish(context: {
    traceId: string
    spanId: string
    parentSpanId?: string
    sampled: boolean
    consoleSampled: boolean
    startMono: number
    startWall: number
    route: string
    info: RequestEnd
  }): void {
    this.inflight = Math.max(0, this.inflight - 1)
    const { info, route } = context
    // Forwarded writes are counted by the writer process that actually ran them.
    if (info.forwarded || this.closed) return
    const durationMs = Math.max(0, performance.now() - context.startMono)
    const statusClass = `${Math.floor(info.status / 100)}xx`
    const labels = { method: info.method, route, status_class: statusClass, project: info.project || this.projectId }

    // The overview needs every request, not only the sampled traces.
    if (this.console && info.telemetry) info.telemetry.recordRequest(info.project ?? '', durationMs, info.status)

    if (this.metricsSink) {
      this.metrics.counter('bunwrite.http.requests', 1, { ...labels, status: info.status })
      this.metrics.histogram('bunwrite.http.request.duration', durationMs, labels)
      if (info.responseBytes && info.responseBytes > 0) this.metrics.counter('bunwrite.http.response.bytes', info.responseBytes, labels)
      this.metrics.gauge('bunwrite.http.in_flight', this.inflight)
    }

    const attributes = {
      'http.request.method': info.method,
      'http.route': route,
      'url.path': info.path,
      'http.response.status_code': info.status,
      'http.request.body.size': info.requestBytes ?? 0,
      'http.response.body.size': info.responseBytes ?? 0,
      'bunwrite.project': info.project,
      'bunwrite.auth': info.auth,
      'client.address': info.ip,
      'user_agent.original': info.userAgent,
      'request.id': info.id,
    }

    if (this.traces && context.sampled) {
      this.traces.add({
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
        name: `${info.method} ${route}`,
        startUnixNano: unixNano(context.startWall),
        endUnixNano: unixNano(context.startWall + durationMs),
        attributes,
        error: info.error,
      })
    }

    if (this.logs) {
      const severity = severityOf(info.status, info.error)
      this.logs.add({
        timeUnixNano: unixNano(context.startWall + durationMs),
        severity: severity.number,
        severityText: severity.text,
        message: `${info.method} ${route} ${info.status} ${durationMs.toFixed(1)}ms`,
        attributes: {
          ...attributes,
          status: info.status,
          duration_ms: Math.round(durationMs * 10) / 10,
          error: info.error,
        },
        traceId: context.traceId,
        spanId: context.spanId,
      })
    }

    // Local copy for the console. This is sampled separately from exporters so
    // the trace explorer works with no provider configured.
    if (this.console && context.consoleSampled && info.telemetry) {
      info.telemetry.recordSpan({
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
        requestId: info.id,
        name: `${info.method} ${route}`,
        method: info.method,
        route,
        status: info.status,
        durationMs,
        project: info.project ?? '',
        auth: info.auth,
        error: info.error,
        attributes,
      })
    }
  }

  /** Product analytics from the document events a request produced. */
  captureEvents(events: DocEvent[], caller: Caller, project: string, telemetry?: TelemetryStore): void {
    if (this.closed || events.length === 0 || (!this.analytics && !(this.console && telemetry))) return
    const distinctId = caller.user?.id ?? `project:${project}`
    const timestamp = new Date().toISOString()
    for (const event of events) {
      const name = `document.${event.action}`
      const properties = {
        project,
        database: event.collection.databaseId,
        collection: event.collection.id,
        collection_name: event.collection.name,
        document_id: String(event.document.$id),
        action: event.action,
      }
      if (this.console && telemetry) {
        telemetry.recordEvent({
          event: name,
          distinctId,
          project,
          database: event.collection.databaseId,
          collection: event.collection.id,
          documentId: String(event.document.$id),
          properties,
        })
      }
      this.analytics?.add({ event: name, distinctId, timestamp, properties })
    }
  }

  private async flushMetrics(): Promise<void> {
    if (!this.metricsSink || this.metricsFlushing || this.closed) return
    this.metricsFlushing = true
    try {
      const endMs = Date.now()
      collectProcessMetrics(this.metrics, this.projectId)
      const points = this.metrics.snapshot()
      if (points.length === 0) return
      const startMs = this.metricsWindowStart
      this.metricsWindowStart = endMs
      const otlp = this.config.otlp
      const datadog = this.config.datadog
      const work: Array<Promise<void>> = []
      if (otlp?.metrics && otlp.signals.has('metrics')) {
        work.push(sendOtlp(otlp.metrics, otlp.headers, metricsPayload(points, this.config, { startMs, endMs }), this.config.timeoutMs))
      }
      if (datadog?.metrics) work.push(sendDatadogMetrics(datadog, points, { startMs, endMs }, this.config.timeoutMs))
      const results = await Promise.allSettled(work)
      for (const result of results) {
        if (result.status === 'rejected') this.warn('metrics', result.reason)
      }
    } finally {
      this.metricsFlushing = false
    }
  }

  /** Drain every queue. Safe to call on shutdown or in tests. */
  async flush(): Promise<void> {
    const work: Array<Promise<void>> = [this.flushMetrics()]
    if (this.traces) work.push(this.traces.flush())
    if (this.logs) work.push(this.logs.flush())
    if (this.analytics) work.push(this.analytics.flush())
    await Promise.allSettled(work)
  }

  /** Stop the timers, flush, and refuse new telemetry. */
  async close(): Promise<void> {
    if (this.closed) return
    await this.flush()
    this.closed = true
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer)
      this.metricsTimer = null
    }
    const work: Array<Promise<void>> = []
    if (this.traces) work.push(this.traces.close())
    if (this.logs) work.push(this.logs.close())
    if (this.analytics) work.push(this.analytics.close())
    await Promise.allSettled(work)
  }

  private warn(scope: string, error: unknown): void {
    const now = Date.now()
    if (!this.config.debug && now - this.lastWarning < 60_000) return
    this.lastWarning = now
    console.warn(`[observability] ${scope}:`, error instanceof Error ? error.message : error)
  }
}

/** Create the facade from a project's settings. */
export function createObservability(config: ObservabilityConfig = defaultObservabilityConfig(), options: ObservabilityOptions = {}): Observability {
  return new Observability(config, options)
}
