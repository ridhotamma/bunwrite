/**
 * One process writes to SQLite at a time. SQLite already serialises writers,
 * so the other workers do not gain anything by holding the lock themselves:
 * they would only queue on `busy_timeout` while the writer's connection is
 * already there. In a cluster, worker 0 publishes a loopback listener and the
 * other workers forward database writes to it.
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

/**
 * Database writes are the only requests that touch the writer connection.
 * Storage uploads and site requests stay on the worker that accepted them.
 */
export function isDatabaseWrite(method: string, pathname: string): boolean {
  if (!WRITE_METHODS.has(method)) return false
  // `pathname` arrives with the `/v1` prefix already removed.
  return pathname === '/databases' || pathname.startsWith('/databases/')
}

/** Whether this request should be handed to the writer worker's listener. */
export function shouldForwardDatabaseWrite(config: Config, method: string, pathname: string): boolean {
  if (config.workers <= 1 || config.writerPort <= 0) return false
  if (isWriterWorker(config)) return false
  if (Date.now() < circuitOpenUntil) return false
  return isDatabaseWrite(method, pathname)
}

const HOP_BY_HOP = ['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade']

/**
 * Send the request to worker 0 unchanged apart from the client address.
 * Returns null when the writer did not take it, so the caller can handle the
 * write locally instead of failing it.
 */
export async function forwardDatabaseWrite(config: Config, request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  const target = `http://${config.writerHost}:${config.writerPort}${url.pathname}${url.search}`
  // Tee the body: if forwarding fails, the caller still handles the request.
  const body = await request.clone().arrayBuffer()
  const headers = new Headers(request.headers)
  for (const name of HOP_BY_HOP) headers.delete(name)
  // Loopback is a trusted proxy (`TRUSTED_PROXIES=private`), so the writer
  // resolves the real client from this header instead of 127.0.0.1.
  headers.set('x-forwarded-for', clientIpOf(request))

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
