import { afterEach, describe, expect, test } from 'bun:test'

import type { Caller } from '~/auth/caller'
import type { Collection } from '~/schema/types'
import type { DocEvent } from '~/documents/store'
import { observabilityConfig, parseHeaders, parseLocalFlags } from '~/observability/config'
import { normalizePath, Observability, parseTraceparent } from '~/observability'
import { MetricRegistry } from '~/observability/metrics'
import { datadogSeries } from '~/observability/providers'
import { logsPayload, metricsPayload, tracesPayload } from '~/observability/otlp'

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

describe('observability config', () => {
  test('is off with no provider', () => {
    const config = observabilityConfig({})
    expect(config.enabled).toBe(false)
    expect(config.otlp).toBeNull()
    expect(config.datadog).toBeNull()
    expect(config.posthog).toBeNull()
  })

  test('reads OTLP, headers and per-signal overrides', () => {
    const config = observabilityConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example.com/',
      OTEL_EXPORTER_OTLP_HEADERS: 'api-key=abc,x-tenant=one',
      OTEL_METRICS_EXPORTER: 'none',
    })
    expect(config.enabled).toBe(true)
    expect(config.otlp?.traces).toBe('https://otlp.example.com/v1/traces')
    expect(config.otlp?.headers).toEqual({ 'api-key': 'abc', 'x-tenant': 'one' })
    expect([...(config.otlp?.signals ?? [])].sort()).toEqual(['logs', 'traces'])
  })

  test('reads Datadog and PostHog, and lets local flags win later', () => {
    const config = observabilityConfig({
      DD_API_KEY: 'dd-key',
      DD_SITE: 'datadoghq.eu',
      POSTHOG_API_KEY: 'ph-key',
      POSTHOG_HOST: 'https://eu.i.posthog.com/',
      FEATURE_FLAGS: '{"beta":true,"theme":"dark","ignored":1}',
      OBSERVABILITY_SAMPLE_RATE: '0.25',
    })
    expect(config.datadog).toMatchObject({ apiKey: 'dd-key', site: 'datadoghq.eu', logs: true, metrics: true })
    expect(config.posthog).toMatchObject({ apiKey: 'ph-key', host: 'https://eu.i.posthog.com', flags: true })
    expect(config.localFlags).toEqual({ beta: true, theme: 'dark' })
    expect(config.sampleRate).toBe(0.25)
  })

  test('explicit switches disable the subsystem and individual providers', () => {
    expect(observabilityConfig({ OBSERVABILITY_ENABLED: 'false', POSTHOG_API_KEY: 'x' }).enabled).toBe(false)
    expect(observabilityConfig({ DD_API_KEY: 'x', DD_LOGS_ENABLED: 'false' }).datadog?.logs).toBe(false)
    expect(observabilityConfig({ POSTHOG_API_KEY: 'x', POSTHOG_ANALYTICS: 'false' }).posthog?.analytics).toBe(false)
  })

  test('parsers tolerate malformed input', () => {
    expect(parseHeaders('a=1,b=2=3,c')).toEqual({ a: '1', b: '2=3' })
    expect(parseHeaders(undefined)).toEqual({})
    expect(parseLocalFlags('not json')).toEqual({})
    expect(parseLocalFlags('[1,2]')).toEqual({})
    expect(parseLocalFlags('{"ok":true,"n":2}')).toEqual({ ok: true })
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
    const config = observabilityConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })
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
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: captureServer.url,
        POSTHOG_API_KEY: 'ph-key',
        POSTHOG_HOST: captureServer.url,
        FEATURE_FLAGS: '{"beta":true,"theme":"dark"}',
      },
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
      {
        POSTHOG_API_KEY: 'ph-key',
        POSTHOG_HOST: captureServer.url,
        FEATURE_FLAGS: '{"beta":true,"theme":"dark"}',
      },
      { timers: false },
    )
    const flags = await observability.flags.evaluate('user-1', { project: 'booking-app' })
    expect(flags).toEqual({ beta: true, theme: 'dark', off: false })
    await observability.flags.evaluate('user-1', { project: 'booking-app' })
    expect(captureServer.requests.filter((entry) => entry.path === '/flags')).toHaveLength(1)
    expect(await observability.flags.isEnabled('off', 'user-1', true)).toBe(false)
    await observability.close()
  })

  test('stays inert when no provider is configured', () => {
    const observability = new Observability({}, { timers: false })
    expect(observability.enabled).toBe(false)
    expect(observability.begin(new Request('http://localhost/'))).toBeNull()
    expect(observability.flags.enabled).toBe(false)
  })
})
