import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'

import { ConsoleAuth } from '~/console/auth'
import { configFromEnv, defaultLogSampleRate } from '~/config'
import { flushRequestLogLines, formatRequestLog } from '~/lib/log'
import { PROJECT, startServer, type TestServer } from './helpers'

describe('request logs', () => {
  let server: TestServer
  let restoreLog: () => void
  const lines: string[] = []

  beforeAll(() => {
    server = startServer(undefined, { logRequests: true, logFormat: 'json' })
    const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      // Request lines are written in batches, one per line break.
      lines.push(...args.map((arg) => String(arg)).join(' ').split('\n'))
    })
    restoreLog = () => spy.mockRestore()
  })

  afterAll(() => {
    server.services.requestLogs.flush()
    restoreLog()
    server.stop()
  })

  test('writes a JSON line and returns the request id', async () => {
    const res = await fetch(`${server.endpoint}/health`, {
      headers: {
        'x-request-id': 'req-test-1',
        'x-forwarded-for': '203.0.113.9',
        'x-appwrite-project': PROJECT,
        referer: 'https://example.com/app',
        'user-agent': 'LogTest/1.0',
      },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-request-id')).toBe('req-test-1')
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0)

    flushRequestLogLines()
    const line = lines.find((entry) => entry.includes('"msg":"request"') && entry.includes('"/v1/health"'))
    expect(line).toBeDefined()
    const entry = JSON.parse(line!)
    expect(entry).toMatchObject({
      level: 'info',
      msg: 'request',
      id: 'req-test-1',
      method: 'GET',
      path: '/v1/health',
      status: 200,
      ip: '203.0.113.9',
      project: PROJECT,
      auth: 'guest',
      referer: 'https://example.com/app',
      userAgent: 'LogTest/1.0',
    })
    expect(typeof entry.durationMs).toBe('number')
    expect(entry.requestBytes).toBe(0)
    expect(entry.responseBytes).toBeGreaterThan(0)
    expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('can be turned off', async () => {
    server.config.logRequests = false
    const before = lines.length
    await fetch(`${server.endpoint}/health`, { headers: { 'x-appwrite-project': PROJECT } })
    flushRequestLogLines()
    expect(lines.length).toBe(before)
    server.config.logRequests = true
  })

  test('sampling skips successful requests but keeps errors', async () => {
    server.config.logSampleRate = 0
    const before = lines.length
    await fetch(`${server.endpoint}/health`, { headers: { 'x-appwrite-project': PROJECT, 'x-request-id': 'sampled-out' } })
    flushRequestLogLines()
    expect(lines.length).toBe(before)

    await fetch(`${server.endpoint}/nope`, { headers: { 'x-appwrite-project': PROJECT, 'x-request-id': 'sampled-error' } })
    flushRequestLogLines()
    expect(lines.some((entry) => entry.includes('sampled-error'))).toBe(true)
    server.config.logSampleRate = 1
  })

  test('stores logs and renders them in the console', async () => {
    server.config.logRequests = true
    const base = server.endpoint.replace(/\/v1$/, '')
    await new ConsoleAuth(server.db).upsert('logs@example.com', 'logs-password')
    const login = await fetch(`${base}/console/login`, {
      method: 'POST',
      body: new URLSearchParams({ email: 'logs@example.com', password: 'logs-password' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    })
    const cookie = `${login.headers.get('set-cookie')!.split(';')[0]!}; console_project=${PROJECT}`

    await fetch(`${server.endpoint}/health`, {
      headers: { 'x-appwrite-project': PROJECT, 'x-request-id': 'visible-1', referer: 'https://example.com/app', 'user-agent': 'LogTest/1.0' },
    })
    server.services.requestLogs.flush()
    const home = await (await fetch(`${base}/console/overview`, { headers: { cookie } })).text()
    expect(home).toContain('Bandwidth over time')
    expect(home).toContain('<svg')
    expect(home).toContain('/v1/health')

    const page = await (await fetch(`${base}/console/logs`, { headers: { cookie } })).text()
    expect(page).toContain('/v1/health')
    expect(page).toContain('visible-1')
    expect(page).toContain('guest')
    expect((await server.services.requestLogs.list({ page: 1, limit: 100 })).logs.some((log) => log.path === '/console/logs')).toBe(false)

    await fetch(`${server.endpoint}/nope`, { headers: { 'x-appwrite-project': PROJECT, 'x-request-id': 'missing-1' } })
    const filtered = await (await fetch(`${base}/console/logs?status=4xx`, { headers: { cookie } })).text()
    expect(filtered).toContain('missing-1')
    expect(filtered).not.toContain('visible-1')

    const missing = (await server.services.requestLogs.list({ page: 1, limit: 10, search: 'missing-1' })).logs[0]!
    expect(missing.error).toContain('Route not found')
    const detail = await (await fetch(`${base}/console/logs/${missing.seq}`, { headers: { cookie } })).text()
    expect(detail).toContain('missing-1')
    expect(detail).toContain('Route not found')
    expect(detail).toContain('/v1/nope')

    const visible = (await server.services.requestLogs.list({ page: 1, limit: 10, search: 'visible-1' })).logs[0]!
    expect([visible.auth, visible.referer, visible.user_agent]).toEqual(['guest', 'https://example.com/app', 'LogTest/1.0'])
  })

  test('prunes rows older than the retention window', async () => {
    server.db.sqlite
      .query(
        `INSERT INTO _request_logs (id, method, path, status, duration_ms, ip, project, created_at)
         VALUES ('old-request', 'GET', '/old', 200, 1, '', '', '2000-01-01T00:00:00.000+00:00')`,
      )
      .run()
    await server.services.requestLogs.prune()
    const row = server.db.sqlite.query("SELECT count(*) AS n FROM _request_logs WHERE id = 'old-request'").get() as { n: number }
    expect(row.n).toBe(0)
  })
})

test('text format is one readable line', () => {
  const line = formatRequestLog(
    { id: 'req-1', method: 'GET', path: '/v1/health', status: 200, durationMs: 1.24, ip: '203.0.113.9', project: 'test-project', auth: 'user:u1', error: 'boom' },
    'text',
  )
  expect(line).toContain('INFO GET /v1/health 200 1.2ms')
  expect(line).toContain('req=req-1 ip=203.0.113.9 project=test-project auth=user:u1 error="boom"')
})

test('request log environment variables are ignored', () => {
  const config = configFromEnv({
    LOG_REQUESTS: 'false',
    LOG_SAMPLE_RATE: '0.5',
    LOG_FORMAT: 'json',
    LOG_RETENTION_DAYS: '30',
    LOG_IP: 'false',
  })
  expect(config).toMatchObject({ logRequests: true, logSampleRate: 1, logFormat: 'text', logRetentionDays: 7, logIp: true })
})

test('several workers sample successful requests at 10% by default', () => {
  expect(defaultLogSampleRate(4)).toBe(0.1)
  expect(defaultLogSampleRate(1)).toBe(1)
  // The default follows the worker count this platform actually runs.
  const config = configFromEnv({ WORKERS: '4' })
  expect(config.logSampleRate).toBe(defaultLogSampleRate(config.workers))
})
