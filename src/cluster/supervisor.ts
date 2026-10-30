/**
 * One process that owns N HTTP workers. Workers bind the same port with
 * SO_REUSEPORT, so the kernel spreads connections across them. A worker that
 * exits is restarted with backoff; SIGINT/SIGTERM stops them all.
 */
import { applyAutotune } from '~/system/autotune'
import { clusterProcessCount, workerPortsEnabled, writerEnabled } from './config'

const MAX_BACKOFF_MS = 30_000
const SHUTDOWN_GRACE_MS = 10_000

/**
 * The command line for a worker: the executable plus only the user's
 * arguments. Bun puts the entrypoint at argv[1] (`/$bunfs/root/bunwrite` in a
 * compiled binary), so argv.slice(2) is what `src/main.ts` dispatches on.
 * Passing argv[1] through would hand the worker the script path as a command.
 */
export function workerCommand(argv: string[] = process.argv, execPath: string = process.execPath): string[] {
  return [execPath, ...argv.slice(2)]
}

export async function runSupervisor(publicWorkers: number): Promise<void> {
  // Set the runtime limits in this process too, so the workers inherit them
  // before their Bun runtimes start.
  applyAutotune()
  const withWriter = writerEnabled()
  const total = clusterProcessCount(publicWorkers, withWriter)
  const ports = workerPortsEnabled()
  const port = process.env.PORT ?? '8080'
  const publicRange = ports ? ` on :${port}-${Number(port) + publicWorkers - 1}` : ` on :${port}`
  console.log(
    `[cluster] starting ${publicWorkers} HTTP worker${publicWorkers === 1 ? '' : 's'}${publicRange}` +
      `${withWriter ? ' + 1 writer' : ''}`,
  )

  const children = new Map<number, ReturnType<typeof Bun.spawn>>()
  const backoff = new Map<number, number>()
  let stopping = false

  const spawnWorker = (index: number): void => {
    const startedAt = Date.now()
    const child = Bun.spawn({
      cmd: workerCommand(),
      env: { ...process.env, BUNWRITE_WORKER: String(index), BUNWRITE_CLUSTER_SIZE: String(total) },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    children.set(index, child)
    void child.exited.then((code) => {
      if (children.get(index) === child) children.delete(index)
      if (stopping) return
      const ran = Date.now() - startedAt
      const delay = ran > 60_000 ? 1_000 : Math.min(MAX_BACKOFF_MS, (backoff.get(index) ?? 500) * 2)
      backoff.set(index, delay)
      console.error(`[cluster] worker ${index} exited (${code}); restarting in ${delay}ms`)
      const timer = setTimeout(() => {
        if (!stopping) spawnWorker(index)
      }, delay)
      timer.unref?.()
    })
  }

  for (let index = 0; index < total; index++) spawnWorker(index)

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    console.log(`[cluster] ${signal}: stopping ${children.size} workers`)
    for (const child of children.values()) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    const deadline = Date.now() + SHUTDOWN_GRACE_MS
    while (children.size > 0 && Date.now() < deadline) await Bun.sleep(100)
    for (const child of children.values()) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  await new Promise<never>(() => {})
}
