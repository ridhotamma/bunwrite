/**
 * One process writes to SQLite at a time. SQLite already serialises writers,
 * so the other workers do not gain anything by holding the lock themselves:
 * they would only queue on `busy_timeout` while the writer's connection is
 * already there. In a cluster, worker 0 publishes a loopback listener and the
 * other workers forward short database writes to it.
 *
 * Almost every mutating API call and short console form is a short
 * transaction, so it belongs on the writer too. The exceptions are requests
 * that spend their time outside the database: file uploads, function
 * executions and deployments, site deployments, backups, render jobs and
 * GitHub/VCS work. Those stay on the worker that accepted them.
 *
 * Everything stays inside the same container/network namespace, so this needs
 * no proxy or Caddy configuration: `WRITER_PORT` defaults to `PORT + 1` and
 * binds loopback. `WRITER_PORT=0` restores the old local-write behavior.
 */
import type { Config } from '~/config'
import { clientIpOf } from '~/lib/client-ip'

/** The worker that owns the write connection; 0 unless a future mode says otherwise. */
export const WRITER_WORKER = 0

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
/** Document and transaction writes always belong on the writer. */
const DATABASE_WRITE = /^\/databases(?:\/|$)/
/**
 * Writes whose time is mostly spent outside SQLite. Forwarding them would move
 * large bodies or long-running work onto the writer's event loop.
 */
const LONG_RUNNING_WRITES = [
  // `POST /storage/buckets/:bucketId/files` carries the uploaded file itself.
  /^\/storage\/buckets\/[^/]+\/files\/?$/,
  // Function requests: runs, deployments and the function's own HTTP endpoint.
  /^\/functions\/[^/]+\/executions(?:\/|$)/,
  /^\/functions\/[^/]+\/deployments(?:\/|$)/,
  /^\/functions\/[^/]+\/http(?:\/|$)/,
  // Site deployments unpack/build the uploaded bundle.
  /^\/sites\/[^/]+\/deployments(?:\/|$)/,
  // Rendering waits on Chromium.
  /^\/render\/(?:pdf|image)\/?$/,
  // GitHub calls and repository work can take seconds.
  /^\/vcs(?:\/|$)/,
]
/**
 * Console POSTs that stay on the accepting worker: first-run setup, login,
 * project create/delete, uploads and builds, backups, outbound tests and VCS.
 * Everything else is a short form write and belongs on the writer.
 */
const CONSOLE_LOCAL_WRITES = [
  /^\/console\/?$/,
  /^\/console\/setup\/?$/,
  /^\/console\/login\/?$/,
  /^\/console\/projects\/[^/]+\/delete\/?$/,
  /^\/console\/organization\/github-app(?:\/|$)/,
  /^\/console\/vcs(?:\/|$)/,
  /^\/console\/sites\/?$/,
  /^\/console\/sites\/bulk-delete\/?$/,
  /^\/console\/sites\/[^/]+\/delete\/?$/,
  /^\/console\/sites\/[^/]+\/deployments(?:\/|$)/,
  /^\/console\/functions\/?$/,
  /^\/console\/functions\/bulk-delete\/?$/,
  /^\/console\/functions\/[^/]+\/delete\/?$/,
  /^\/console\/functions\/[^/]+\/run\/?$/,
  /^\/console\/functions\/[^/]+\/deployments(?:\/|$)/,
  /^\/console\/storage\/[^/]+\/files\/?$/,
  /^\/console\/storage\/[^/]+\/delete\/?$/,
  /^\/console\/settings\/backups\/(?:create|restore)\/?$/,
  /^\/console\/settings\/backups\/[^/]+\/delete\/?$/,
  /^\/console\/settings\/smtp\/test\/?$/,
  /^\/console\/settings\/render\/test\/?$/,
  /^\/console\/settings\/cache\/previews\/clear\/?$/,
  /^\/console\/webhooks\/[^/]+\/test\/?$/,
  /^\/console\/schema\/preview\/?$/,
  /^\/console\/schema\/save\/?$/,
  /^\/console\/schema\/import\/preview\/?$/,
]
/** How long to keep trying while the writer process is restarting. */
const RETRY_DELAYS_MS = [0, 50, 150]
/** After this many failed forwards, serve writes locally for a while. */
const CIRCUIT_OPEN_MS = 30_000
/**
 * A forwarded write waits at most this long. Anything longer is a stalled
 * writer; falling back to a local write with a short busy timeout is better
 * than holding the public worker's event loop for a minute.
 */
const FORWARD_TIMEOUT_MS = 10_000

let circuitOpenUntil = 0

export interface ClusterRole {
  workers: number
  workerIndex: number
}

/** Single-process servers and worker 0 write locally. */
export function isWriterWorker(role: ClusterRole): boolean {
  return role.workers <= 1 || role.workerIndex === WRITER_WORKER
}

/** Whether this path is a document or transaction write. */
export function isDatabaseWrite(method: string, pathname: string): boolean {
  if (!WRITE_METHODS.has(method)) return false
  // `pathname` arrives with the `/v1` prefix already removed.
  return DATABASE_WRITE.test(pathname)
}

/**
 * Whether this is a short write that should run on the writer connection.
 * Reads, uploads, executions, deployments, render jobs and VCS work stay on
 * the worker that accepted them.
 */
export function isForwardedWrite(method: string, pathname: string): boolean {
  if (!WRITE_METHODS.has(method)) return false
  if (DATABASE_WRITE.test(pathname)) return true
  return !LONG_RUNNING_WRITES.some((pattern) => pattern.test(pathname))
}

/**
 * Whether a console form is a short write. Console mutations are POSTs; the
 * pages that upload, build, render, call out or delete many files stay local.
 */
export function isForwardedConsoleWrite(method: string, pathname: string): boolean {
  if (method !== 'POST') return false
  if (pathname !== '/console' && !pathname.startsWith('/console/')) return false
  return !CONSOLE_LOCAL_WRITES.some((pattern) => pattern.test(pathname))
}

/** A cluster with a reachable writer and this process is not it. */
function canForward(config: Config): boolean {
  if (config.workers <= 1 || config.writerPort <= 0) return false
  if (isWriterWorker(config)) return false
  return Date.now() >= circuitOpenUntil
}

/** Whether this request should be handed to the writer worker's listener. */
export function shouldForwardWrite(config: Config, method: string, pathname: string): boolean {
  return canForward(config) && isForwardedWrite(method, pathname)
}

/** Whether this console form should be handed to the writer worker's listener. */
export function shouldForwardConsoleWrite(config: Config, method: string, pathname: string): boolean {
  return canForward(config) && isForwardedConsoleWrite(method, pathname)
}

const HOP_BY_HOP = ['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade']

/**
 * Send the request to worker 0, preserving its headers apart from the client
 * address (and the console's Origin, which must match the listener it reaches).
 * Returns null when the writer did not take it, so the caller can handle the
 * write locally instead of failing it.
 */
export async function forwardWrite(config: Config, request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  const target = `http://${config.writerHost}:${config.writerPort}${url.pathname}${url.search}`
  // Tee the body: if forwarding fails, the caller still handles the request.
  const body = await request.clone().arrayBuffer()
  const headers = new Headers(request.headers)
  for (const name of HOP_BY_HOP) headers.delete(name)
  // Loopback is a trusted proxy (`TRUSTED_PROXIES=private`), so the writer
  // resolves the real client from this header instead of 127.0.0.1.
  headers.set('x-forwarded-for', clientIpOf(request))
  // The console refuses a POST whose Origin is not the host it received it
  // on. On the writer that host is the loopback listener, so present it as
  // the origin; the API itself uses the original Origin for CORS.
  if (url.pathname === '/console' || url.pathname.startsWith('/console/')) {
    if (headers.has('origin')) headers.set('origin', `http://${config.writerHost}:${config.writerPort}`)
  }

  let lastError: unknown
  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) await Bun.sleep(delay)
    try {
      return await fetch(target, {
        method: request.method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      })
    } catch (error) {
      lastError = error
    }
  }

  circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS
  console.error(
    `[cluster] write listener ${config.writerHost}:${config.writerPort} is unreachable; serving writes locally for ${CIRCUIT_OPEN_MS / 1000}s:`,
    lastError instanceof Error ? lastError.message : lastError,
  )
  return null
}
