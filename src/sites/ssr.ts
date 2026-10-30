/**
 * Server-side-rendered sites. An `adapter: 'ssr'` deployment is started as a
 * child process on loopback and requests are proxied to it. Nothing else
 * changes: the site still answers on `<id>.<SITES_DOMAIN>` and on its custom
 * domains, and Caddy still forwards everything to this server.
 *
 * Processes are lazy and short-lived:
 * - the first request starts the app; later requests reuse it;
 * - an idle app is stopped after `SITES_SSR_IDLE_MS`;
 * - at most `SITES_SSR_MAX_PROCESSES` apps run at once per worker (least
 *   recently used first out), since each worker keeps its own process;
 * - a crash is reported once, then the next request starts it again after a
 *   short backoff;
 * - activating another deployment, deleting a site or shutting down kills it.
 *
 * With no start command, requests run the site's API function instead. That
 * is the cheapest mode: no process at all, every request is a function call.
 */
import { connect } from 'node:net'

import { resolveCaller } from '~/auth/caller'
import type { Config } from '~/config'
import { functionHttpResponse } from '~/functions/http'
import type { FunctionSandbox } from '~/functions/sandbox'
import { errorResponse } from '~/lib/http'
import type { Services } from '~/services'
import { sitePage } from './pages'
import type { SiteDeploymentRow, SiteRow } from './service'
import { ensureRuntime, withRuntime } from '~/runtimes/install'
import { siteRuntimeEnv } from './env'
import type { DeployContext } from '~/variables/context'

/** How long an app may take to open its port. */
const START_TIMEOUT_MS = 30_000
/** Killed with SIGKILL if it ignores SIGTERM this long. */
const KILL_GRACE_MS = 3_000
/** Runtime output kept per site for the console. */
const MAX_LOG = 16_000
const POLL_MS = 100

/** Headers that only describe one hop and must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** What the runtime needs to start one deployment. */
export interface SsrTarget {
  /**
   * `<siteId>/<deploymentId>/<context>`. Activating a build stops its apps, and
   * the next request starts it again as the live app, with live values.
   */
  key: string
  /** live for the site's active deployment, preview for any other. */
  context: DeployContext
  siteId: string
  deploymentId: string
  command: string
  /** Working directory: the deployment folder plus `outputDirectory`. */
  cwd: string
  /** The deployment's runtime, such as node-22; '' runs on the server's Bun. */
  runtime: string
}

interface RunningApp {
  target: SsrTarget
  proc: Bun.Subprocess | null
  port: number
  starting: Promise<void>
  state: 'starting' | 'ready'
  active: number
  lastUsed: number
  stopping: boolean
  logs: string
  live: LiveProcess | null
  idleTimer?: ReturnType<typeof setTimeout>
}

interface Failure {
  count: number
  until: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Children still alive, so a process exit never leaves an app behind. */
interface LiveProcess {
  proc: Bun.Subprocess
  sandbox: FunctionSandbox | null
}
const LIVE = new Set<LiveProcess>()
let exitHook = false

/** Signal the app's whole process group, so `npm start` and its children go too. */
function signalProc(entry: LiveProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const { proc, sandbox } = entry
  if (sandbox) {
    try {
      sandbox.signal(proc.pid, signal === 'SIGKILL' ? 'KILL' : 'TERM')
    } catch {
      /* the helper could not signal it; it may be gone already */
    }
    return
  }
  try {
    if (proc.pid > 0) {
      process.kill(-proc.pid, signal)
      return
    }
  } catch {
    /* not a group leader: try the process itself */
  }
  try {
    proc.kill(signal === 'SIGKILL' ? 9 : undefined)
  } catch {
    /* already gone */
  }
}

function killAll(): void {
  if (!exitHook) {
    exitHook = true
    process.once('exit', () => {
      for (const entry of LIVE) signalProc(entry, 'SIGKILL')
    })
  }
}

/** If the app does not listen within this long, it is not coming up. */
async function canConnect(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(timeoutMs, () => done(false))
  })
}

/**
 * Site apps listen on a loopback port in this worker's own slice of
 * 10000–31999. Ephemeral ports (Linux starts those at 32768) are shared by
 * every worker, so two workers starting an app at the same moment could pick
 * one port, stop their probes, and then race to bind it: one app dies with
 * EADDRINUSE and its requests 502. The slices keep workers apart, and `ports`
 * does the same inside one worker.
 *
 * The slice is sized from WORKERS: one process gets the whole range, while the
 * maximum 16 public workers plus the writer get about 1,290 ports each. More
 * apps than that are possible on a big host, but memory, PIDs and file
 * descriptors run out long before the ports do.
 */
const SITE_PORT_BASE = 10_000
/** Exclusive. Kept below the default ephemeral range (32768+). */
const SITE_PORT_LIMIT = 32_000

/**
 * Ports in this process handed to an app that is still starting or running.
 * Every project has its own SsrRuntime, so this cannot live on one instance:
 * two projects starting an app at the same moment would otherwise reserve the
 * same port. Workers are separate processes and are kept apart by the slice.
 */
const reservedPorts = new Set<number>()
let portCursor = 0

/** The loopback port slice one worker may use for site apps. */
export function sitePortSlice(workers: number, index: number): { base: number; size: number } {
  const count = Math.max(1, Math.floor(workers) || 1)
  const size = Math.max(1, Math.floor((SITE_PORT_LIMIT - SITE_PORT_BASE) / count))
  return { base: SITE_PORT_BASE + (Math.abs(index) % count) * size, size }
}

export class SsrRuntime {
  private readonly apps = new Map<string, RunningApp>()
  private readonly failures = new Map<string, Failure>()
  private readonly lastLogs = new Map<string, string>()
  private readonly sandbox: FunctionSandbox | null

  constructor(
    private readonly config: Config,
    private readonly lookup: (siteId: string, deploymentId?: string | null) => SsrTarget | null,
    /** Project + site variables for a site in a deploy context; empty when the service does not have them. */
    private readonly variablesFor: (siteId: string, context: DeployContext) => Record<string, string> = () => ({}),
  ) {
    this.sandbox = config.functionsSandbox ?? null
  }

  /** Answer a request by proxying it to the site's app (or a preview's), starting it if needed. */
  async handle(siteId: string, request: Request, deploymentId?: string | null): Promise<Response> {
    const target = this.lookup(siteId, deploymentId)
    if (!target) return sitePage(404, 'Nothing here yet', 'This site has no live app.')
    let app: RunningApp
    try {
      app = await this.appFor(target)
    } catch (error) {
      console.warn(`[sites] ${siteId}: ${error instanceof Error ? error.message : String(error)}`)
      return sitePage(502, 'Site unavailable', 'The app did not start. The deployment log has the details.')
    }
    app.active++
    app.lastUsed = Date.now()
    try {
      return await this.proxy(request, app.port)
    } catch (error) {
      this.log(app, `[proxy] ${error instanceof Error ? error.message : String(error)}`)
      return sitePage(502, 'Site unavailable', 'The app stopped answering. It will be started again on the next request.')
    } finally {
      app.active--
      app.lastUsed = Date.now()
      this.scheduleIdle(app)
    }
  }

  /** Number of apps running (or starting) for a site, or for all sites. */
  running(siteId?: string): number {
    let count = 0
    for (const app of this.apps.values()) {
      if (siteId && app.target.siteId !== siteId) continue
      if (app.state === 'starting' || app.state === 'ready') count++
    }
    return count
  }

  /** The last output of a site's app, for the console. */
  logs(siteId: string): string {
    return this.lastLogs.get(siteId) ?? ''
  }

  /** One deployment is no longer live: stop its app, and let the next one start fresh. */
  stopDeployment(siteId: string, deploymentId: string): void {
    // A build may run twice: as the live app and as a preview, each with its own values.
    for (const app of this.apps.values()) {
      if (app.target.siteId === siteId && app.target.deploymentId === deploymentId) void this.stopApp(app, 'deployment changed')
    }
    this.failures.delete(siteId)
  }

  /** The site is paused, deleted or reconfigured: stop every app it has. */
  stopSite(siteId: string): void {
    for (const app of this.apps.values()) if (app.target.siteId === siteId) void this.stopApp(app, 'site stopped')
    this.failures.delete(siteId)
  }

  /** The site is gone: stop it and drop the output kept for the console. */
  forget(siteId: string): void {
    this.stopSite(siteId)
    this.lastLogs.delete(siteId)
  }

  /** Shut every app down (project close or tests). */
  stop(): void {
    for (const app of this.apps.values()) void this.stopApp(app, 'shutdown')
  }

  private appFor(target: SsrTarget): Promise<RunningApp> {
    const failure = this.failures.get(target.siteId)
    if (failure && failure.until > Date.now()) {
      const seconds = Math.ceil((failure.until - Date.now()) / 1000)
      throw new Error(`the last start failed; trying again in ${seconds}s`)
    }
    const existing = this.apps.get(target.key)
    if (existing) return existing.starting.then(() => existing)

    this.evict(target.key)
    const app: RunningApp = {
      target,
      proc: null,
      port: 0,
      starting: Promise.resolve(),
      state: 'starting',
      active: 0,
      lastUsed: Date.now(),
      stopping: false,
      logs: '',
      live: null,
    }
    this.apps.set(target.key, app)
    app.starting = this.start(app)
      .then(() => {
        if (app.stopping) throw new Error('the app was stopped while starting')
        app.state = 'ready'
        this.failures.delete(target.siteId)
        this.scheduleIdle(app)
      })
      .catch((error) => {
        if (this.apps.get(target.key) === app) this.apps.delete(target.key)
        throw error
      })
    return app.starting.then(() => app)
  }

  private async start(app: RunningApp): Promise<void> {
    const target = app.target
    const argv = ['sh', '-c', target.command]
    const uid = this.sandbox?.uidFor(this.config.projectId, `site:${target.siteId}`)
    const sandboxed = this.sandbox !== null && uid !== undefined
    let runtime: Awaited<ReturnType<typeof ensureRuntime>>
    try {
      // Installed by the build; only a runtime removed since then downloads here.
      runtime = await ensureRuntime(this.config, target.runtime, (line) => this.log(app, `[runtime] ${line}`))
    } catch (error) {
      this.recordFailure(target.siteId)
      throw new Error(`could not start "${target.command}": ${error instanceof Error ? error.message : String(error)}`)
    }
    // Take the port only after the runtime is ready: the shorter the gap before
    // the app binds it, the smaller the chance anything else takes it.
    const port = await this.freePort()
    app.port = port
    let proc: Bun.Subprocess
    try {
      proc = Bun.spawn(sandboxed ? this.sandbox!.wrap(uid, target.cwd, argv) : argv, {
        cwd: sandboxed ? undefined : target.cwd,
        env: withRuntime(
          siteRuntimeEnv(this.config, target.siteId, port, this.variablesFor(target.siteId, target.context)),
          runtime,
        ),
        stdout: 'pipe',
        stderr: 'pipe',
        // One session per app: stopping it takes `npm start`'s children too.
        detached: true,
      })
    } catch (error) {
      reservedPorts.delete(port)
      this.recordFailure(target.siteId)
      throw new Error(`could not start "${target.command}": ${error instanceof Error ? error.message : String(error)}`)
    }
    app.proc = proc
    app.live = { proc, sandbox: sandboxed ? this.sandbox : null }
    LIVE.add(app.live)
    killAll()
    proc.unref?.()
    void this.read(proc.stdout as ReadableStream<Uint8Array> | undefined, app)
    void this.read(proc.stderr as ReadableStream<Uint8Array> | undefined, app)
    void proc.exited
      .then((code) => {
        if (app.live) LIVE.delete(app.live)
        if (app.stopping) return
        this.log(app, `[runtime] exited with code ${code}`)
        if (this.apps.get(target.key) === app) this.apps.delete(target.key)
      })
      .catch(() => {
        if (app.live) LIVE.delete(app.live)
      })
      .finally(() => reservedPorts.delete(port))

    try {
      await this.waitUntilListening(app, proc, port)
    } catch (error) {
      const stopped = app.stopping
      app.stopping = true
      this.terminate(app, proc)
      if (!stopped) this.recordFailure(target.siteId)
      throw error
    }
    this.log(app, `[runtime] listening on 127.0.0.1:${port}`)
  }

  /**
   * A loopback port from this worker's range, reserved process-wide until the
   * app exits. `Bun.serve` on the exact port proves that nothing else holds
   * it, and the probe is closed before the app starts.
   */
  private async freePort(): Promise<number> {
    const { base, size } = sitePortSlice(this.config.workers, this.config.workerIndex)
    for (let i = 0; i < size; i++) {
      const port = base + ((portCursor + i) % size)
      if (reservedPorts.has(port)) continue
      // Reserve before the await, so another project or start skips it.
      reservedPorts.add(port)
      try {
        const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response(null, { status: 204 }) })
        await server.stop(true)
        portCursor = (portCursor + i + 1) % size
        return port
      } catch {
        reservedPorts.delete(port)
      }
    }
    // The whole slice is taken or blocked: let the OS choose, as before.
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(null, { status: 204 }) })
    const port = server.port!
    await server.stop(true)
    reservedPorts.add(port)
    return port
  }

  private async waitUntilListening(app: RunningApp, proc: Bun.Subprocess, port: number): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (app.stopping) throw new Error('the app was stopped while starting')
      if (proc.exitCode !== null) throw new Error(`the start command exited with code ${proc.exitCode}`)
      if (await canConnect(port, 250)) return
      await sleep(POLL_MS)
    }
    throw new Error(`the app did not listen on 127.0.0.1:${port} within ${START_TIMEOUT_MS / 1000}s`)
  }

  /**
   * Stream the request to the app and its answer back. `decompress: false`
   * keeps compressed bytes and their headers intact, so the browser gets the
   * app's own encoding and `Content-Length`.
   */
  private async proxy(request: Request, port: number): Promise<Response> {
    const url = new URL(request.url)
    const headers = new Headers(request.headers)
    // fetch sets Host itself; frameworks read the original host from these.
    // Keep what the TLS terminator (Caddy, a tunnel) already said; the socket
    // here only sees the internal hop, which is usually plain HTTP.
    const first = (name: string) => request.headers.get(name)?.split(',')[0]?.trim() || ''
    headers.delete('host')
    headers.set('x-forwarded-host', first('x-forwarded-host') || url.host)
    headers.set('x-forwarded-proto', first('x-forwarded-proto') || url.protocol.slice(0, -1))
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body
    const upstream = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      decompress: false,
      duplex: 'half',
    } as RequestInit)
    const out = new Headers()
    for (const [name, value] of upstream.headers) if (!HOP_BY_HOP.has(name.toLowerCase())) out.set(name, value)
    // Headers folds several Set-Cookie values into one; keep them separate.
    const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : []
    if (cookies.length) {
      out.delete('set-cookie')
      for (const cookie of cookies) out.append('set-cookie', cookie)
    }
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out })
  }

  private async read(stream: ReadableStream<Uint8Array> | undefined, app: RunningApp): Promise<void> {
    if (!stream) return
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) this.log(app, decoder.decode(value, { stream: true }))
      }
    } catch {
      /* the process went away; its exit is logged separately */
    }
  }

  private log(app: RunningApp, text: string): void {
    if (!text) return
    app.logs = (app.logs + text).slice(-MAX_LOG)
    this.lastLogs.set(app.target.siteId, app.logs)
  }

  /** Keep at most `SITES_SSR_MAX_PROCESSES` apps: least recently used goes first. */
  private evict(keepKey: string): void {
    const cap = Math.max(1, this.config.sitesSsrMaxProcesses)
    while (this.apps.size >= cap) {
      const victims = [...this.apps.values()]
        .filter((app) => app.target.key !== keepKey && app.active === 0 && app.state === 'ready')
        .sort((a, b) => a.lastUsed - b.lastUsed)
      const victim = victims[0]
      if (!victim) return
      this.log(victim, '[runtime] stopped: too many apps are running')
      void this.stopApp(victim, 'not used recently')
    }
  }

  /**
   * Stop the app when it has been unused for `SITES_SSR_IDLE_MS`. One timer per
   * app, so a request that comes in on time simply reschedules it.
   */
  private scheduleIdle(app: RunningApp): void {
    if (app.idleTimer) clearTimeout(app.idleTimer)
    app.idleTimer = undefined
    const idleMs = this.config.sitesSsrIdleMs
    if (idleMs <= 0 || app.stopping) return
    if (app.active > 0) return
    const idleFor = Date.now() - app.lastUsed
    const wait = Math.max(0, idleMs - idleFor)
    const timer = setTimeout(() => this.idleCheck(app), wait)
    timer.unref?.()
    app.idleTimer = timer
  }

  private idleCheck(app: RunningApp): void {
    app.idleTimer = undefined
    if (app.stopping || this.apps.get(app.target.key) !== app) return
    if (app.state === 'starting') {
      this.scheduleIdle(app)
      return
    }
    if (app.active > 0 || Date.now() - app.lastUsed < this.config.sitesSsrIdleMs) {
      this.scheduleIdle(app)
      return
    }
    void this.stopApp(app, 'idle')
  }

  private async stopApp(app: RunningApp, reason: string): Promise<void> {
    if (app.stopping) return
    app.stopping = true
    if (app.idleTimer) clearTimeout(app.idleTimer)
    app.idleTimer = undefined
    if (this.apps.get(app.target.key) === app) this.apps.delete(app.target.key)
    this.log(app, `[runtime] stopping (${reason})`)
    const proc = app.proc
    if (!proc) return
    this.terminate(app, proc)
    await proc.exited.catch(() => undefined)
  }

  /** SIGTERM, then SIGKILL if the app ignores it. */
  private terminate(app: RunningApp, proc: Bun.Subprocess): void {
    if (app.live) signalProc(app.live, 'SIGTERM')
    else signalProc({ proc, sandbox: null }, 'SIGTERM')
    const timer = setTimeout(() => {
      if (proc.exitCode !== null) return
      signalProc(app.live ?? { proc, sandbox: null }, 'SIGKILL')
    }, KILL_GRACE_MS)
    timer.unref?.()
  }

  private recordFailure(siteId: string): void {
    const previous = this.failures.get(siteId)
    const count = (previous?.count ?? 0) + 1
    // 1s, 2s, 4s ... at most 30s, so a broken app is not retried in a loop.
    this.failures.set(siteId, { count, until: Date.now() + Math.min(30_000, 1000 * 2 ** (count - 1)) })
  }
}

/** The function-or-app answer for a host that belongs to an SSR site. */
export async function ssrResponse(services: Services, site: SiteRow, request: Request, deploymentId?: string | null): Promise<Response> {
  if (!services.config.sitesSsr) return sitePage(503, 'SSR sites are off', 'This server has site rendering turned off.')
  let deployment: SiteDeploymentRow | null
  const id = deploymentId || site.deployment_id
  try {
    deployment = id ? services.sites.deployment(site.id, id) : null
  } catch {
    deployment = null
  }
  if (!deployment || deployment.status !== 'ready') return sitePage(404, 'Nothing here yet', 'This site has no live deployment.')
  // The command is part of the deployment, so rolling back runs the old app.
  if (deployment.start_command.trim()) return services.sites.ssr.handle(site.id, request, deploymentId)
  if (!site.api_function_id) return sitePage(502, 'No app', 'This SSR site has no start command and no API function.')
  let fn
  try {
    fn = services.functions.fn(site.api_function_id)
  } catch {
    return sitePage(502, 'No app', `The site's API function "${site.api_function_id}" does not exist.`)
  }
  try {
    const caller = await resolveCaller(services.db, services.config, request)
    const url = new URL(request.url)
    return await functionHttpResponse(services, fn, caller, request, `${url.pathname}${url.search}`)
  } catch (error) {
    return errorResponse(error)
  }
}
