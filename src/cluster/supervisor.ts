/**
 * One process that owns N HTTP workers. Workers bind the same port with
 * SO_REUSEPORT, so the kernel spreads connections across them. A worker that
 * exits is restarted with backoff; SIGINT/SIGTERM stops them all.
 */
import { applyAutotune } from '~/system/autotune'

const MAX_BACKOFF_MS = 30_000
const SHUTDOWN_GRACE_MS = 10_000

export async function runSupervisor(workers: number): Promise<void> {
  // Set the runtime limits in this process too, so the workers inherit them
  // before their Bun runtimes start.
  applyAutotune()
  console.log(`[cluster] starting ${workers} HTTP workers on :${process.env.PORT ?? 8080}`)

  const children = new Map<number, ReturnType<typeof Bun.spawn>>()
  const backoff = new Map<number, number>()
  let stopping = false

  const spawnWorker = (index: number): void => {
    const startedAt = Date.now()
    const child = Bun.spawn({
      cmd: [process.execPath, ...process.argv.slice(1)],
      env: { ...process.env, BUNWRITE_WORKER: String(index), BUNWRITE_CLUSTER_SIZE: String(workers) },
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

  for (let index = 0; index < workers; index++) spawnWorker(index)

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
