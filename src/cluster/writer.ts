/**
 * Several writer processes may run, each owning a hash of project IDs. SQLite
 * still has one writer per database file, but write traffic from different
 * projects lands on different event loops instead of one shared writer.
 * A process in the writer pool publishes a loopback listener and the public
 * workers forward short database writes to the writer that owns the project.
 *
 * Almost every mutating API call and short console form is a short
 * transaction, so it belongs on a writer too. The exceptions are requests
 * that spend their time outside the database: file uploads, function
 * executions and deployments, site deployments, backups, render jobs and
 * GitHub/VCS work. Those stay on the worker that accepted them.
 *
 * Everything stays inside the same container/network namespace, so this needs
 * no proxy or Caddy configuration: the first writer listens on `WRITER_PORT`
 * (default `PORT + 1`) and shard `i` on `WRITER_PORT + i`, all on loopback.
 * `WRITER_PORT=0` restores the old local-write behavior.
 */
import type { Config } from '~/config'
import { clientIpOf } from '~/lib/client-ip'
import { err } from '~/lib/errors'

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
  // Vector ingest/search may call an embedding model or scan a large collection.
  /^\/vectors(?:\/|$)/,
  /^\/rag(?:\/|$)/,
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
  // Vector ingest, search and RAG may call an embedding/chat model.
  /^\/console\/vectors(?:\/|$)/,
  /^\/console\/storage\/[^/]+\/files\/?$/,
  /^\/console\/storage\/[^/]+\/delete\/?$/,
  /^\/console\/organization\/backups\/(?:create|restore|restore\/cancel)\/?$/,
  /^\/console\/organization\/backups\/[^/]+\/delete\/?$/,
  /^\/console\/settings\/smtp\/test\/?$/,
  /^\/console\/settings\/render\/test\/?$/,
  /^\/console\/settings\/cache\/previews\/clear\/?$/,
  /^\/console\/webhooks\/[^/]+\/test\/?$/,
  /^\/console\/schema\/preview\/?$/,
  /^\/console\/schema\/save\/?$/,
  /^\/console\/schema\/import\/preview\/?$/,
]
/**
 * How long to keep trying while the writer process is restarting. Only a
 * failed connection is retried: the writer never saw that request.
 */
const RETRY_DELAYS_MS = [0, 50, 150]
/** After this many failed forwards, serve writes locally for a while. */
const CIRCUIT_OPEN_MS = 30_000
/**
 * A forwarded write waits at most this long. The writer may still finish it,
 * so a timeout is answered with 504 instead of being retried or written
 * locally: sending a create twice would apply it twice.
 */
const FORWARD_TIMEOUT_MS = 10_000

/** True when the request reached the writer but its answer did not come back in time. */
function timedOut(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

function unconfirmedWrite(): Response {
  const body = {
    ...err(
      'general_unknown',
      'The write took too long to confirm, so it may or may not have been applied. Read the affected resources back before retrying.',
    ).toJSON(),
    code: 504,
  }
  return new Response(JSON.stringify(body), { status: 504, headers: { 'content-type': 'application/json' } })
}

/** Shards whose listener failed recently; one bad writer does not open the others' circuits. */
const circuitOpenUntil = new Map<number, number>()

export interface ClusterRole {
  workers: number
  workerIndex: number
  /** Writer processes in the pool; defaults to one. */
  writerShards?: number
}

/**
 * Which writer owns a project. Stable across processes, so every worker picks
 * the same writer for the same project. FNV-1a is enough here: project IDs are
 * short, and the mapping only needs to spread them, not resist attacks.
 */
export function writerShardFor(projectId: string, writerShards: number): number {
  const shards = Math.max(1, Math.floor(writerShards) || 1)
  if (shards === 1) return 0
  let hash = 0x811c9dc5
  for (let index = 0; index < projectId.length; index++) {
    hash ^= projectId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % shards
}

/** Single-process servers and every process in the writer pool write locally. */
export function isWriterWorker(role: ClusterRole): boolean {
  if (role.workers <= 1) return true
  return role.workerIndex < Math.max(1, Math.floor(role.writerShards ?? 1))
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

/** The loopback port a writer shard listens on. */
export function writerPortFor(config: Config, shard = writerShardFor(config.projectId, config.writerShards)): number {
  return config.writerPort + shard
}

/** A cluster with a reachable writer for this project and this process is not it. */
function canForward(config: Config, shard: number): boolean {
  if (config.workers <= 1 || config.writerPort <= 0) return false
  if (isWriterWorker(config)) return false
  return Date.now() >= (circuitOpenUntil.get(shard) ?? 0)
}

/** Whether this request should be handed to the writer that owns the project. */
export function shouldForwardWrite(config: Config, method: string, pathname: string, projectId = config.projectId): boolean {
  const shard = writerShardFor(projectId, config.writerShards)
  return canForward(config, shard) && isForwardedWrite(method, pathname)
}

/** Whether this console form should be handed to the writer that owns its project. */
export function shouldForwardConsoleWrite(config: Config, method: string, pathname: string, projectId = config.projectId): boolean {
  const shard = writerShardFor(projectId, config.writerShards)
  return canForward(config, shard) && isForwardedConsoleWrite(method, pathname)
}

const HOP_BY_HOP = ['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade']

/**
 * Send the request to the writer that owns its project, preserving its headers
 * apart from the client address (and the console's Origin, which must match the
 * listener it reaches). Returns null when that writer did not take it, so the
 * caller can handle the write locally instead of failing it.
 */
export async function forwardWrite(
  config: Config,
  request: Request,
  projectId = config.projectId,
  options: { timeoutMs?: number } = {},
): Promise<Response | null> {
  const timeoutMs = options.timeoutMs ?? FORWARD_TIMEOUT_MS
  const shard = writerShardFor(projectId, config.writerShards)
  const port = writerPortFor(config, shard)
  const url = new URL(request.url)
  const target = `http://${config.writerHost}:${port}${url.pathname}${url.search}`
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
    if (headers.has('origin')) headers.set('origin', `http://${config.writerHost}:${port}`)
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
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (timedOut(error)) {
        console.error(`[cluster] writer shard ${shard} did not answer ${request.method} ${url.pathname} within ${timeoutMs / 1000}s; not retrying`)
        return unconfirmedWrite()
      }
      lastError = error
    }
  }

  circuitOpenUntil.set(shard, Date.now() + CIRCUIT_OPEN_MS)
  console.error(
    `[cluster] writer shard ${shard} (${config.writerHost}:${port}) is unreachable; serving writes for project ${projectId} locally for ${CIRCUIT_OPEN_MS / 1000}s:`,
    lastError instanceof Error ? lastError.message : lastError,
  )
  return null
}
