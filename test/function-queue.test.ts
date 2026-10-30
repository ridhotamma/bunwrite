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

  test('reaping is atomic and leaves a live lease alone', () => {
    seed('reap-once', { status: 'processing', attempts: 1, maxAttempts: 3, lease: '2000-01-01T00:00:00.000+00:00' })
    seed('live-lease', { status: 'processing', attempts: 1, maxAttempts: 3, lease: '2999-01-01T00:00:00.000+00:00' })
    expect(server.services.functions.reap()).toEqual(['reap-once'])
    // The row is no longer processing, so a second pass does not touch it.
    expect(server.services.functions.reap()).toEqual([])
    const live = server.db.sqlite.query<{ status: string }, [string]>('SELECT status FROM _executions WHERE id = ?').get('live-lease')
    expect(live!.status).toBe('processing')
  })

  test('a run that lost its lease does not overwrite the reaper result', async () => {
    const created = await admin.functions.createExecution({ functionId: 'slow', async: true })
    const row = () => server.db.sqlite.query<{ status: string; errors: string }, [string]>('SELECT status, errors FROM _executions WHERE id = ?').get(created.$id)!
    for (let i = 0; i < 100 && row().status !== 'processing'; i++) await Bun.sleep(20)
    expect(row().status).toBe('processing')

    // The worker stalls past its lease: the reaper fails its only attempt
    // while the child process is still running.
    server.db.sqlite.query('UPDATE _executions SET lease_until = ? WHERE id = ?').run('2000-01-01T00:00:00.000+00:00', created.$id)
    expect(server.services.functions.reap()).toEqual([])
    expect(row().status).toBe('failed')

    // Let the stale run finish; its conditional write must not flip the row back.
    const functions = server.services.functions as unknown as { running: Map<string, number> }
    for (let i = 0; i < 100 && (functions.running.get('slow') ?? 0) > 0; i++) await Bun.sleep(50)
    expect(functions.running.get('slow') ?? 0).toBe(0)
    expect(row().status).toBe('failed')
    expect(row().errors).toContain('stopped before it finished')
  }, 15_000)

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

  test('a sync failure is never retried in the background', async () => {
    server.config.functionMaxAttempts = 2
    try {
      const run = await admin.functions.createExecution({ functionId: 'boom' })
      expect(run.status).toBe('failed')
      const row = () => server.db.sqlite.query<{ status: string; attempts: number }, [string]>('SELECT status, attempts FROM _executions WHERE id = ?').get(run.$id)!
      expect(row()).toMatchObject({ status: 'failed', attempts: 1 })
      // A sync row is enqueued with max_attempts = 1; the retry limit must come
      // from the row, not from FUNCTIONS_MAX_ATTEMPTS.
      await Bun.sleep(300)
      expect(row()).toMatchObject({ status: 'failed', attempts: 1 })
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
