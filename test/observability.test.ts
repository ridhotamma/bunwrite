import { afterEach, describe, expect, test } from 'bun:test'
import { KEY, PROJECT, startServer } from './helpers'

import type { Caller } from '~/auth/caller'
import type { Collection } from '~/schema/types'
import type { DocEvent } from '~/documents/store'
import { openDb } from '~/db/connection'
import { defaultObservabilityConfig, parseHeaders, type ObservabilityConfig, type OtlpConfig } from '~/observability/config'
import { normalizePath, Observability, parseTraceparent } from '~/observability'
import { MetricRegistry } from '~/observability/metrics'
import { configFromSettings, ObservabilitySettingsStore, settingsFromConfig } from '~/observability/settings'
import { datadogSeries } from '~/observability/providers'
import { logsPayload, metricsPayload, tracesPayload } from '~/observability/otlp'
import type { SpanInput } from '~/observability/store'

const servers: Array<{ stop: () => void }> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

function capture(): {
  url: string
  requests: Array<{ path: string; body: any; headers: Headers }>
} {
  const requests: Array<{ path: string; body: any; headers: Headers }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = await request.json().catch(() => null)
      requests.push({ path: url.pathname, body, headers: request.headers })
      if (url.pathname === '/flags') {
        return Response.json({ flags: { beta: { enabled: true, variant: 'blue' }, off: { enabled: false } } })
      }
      return new Response('ok')
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, requests }
}

const user = {
  kind: 'user',
  privileged: false,
  user: { id: 'user-1' },
  sessionId: null,
  roles: new Set(['users']),
  scopes: null,
} as unknown as Caller

const event = {
  collection: { databaseId: 'db', id: 'bookings', name: 'Bookings' } as Collection,
  action: 'create',
  document: { $id: 'doc-1' },
} as DocEvent

function runtimeConfig(over: Partial<ObservabilityConfig> = {}): ObservabilityConfig {
  return { ...defaultObservabilityConfig(), ...over }
}

function otlpConfig(endpoint: string): OtlpConfig {
  const base = endpoint.replace(/\/+$/, '')
  return {
    endpoint: base,
    traces: `${base}/v1/traces`,
    metrics: `${base}/v1/metrics`,
    logs: `${base}/v1/logs`,
    headers: {},
    signals: new Set(['traces', 'metrics', 'logs']),
  }
}

describe('observability config', () => {
  test('starts with built-in defaults and no providers', () => {
    const config = defaultObservabilityConfig()
    expect(config.enabled).toBe(false)
    expect(config.console).toBe(true)
    expect(config.otlp).toBeNull()
    expect(config.datadog).toBeNull()
    expect(config.posthog).toBeNull()
    expect(config.sampleRate).toBe(1)
    expect(config.consoleSampleRate).toBe(0.01)
    expect(config.spanLimit).toBe(2_000)
    expect(config.localFlags).toEqual({})
  })

  test('parses header input and tolerates malformed pairs', () => {
    expect(parseHeaders('a=1,b=2=3,c')).toEqual({ a: '1', b: '2=3' })
    expect(parseHeaders(undefined)).toEqual({})
  })

  test('console settings round-trip through the runtime config', () => {
    const base = defaultObservabilityConfig()
    const settings = settingsFromConfig(base)
    settings.otlp = {
      endpoint: 'https://otlp.example.com',
      traces: '',
      metrics: '',
      logs: '',
      headers: 'api-key=abc',
      signals: ['traces', 'metrics', 'logs'],
    }
    settings.datadog = { apiKey: 'dd-key', site: 'datadoghq.com', logs: true, metrics: true }
    settings.posthog = { apiKey: 'ph-key', host: 'https://us.i.posthog.com', analytics: true, flags: true, flagsTtlMs: 30_000 }
    settings.localFlags = { beta: true }

    settings.otlp!.signals = ['traces', 'logs']
    settings.otlp!.headers = 'api-key=changed\nx-tenant=one'
    settings.datadog!.site = 'datadoghq.eu'
    settings.posthog!.flags = false
    const config = configFromSettings(settings, base)
    expect(config.otlp?.traces).toBe('https://otlp.example.com/v1/traces')
    expect([...(config.otlp?.signals ?? [])].sort()).toEqual(['logs', 'traces'])
    expect(config.otlp?.headers).toEqual({ 'api-key': 'changed', 'x-tenant': 'one' })
    expect(config.datadog?.site).toBe('datadoghq.eu')
    expect(config.posthog?.flags).toBe(false)
    expect(config.localFlags).toEqual({ beta: true })
  })

  test('the project settings override persists and can be reset', async () => {
    const db = openDb(':memory:')
    try {
      const store = new ObservabilitySettingsStore(db)
      expect(store.overridden).toBe(false)
      expect(store.config.posthog).toBeNull()
      expect(store.settings.console).toBe(true)

      const next = {
        ...store.settings,
        console: false,
        spanLimit: 1_234,
        posthog: { apiKey: 'console-key', host: 'https://us.i.posthog.com', analytics: true, flags: false, flagsTtlMs: 30_000 },
        localFlags: { fromConsole: true },
      }
      await store.save(next)
      expect(store.overridden).toBe(true)

      // A fresh store reads the row synchronously on SQLite.
      const reloaded = new ObservabilitySettingsStore(db)
      expect(reloaded.settings).toMatchObject({ console: false, spanLimit: 1_234, localFlags: { fromConsole: true } })
      expect(reloaded.config.posthog?.apiKey).toBe('console-key')
      expect(reloaded.config.posthog?.flags).toBe(false)

      await reloaded.reset()
      expect(reloaded.overridden).toBe(false)
      expect(reloaded.config.posthog).toBeNull()
      expect(reloaded.settings.localFlags).toEqual({})
      expect(reloaded.settings.console).toBe(true)
    } finally {
      db.sqlite.close()
    }
  })
})

describe('trace context and routes', () => {
  test('validates traceparent and reads the sampled bit', () => {
    const trace = '0af7651916cd43dd8448eb211c80319c'
    const span = 'b7ad6b7169203331'
    expect(parseTraceparent(`00-${trace}-${span}-01`)).toEqual({ traceId: trace, spanId: span, sampled: true })
    expect(parseTraceparent(`00-${trace}-${span}-00`)).toEqual({ traceId: trace, spanId: span, sampled: false })
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${span}-01`)).toBeNull()
    expect(parseTraceparent('nope')).toBeNull()
    expect(parseTraceparent(undefined)).toBeNull()
  })

  test('normalises IDs out of metric routes', () => {
    expect(normalizePath('/v1/databases/booking_stress/collections/services/documents/bkg-2611011511-svc-000')).toBe(
      '/databases/:id/collections/:id/documents/:id',
    )
    expect(normalizePath('/v1/health')).toBe('/health')
    expect(normalizePath('/v1/account/sessions/current')).toBe('/account/sessions/current')
    expect(normalizePath('/v1/databases/db/collections/c/documents/123e4567-e89b-12d3-a456-426614174000')).toBe('/databases/:id/collections/:id/documents/:id')
    expect(normalizePath('/')).toBe('/')
  })
})

describe('metrics', () => {
  test('counters are deltas, gauges persist and histograms reset', () => {
    const metrics = new MetricRegistry()
    metrics.counter('http.requests', 2, { route: '/a', method: 'GET' })
    metrics.gauge('inflight', 3)
    metrics.histogram('http.duration', 12, { route: '/a' })
    metrics.histogram('http.duration', 300, { route: '/a' })

    const first = metrics.snapshot()
    const counter = first.find((point) => point.name === 'http.requests')
    const gauge = first.find((point) => point.name === 'inflight')
    const histogram = first.find((point) => point.name === 'http.duration')
    expect(counter?.value).toBe(2)
    expect(gauge?.value).toBe(3)
    expect(histogram).toMatchObject({ count: 2, sum: 312, min: 12, max: 300 })

    metrics.counter('http.requests', 1, { route: '/a', method: 'GET' })
    const second = metrics.snapshot()
    expect(second.find((point) => point.name === 'http.requests')?.value).toBe(1)
    expect(second.find((point) => point.name === 'inflight')?.value).toBe(3)
    expect(second.find((point) => point.name === 'http.duration')).toBeUndefined()
  })

  test('builds OTLP metric, trace and log payloads', () => {
    const config = runtimeConfig({ otlp: otlpConfig('http://localhost:4318') })
    const metrics = new MetricRegistry()
    metrics.counter('requests', 1, { route: '/a' })
    const metricBody = metricsPayload(metrics.snapshot(), config, { startMs: 1_000, endMs: 2_000 }) as any
    const sum = metricBody.resourceMetrics[0].scopeMetrics[0].metrics[0]
    expect(sum.name).toBe('requests')
    expect(sum.sum.dataPoints[0].asDouble).toBe(1)

    const traceBody = tracesPayload(
      [
        {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          name: 'GET /a',
          startUnixNano: '1000000000',
          endUnixNano: '2000000000',
          attributes: { 'http.request.method': 'GET', 'http.response.status_code': 200 },
          error: 'boom',
        },
      ],
      config,
    ) as any
    const span = traceBody.resourceSpans[0].scopeSpans[0].spans[0]
    expect(span.status).toEqual({ code: 2, message: 'boom' })
    expect(span.attributes).toHaveLength(2)

    const logBody = logsPayload(
      [
        {
          timeUnixNano: '1000000000',
          severity: 9,
          severityText: 'INFO',
          message: 'GET /a 200 1.0ms',
          attributes: { status: 200 },
          traceId: 'a'.repeat(32),
        },
      ],
      config,
    ) as any
    expect(logBody.resourceLogs[0].scopeLogs[0].logRecords[0].traceId).toBe('a'.repeat(32))
  })

  test('converts histograms to Datadog avg/p95/max', () => {
    const metrics = new MetricRegistry()
    for (const value of [1, 2, 3, 100]) metrics.histogram('duration', value)
    const series = datadogSeries(metrics.snapshot(), { startMs: 0, endMs: 60_000 })
    expect(series.find((entry) => entry.metric === 'duration.avg')?.points[0]![1]).toBe(26.5)
    expect(series.find((entry) => entry.metric === 'duration.max')?.points[0]![1]).toBe(100)
    expect(series.find((entry) => entry.metric === 'duration.p95')?.points[0]![1]).toBe(100)
  })
})

describe('Observability facade', () => {
  test('ships traces, logs, metrics and analytics without blocking', async () => {
    const captureServer = capture()
    const observability = new Observability(
      runtimeConfig({
        enabled: true,
        otlp: otlpConfig(captureServer.url),
        posthog: { apiKey: 'ph-key', host: captureServer.url, analytics: true, flags: true, flagsTtlMs: 30_000 },
        localFlags: { beta: true, theme: 'dark' },
      }),
      { timers: false },
    )

    const traceId = '0af7651916cd43dd8448eb211c80319c'
    const spanId = 'b7ad6b7169203331'
    const request = new Request('https://api.example.com/v1/databases/db/collections/bookings/documents/doc-1', {
      method: 'GET',
      headers: { traceparent: `00-${traceId}-${spanId}-01` },
    })
    const observation = observability.begin(request)!
    expect(observation.traceId).toBe(traceId)
    expect(observation.spanId).not.toBe(spanId)
    observation.setRoute('/databases/:id/collections/bookings/documents/:id')
    observation.end({
      method: 'GET',
      path: '/v1/databases/db/collections/bookings/documents/doc-1',
      status: 500,
      project: 'booking-app',
      auth: 'user:user-1',
      responseBytes: 10,
      error: 'boom',
      id: 'req-1',
    })
    observability.captureEvents([event], user, 'booking-app')
    await observability.flush()

    const traces = captureServer.requests.find((entry) => entry.path === '/v1/traces')
    const span = traces?.body.resourceSpans[0].scopeSpans[0].spans[0]
    expect(span.traceId).toBe(traceId)
    expect(span.parentSpanId).toBe(spanId)
    expect(span.status.code).toBe(2)
    expect(span.attributes).toContainEqual({ key: 'http.route', value: { stringValue: '/databases/:id/collections/bookings/documents/:id' } })

    const logs = captureServer.requests.find((entry) => entry.path === '/v1/logs')
    expect(logs?.body.resourceLogs[0].scopeLogs[0].logRecords[0].traceId).toBe(traceId)

    const metrics = captureServer.requests.find((entry) => entry.path === '/v1/metrics')
    const names = metrics?.body.resourceMetrics[0].scopeMetrics[0].metrics.map((metric: any) => metric.name)
    expect(names).toContain('bunwrite.http.requests')
    expect(names).toContain('bunwrite.http.request.duration')
    expect(names).toContain('bunwrite.process.memory.rss')

    const analytics = captureServer.requests.find((entry) => entry.path === '/batch/')
    expect(analytics?.body.batch[0]).toMatchObject({
      event: 'document.create',
      properties: { distinct_id: 'user-1', project: 'booking-app', collection: 'bookings', document_id: 'doc-1' },
    })

    await observability.close()
  })

  test('local feature flags win over PostHog and are cached', async () => {
    const captureServer = capture()
    const observability = new Observability(
      runtimeConfig({
        posthog: { apiKey: 'ph-key', host: captureServer.url, analytics: true, flags: true, flagsTtlMs: 30_000 },
        localFlags: { beta: true, theme: 'dark' },
      }),
      { timers: false },
    )
    const flags = await observability.flags.evaluate('user-1', { project: 'booking-app' })
    expect(flags).toEqual({ beta: true, theme: 'dark', off: false })
    await observability.flags.evaluate('user-1', { project: 'booking-app' })
    expect(captureServer.requests.filter((entry) => entry.path === '/flags')).toHaveLength(1)
    expect(await observability.flags.isEnabled('off', 'user-1', true)).toBe(false)
    await observability.close()
  })

  test('stays inert when the console and every provider are off', () => {
    const observability = new Observability(runtimeConfig({ console: false }), { timers: false })
    expect(observability.enabled).toBe(false)
    expect(observability.begin(new Request('http://localhost/'))).toBeNull()
    expect(observability.flags.enabled).toBe(false)
  })

  test('can be reconfigured in place without a restart', async () => {
    const observability = new Observability(runtimeConfig({ console: false }), { timers: false })
    expect(observability.enabled).toBe(false)
    await observability.reconfigure(runtimeConfig({ console: true, consoleSampleRate: 1, localFlags: { beta: true } }), { timers: false })
    expect(observability.enabled).toBe(true)
    expect(observability.console).toBe(true)
    expect(observability.flags.enabled).toBe(true)
    expect(await observability.flags.evaluate('project:p')).toEqual({ beta: true })
    const observation = observability.begin(new Request('https://api.example.com/v1/health'))
    expect(observation).not.toBeNull()
    observation!.end({ method: 'GET', path: '/v1/health', status: 200, project: 'p' })
    await observability.close()
  })

  test('keeps a local trace when the console is on and no provider is configured', async () => {
    const observability = new Observability(runtimeConfig({ consoleSampleRate: 1 }), { timers: false })
    const spans: Array<{ route: string; status: number }> = []
    const observation = observability.begin(new Request('https://api.example.com/v1/health'))!
    expect(observation).not.toBeNull()
    observation.end({
      method: 'GET',
      path: '/v1/health',
      status: 200,
      project: 'booking-app',
      telemetry: {
        recordSpan: (span: SpanInput) => spans.push({ route: span.route, status: span.status }),
        recordEvent: () => {},
        recordRequest: () => {},
      } as any,
    })
    expect(spans).toEqual([{ route: '/health', status: 200 }])
    await observability.close()
  })
})

describe('route labels', () => {
  test('paths that match no route share one label', async () => {
    const server = startServer()
    try {
      const observability = server.services.observability
      await observability.reconfigure({ ...observability.config, console: true, consoleSampleRate: 1 }, { timers: false })
      for (const path of ['/wp-login.php', '/.env/backup', '/databases/main/collections/products/documents']) {
        await fetch(`${server.endpoint}${path}`, { headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY } })
      }
      await server.services.telemetry.flush()
      const routes = server.db.sqlite
        .query<{ route: string }, []>('SELECT DISTINCT route FROM _telemetry_spans ORDER BY route')
        .all()
        .map((row) => row.route)
      expect(routes).toEqual(['/databases/:id/collections/:id/documents', 'unmatched'])
    } finally {
      server.stop()
    }
  })
})
