/**
 * Running a build command on this host: one `sh -c` per deployment, a timeout,
 * and optionally through the function sandbox so the command runs as the
 * resource's own user. Functions and sites share this so there is only one
 * place that decides how long a build may take and how it is killed.
 */
import type { FunctionSandbox } from '~/functions/sandbox'

/** Appwrite builds have 15 minutes; a build that takes longer is killed. */
export const BUILD_TIMEOUT_MS = 15 * 60 * 1000

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
  timeoutMs?: number
}

/** Run `command` with `sh -c`, collecting both output streams. */
export async function runShell(options: ShellOptions): Promise<ShellResult> {
  const argv = options.wrap ? options.wrap(['sh', '-c', options.command]) : ['sh', '-c', options.command]
  const proc = Bun.spawn(argv, { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timeoutMs = options.timeoutMs ?? BUILD_TIMEOUT_MS
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }, timeoutMs)
  timer.unref?.()
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { code, output: [out.trim(), err.trim()].filter(Boolean).join('\n'), timedOut }
  } finally {
    clearTimeout(timer)
  }
}
