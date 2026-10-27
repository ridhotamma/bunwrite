/**
 * Appwrite Functions without Docker. Each execution runs the function's code
 * from its folder in a child process (Bun for node-* runtimes, python3 for
 * python-*), with the same env vars Appwrite injects, so a crash or a leak
 * dies with the process. Schedules run from an in-process cron.
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import type { Caller } from '~/auth/caller'
import type { Config } from '~/config'
import type { Db } from '~/db/connection'
import type { DocumentStore } from '~/documents/store'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { uniqueId } from '~/lib/ids'
import { normalizeAttribute, type Collection } from '~/schema/types'
import { listSeqs } from '~/system/list'
import { parseCron } from './cron'

const RESULT_MARKER = '__APPWRITE_EXECUTION_RESULT__'
const SYNC_TIMEOUT = 30
const RUNNER_NODE = join(import.meta.dir, 'runner-node.ts')
const RUNNER_PYTHON = join(import.meta.dir, 'runner-python.py')
/** Server-only settings a function never needs to see. */
const PRIVATE_ENV = ['SECRET', 'API_KEYS', 'GOOGLE_CLIENT_SECRET', 'SMTP_PASSWORD', 'CONSOLE_ADMIN_PASSWORD']

export interface FunctionRow {
  id: string
  name: string
  runtime: string
  entrypoint: string
  path: string
  execute: string
  events: string
  schedule: string
  timeout: number
  enabled: number
  scopes: string
  created_at: string
  updated_at: string
}

export interface ExecutionRow {
  seq: number
  id: string
  function_id: string
  trigger: string
  status: string
  request_method: string
  request_path: string
  request_headers: string
  request_body: string
  response_status_code: number
  response_body: string
  response_headers: string
  logs: string
  errors: string
  duration: number
  scheduled_at: string | null
  created_at: string
  updated_at: string
}

export interface ExecutionRequest {
  trigger: 'http' | 'schedule' | 'event'
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: string
  userId?: string | null
}

export interface ExecutionResult {
  statusCode: number
  headers: Record<string, string>
  body: string
}

const EXECUTIONS: Collection = (() => {
  const attributes = (
    [
      ['functionId', 'string'],
      ['trigger', 'string'],
      ['status', 'string'],
      ['responseStatusCode', 'integer'],
      ['requestMethod', 'string'],
      ['requestPath', 'string'],
      ['duration', 'double'],
    ] as const
  ).map(([key, type]) => normalizeAttribute({ key, type, size: 1_000_000 }))
  return {
    seq: 0, databaseId: '', databaseSeq: 0, id: 'executions', name: 'executions', enabled: true, documentSecurity: false,
    permissions: [], attributes, indexes: [], createdAt: '', updatedAt: '', table: 'v_executions', permsTable: '',
    attributeMap: new Map(attributes.map((a) => [a.key, a])),
  }
})()

const parse = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function functionModel(f: FunctionRow) {
  return {
    $id: f.id,
    $createdAt: f.created_at,
    $updatedAt: f.updated_at,
    execute: parse<string[]>(f.execute, []),
    name: f.name,
    description: '',
    enabled: Boolean(f.enabled),
    live: true,
    logging: true,
    runtime: f.runtime,
    deploymentRetention: 0,
    deploymentId: f.id,
    deploymentCreatedAt: f.updated_at,
    latestDeploymentId: f.id,
    latestDeploymentCreatedAt: f.updated_at,
    latestDeploymentStatus: 'ready',
    scopes: parse<string[]>(f.scopes, []),
    vars: [] as unknown[],
    events: parse<string[]>(f.events, []),
    schedule: f.schedule,
    timeout: f.timeout,
    entrypoint: f.entrypoint,
    commands: '',
    version: 'v5',
    installationId: '',
    providerRepositoryId: '',
    providerBranch: '',
    providerRootDirectory: '',
    providerSilentMode: false,
    buildSpecification: 's-1vcpu-512mb',
    runtimeSpecification: 's-1vcpu-512mb',
  }
}

export function executionModel(e: ExecutionRow) {
  return {
    $id: e.id,
    $createdAt: e.created_at,
    $updatedAt: e.updated_at,
    $permissions: [] as string[],
    functionId: e.function_id,
    resourceId: e.function_id,
    resourceType: 'functions',
    deploymentId: e.function_id,
    requestMethod: e.request_method,
    requestPath: e.request_path,
    requestHeaders: parse<unknown[]>(e.request_headers, []),
    responseStatusCode: e.response_status_code,
    responseBody: e.response_body,
    responseHeaders: parse<unknown[]>(e.response_headers, []),
    logs: e.logs,
    errors: e.errors,
    duration: e.duration,
    trigger: e.trigger,
    status: e.status,
    scheduledAt: e.scheduled_at,
  }
}

/** Parse a dotenv file for function variables (FUNCTIONS_ENV_FILE). */
export function readEnvFile(path: string | undefined): Record<string, string> {
  if (!path || !existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

export class FunctionService {
  private running = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTick = -1

  constructor(
    private db: Db,
    private config: Config,
    private store: DocumentStore,
    private options: { functionEnv?: Record<string, string>; skipSchedules?: string[]; internalEndpoint?: string } = {},
  ) {}

  private get sql() {
    return this.db.sqlite
  }

  fn(id: string): FunctionRow {
    const row = this.sql.query<FunctionRow, [string]>('SELECT * FROM _functions WHERE id = ?').get(id)
    if (!row) throw err('function_not_found')
    return row
  }

  list(): FunctionRow[] {
    return this.sql.query<FunctionRow, []>('SELECT * FROM _functions ORDER BY seq').all()
  }

  update(id: string, fields: { enabled: boolean; schedule: string; timeout: number; execute: string[] }): FunctionRow {
    this.fn(id)
    if (fields.schedule) parseCron(fields.schedule) // throws on a bad expression
    if (!Number.isInteger(fields.timeout) || fields.timeout < 1 || fields.timeout > 900) {
      throw err('general_argument_invalid', 'Timeout must be between 1 and 900 seconds.')
    }
    this.sql
      .query('UPDATE _functions SET enabled = ?, schedule = ?, timeout = ?, execute = ?, updated_at = ? WHERE id = ?')
      .run(fields.enabled ? 1 : 0, fields.schedule, fields.timeout, JSON.stringify(fields.execute), now(), id)
    return this.fn(id)
  }

  variables(functionId: string): { key: string; value: string; secret: number; function_id: string }[] {
    return this.sql
      .query<{ key: string; value: string; secret: number; function_id: string }, [string]>('SELECT key, value, secret, function_id FROM _function_vars WHERE function_id = ? ORDER BY key')
      .all(functionId)
  }

  setVariable(functionId: string, key: string, value: string, secret: boolean): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw err('general_argument_invalid', 'Variable names use letters, digits and underscores.')
    const stamp = now()
    this.sql
      .query(
        `INSERT INTO _function_vars (function_id, key, value, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(function_id, key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at`,
      )
      .run(functionId, key, value, secret ? 1 : 0, stamp, stamp)
  }

  deleteVariable(functionId: string, key: string): void {
    this.sql.query('DELETE FROM _function_vars WHERE function_id = ? AND key = ?').run(functionId, key)
  }

  execution(functionId: string, executionId: string): ExecutionRow {
    const row = this.sql.query<ExecutionRow, [string, string]>('SELECT * FROM _executions WHERE id = ? AND function_id = ?').get(executionId, functionId)
    if (!row) throw err('execution_not_found')
    return row
  }

  listExecutions(functionId: string, queries: unknown[], includeTotal = true) {
    this.fn(functionId)
    const scope = [JSON.stringify({ method: 'equal', attribute: 'functionId', values: [functionId] })]
    const { total, seqs } = listSeqs(this.store, EXECUTIONS, queries, { scope, includeTotal })
    const rows = seqs.length
      ? (this.sql.query(`SELECT * FROM _executions WHERE seq IN (${seqs.map(() => '?').join(', ')})`).all(...seqs) as ExecutionRow[])
      : []
    const bySeq = new Map(rows.map((r) => [r.seq, r]))
    return { total, executions: seqs.map((s) => bySeq.get(s)!).filter(Boolean).map(executionModel) }
  }

  /** Who may run it: API keys always; others need a role in `execute`. */
  assertCanExecute(caller: Caller, f: FunctionRow): void {
    if (caller.privileged) return
    const execute = parse<string[]>(f.execute, [])
    if (!execute.some((role) => caller.roles.has(role))) {
      throw err('user_unauthorized', 'To execute function using client SDK, please add your role to function "execute" field.')
    }
  }

  /** Create an execution. Async ones return at once with status `waiting`. */
  async execute(f: FunctionRow, request: ExecutionRequest, mode: 'sync' | 'async'): Promise<{ execution: ExecutionRow; result: ExecutionResult | null }> {
    if (!f.enabled) throw err('function_not_found')
    const id = uniqueId()
    const stamp = now()
    const headers = Object.entries(request.headers ?? {})
      .filter(([k]) => !/^(authorization|cookie|x-appwrite-key|x-appwrite-session|x-appwrite-jwt|x-fallback-cookies)$/i.test(k))
      .map(([name, value]) => ({ name, value }))
    this.sql
      .query(
        `INSERT INTO _executions (id, function_id, trigger, status, request_method, request_path, request_headers, request_body, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, f.id, request.trigger, mode === 'async' ? 'waiting' : 'processing', request.method ?? 'POST', request.path ?? '/', JSON.stringify(headers), mode === 'async' ? (request.body ?? '') : '', request.userId ?? null, stamp, stamp)
    const run = this.run(id, f, request, mode === 'sync' ? Math.min(f.timeout, SYNC_TIMEOUT) : f.timeout)
    if (mode === 'async') {
      run.catch((e) => console.error('[functions] execution failed to run', e))
      return { execution: this.execution(f.id, id), result: null }
    }
    const result = await run
    return { execution: this.execution(f.id, id), result }
  }

  private env(f: FunctionRow, trigger: string): Record<string, string> {
    const base: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PRIVATE_ENV.includes(k)) base[k] = v
    const endpoint = this.options.internalEndpoint ?? `http://127.0.0.1:${this.config.port}/v1`
    const key = this.config.internalKey ?? this.config.apiKeys[0] ?? ''
    const vars: Record<string, string> = {}
    for (const v of this.sql
      .query<{ key: string; value: string }, [string]>("SELECT key, value FROM _function_vars WHERE function_id IN ('*', ?) ORDER BY function_id = '*' DESC")
      .all(f.id)) {
      vars[v.key] = v.value
    }
    const [runtimeName, runtimeVersion] = f.runtime.split('-')
    return {
      ...base,
      ...this.options.functionEnv,
      ...vars,
      APPWRITE_FUNCTION_API_ENDPOINT: endpoint,
      APPWRITE_FUNCTION_ID: f.id,
      APPWRITE_FUNCTION_NAME: f.name,
      APPWRITE_FUNCTION_DEPLOYMENT: f.id,
      APPWRITE_FUNCTION_PROJECT_ID: this.config.projectId,
      APPWRITE_FUNCTION_RUNTIME_NAME: runtimeName ?? '',
      APPWRITE_FUNCTION_RUNTIME_VERSION: runtimeVersion ?? '',
      APPWRITE_FUNCTION_TRIGGER: trigger,
      APPWRITE_FUNCTION_CPUS: '1',
      APPWRITE_FUNCTION_MEMORY: '512',
      // Appwrite hands functions a key; this server hands them its own.
      APPWRITE_API_KEY: vars.APPWRITE_API_KEY ?? this.options.functionEnv?.APPWRITE_API_KEY ?? key,
      APPWRITE_ENDPOINT: vars.APPWRITE_ENDPOINT ?? this.options.functionEnv?.APPWRITE_ENDPOINT ?? endpoint,
      APPWRITE_PROJECT_ID: this.config.projectId,
    }
  }

  /**
   * The folder holding a function's code. Tried in order: the stored path (absolute, or relative
   * to the code folder), then `<code folder>/functions/<id>`, Pesanle's layout. The last one also
   * repairs paths stored against the wrong folder by an uploaded import.
   */
  codeDir(f: FunctionRow): { dir: string | null; tried: string[] } {
    const base = this.config.functionsDir
    const tried = [...new Set([isAbsolute(f.path) ? f.path : resolve(base, f.path), join(base, 'functions', f.id)])]
    const dir = tried.find((d) => existsSync(join(d, f.entrypoint))) ?? null
    return { dir, tried: tried.map((d) => join(d, f.entrypoint)) }
  }

  private command(f: FunctionRow, dir: string): string[] {
    const entry = join(dir, f.entrypoint)
    if (f.runtime.startsWith('python')) return [process.env.PYTHON_BIN ?? 'python3', RUNNER_PYTHON, entry]
    if (f.runtime.startsWith('node') || f.runtime.startsWith('bun')) return [process.execPath, RUNNER_NODE, entry]
    throw new Error(`Runtime ${f.runtime} is not supported on this server`)
  }

  private async run(id: string, f: FunctionRow, request: ExecutionRequest, timeout: number): Promise<ExecutionResult> {
    const started = performance.now()
    this.running.set(f.id, (this.running.get(f.id) ?? 0) + 1)
    this.sql.query("UPDATE _executions SET status = 'processing', updated_at = ? WHERE id = ?").run(now(), id)
    let statusCode = 500
    let headers: Record<string, string> = {}
    let body = ''
    let logs = ''
    let errors = ''
    try {
      const { dir, tried } = this.codeDir(f)
      if (!dir) {
        throw new Error(
          `Function code not found. Looked for ${tried.join(' and ')}. ` +
            'Set the code folder (the folder with appwrite.config.json) in Console > Settings > Functions, or FUNCTIONS_DIR.',
        )
      }
      const proc = Bun.spawn(this.command(f, dir), {
        cwd: dir,
        env: this.env(f, request.trigger),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const url = new URL(this.config.publicEndpoint)
      proc.stdin.write(
        JSON.stringify({
          method: request.method ?? 'POST',
          path: request.path ?? '/',
          headers: Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
          body: request.body ?? '',
          host: url.hostname,
          scheme: url.protocol.replace(':', ''),
          port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
        }),
      )
      proc.stdin.end()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        proc.kill()
      }, timeout * 1000)
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      clearTimeout(timer)
      const markerAt = stdout.lastIndexOf(RESULT_MARKER)
      if (timedOut) {
        errors = `Operation timed out after ${timeout} seconds.`
        statusCode = 500
      } else if (markerAt < 0) {
        errors = (stderr || stdout || 'The function exited without a result.').trim()
      } else {
        const out = JSON.parse(stdout.slice(markerAt + RESULT_MARKER.length).split('\n')[0]!)
        statusCode = out.statusCode
        headers = out.headers ?? {}
        body = out.body ?? ''
        logs = [stdout.slice(0, markerAt).trim(), out.logs].filter(Boolean).join('\n')
        errors = [out.errors, stderr.trim()].filter(Boolean).join('\n')
      }
    } catch (error) {
      errors = error instanceof Error ? error.message : String(error)
    } finally {
      this.running.set(f.id, (this.running.get(f.id) ?? 1) - 1)
    }
    const failed = statusCode >= 400 || statusCode === 0
    const responseHeaders = Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }))
    this.sql
      .query(
        `UPDATE _executions SET status = ?, response_status_code = ?, response_body = ?, response_headers = ?, logs = ?, errors = ?, duration = ?, request_body = '', updated_at = ?
         WHERE id = ?`,
      )
      .run(failed ? 'failed' : 'completed', statusCode, body.slice(0, 1_000_000), JSON.stringify(responseHeaders), logs.slice(0, 1_000_000), errors.slice(0, 1_000_000), (performance.now() - started) / 1000, now(), id)
    return { statusCode, headers, body }
  }

  /** Run due schedules once a minute. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(new Date()), 15_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Fire every function whose schedule matches this minute (once per minute). */
  tick(date: Date): string[] {
    const minute = Math.floor(date.getTime() / 60_000)
    if (minute === this.lastTick) return []
    this.lastTick = minute
    const fired: string[] = []
    for (const f of this.list()) {
      if (!f.enabled || !f.schedule || this.options.skipSchedules?.includes(f.id)) continue
      if ((this.running.get(f.id) ?? 0) > 0) continue // never overlap a slow run
      let due = false
      try {
        due = parseCron(f.schedule).matches(date)
      } catch (error) {
        console.error(`[functions] ${f.id}: ${(error as Error).message}`)
      }
      if (!due) continue
      fired.push(f.id)
      this.execute(f, { trigger: 'schedule', method: 'POST', path: '/' }, 'async').catch((e) => console.error(`[functions] ${f.id}`, e))
    }
    return fired
  }

  prune(days = 30): void {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString().replace('Z', '+00:00')
    this.sql.query("DELETE FROM _executions WHERE created_at < ? AND status IN ('completed', 'failed')").run(cutoff)
  }
}
