/**
 * How many HTTP processes to run. `reusePort` is a Linux socket option, so
 * other platforms stay single-process until Bun supports it there.
 */
import { detectResources } from '~/system/autotune'

/** Beyond this, SQLite write contention and memory per process outweigh the gain. */
const MAX_WORKERS = 16

export interface ClusterConfig {
  /** Total processes, including the dedicated writer when there is one. */
  workers: number
  /** Processes that accept public HTTP traffic. */
  publicWorkers: number
  /** This process's position, 0-based. Index 0 is the writer in a cluster. */
  workerIndex: number
  /** This process starts the workers and does not serve HTTP itself. */
  supervisor: boolean
}

/**
 * `WORKERS=auto` sizes to the CPUs the container may use; a number pins the
 * public HTTP count; unset, `1`, `off` and `false` keep one process.
 */
export function resolveWorkers(
  value: string | undefined,
  platform = process.platform,
  cpus?: () => number,
): number {
  if (platform !== 'linux') return 1
  const setting = (value ?? '').trim().toLowerCase()
  if (!setting || setting === '1' || setting === 'off' || setting === 'false') return 1
  if (setting === 'auto') {
    const count = cpus ? cpus() : detectResources().cpus
    return Math.max(1, Math.min(MAX_WORKERS, Math.round(count)))
  }
  const count = Number(setting)
  if (!Number.isInteger(count) || count <= 1) return 1
  return Math.min(MAX_WORKERS, count)
}

/** Whether a cluster runs a writer process that does not accept public traffic. */
export function writerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.WRITER_PORT ?? '').trim() !== '0'
}

/** `WORKER_PORTS` binds one port per public worker instead of using SO_REUSEPORT. */
export function workerPortsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return ['1', 'true', 'yes', 'on'].includes((env.WORKER_PORTS ?? '').trim().toLowerCase())
}

/**
 * Public workers plus the dedicated writer. A single process keeps the old
 * layout (one process that serves HTTP and writes); a cluster needs one extra
 * process so the writer never has to share an event loop with request handling.
 */
export function clusterProcessCount(publicWorkers: number, withWriter = true): number {
  const publicCount = Math.max(1, Math.round(publicWorkers))
  return withWriter && publicCount > 1 ? publicCount + 1 : publicCount
}

/**
 * The port a public worker binds. With `WORKER_PORTS` each worker gets its own
 * listener so the proxy can health-check and route around it; otherwise every
 * public worker shares one port with SO_REUSEPORT.
 *
 * `publicOffset` is 1 when index 0 is the dedicated writer (public indices are
 * 1..N) and 0 when every process serves public traffic (`WRITER_PORT=0`).
 */
export function workerPort(
  basePort: number,
  workerIndex: number,
  perWorkerPorts: boolean,
  publicOffset = 1,
): number {
  if (!perWorkerPorts) return basePort
  return basePort + Math.max(0, workerIndex - publicOffset)
}

export function clusterConfig(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
): ClusterConfig {
  // Set by the supervisor on every child; it also stops a child from becoming
  // a supervisor itself when WORKERS is still in the environment.
  if (env.BUNWRITE_WORKER !== undefined && env.BUNWRITE_WORKER !== '') {
    const index = Math.max(0, Math.floor(Number(env.BUNWRITE_WORKER) || 0))
    const total = Math.max(1, Math.floor(Number(env.BUNWRITE_CLUSTER_SIZE) || 1))
    const publicWorkers = writerEnabled(env) && total > 1 ? total - 1 : total
    return { workers: total, publicWorkers, workerIndex: index, supervisor: false }
  }
  const publicWorkers = resolveWorkers(env.WORKERS, platform)
  const total = clusterProcessCount(publicWorkers, writerEnabled(env))
  return { workers: total, publicWorkers, workerIndex: 0, supervisor: total > 1 && publicWorkers > 1 }
}
