/**
 * Load-test runner. Uses `oha` when available (accurate HTTP/1.1 client),
 * otherwise falls back to a small in-process Bun client. Saves every result as
 * JSON and prints a table with RPS, latency percentiles and a rough user count.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { randomId } from './lib'

export interface Target {
  name: string
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  contentType?: string
  /** The URL is a regex for `oha --rand-regex-url`. */
  randomUrl?: boolean
  /** Built-in runner's URL generator for random IDs. */
  urlFor?: (index: number) => string
  concurrency?: number[]
}

export interface RunOptions {
  targets: Target[]
  headers: Record<string, string>
  concurrency: number[]
  duration: number
  warmup: number
  timeout: number
  tool: 'auto' | 'oha' | 'builtin'
  outDir: string
  meta: Record<string, unknown>
  log?: (line: string) => void
}

export interface RunResult {
  target: string
  method: string
  concurrency: number
  durationSec: number
  tool: 'oha' | 'builtin'
  rps: number
  p50ms: number
  p95ms: number
  p99ms: number
  successPct: number
  responseKb: number
  mbps: number
  users5s: number
  status: Record<string, number>
  errors: Record<string, number>
}

interface OhaResult {
  summary: {
    successRate: number
    requestsPerSec: number
    average: number
    sizePerRequest: number
    sizePerSec: number
  }
  latencyPercentiles: Record<string, number>
  statusCodeDistribution: Record<string, number>
  errorDistribution: Record<string, number>
}

let active: Bun.Subprocess | null = null

function resolveTool(requested: RunOptions['tool']): 'oha' | 'builtin' {
  if (requested === 'builtin') return 'builtin'
  const oha = Bun.which('oha')
  if (requested === 'oha' && !oha) {
    throw new Error('oha is not installed. Install it with `brew install oha` or use --tool builtin.')
  }
  return oha ? 'oha' : 'builtin'
}

function headersFor(target: Target, common: Record<string, string>): Record<string, string> {
  return { ...common, ...target.headers }
}

function resultFromOha(target: Target, concurrency: number, duration: number, raw: OhaResult): RunResult {
  return {
    target: target.name,
    method: target.method ?? 'GET',
    concurrency,
    durationSec: duration,
    tool: 'oha',
    rps: raw.summary.requestsPerSec,
    p50ms: (raw.latencyPercentiles.p50 ?? 0) * 1000,
    p95ms: (raw.latencyPercentiles.p95 ?? 0) * 1000,
    p99ms: (raw.latencyPercentiles.p99 ?? 0) * 1000,
    successPct: raw.summary.successRate * 100,
    responseKb: raw.summary.sizePerRequest / 1024,
    mbps: (raw.summary.sizePerSec * 8) / 1_000_000,
    users5s: raw.summary.requestsPerSec * 5,
    status: raw.statusCodeDistribution,
    errors: raw.errorDistribution,
  }
}

async function runOha(target: Target, options: RunOptions, concurrency: number): Promise<RunResult> {
  const headers = headersFor(target, options.headers)
  const args = ['-z', `${options.duration}s`, '-c', String(concurrency), '-t', `${options.timeout}s`, '--no-tui', '-j']
  for (const [name, value] of Object.entries(headers)) args.push('-H', `${name}: ${value}`)
  if (target.randomUrl) args.push('--rand-regex-url')
  if (target.method) args.push('-m', target.method)
  if (target.body) args.push('-d', target.body)
  if (target.contentType) args.push('-T', target.contentType)
  args.push(target.url)

  const proc = Bun.spawn(['oha', ...args], { stdout: 'pipe', stderr: 'pipe' })
  active = proc
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  active = null
  if (code !== 0) throw new Error(`oha exited ${code}: ${stderr.slice(0, 500)}`)
  try {
    return resultFromOha(target, concurrency, options.duration, JSON.parse(stdout) as OhaResult)
  } catch {
    throw new Error(`oha returned invalid JSON: ${stdout.slice(0, 500)} ${stderr.slice(0, 500)}`)
  }
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
}

async function runBuiltin(target: Target, options: RunOptions, concurrency: number): Promise<RunResult> {
  if (target.randomUrl && !target.urlFor) {
    throw new Error(`Target "${target.name}" uses randomUrl, which the built-in client cannot generate. Use --tool oha or a fixed URL.`)
  }
  const headers = headersFor(target, options.headers)
  if (target.body && target.contentType && !headers['content-type'] && !headers['Content-Type']) {
    headers['content-type'] = target.contentType
  }
  const method = target.method ?? 'GET'
  const started = performance.now()
  const deadline = started + options.duration * 1000
  const status: Record<string, number> = {}
  const errors: Record<string, number> = {}
  const latencies: number[] = []
  let attempts = 0
  let completed = 0
  let ok = 0
  let bytes = 0
  let index = 0

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < deadline) {
        const url = target.urlFor ? target.urlFor(index++) : target.url
        const requestStarted = performance.now()
        attempts++
        try {
          const response = await fetch(url, {
            method,
            headers,
            body: method === 'GET' || method === 'HEAD' ? undefined : target.body,
            signal: AbortSignal.timeout(options.timeout * 1000),
          })
          const body = await response.arrayBuffer()
          completed++
          bytes += body.byteLength
          status[String(response.status)] = (status[String(response.status)] ?? 0) + 1
          if (response.status >= 200 && response.status < 400) ok++
          latencies.push(performance.now() - requestStarted)
        } catch (error) {
          const name = error instanceof Error ? error.name : 'Error'
          errors[name] = (errors[name] ?? 0) + 1
        }
      }
    }),
  )

  const elapsed = Math.max(0.001, (performance.now() - started) / 1000)
  latencies.sort((a, b) => a - b)
  return {
    target: target.name,
    method,
    concurrency,
    durationSec: options.duration,
    tool: 'builtin',
    rps: attempts / elapsed,
    p50ms: percentile(latencies, 0.5),
    p95ms: percentile(latencies, 0.95),
    p99ms: percentile(latencies, 0.99),
    successPct: attempts === 0 ? 0 : (ok / attempts) * 100,
    responseKb: completed === 0 ? 0 : bytes / completed / 1024,
    mbps: (bytes / elapsed / 1_000_000) * 8,
    users5s: (attempts / elapsed) * 5,
    status,
    errors,
  }
}

function printRow(result: RunResult): void {
  console.log(
    `${result.target.padEnd(14)} c=${String(result.concurrency).padStart(4)}  ` +
      `${result.rps.toFixed(0).padStart(7)} rps  ` +
      `p50=${result.p50ms.toFixed(1).padStart(6)}ms  ` +
      `p95=${result.p95ms.toFixed(1).padStart(6)}ms  ` +
      `p99=${result.p99ms.toFixed(1).padStart(6)}ms  ` +
      `ok=${result.successPct.toFixed(2).padStart(6)}%  ` +
      `${result.responseKb.toFixed(1).padStart(6)} KB  ` +
      `${result.mbps.toFixed(1).padStart(6)} Mbps  ` +
      `users@5s≈${Math.round(result.users5s)}`,
  )
}

export async function runMatrix(options: RunOptions): Promise<{ results: RunResult[]; file: string; tool: 'oha' | 'builtin' }> {
  const log = options.log ?? ((line) => console.log(line))
  const tool = resolveTool(options.tool)
  if (tool === 'builtin' && options.tool === 'auto') log('oha not found; using the built-in Bun client (the client may be the bottleneck).')
  const results: RunResult[] = []
  let interrupted = false
  process.on('SIGINT', () => {
    interrupted = true
    active?.kill()
  })

  for (const target of options.targets) {
    const levels = target.concurrency ?? options.concurrency
    log(`\n${target.name}: ${target.method ?? 'GET'} ${target.url.length > 140 ? `${target.url.slice(0, 137)}...` : target.url}`)
    if (options.warmup > 0) {
      const warm = Math.min(10, Math.max(...levels))
      log(`  warmup ${options.warmup}s at c=${warm}`)
      await (tool === 'oha' ? runOha(target, { ...options, duration: options.warmup }, warm) : runBuiltin(target, { ...options, duration: options.warmup }, warm))
    }
    for (const concurrency of levels) {
      if (interrupted) break
      const result = await (tool === 'oha' ? runOha(target, options, concurrency) : runBuiltin(target, options, concurrency))
      results.push(result)
      printRow(result)
    }
    if (interrupted) break
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(options.outDir, `stress-${stamp}-${randomId().slice(0, 6)}.json`)
  mkdirSync(options.outDir, { recursive: true })
  writeFileSync(file, JSON.stringify({ ...options.meta, tool, durationSec: options.duration, concurrency: options.concurrency, results }, null, 2))
  log(`\nresults: ${file}`)
  log('users@5s is RPS × 5s (one request per user every 5 seconds); divide by calls per page for real user counts.')
  return { results, file, tool }
}
