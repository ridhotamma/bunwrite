/**
 * Instance-wide observability settings.
 *
 * Everything here is optional and read from the environment, like the rest of
 * the server. With no provider configured the whole subsystem stays off and
 * the request path only pays a boolean check.
 *
 * Supported providers:
 *   - Any OTLP/HTTP collector (Grafana, Honeycomb, Datadog OTLP, an Agent).
 *   - Datadog logs and metrics intake (HTTPS, no SDK).
 *   - PostHog analytics and feature flags (HTTPS, no SDK).
 *
 * No third-party SDK is imported: every exporter is a `fetch` against the
 * provider's documented HTTP API, so the server keeps its small dependency set
 * and the Bun build stays reproducible.
 */

export type OtlpSignal = 'traces' | 'metrics' | 'logs'

export interface OtlpConfig {
  /** Base endpoint, without `/v1/<signal>`. */
  endpoint: string
  /** Full per-signal endpoints, already including the path. */
  traces: string
  metrics: string
  logs: string
  headers: Record<string, string>
  signals: Set<OtlpSignal>
}

export interface DatadogConfig {
  apiKey: string
  /** `datadoghq.com`, `datadoghq.eu`, `us3.datadoghq.com`, ... */
  site: string
  logs: boolean
  metrics: boolean
}

export interface PosthogConfig {
  apiKey: string
  /** `https://us.i.posthog.com` or `https://eu.i.posthog.com`. */
  host: string
  analytics: boolean
  flags: boolean
  flagsTtlMs: number
}

export interface ObservabilityConfig {
  enabled: boolean
  /** Keep a local copy for the console even without an external provider. */
  console: boolean
  serviceName: string
  serviceVersion: string
  environment: string
  /** Distinguishes workers of one deployment in traces and metrics. */
  instanceId: string
  /** Head-based trace sampling, 0..1. Metrics and logs are not sampled here. */
  sampleRate: number
  /** Fraction of requests stored for the console trace explorer. */
  consoleSampleRate: number
  /** Rows kept per project by the local console store. */
  spanLimit: number
  eventLimit: number
  consoleRetentionDays: number
  flushMs: number
  timeoutMs: number
  /** Bounded queues; oldest events are dropped first. */
  queueLimit: number
  debug: boolean
  otlp: OtlpConfig | null
  datadog: DatadogConfig | null
  posthog: PosthogConfig | null
  /** Operator overrides from `FEATURE_FLAGS`; they win over PostHog. */
  localFlags: Record<string, boolean | string>
}

type Env = Record<string, string | undefined>

const text = (value: string | undefined): string => (value ?? '').trim()
const truthy = (value: string | undefined, fallback: boolean): boolean => {
  const setting = text(value).toLowerCase()
  if (!setting) return fallback
  if (['1', 'true', 'yes', 'on'].includes(setting)) return true
  if (['0', 'false', 'no', 'off'].includes(setting)) return false
  return fallback
}

const number = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = Number(text(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

const stripSlash = (value: string): string => value.replace(/\/+$/, '')

/** `OTEL_EXPORTER_OTLP_HEADERS=api-key=abc,x-tenant=one` */
export function parseHeaders(value: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const pair of text(value).split(',')) {
    if (!pair) continue
    const at = pair.indexOf('=')
    if (at < 1) continue
    headers[pair.slice(0, at).trim()] = pair.slice(at + 1).trim()
  }
  return headers
}

function parseSignals(value: string | undefined): Set<OtlpSignal> {
  const allowed: OtlpSignal[] = ['traces', 'metrics', 'logs']
  const requested = text(value)
    .split(',')
    .map((signal) => signal.trim().toLowerCase())
    .filter((signal): signal is OtlpSignal => (allowed as string[]).includes(signal))
  return new Set(requested.length ? requested : allowed)
}

export function parseLocalFlags(value: string | undefined): Record<string, boolean | string> {
  if (!text(value)) return {}
  try {
    const parsed: unknown = JSON.parse(value!)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const flags: Record<string, boolean | string> = {}
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof raw === 'boolean' || typeof raw === 'string') flags[key] = raw
    }
    return flags
  } catch {
    return {}
  }
}

function otlpConfig(env: Env): OtlpConfig | null {
  const base = stripSlash(text(env.OTEL_EXPORTER_OTLP_ENDPOINT))
  const traces = text(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) || (base ? `${base}/v1/traces` : '')
  const metrics = text(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) || (base ? `${base}/v1/metrics` : '')
  const logs = text(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) || (base ? `${base}/v1/logs` : '')
  if (!base && !traces && !metrics && !logs) return null
  return {
    endpoint: base || traces || metrics || logs,
    traces,
    metrics,
    logs,
    headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    // OTEL_<SIGNAL>_EXPORTER=none is the standard way to silence one signal.
    signals: new Set(
      [...parseSignals(env.OBSERVABILITY_SIGNALS ?? env.OTEL_EXPORTER_OTLP_SIGNALS)].filter(
        (signal) => text(env[`OTEL_${signal.toUpperCase()}_EXPORTER`]).toLowerCase() !== 'none',
      ),
    ),
  }
}

function datadogConfig(env: Env): DatadogConfig | null {
  const apiKey = text(env.DD_API_KEY)
  if (!apiKey) return null
  return {
    apiKey,
    site: text(env.DD_SITE) || 'datadoghq.com',
    logs: truthy(env.DD_LOGS_ENABLED, true),
    metrics: truthy(env.DD_METRICS_ENABLED, true),
  }
}

function posthogConfig(env: Env): PosthogConfig | null {
  const apiKey = text(env.POSTHOG_API_KEY) || text(env.POSTHOG_PROJECT_API_KEY)
  if (!apiKey) return null
  return {
    apiKey,
    host: stripSlash(text(env.POSTHOG_HOST) || 'https://us.i.posthog.com'),
    analytics: truthy(env.POSTHOG_ANALYTICS, true),
    flags: truthy(env.POSTHOG_FLAGS, true),
    flagsTtlMs: number(env.POSTHOG_FLAGS_TTL_MS, 30_000, 1_000, 3_600_000),
  }
}

export function observabilityConfig(env: Env = process.env): ObservabilityConfig {
  const otlp = otlpConfig(env)
  const datadog = datadogConfig(env)
  const posthog = posthogConfig(env)
  const localFlags = parseLocalFlags(env.FEATURE_FLAGS)
  const configured = Boolean(otlp || datadog || posthog) || Object.keys(localFlags).length > 0
  const instanceSuffix = text(env.BUNWRITE_WORKER) || '0'
  const host = text(env.HOSTNAME) || text(env.HOST) || 'unknown'

  return {
    enabled: truthy(env.OBSERVABILITY_ENABLED ?? env.OBSERVABILITY, configured),
    // Local telemetry only matters when the console that renders it is on.
    console: truthy(env.OBSERVABILITY_CONSOLE, truthy(env.CONSOLE_ENABLED, true)),
    serviceName: text(env.OTEL_SERVICE_NAME) || 'bunwrite',
    serviceVersion: text(env.OTEL_SERVICE_VERSION) || '1.8.0',
    environment: text(env.DEPLOYMENT_ENVIRONMENT) || text(env.NODE_ENV) || 'production',
    instanceId: text(env.OBSERVABILITY_INSTANCE_ID) || `${host}:${instanceSuffix}`,
    sampleRate: number(env.OBSERVABILITY_SAMPLE_RATE ?? env.OTEL_TRACES_SAMPLER_ARG, 1, 0, 1),
    consoleSampleRate: number(env.OBSERVABILITY_CONSOLE_SAMPLE_RATE, 0.01, 0, 1),
    spanLimit: number(env.OBSERVABILITY_CONSOLE_SPANS, 2_000, 100, 100_000),
    eventLimit: number(env.OBSERVABILITY_CONSOLE_EVENTS, 5_000, 100, 100_000),
    consoleRetentionDays: number(env.OBSERVABILITY_CONSOLE_RETENTION_DAYS, 7, 1, 90),
    flushMs: number(env.OBSERVABILITY_FLUSH_MS, 5_000, 250, 60_000),
    timeoutMs: number(env.OBSERVABILITY_TIMEOUT_MS, 5_000, 250, 30_000),
    queueLimit: number(env.OBSERVABILITY_QUEUE_LIMIT, 5_000, 100, 100_000),
    debug: truthy(env.OBSERVABILITY_DEBUG, false),
    otlp,
    datadog,
    posthog,
    localFlags,
  }
}

/** True when at least one configured exporter will actually receive data. */
export function hasAnySink(config: ObservabilityConfig): boolean {
  const otlp = config.otlp
  return Boolean(
    (otlp && otlp.signals.size > 0) ||
    (config.datadog && (config.datadog.logs || config.datadog.metrics)) ||
    (config.posthog && (config.posthog.analytics || config.posthog.flags)),
  )
}
