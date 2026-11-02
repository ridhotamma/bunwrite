/**
 * Console-managed observability settings.
 *
 * Environment variables remain the defaults. A single `_settings` row in the
 * control database overlays them, so an operator can configure OTLP, Datadog,
 * PostHog and feature flags without editing `.env` or restarting. Saving emits
 * to `Observability.reconfigure()` and to every project's local telemetry store.
 */
import type { SqlDatabase } from '~/db/driver'
import { now } from '~/lib/datetime'
import { observabilityConfig, parseHeaders, type ObservabilityConfig, type OtlpSignal } from './config'
import type { TelemetryOptions } from './store'

export const OBSERVABILITY_SETTING = 'observability'

export interface OtlpSettings {
  endpoint: string
  traces: string
  metrics: string
  logs: string
  /** `key=value` pairs, one per line or comma-separated. */
  headers: string
  signals: OtlpSignal[]
}

export interface DatadogSettings {
  apiKey: string
  site: string
  logs: boolean
  metrics: boolean
}

export interface PosthogSettings {
  apiKey: string
  host: string
  analytics: boolean
  flags: boolean
  flagsTtlMs: number
}

export interface ObservabilitySettings {
  enabled: boolean
  console: boolean
  serviceName: string
  serviceVersion: string
  environment: string
  sampleRate: number
  consoleSampleRate: number
  spanLimit: number
  eventLimit: number
  consoleRetentionDays: number
  flushMs: number
  timeoutMs: number
  queueLimit: number
  debug: boolean
  otlp: OtlpSettings | null
  datadog: DatadogSettings | null
  posthog: PosthogSettings | null
  localFlags: Record<string, boolean | string>
}

const SIGNALS: OtlpSignal[] = ['traces', 'metrics', 'logs']

export function settingsFromConfig(config: ObservabilityConfig): ObservabilitySettings {
  return {
    enabled: config.enabled,
    console: config.console,
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
    environment: config.environment,
    sampleRate: config.sampleRate,
    consoleSampleRate: config.consoleSampleRate,
    spanLimit: config.spanLimit,
    eventLimit: config.eventLimit,
    consoleRetentionDays: config.consoleRetentionDays,
    flushMs: config.flushMs,
    timeoutMs: config.timeoutMs,
    queueLimit: config.queueLimit,
    debug: config.debug,
    otlp: config.otlp
      ? {
          endpoint: config.otlp.endpoint,
          traces: config.otlp.traces,
          metrics: config.otlp.metrics,
          logs: config.otlp.logs,
          headers: Object.entries(config.otlp.headers)
            .map(([key, value]) => `${key}=${value}`)
            .join('\n'),
          signals: [...config.otlp.signals],
        }
      : null,
    datadog: config.datadog ? { ...config.datadog } : null,
    posthog: config.posthog ? { ...config.posthog } : null,
    localFlags: { ...config.localFlags },
  }
}

/** Turn console settings back into the runtime shape. `base` supplies the per-worker instance ID. */
export function configFromSettings(settings: ObservabilitySettings, base: ObservabilityConfig): ObservabilityConfig {
  const otlpSettings = settings.otlp
  const endpoint = otlpSettings?.endpoint.trim().replace(/\/+$/, '') ?? ''
  const traces = otlpSettings?.traces.trim() || (endpoint ? `${endpoint}/v1/traces` : '')
  const metrics = otlpSettings?.metrics.trim() || (endpoint ? `${endpoint}/v1/metrics` : '')
  const logs = otlpSettings?.logs.trim() || (endpoint ? `${endpoint}/v1/logs` : '')
  const headers = parseHeaders((otlpSettings?.headers ?? '').replace(/\n/g, ','))
  const signals = new Set((otlpSettings?.signals ?? []).filter((signal): signal is OtlpSignal => SIGNALS.includes(signal)))
  const otlp =
    otlpSettings && (endpoint || traces || metrics || logs)
      ? {
          endpoint: endpoint || traces || metrics || logs,
          traces,
          metrics,
          logs,
          headers,
          signals,
        }
      : null

  return {
    ...base,
    enabled: settings.enabled,
    console: settings.console,
    serviceName: settings.serviceName,
    serviceVersion: settings.serviceVersion,
    environment: settings.environment,
    sampleRate: settings.sampleRate,
    consoleSampleRate: settings.consoleSampleRate,
    spanLimit: settings.spanLimit,
    eventLimit: settings.eventLimit,
    consoleRetentionDays: settings.consoleRetentionDays,
    flushMs: settings.flushMs,
    timeoutMs: settings.timeoutMs,
    queueLimit: settings.queueLimit,
    debug: settings.debug,
    otlp,
    datadog: settings.datadog?.apiKey ? { ...settings.datadog } : null,
    posthog: settings.posthog?.apiKey ? { ...settings.posthog } : null,
    localFlags: { ...settings.localFlags },
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function stringOf(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function booleanOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numberOf(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed * 1000) / 1000)) : fallback
}

function flagsOf(value: unknown, fallback: Record<string, boolean | string>): Record<string, boolean | string> {
  const object = objectOf(value)
  if (!object) return { ...fallback }
  return Object.fromEntries(Object.entries(object).filter((entry): entry is [string, boolean | string] => typeof entry[1] === 'boolean' || typeof entry[1] === 'string'))
}

function normalizeOtlp(value: unknown, fallback: OtlpSettings | null): OtlpSettings | null {
  if (value === null) return null
  const object = objectOf(value)
  if (!object) return fallback ? { ...fallback, signals: [...fallback.signals] } : null
  return {
    endpoint: stringOf(object.endpoint, fallback?.endpoint ?? ''),
    traces: stringOf(object.traces, fallback?.traces ?? ''),
    metrics: stringOf(object.metrics, fallback?.metrics ?? ''),
    logs: stringOf(object.logs, fallback?.logs ?? ''),
    headers: stringOf(object.headers, fallback?.headers ?? ''),
    signals: Array.isArray(object.signals)
      ? object.signals.filter((signal): signal is OtlpSignal => typeof signal === 'string' && SIGNALS.includes(signal as OtlpSignal))
      : [...(fallback?.signals ?? [])],
  }
}

function normalizeDatadog(value: unknown, fallback: DatadogSettings | null): DatadogSettings | null {
  if (value === null) return null
  const object = objectOf(value)
  if (!object) return fallback ? { ...fallback } : null
  return {
    apiKey: stringOf(object.apiKey, fallback?.apiKey ?? ''),
    site: stringOf(object.site, fallback?.site ?? 'datadoghq.com') || 'datadoghq.com',
    logs: booleanOf(object.logs, fallback?.logs ?? true),
    metrics: booleanOf(object.metrics, fallback?.metrics ?? true),
  }
}

function normalizePosthog(value: unknown, fallback: PosthogSettings | null): PosthogSettings | null {
  if (value === null) return null
  const object = objectOf(value)
  if (!object) return fallback ? { ...fallback } : null
  return {
    apiKey: stringOf(object.apiKey, fallback?.apiKey ?? ''),
    host: stringOf(object.host, fallback?.host ?? 'https://us.i.posthog.com') || 'https://us.i.posthog.com',
    analytics: booleanOf(object.analytics, fallback?.analytics ?? true),
    flags: booleanOf(object.flags, fallback?.flags ?? true),
    flagsTtlMs: numberOf(object.flagsTtlMs, fallback?.flagsTtlMs ?? 30_000, 1_000, 3_600_000),
  }
}

/** Validate a stored or submitted value, filling gaps from the environment defaults. */
export function normalizeSettings(value: unknown, defaults: ObservabilitySettings): ObservabilitySettings {
  const object = objectOf(value) ?? {}
  return {
    enabled: booleanOf(object.enabled, defaults.enabled),
    console: booleanOf(object.console, defaults.console),
    serviceName: stringOf(object.serviceName, defaults.serviceName) || 'bunwrite',
    serviceVersion: stringOf(object.serviceVersion, defaults.serviceVersion) || '1.8.0',
    environment: stringOf(object.environment, defaults.environment) || 'production',
    sampleRate: numberOf(object.sampleRate, defaults.sampleRate, 0, 1),
    consoleSampleRate: numberOf(object.consoleSampleRate, defaults.consoleSampleRate, 0, 1),
    spanLimit: numberOf(object.spanLimit, defaults.spanLimit, 100, 100_000),
    eventLimit: numberOf(object.eventLimit, defaults.eventLimit, 100, 100_000),
    consoleRetentionDays: numberOf(object.consoleRetentionDays, defaults.consoleRetentionDays, 1, 90),
    flushMs: numberOf(object.flushMs, defaults.flushMs, 250, 60_000),
    timeoutMs: numberOf(object.timeoutMs, defaults.timeoutMs, 250, 30_000),
    queueLimit: numberOf(object.queueLimit, defaults.queueLimit, 100, 100_000),
    debug: booleanOf(object.debug, defaults.debug),
    otlp: normalizeOtlp(object.otlp, defaults.otlp),
    datadog: normalizeDatadog(object.datadog, defaults.datadog),
    posthog: normalizePosthog(object.posthog, defaults.posthog),
    localFlags: flagsOf(object.localFlags, defaults.localFlags),
  }
}

type Listener = (settings: ObservabilitySettings) => void | Promise<void>

export class ObservabilitySettingsStore {
  private readonly base: ObservabilityConfig
  private readonly defaults: ObservabilitySettings
  private current: ObservabilitySettings
  private stored = false
  private readonly listeners = new Set<Listener>()

  constructor(
    private readonly db: SqlDatabase,
    env: Record<string, string | undefined> = process.env,
  ) {
    this.base = observabilityConfig(env)
    this.defaults = settingsFromConfig(this.base)
    this.current = this.defaults
    if (db.dialect === 'sqlite') this.loadSync()
  }

  get settings(): ObservabilitySettings {
    return this.current
  }

  get config(): ObservabilityConfig {
    return configFromSettings(this.current, this.base)
  }

  /** True when the value comes from the console rather than `.env`. */
  get overridden(): boolean {
    return this.stored
  }

  get environmentDefaults(): ObservabilitySettings {
    return this.defaults
  }

  /** Returns true when the effective value changed. */
  private apply(value: unknown): boolean {
    const before = JSON.stringify(this.current)
    const wasStored = this.stored
    if (value === null || value === undefined || value === '') {
      this.current = this.defaults
      this.stored = false
    } else {
      try {
        this.current = normalizeSettings(typeof value === 'string' ? JSON.parse(value) : value, this.defaults)
        this.stored = true
      } catch {
        this.current = this.defaults
        this.stored = false
      }
    }
    return wasStored !== this.stored || before !== JSON.stringify(this.current)
  }

  private loadSync(): void {
    const row = this.db.sqlite?.query<{ value: string }, [string]>('SELECT value FROM _settings WHERE key = ?').get(OBSERVABILITY_SETTING)
    this.apply(row?.value)
  }

  async load(): Promise<void> {
    const row = await this.db.driver.get<{ value: string }>('SELECT value FROM _settings WHERE key = ?', [OBSERVABILITY_SETTING])
    if (this.apply(row?.value)) await this.emit()
  }

  async save(settings: ObservabilitySettings): Promise<void> {
    this.current = normalizeSettings(settings, this.defaults)
    this.stored = true
    await this.db.driver.run(
      'INSERT INTO _settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [OBSERVABILITY_SETTING, JSON.stringify(this.current), now()],
    )
    await this.emit()
  }

  /** Delete the console override and go back to the environment values. */
  async reset(): Promise<void> {
    await this.db.driver.run('DELETE FROM _settings WHERE key = ?', [OBSERVABILITY_SETTING])
    this.current = this.defaults
    this.stored = false
    await this.emit()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async emit(): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => listener(this.current)))
  }
}

/** The local telemetry limits implied by a runtime config. */
export function telemetryOptionsOf(config: ObservabilityConfig): TelemetryOptions {
  return {
    maxSpans: config.spanLimit,
    maxEvents: config.eventLimit,
    retentionDays: config.consoleRetentionDays,
    flushMs: Math.min(config.flushMs, 5_000),
  }
}
