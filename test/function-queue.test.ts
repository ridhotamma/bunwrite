/**
 * Durable function executions: queued async runs survive a restart, stale
 * claims are reclaimed, failures retry, and the concurrency cap holds.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { adminClient, startServer, testSchema, type TestServer } from './helpers'

let dir: string
let server: TestServer
let admin: ReturnType<typeof adminClient>

function fn(id: string, source: string) {
  mkdirSync(join(dir, 'functions', id, 'src'), { recursive: true })
  writeFileSync(join(dir, 'functions', id, 'src/main.js'), source)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bunwrite-function-queue-'))
  fn('echo', 'module.exports = async (context) => context.res.json({ ok: true })')
  fn('boom', "module.exports = async () => { throw new Error('kaboom') }")
  fn('slow', 'module.exports = async (context) => { await new Promise((r) => setTimeout(r, 2000)); return context.res.json({}) }')

  const schema = {
    ...testSchema,
    functions: [
      { $id: 'echo', name: 'Echo', runtime: 'node-22', entrypoint: 'src/main.js', path: 'functions/echo', execute: [], timeout: 15 },
      { $id: 'boom', name: 'Boom', runtime: 'node-22', entrypoint: 'src/main.js', path: 'functions/boom', execute: [], timeout: 15 },
      { $id: 'slow', name: 'Slow', runtime: 'node-22', entrypoint: 'src/main.js', path: 'functions/slow', execute: [], timeout: 5 },
    ],
  }
  server = startServer(schema, {}, dir)
  admin = adminClient(server.endpoint)
})

afterAll(() => {
  server?.services.functions.stop()
  server?.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** Put an execution row in the queue directly, as a crashed server would leave it. */
function seed(id: string, fields: { status: string; attempts?: number; maxAttempts?: number; lease?: string | null }): void {
  const stamp = '2026-01-01T00:00:00.000+00:00'
  server.db.sqlite
    .query(
      `INSERT INTO _executions (id, function_id, trigger, status, request_method, request_path, request_headers, request_body, user_id, attempts, max_attempts, available_at, lease_until, created_at, updated_at)
       VALUES (?, 'echo', 'http', ?, 'POST', '/', '[]', '', NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, fields.status, fields.attempts ?? 0, fields.maxAttempts ?? 1, stamp, fields.lease ?? null, stamp, stamp)
}

async function waitFor(id: string, done: (status: string) => boolean, ms = 5000) {
  for (let i = 0; i < ms / 50; i++) {
    const execution = await admin.functions.getExecution({ functionId: 'echo', executionId: id })
    if (done(execution.status)) return execution
    await Bun.sleep(50)
  }
  return admin.functions.getExecution({ functionId: 'echo', executionId: id })
}

describe('durable executions', () => {
  test('a waiting run left by a restart is picked up by the drain', async () => {
    seed('crashed', { status: 'waiting' })
    expect((await admin.functions.getExecution({ functionId: 'echo', executionId: 'crashed' })).status).toBe('waiting')
    server.services.functions.drain()
    expect((await waitFor('crashed', (s) => s === 'completed')).status).toBe('completed')
  })

  test('a stale claim is requeued by the reaper, then runs', async () => {
    seed('stale', { status: 'processing', attempts: 1, maxAttempts: 2, lease: '2000-01-01T00:00:00.000+00:00' })
    expect(server.services.functions.reap()).toEqual(['stale'])
    const done = await waitFor('stale', (s) => s === 'completed')
    expect(done.status).toBe('completed')
  })

  test('a stale claim out of attempts fails instead of looping', async () => {
    seed('poison', { status: 'processing', attempts: 1, maxAttempts: 1, lease: '2000-01-01T00:00:00.000+00:00' })
    expect(server.services.functions.reap()).toEqual([])
    const row = server.db.sqlite.query<{ status: string; errors: string }, [string]>('SELECT status, errors FROM _executions WHERE id = ?').get('poison')
    expect(row!.status).toBe('failed')
    expect(row!.errors).toContain('stopped before it finished')
  })

  test('a failed async run retries up to FUNCTIONS_MAX_ATTEMPTS', async () => {
    server.config.functionMaxAttempts = 2
    try {
      const created = await admin.functions.createExecution({ functionId: 'boom', async: true })
      let row: { status: string; attempts: number } | null = null
      for (let i = 0; i < 100; i++) {
        row = server.db.sqlite.query<{ status: string; attempts: number }, [string]>('SELECT status, attempts FROM _executions WHERE id = ?').get(created.$id)
        if (row?.status === 'failed') break
        await Bun.sleep(50)
      }
      expect(row).toMatchObject({ status: 'failed', attempts: 2 })
    } finally {
      server.config.functionMaxAttempts = 1
    }
  }, 15_000)

  test('async runs wait for a free slot instead of all starting at once', async () => {
    server.config.functionsConcurrency = 1
    try {
      const first = await admin.functions.createExecution({ functionId: 'slow', async: true })
      // Let the drain claim the first run before queueing the second.
      await Bun.sleep(100)
      const second = await admin.functions.createExecution({ functionId: 'slow', async: true })
      await Bun.sleep(200)
      const status = (id: string) =>
        server.db.sqlite.query<{ status: string }, [string]>('SELECT status FROM _executions WHERE id = ?').get(id)!.status
      expect(status(first.$id)).toBe('processing')
      expect(status(second.$id)).toBe('waiting')
    } finally {
      server.config.functionsConcurrency = 4
    }
  }, 15_000)
})
