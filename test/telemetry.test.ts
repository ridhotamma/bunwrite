import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb, type Db } from '~/db/connection'
import { addSeconds } from '~/lib/datetime'
import { TelemetryStore } from '~/observability/store'

const dirs: string[] = []
const databases: Db[] = []

function database(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'bunwrite-telemetry-'))
  dirs.push(dir)
  const db = openDb(join(dir, 'telemetry.sqlite'))
  databases.push(db)
  return db
}

function store(db = database(), options: Partial<ConstructorParameters<typeof TelemetryStore>[1]> = {}): TelemetryStore {
  return new TelemetryStore(db, { flushMs: 60_000, ...options })
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.sqlite.close()
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('TelemetryStore', () => {
  test('buffers spans and events, then lists them for one project', async () => {
    const telemetry = store()
    telemetry.recordSpan({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      requestId: 'req-1',
      name: 'GET /databases/:id',
      method: 'GET',
      route: '/databases/:id',
      status: 200,
      durationMs: 12.5,
      project: 'booking-app',
      auth: 'user:user-1',
      attributes: { 'http.route': '/databases/:id' },
    })
    telemetry.recordSpan({
      traceId: 'c'.repeat(32),
      spanId: 'd'.repeat(16),
      name: 'GET /other',
      method: 'GET',
      route: '/other',
      status: 500,
      durationMs: 30,
      project: 'another-project',
      attributes: {},
    })
    telemetry.recordEvent({
      event: 'document.created',
      distinctId: 'user:user-1',
      project: 'booking-app',
      database: 'db',
      collection: 'bookings',
      documentId: 'doc-1',
      properties: { action: 'create' },
    })
    await telemetry.flush()

    const spans = await telemetry.listSpans({ page: 1, limit: 10, project: 'booking-app' })
    expect(spans.total).toBe(1)
    expect(spans.spans[0]).toMatchObject({ route: '/databases/:id', status: 200, request_id: 'req-1', auth: 'user:user-1' })
    expect(JSON.parse(spans.spans[0]!.attributes)).toEqual({ 'http.route': '/databases/:id' })
    expect(await telemetry.getSpan(spans.spans[0]!.seq, 'booking-app')).not.toBeNull()
    expect(await telemetry.getSpan(spans.spans[0]!.seq, 'another-project')).toBeNull()

    const events = await telemetry.listEvents({ page: 1, limit: 10, project: 'booking-app' })
    expect(events.total).toBe(1)
    expect(events.events[0]).toMatchObject({ event: 'document.created', collection: 'bookings', document_id: 'doc-1' })
    expect(await telemetry.eventNames('booking-app')).toEqual(['document.created'])
    expect(await telemetry.distinctIds('booking-app', addSeconds(-60))).toBe(1)
    expect(await telemetry.eventSummary('booking-app', addSeconds(-60))).toEqual([{ event: 'document.created', n: 1 }])

    const hours = await telemetry.eventsByHour('booking-app', addSeconds(-60))
    expect(hours).toHaveLength(1)
    expect(hours[0]!.n).toBe(1)
    expect(await telemetry.counts('booking-app')).toEqual({ spans: 1, events: 1 })
    expect(await telemetry.topRoutes('booking-app', addSeconds(-60), 6)).toEqual([{ route: '/databases/:id', requests: 1, errors: 0, avg: 12.5 }])
    await telemetry.close()
  })

  test('upserts per-request metrics across workers into one minute row', async () => {
    const db = database()
    const first = store(db)
    const second = store(db)
    const at = Math.floor(Date.now() / 60_000) * 60_000 + 30_000
    const minute = new Date(at).toISOString().slice(0, 16)
    for (let index = 0; index < 10; index++) {
      first.recordRequest('booking-app', 20, 200, at)
      second.recordRequest('booking-app', 300, 500, at)
    }
    await first.flush()
    await second.flush()

    const summary = await first.summary('booking-app', minute)
    expect(summary).toMatchObject({ requests: 20, errors: 10, avg: 160, p50: 25, p95: 500 })
    const points = await first.minutePoints('booking-app', minute)
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ minute, requests: 20, errors: 10, avg: 160 })
    await first.close()
    await second.close()
  })

  test('trims to the configured caps and clears one project', async () => {
    const telemetry = store(undefined, { maxSpans: 2, maxEvents: 1 })
    for (let index = 0; index < 3; index++) {
      telemetry.recordSpan({
        traceId: String(index).repeat(32).slice(0, 32),
        spanId: String(index).repeat(16).slice(0, 16),
        name: `GET /${index}`,
        method: 'GET',
        route: `/${index}`,
        status: 200,
        durationMs: index,
        project: 'booking-app',
        attributes: {},
      })
      telemetry.recordEvent({
        event: 'document.updated',
        distinctId: 'user:user-1',
        project: 'booking-app',
        database: 'db',
        collection: 'bookings',
        documentId: String(index),
        properties: {},
      })
    }
    await telemetry.flush()
    expect((await telemetry.listSpans({ page: 1, limit: 10, project: 'booking-app' })).total).toBe(2)
    expect((await telemetry.listEvents({ page: 1, limit: 10, project: 'booking-app' })).total).toBe(1)

    await telemetry.clearSpans('booking-app')
    await telemetry.clearEvents('booking-app')
    expect(await telemetry.counts('booking-app')).toEqual({ spans: 0, events: 0 })
    await telemetry.close()
  })

  test('filters spans by search and status', async () => {
    const telemetry = store()
    for (const [route, status] of [
      ['/databases/:id', 200],
      ['/databases/:id', 500],
      ['/health', 200],
    ] as const) {
      telemetry.recordSpan({
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        name: `GET ${route}`,
        method: 'GET',
        route,
        status,
        durationMs: 1,
        project: 'booking-app',
        attributes: {},
      })
    }
    await telemetry.flush()
    expect((await telemetry.listSpans({ page: 1, limit: 10, project: 'booking-app', status: '5xx' })).total).toBe(1)
    expect((await telemetry.listSpans({ page: 1, limit: 10, project: 'booking-app', search: 'health' })).total).toBe(1)
    expect((await telemetry.listSpans({ page: 1, limit: 10, project: 'booking-app', search: 'databases', status: '2xx' })).total).toBe(1)
    await telemetry.close()
  })
})
