/**
 * Appwrite Functions without Docker. Each execution runs the function's code
 * from its folder in a child process (Bun for node-* runtimes, python3 for
 * python-*), with the same env vars Appwrite injects, so a crash or a leak
 * dies with the process. Schedules run from an in-process cron.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import type { Caller } from '~/auth/caller'
import type { Config } from '~/config'
import type { Db } from '~/db/connection'
import type { DocumentStore } from '~/documents/store'
import { CREDENTIAL_HEADERS, functionVariables } from '~/lib/compat'
import { formatDate, now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { functionHost, functionsDomainOf, hostOf, urlForHost } from '~/lib/hosts'
import { uniqueId } from '~/lib/ids'
import type { ProxyService } from '~/proxy/service'
import { normalizeAttribute, type Collection } from '~/schema/types'
import { listSeqs } from '~/system/list'
import { parseCron } from './cron'
import { ENV_KEY_RE, type EnvVariable } from './env'
import { deploymentDir, functionHome } from './deployments'
import { removeTree } from './sandbox'
import { pythonRunner } from './runtime'

const RESULT_MARKER = '__BUNWRITE_EXECUTION_RESULT__'
/** Request headers a function never sees: credentials. */
const HIDDEN_HEADERS = new Set(['authorization', 'cookie', 'x-fallback-cookies', ...CREDENTIAL_HEADERS])
const SYNC_TIMEOUT = 30
const RUNNER_NODE = join(import.meta.dir, 'runner-node.ts')
const NODE_RUNNER_MODE = '__bunwrite-runner-node'
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
  commands: string
  logging: number
  deployment_id: string
  build_specification: string
  runtime_specification: string
  deployment_retention: number
  created_at: string
  updated_at: string
}

/** Settings a create or update call may set. */
export interface FunctionSettings {
  name: string
  runtime: string
  execute: string[]
  events: string[]
  schedule: string
  timeout: number
  enabled: boolean
  logging: boolean
  entrypoint: string
  commands: string
  scopes: string[]
  buildSpecification: string
  runtimeSpecification: string
  deploymentRetention: number
  /** Custom domains, in addition to `<id>.<functionsDomain>`. */
  domains?: string[]
}

/** Runtimes this server can run: node-* and bun-* under Bun, python-* under python3. */
export const SUPPORTED_RUNTIME = /^(node|bun|python)-[0-9.]+$/

/** The newest deployment of a function, for the function model. */
export interface LatestDeployment {
  id: string
  status: string
  created_at: string
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
  user_id: string | null
  created_at: string
  updated_at: string
}

export interface ExecutionStatus {
  function_id: string
  status: string
  created_at: string
}

export interface ExecutionSummary {
  id: string
  function_id: string
  status: string
  trigger: string
  duration: number
  created_at: string
}

export interface ExecutionRequest {
  trigger: 'http' | 'schedule' | 'event'
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: string
  /**
   * The request body exactly as it arrived, when it came over HTTP. `body` is
   * its UTF-8 reading, which mangles binary uploads; runners build
   * `req.bodyBinary` from these bytes instead, as Appwrite does.
   */
  bodyBytes?: Uint8Array
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

export function functionModel(f: FunctionRow, latest?: LatestDeployment | null, codeAtPath = true, domains: string[] = [], url = '') {
  // Code found at `path` (schema:push) counts as a ready deployment named after the function.
  const stand = codeAtPath ? f.id : ''
  const active = f.deployment_id || stand
  return {
    $id: f.id,
    $createdAt: f.created_at,
    $updatedAt: f.updated_at,
    execute: parse<string[]>(f.execute, []),
    name: f.name,
    description: '',
    enabled: Boolean(f.enabled),
    live: true,
    logging: Boolean(f.logging),
    runtime: f.runtime,
    deploymentRetention: f.deployment_retention,
    deploymentId: active,
    deploymentCreatedAt: active ? f.updated_at : '',
    latestDeploymentId: latest?.id ?? stand,
    latestDeploymentCreatedAt: latest?.created_at ?? (stand ? f.updated_at : ''),
    latestDeploymentStatus: latest?.status ?? (stand ? 'ready' : ''),
    scopes: parse<string[]>(f.scopes, []),
    vars: [] as unknown[],
    events: parse<string[]>(f.events, []),
    schedule: f.schedule,
    timeout: f.timeout,
    entrypoint: f.entrypoint,
    commands: f.commands,
    version: 'v5',
    installationId: '',
    providerRepositoryId: '',
    providerBranch: '',
    providerRootDirectory: '',
    providerSilentMode: false,
    buildSpecification: f.build_specification,
    runtimeSpecification: f.runtime_specification,
    // Bunwrite extensions.
    url,
    domains,
    domain: domains[0] ?? '',
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

/** Set by the server only: who called the function. A client sending these is ignored. */
const CALLER_HEADERS = ['user-id', 'user-jwt'].flatMap((n) => [`x-bunwrite-${n}`, `x-appwrite-${n}`])

/** Like Appwrite, tell the function which signed-in user called it (`x-appwrite-user-id`). */
function withCallerHeaders(headers: Record<string, string> | undefined, userId: string | null | undefined): Record<string, string> {
  const out = Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => !CALLER_HEADERS.includes(k.toLowerCase())))
  if (userId) out['x-appwrite-user-id'] = out['x-bunwrite-user-id'] = userId
  return out
}

export class FunctionService {
  /** Other projects, so default function hosts do not collide on this server. */
  peers: () => FunctionService[] = () => []
  private running = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTick = -1

  constructor(
    private db: Db,
    private config: Config,
    private store: DocumentStore,
    private proxy: ProxyService,
    private options: { functionEnv?: Record<string, string>; internalEndpoint?: string } = {},
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

  has(id: string): boolean {
    return Boolean(this.sql.query('SELECT 1 FROM _functions WHERE id = ?').get(id))
  }

  /** The function a request's Host header points at, if it is one of this project's. */
  byHost(host: string): FunctionRow | null {
    const name = hostOf(host)
    const custom = this.proxy.byDomain(name)
    if (custom?.resource_type === 'function') return this.fn(custom.resource_id)
    const suffix = `.${functionsDomainOf(this.config)}`
    if (!name.endsWith(suffix)) return null
    const sub = name.slice(0, -suffix.length)
    if (sub.includes('.')) return null
    const row = this.sql.query<FunctionRow, [string]>('SELECT * FROM _functions WHERE lower(id) = ?').get(sub)
    return row ?? null
  }

  /** `https://<id>.<FUNCTIONS_DOMAIN>`, with the API's port when it has one (local development). */
  url(f: FunctionRow): string {
    return urlForHost(this.config, functionHost(this.config, f.id))
  }

  /** Every address the function answers on. */
  urls(f: FunctionRow): string[] {
    return [this.url(f), ...this.proxy.domainsFor('function', f.id).map((domain) => urlForHost(this.config, domain))]
  }

  domains(f: FunctionRow): string[] {
    return this.proxy.domainsFor('function', f.id)
  }

  update(id: string, fields: { enabled: boolean; schedule: string; timeout: number; execute: string[] }): FunctionRow {
    this.fn(id)
    this.check(fields)
    this.sql
      .query('UPDATE _functions SET enabled = ?, schedule = ?, timeout = ?, execute = ?, updated_at = ? WHERE id = ?')
      .run(fields.enabled ? 1 : 0, fields.schedule, fields.timeout, JSON.stringify(fields.execute), now(), id)
    return this.fn(id)
  }

  private check(fields: { schedule: string; timeout: number; runtime?: string }): void {
    if (fields.schedule) {
      try {
        parseCron(fields.schedule)
      } catch (error) {
        throw err('general_argument_invalid', `Invalid schedule: ${(error as Error).message}`)
      }
    }
    if (!Number.isInteger(fields.timeout) || fields.timeout < 1 || fields.timeout > 900) {
      throw err('general_argument_invalid', 'Timeout must be between 1 and 900 seconds.')
    }
    if (fields.runtime !== undefined && !SUPPORTED_RUNTIME.test(fields.runtime)) {
      throw err('function_runtime_unsupported', `Runtime "${fields.runtime}" is not supported here. Use a node-*, bun-* or python-* runtime.`)
    }
  }

  /** A new function (functions.create). Its code arrives later as a deployment. */
  create(id: string, fields: FunctionSettings): FunctionRow {
    this.check(fields)
    if ([this, ...this.peers().filter((peer) => peer !== this)].some((peer) => peer.has(id))) throw err('function_already_exists')
    const domains = this.proxy.normalizeAll(fields.domains ?? [])
    this.proxy.assertDefaultHost('function', id)
    const stamp = now()
    this.sql.transaction(() => {
      this.sql
        .query(
          `INSERT INTO _functions (id, path, name, runtime, entrypoint, execute, events, schedule, timeout, enabled, scopes, commands, logging,
           build_specification, runtime_specification, deployment_retention, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, `functions/${id}`, ...this.settingValues(fields), stamp, stamp)
      this.proxy.set('function', id, domains)
    })()
    return this.fn(id)
  }

  /** Replace a function's settings (functions.update). */
  save(id: string, fields: FunctionSettings): FunctionRow {
    const current = this.fn(id)
    this.check(fields)
    const domains = this.proxy.normalizeAll(fields.domains ?? this.domains(current), { type: 'function', id })
    this.sql.transaction(() => {
      this.sql
        .query(
          `UPDATE _functions SET name = ?, runtime = ?, entrypoint = ?, execute = ?, events = ?, schedule = ?, timeout = ?, enabled = ?, scopes = ?,
           commands = ?, logging = ?, build_specification = ?, runtime_specification = ?, deployment_retention = ?, updated_at = ? WHERE id = ?`,
        )
        .run(...this.settingValues(fields), now(), id)
      this.proxy.set('function', id, domains)
    })()
    return this.fn(id)
  }

  private settingValues(f: FunctionSettings) {
    return [
      f.name,
      f.runtime,
      f.entrypoint,
      JSON.stringify(f.execute),
      JSON.stringify(f.events),
      f.schedule,
      f.timeout,
      f.enabled ? 1 : 0,
      JSON.stringify(f.scopes),
      f.commands,
      f.logging ? 1 : 0,
      f.buildSpecification,
      f.runtimeSpecification,
      f.deploymentRetention,
    ] as const
  }

  /**
   * The entry file's text for the console editor, or undefined when it is
   * missing or larger than `maxBytes`. Read as the function's user when
   * functions are isolated, since the server cannot read their folders.
   */
  readEntry(f: FunctionRow, maxBytes: number): string | undefined {
    const { dir, entrypoint } = this.codeDir(f)
    if (!dir) return undefined
    const sandbox = this.config.functionsSandbox
    if (!sandbox) {
      const path = join(dir, entrypoint)
      if (!existsSync(path) || statSync(path).size > maxBytes) return undefined
      return readFileSync(path, 'utf8')
    }
    const read = Bun.spawnSync(sandbox.wrap(sandbox.uidFor(this.config.projectId, f.id), dir, ['head', '-c', String(maxBytes + 1), '--', entrypoint]), { stdout: 'pipe', stderr: 'ignore' })
    if (read.exitCode !== 0 || read.stdout.length > maxBytes) return undefined
    return read.stdout.toString('utf8')
  }

  /** Delete a function with its variables, executions and deployments. */
  remove(id: string): void {
    this.fn(id)
    this.sql.transaction(() => {
      this.proxy.removeFor('function', id)
      for (const table of ['_function_vars', '_executions', '_deployments']) this.sql.query(`DELETE FROM ${table} WHERE function_id = ?`).run(id)
      this.sql.query('DELETE FROM _functions WHERE id = ?').run(id)
    })()
    removeTree(this.config.functionsSandbox, deploymentDir(this.config, id))
  }

  /** Every variable scope is a `function_id`: `*` holds the global ones. */
  variables(functionId: string): { key: string; value: string; secret: number; function_id: string }[] {
    return this.sql
      .query<{ key: string; value: string; secret: number; function_id: string }, [string]>('SELECT key, value, secret, function_id FROM _function_vars WHERE function_id = ? ORDER BY key')
      .all(functionId)
  }

  globalVariables() {
    return this.variables('*')
  }

  setVariable(functionId: string, key: string, value: string, secret: boolean): void {
    this.setVariables(functionId, [{ key, value }], secret)
  }

  setVariables(functionId: string, entries: EnvVariable[], secret: boolean): void {
    const stamp = now()
    const statement = this.sql.prepare(
      `INSERT INTO _function_vars (function_id, key, value, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(function_id, key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at`,
    )
    this.sql.transaction(() => {
      for (const { key, value } of entries) {
        if (!ENV_KEY_RE.test(key)) throw err('general_argument_invalid', 'Variable names use letters, digits and underscores.')
        statement.run(functionId, key, value, secret ? 1 : 0, stamp, stamp)
      }
    })()
  }

  deleteVariable(functionId: string, key: string): void {
    this.sql.query('DELETE FROM _function_vars WHERE function_id = ? AND key = ?').run(functionId, key)
  }

  /** Forget every variable in a scope; returns how many were removed. */
  clearVariables(functionId: string): number {
    return Number(this.sql.query('DELETE FROM _function_vars WHERE function_id = ?').run(functionId).changes ?? 0)
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

  /** The newest execution for each function, keyed by function ID. */
  latestByFunction(): Map<string, ExecutionStatus> {
    const rows = this.sql
      .query<ExecutionStatus, []>('SELECT function_id, status, created_at FROM _executions WHERE seq IN (SELECT max(seq) FROM _executions GROUP BY function_id)')
      .all()
    return new Map(rows.map((row) => [row.function_id, row]))
  }

  /** Recent executions across all functions, newest first. */
  recent(limit = 6): ExecutionSummary[] {
    return this.sql
      .query<ExecutionSummary, [number]>('SELECT id, function_id, status, trigger, duration, created_at FROM _executions ORDER BY seq DESC LIMIT ?')
      .all(limit)
  }

  /** Executions of one function, newest first. */
  runsFor(functionId: string, limit = 20): ExecutionRow[] {
    return this.sql
      .query<ExecutionRow, [string, number]>('SELECT * FROM _executions WHERE function_id = ? ORDER BY seq DESC LIMIT ?')
      .all(functionId, limit)
  }

  /** Number of failed executions created after `since`, an ISO timestamp. */
  failedSince(since: string): number {
    return (this.sql
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM _executions WHERE status = 'failed' AND created_at > ?")
      .get(since) as { n: number }).n
  }

  /** Who may run it: API keys always; others need a role in `execute`. */
  assertCanExecute(caller: Caller, f: FunctionRow): void {
    if (caller.privileged) return
    const execute = parse<string[]>(f.execute, [])
    if (!execute.some((role) => caller.roles.has(role))) {
      throw err('user_unauthorized', 'To execute function using client SDK, please add your role to function "execute" field.')
    }
  }

  /** Request headers as stored on a row: the ones a function may see, in wire order. */
  private headerList(headers: Record<string, string> | undefined): { name: string; value: string }[] {
    return Object.entries(headers ?? {})
      .filter(([k]) => !HIDDEN_HEADERS.has(k.toLowerCase()))
      .map(([name, value]) => ({ name, value }))
  }

  /** Create an execution. Async ones return at once with status `waiting`. */
  async execute(f: FunctionRow, request: ExecutionRequest, mode: 'sync' | 'async'): Promise<{ execution: ExecutionRow; result: ExecutionResult | null }> {
    if (!f.enabled) throw err('function_not_found')
    request = { ...request, headers: withCallerHeaders(request.headers, request.userId) }
    const id = uniqueId()
    const stamp = now()
    const headers = this.headerList(request.headers)
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

  /**
   * Store a one-off execution to run at `scheduledAt` instead of running it now.
   *
   * Appwrite's deferred execution: the row is written immediately with status
   * `scheduled`, and `tickScheduled` runs it when its time comes. The id the
   * caller gets back is the execution that eventually runs — it is never
   * replaced by a second row.
   */
  schedule(f: FunctionRow, request: ExecutionRequest, scheduledAt: string): ExecutionRow {
    if (!f.enabled) throw err('function_not_found')
    const id = uniqueId()
    const stamp = now()
    this.sql
      .query(
        `INSERT INTO _executions (id, function_id, trigger, status, request_method, request_path, request_headers, request_body, scheduled_at, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, f.id, 'schedule', 'scheduled', request.method ?? 'POST', request.path ?? '/', JSON.stringify(this.headerList(request.headers)), request.body ?? '', scheduledAt, request.userId ?? null, stamp, stamp)
    return this.execution(f.id, id)
  }

  /**
   * Environment for a run or a build: server env without secrets, function variables, and
   * BUNWRITE_FUNCTION_* values (plus APPWRITE_FUNCTION_* in Appwrite mode).
   */
  env(f: FunctionRow, trigger: string): Record<string, string> {
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
    const own = { ...this.options.functionEnv, ...vars }
    const fromVars = (name: string) => own[`BUNWRITE_${name}`] ?? own[`APPWRITE_${name}`]
    return {
      ...base,
      ...this.options.functionEnv,
      ...vars,
      ...functionVariables(this.config, {
        FUNCTION_API_ENDPOINT: endpoint,
        FUNCTION_ID: f.id,
        FUNCTION_NAME: f.name,
        FUNCTION_DEPLOYMENT: f.deployment_id || f.id,
        FUNCTION_PROJECT_ID: this.config.projectId,
        FUNCTION_RUNTIME_NAME: runtimeName ?? '',
        FUNCTION_RUNTIME_VERSION: runtimeVersion ?? '',
        FUNCTION_TRIGGER: trigger,
        FUNCTION_CPUS: '1',
        FUNCTION_MEMORY: '512',
        // Functions get a key from this server; a variable of their own wins.
        API_KEY: fromVars('API_KEY') ?? key,
        ENDPOINT: fromVars('ENDPOINT') ?? endpoint,
        PROJECT_ID: this.config.projectId,
      }),
    }
  }

  /**
   * The folder holding a function's code and the entrypoint to run. The active deployment
   * (`appwrite push functions`) wins. Otherwise, tried in order: the stored path (absolute, or
   * relative to the code folder), then `<code folder>/functions/<id>`, the conventional layout. The
   * last one also repairs paths stored against the wrong folder by an uploaded import.
   */
  codeDir(f: FunctionRow): { dir: string | null; tried: string[]; entrypoint: string } {
    if (f.deployment_id) {
      const deployment = this.sql
        .query<{ entrypoint: string }, [string, string]>("SELECT entrypoint FROM _deployments WHERE id = ? AND function_id = ? AND status = 'ready'")
        .get(f.deployment_id, f.id)
      const dir = deploymentDir(this.config, f.id, f.deployment_id)
      // An isolated deployment folder is closed to the server; the build already checked the entrypoint.
      const present = existsSync(join(dir, deployment?.entrypoint ?? '')) || (Boolean(this.config.functionsSandbox) && existsSync(dir))
      if (deployment && present) return { dir, tried: [join(dir, deployment.entrypoint)], entrypoint: deployment.entrypoint }
    }
    const base = this.config.functionsDir
    const tried = [...new Set([isAbsolute(f.path) ? f.path : resolve(base, f.path), join(base, 'functions', f.id)])]
    const dir = tried.find((d) => existsSync(join(d, f.entrypoint))) ?? null
    return { dir, tried: tried.map((d) => join(d, f.entrypoint)), entrypoint: f.entrypoint }
  }

  private command(f: FunctionRow, dir: string, entrypoint: string): string[] {
    const entry = join(dir, entrypoint)
    if (f.runtime.startsWith('python')) return [process.env.PYTHON_BIN ?? 'python3', pythonRunner(this.config), entry]
    if (f.runtime.startsWith('node') || f.runtime.startsWith('bun')) {
      return Bun.isStandaloneExecutable ? [process.execPath, NODE_RUNNER_MODE, entry] : [process.execPath, RUNNER_NODE, entry]
    }
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
      const { dir, tried, entrypoint } = this.codeDir(f)
      if (!dir) {
        throw new Error(
          `Function code not found. Looked for ${tried.join(' and ')}. ` +
            'Set the code folder (the folder with bunwrite.config.json or appwrite.config.json) in Console > Settings > Functions, or FUNCTIONS_DIR.',
        )
      }
      const sandbox = this.config.functionsSandbox
      let command = this.command(f, dir, entrypoint)
      const env = this.env(f, request.trigger)
      if (sandbox) {
        const uid = sandbox.uidFor(this.config.projectId, f.id)
        const home = functionHome(this.config, f.id)
        // Deployments built before isolation was on (or code from the code folder) get their user now.
        if (dir.startsWith(deploymentDir(this.config, f.id)) && !sandbox.owns(dir, uid)) sandbox.adopt(dir, home, uid)
        else if (!sandbox.owns(home, uid)) sandbox.adopt(null, home, uid)
        command = sandbox.wrap(uid, dir, command)
        env.HOME = env.TMPDIR = home
      }
      const proc = Bun.spawn(command, {
        cwd: sandbox ? undefined : dir,
        env,
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
          ...(request.bodyBytes ? { bodyBase64: Buffer.from(request.bodyBytes).toString('base64') } : {}),
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

  /** Run due cron schedules (once a minute) and due deferred executions (every tick). */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const date = new Date()
      this.tick(date)
      this.tickScheduled(date)
    }, 15_000)
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
      if (!f.enabled || !f.schedule || this.config.skipSchedules.includes(f.id)) continue
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

  /**
   * Run the one-off executions `scheduledAt` deferred whose time has come.
   *
   * Rows are claimed by `run()`, which flips `scheduled` to `processing` before
   * its first await, so a slow run can never be picked up twice. A run that is
   * still going leaves the rest of that function's queue for the next tick
   * rather than overlapping it, matching the cron path.
   */
  tickScheduled(date: Date): string[] {
    const due = this.sql
      .query<ExecutionRow, [string, number]>(
        "SELECT * FROM _executions WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY seq ASC LIMIT ?",
      )
      .all(formatDate(date), 50)
    const fired: string[] = []
    for (const row of due) {
      let f: FunctionRow
      try {
        f = this.fn(row.function_id)
      } catch {
        this.sql
          .query("UPDATE _executions SET status = 'failed', errors = ?, updated_at = ? WHERE id = ?")
          .run('The function was deleted before this execution ran.', now(), row.id)
        continue
      }
      if ((this.running.get(f.id) ?? 0) > 0) continue
      fired.push(row.id)
      const request: ExecutionRequest = {
        trigger: 'schedule',
        method: row.request_method,
        path: row.request_path,
        headers: Object.fromEntries(
          parse<{ name: string; value: string }[]>(row.request_headers, []).map((h) => [h.name, h.value]),
        ),
        body: row.request_body,
        userId: row.user_id,
      }
      this.run(row.id, f, request, f.timeout).catch((e) => console.error(`[functions] ${f.id}`, e))
    }
    return fired
  }

  prune(days = 30): void {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString().replace('Z', '+00:00')
    this.sql.query("DELETE FROM _executions WHERE created_at < ? AND status IN ('completed', 'failed')").run(cutoff)
  }
}
