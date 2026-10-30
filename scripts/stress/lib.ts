/**
 * Shared plumbing for the stress scripts: flags, API calls, manifests,
 * statistics and small formatting helpers. Keeping this here means the
 * booking, social and realtime scenarios only describe their own workload.
 */

export interface Cli {
  flag(name: string): string | undefined
  has(name: string): boolean
  numberFlag(name: string, fallback: number): number
  integerFlag(name: string, fallback: number, min?: number): number
  levels(name: string, fallback: string): number[]
  boolFlag(name: string, fallback?: boolean): boolean
}

/** Build flag readers bound to one argv slice. */
export function createCli(argv: string[]): Cli {
  const flag = (name: string): string | undefined => {
    const eq = argv.find((arg) => arg.startsWith(`--${name}=`))
    if (eq !== undefined) return eq.slice(name.length + 3)
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : undefined
  }

  const has = (name: string): boolean => argv.includes(`--${name}`)

  const numberFlag = (name: string, fallback: number): number => {
    const raw = flag(name)
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`)
    return value
  }

  const integerFlag = (name: string, fallback: number, min = 1): number => {
    const value = numberFlag(name, fallback)
    if (!Number.isInteger(value) || value < min) throw new Error(`--${name} must be an integer >= ${min}`)
    return value
  }

  const levels = (name: string, fallback: string): number[] => {
    const raw = flag(name) ?? fallback
    const out = raw.split(',').map((value) => Number(value.trim()))
    if (out.length === 0 || out.some((value) => !Number.isInteger(value) || value < 1)) {
      throw new Error(`--${name} must be a comma-separated list of positive integers`)
    }
    return out
  }

  const boolFlag = (name: string, fallback = false): boolean => {
    if (has(name)) return true
    const raw = flag(name)
    if (raw === undefined) return fallback
    return raw === 'true' || raw === '1' || raw === 'yes'
  }

  return { flag, has, numberFlag, integerFlag, levels, boolFlag }
}

export function env(name: string): string | undefined {
  return process.env[name] || undefined
}

export function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required.`)
  return value
}

export function normalizeBase(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function assertId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(value)) {
    throw new Error(`${label} must be 1-36 chars of a-z, A-Z, 0-9, period, hyphen and underscore`)
  }
  return value
}

export function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0')
}

export function iso(value: Date | number): string {
  return new Date(value).toISOString()
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 14).padEnd(12, '0')
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function queryString(queries: Record<string, unknown>[], total: boolean): string {
  const encoded = queries.map((query, index) => `queries[${index}]=${encodeURIComponent(JSON.stringify(query))}`)
  encoded.push(`total=${total ? 'true' : 'false'}`)
  return encoded.join('&')
}

export interface ApiOptions {
  base: string
  project: string
  key: string
  timeout: number
}

export interface ApiResult {
  status: number
  body: unknown
  text: string
}

export async function api(
  options: ApiOptions,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    'X-Appwrite-Project': options.project,
    'X-Appwrite-Key': options.key,
    ...extraHeaders,
  }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${options.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeout * 1000),
  })
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  return { status: response.status, body: parsed, text }
}

export function assertOk(result: ApiResult, label: string, allowed: number[] = []): ApiResult {
  if (result.status >= 200 && result.status < 300) return result
  if (allowed.includes(result.status)) return result
  throw new Error(`${label} failed: HTTP ${result.status} ${result.text.slice(0, 1000)}`)
}

export interface Stats {
  n: number
  min: number
  avg: number
  p50: number
  p95: number
  p99: number
  max: number
}

export function stats(values: number[]): Stats {
  if (values.length === 0) return { n: 0, min: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
  return {
    n: sorted.length,
    min: sorted[0]!,
    avg: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1]!,
  }
}

export function ms(value: number): string {
  return `${value.toFixed(value >= 100 ? 0 : 1)} ms`
}

export function pct(value: number): string {
  return `${value.toFixed(2)}%`
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs)
    promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; error?: { message?: unknown }; type?: unknown }
    if (value.message) return String(value.message)
    if (value.error?.message) return String(value.error.message)
    if (value.type) return String(value.type)
  }
  return String(error)
}
