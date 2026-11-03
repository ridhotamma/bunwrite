/**
 * Observability settings and their built-in defaults.
 *
 * Providers, sampling, limits and local feature flags are configured per
 * project in the console and stored in that project's database. No
 * operator-editable setting is read from the environment: a project starts
 * with the defaults below until an operator saves its own values.
 *
 * With no provider configured the whole subsystem stays off and the request
 * path only pays a boolean check.
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
  /** Local flag overrides; they win over PostHog. */
  localFlags: Record<string, boolean | string>
}

/** `OTEL_EXPORTER_OTLP_HEADERS`-style input, or the console textarea value. */
export function parseHeaders(value: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const pair of (value ?? '').trim().split(',')) {
    if (!pair) continue
    const at = pair.indexOf('=')
    if (at < 1) continue
    headers[pair.slice(0, at).trim()] = pair.slice(at + 1).trim()
  }
  return headers
}

/** The starting point for a project that has not saved observability settings. */
export function defaultObservabilityConfig(): ObservabilityConfig {
  // Only process identity comes from the environment; every operator-editable
  // setting is per project and lives in the project database.
  const worker = (process.env.BUNWRITE_WORKER ?? '').trim() || '0'
  const host = (process.env.HOSTNAME ?? process.env.HOST ?? '').trim() || 'unknown'
  return {
    enabled: false,
    console: true,
    serviceName: 'bunwrite',
    serviceVersion: '1.8.0',
    environment: 'production',
    instanceId: `${host}:${worker}`,
    sampleRate: 1,
    consoleSampleRate: 0.01,
    spanLimit: 2_000,
    eventLimit: 5_000,
    consoleRetentionDays: 7,
    flushMs: 5_000,
    timeoutMs: 5_000,
    queueLimit: 5_000,
    debug: false,
    otlp: null,
    datadog: null,
    posthog: null,
    localFlags: {},
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
