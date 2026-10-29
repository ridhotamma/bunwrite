/**
 * A build that times out must take the children it started with it. Killing
 * only the `sh` would leave a worker running as the function's user after the
 * build was already recorded as failed, which is how a build command escapes
 * its 15-minute limit.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { runShell } from '~/deploy/command'

describe('runShell', () => {
  test('returns the output of a build that finishes', async () => {
    const result = await runShell({ command: 'echo hello; echo oops >&2', timeoutMs: 5_000 })
    expect(result).toEqual({ code: 0, output: 'hello\noops', timedOut: false })
  })

  test('a timeout kills the whole process group, not just the shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunwrite-command-'))
    const marker = join(dir, 'alive')
    try {
      const started = performance.now()
      const result = await runShell({
        command: `(while :; do echo x > "${marker}"; sleep 0.05; done) & sleep 60`,
        timeoutMs: 300,
      })
      expect(result.timedOut).toBe(true)
      expect(performance.now() - started).toBeLessThan(5_000)

      // The background loop was writing until the timeout; once runShell has
      // returned it must be gone, so the marker is not written again.
      expect(existsSync(marker)).toBe(true)
      rmSync(marker, { force: true })
      await Bun.sleep(400)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
