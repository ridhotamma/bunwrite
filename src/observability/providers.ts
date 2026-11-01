/**
 * Thin HTTP clients for the providers. Each function is one fetch against the
 * provider's public intake, with no SDK, no background worker and a bounded
 * timeout. Callers batch and retry through BatchQueue.
 */
import type { DatadogConfig, PosthogConfig } from './config'
import type { MetricPoint } from './metrics'
import type { LogData } from './otlp'

export interface AnalyticsEvent {
  event: string
  distinctId: string
  properties: Record<string, string | number | boolean | undefined>
  timestamp: string
}

const USER_AGENT = 'bunwrite-observability/1.0'

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (response.ok) return
  const detail = (await response.text().catch(() => '')).slice(0, 300)
  throw new Error(`${url} returned ${response.status}${detail ? `: ${detail}` : ''}`)
}

export async function sendOtlp(endpoint: string, headers: Record<string, string>, payload: unknown, timeoutMs: number): Promise<void> {
  await postJson(endpoint, payload, headers, timeoutMs)
}

const tagValue = (value: string): string => value.replace(/[,\s]+/g, '_').slice(0, 200)

const datadogTags = (attributes: LogData['attributes'], service: string, environment: string): string =>
  [
    `env:${tagValue(environment)}`,
    `service:${tagValue(service)}`,
    ...Object.entries(attributes)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${tagValue(key)}:${tagValue(String(value))}`),
  ].join(',')

/** Datadog correlates with the low 64 bits of an OTLP 128-bit trace ID. */
const datadogTraceId = (traceId: string): string => BigInt(`0x${traceId.slice(-16)}`).toString()
const datadogSpanId = (spanId: string): string => BigInt(`0x${spanId}`).toString()

/** Datadog Logs intake: `https://http-intake.logs.<site>/api/v2/logs`. */
export async function sendDatadogLogs(
  config: DatadogConfig,
  logs: LogData[],
  options: { service: string; environment: string; hostname: string; timeoutMs: number },
): Promise<void> {
  const url = `https://http-intake.logs.${config.site}/api/v2/logs`
  const body = logs.map((log) => ({
    ddsource: 'bunwrite',
    service: options.service,
    hostname: options.hostname,
    ddtags: datadogTags(log.attributes, options.service, options.environment),
    message: log.message,
    ...log.attributes,
    ...(log.traceId ? { 'dd.trace_id': datadogTraceId(log.traceId), 'dd.span_id': datadogSpanId(log.spanId ?? '0') } : {}),
  }))
  await postJson(url, body, { 'DD-API-KEY': config.apiKey }, options.timeoutMs)
}

function percentile(point: MetricPoint, fraction: number): number {
  if (point.count === 0) return 0
  const target = Math.ceil(point.count * fraction)
  let seen = 0
  for (let index = 0; index < point.buckets.length; index++) {
    seen += point.buckets[index] ?? 0
    if (seen >= target) return point.bounds[index] ?? point.bounds[point.bounds.length - 1] ?? point.max
  }
  return point.max
}

interface Series {
  metric: string
  type: 'count' | 'gauge'
  interval?: number
  points: Array<[number, number]>
  tags: string[]
}

export function datadogSeries(points: MetricPoint[], window: { startMs: number; endMs: number }): Series[] {
  const stamp = Math.floor(window.endMs / 1_000)
  const interval = Math.max(1, Math.round((window.endMs - window.startMs) / 1_000))
  const series: Series[] = []
  for (const point of points) {
    const tags = Object.entries(point.tags)
      .filter(([key]) => key !== 'unit')
      .map(([key, value]) => `${tagValue(key)}:${tagValue(value)}`)
    if (point.type === 'counter') {
      series.push({ metric: point.name, type: 'count', interval, points: [[stamp, point.value]], tags })
    } else if (point.type === 'gauge') {
      series.push({ metric: point.name, type: 'gauge', points: [[stamp, point.value]], tags })
    } else if (point.count > 0) {
      series.push({ metric: `${point.name}.avg`, type: 'gauge', points: [[stamp, point.sum / point.count]], tags })
      series.push({ metric: `${point.name}.p95`, type: 'gauge', points: [[stamp, percentile(point, 0.95)]], tags })
      series.push({ metric: `${point.name}.max`, type: 'gauge', points: [[stamp, point.max]], tags })
    }
  }
  return series
}

/** Datadog metrics intake: `https://api.<site>/api/v1/series`. */
export async function sendDatadogMetrics(
  config: DatadogConfig,
  points: MetricPoint[],
  window: { startMs: number; endMs: number },
  timeoutMs: number,
): Promise<void> {
  const series = datadogSeries(points, window)
  if (series.length === 0) return
  await postJson(`https://api.${config.site}/api/v1/series`, { series }, { 'DD-API-KEY': config.apiKey }, timeoutMs)
}

/** PostHog batch capture: `POST <host>/batch/`. */
export async function sendPosthogEvents(config: PosthogConfig, events: AnalyticsEvent[], timeoutMs: number): Promise<void> {
  if (events.length === 0) return
  await postJson(
    `${config.host}/batch/`,
    {
      api_key: config.apiKey,
      batch: events.map((event) => ({
        event: event.event,
        properties: { distinct_id: event.distinctId, $lib: 'bunwrite', ...event.properties },
        timestamp: event.timestamp,
      })),
    },
    {},
    timeoutMs,
  )
}

export interface PosthogFlagResponse {
  featureFlags?: Record<string, string | boolean>
  flags?: Record<string, { enabled?: boolean; variant?: string }>
}

/** PostHog server-side flag evaluation: `POST <host>/flags?v=2`. */
export async function fetchPosthogFlags(
  config: PosthogConfig,
  distinctId: string,
  groups: Record<string, string>,
  timeoutMs: number,
): Promise<Record<string, boolean | string>> {
  const response = await fetch(`${config.host}/flags?v=2`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({
      api_key: config.apiKey,
      distinct_id: distinctId,
      groups,
      person_properties: {},
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new Error(`${config.host}/flags returned ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  const body = (await response.json()) as PosthogFlagResponse
  const flags: Record<string, boolean | string> = {}
  for (const [key, flag] of Object.entries(body.flags ?? {})) {
    if (flag.enabled === false) flags[key] = false
    else flags[key] = flag.variant || true
  }
  for (const [key, value] of Object.entries(body.featureFlags ?? {})) flags[key] = value
  return flags
}
