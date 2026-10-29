/**
 * Running a build command on this host: one `sh -c` per deployment, a timeout,
 * and optionally through the function sandbox so the command runs as the
 * resource's own user. Functions and sites share this so there is only one
 * place that decides how long a build may take and how it is killed.
 *
 * Every build gets its own session, so a timeout or a shutdown takes the whole
 * command (npm, make and whatever they started) with it instead of only its
 * `sh`, which would leave workers running as the function's user for good.
 */
import type { FunctionSandbox } from '~/functions/sandbox'

/** Appwrite builds have 15 minutes; a build that takes longer is killed. */
export const BUILD_TIMEOUT_MS = 15 * 60 * 1000

/** How long a build gets to exit after SIGTERM before its group is killed. */
const KILL_GRACE_MS = 5_000

export interface ShellResult {
  code: number
  /** stdout and stderr, trimmed, as one block. */
  output: string
  timedOut: boolean
}

export interface ShellOptions {
  command: string
  /** Working directory. Leave unset when `wrap` changes into it itself. */
  cwd?: string
  env?: Record<string, string>
  /** `sandbox.wrap(uid, dir, argv)` when the command must run as another user. */
  wrap?: (argv: string[]) => string[]
  /**
   * Signal the build's whole process group. Needed with `wrap`: the group
   * belongs to another user, so only the sandbox helper may signal it.
   * Defaults to `process.kill(-pid)`, which covers same-user builds.
   */
  signal?: (pid: number, signal: 'TERM' | 'KILL') => void
  timeoutMs?: number
}

/** Builds still running, so exiting the server never leaves one behind. */
interface RunningBuild {
  proc: Bun.Subprocess
  signal?: ShellOptions['signal']
}
const RUNNING = new Set<RunningBuild>()
let exitHook = false

/** Signal the group the build leads, then the process itself as a fallback. */
function terminate(build: RunningBuild, signal: 'TERM' | 'KILL'): void {
  const { proc } = build
  if (build.signal) {
    try {
      build.signal(proc.pid, signal)
      return
    } catch {
      /* the helper could not signal it: try the group directly below */
    }
  }
  try {
    if (proc.pid > 0) {
      process.kill(-proc.pid, signal === 'KILL' ? 'SIGKILL' : 'SIGTERM')
      return
    }
  } catch {
    /* not a group leader, or owned by another user: fall back to the process */
  }
  try {
    proc.kill(signal === 'KILL' ? 9 : undefined)
  } catch {
    /* already gone */
  }
}

function trackExit(): void {
  if (exitHook) return
  exitHook = true
  process.once('exit', () => {
    for (const build of RUNNING) terminate(build, 'KILL')
  })
}

/** Run `command` with `sh -c`, collecting both output streams. */
export async function runShell(options: ShellOptions): Promise<ShellResult> {
  const argv = options.wrap ? options.wrap(['sh', '-c', options.command]) : ['sh', '-c', options.command]
  // One session per build: the timeout below kills `-pid`, which includes the
  // children the command started in the background.
  const proc = Bun.spawn(argv, { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe', detached: true })
  const build: RunningBuild = { proc, signal: options.signal }
  trackExit()
  RUNNING.add(build)
  let timedOut = false
  const timeoutMs = options.timeoutMs ?? BUILD_TIMEOUT_MS
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    timedOut = true
    terminate(build, 'TERM')
    // A build can ignore SIGTERM or be stuck in a child; do not await it forever.
    killTimer = setTimeout(() => terminate(build, 'KILL'), KILL_GRACE_MS)
    killTimer.unref?.()
  }, timeoutMs)
  timer.unref?.()
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { code, output: [out.trim(), err.trim()].filter(Boolean).join('\n'), timedOut }
  } finally {
    clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    RUNNING.delete(build)
  }
}
