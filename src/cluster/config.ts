/**
 * How many HTTP processes to run. `reusePort` is a Linux socket option, so
 * other platforms stay single-process until Bun supports it there.
 */
import { detectResources } from '~/system/autotune'

/** Beyond this, SQLite write contention and memory per process outweigh the gain. */
const MAX_WORKERS = 16

export interface ClusterConfig {
  /** Total HTTP processes, including this one. */
  workers: number
  /** This process's position, 0-based. */
  workerIndex: number
  /** This process starts the workers and does not serve HTTP itself. */
  supervisor: boolean
}

/**
 * `WORKERS=auto` sizes to the CPUs the container may use; a number pins the
 * count; unset, `1`, `off` and `false` keep one process.
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

export function clusterConfig(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
): ClusterConfig {
  // Set by the supervisor on every child; it also stops a child from becoming
  // a supervisor itself when WORKERS is still in the environment.
  if (env.BUNWRITE_WORKER !== undefined && env.BUNWRITE_WORKER !== '') {
    const index = Math.max(0, Math.floor(Number(env.BUNWRITE_WORKER) || 0))
    const total = Math.max(1, Math.floor(Number(env.BUNWRITE_CLUSTER_SIZE) || 1))
    return { workers: total, workerIndex: index, supervisor: false }
  }
  const workers = resolveWorkers(env.WORKERS, platform)
  return { workers, workerIndex: 0, supervisor: workers > 1 }
}
