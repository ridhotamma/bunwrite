import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PostgresDoctorReport } from '~/backups/postgres'
import { firstIncompleteStep, postgresReadiness, recordDrill, sqliteReadiness } from '~/backups/readiness'
import { ConsoleAuth } from '~/console/auth'
import { bootstrapInstance } from '~/instance/bootstrap'
import { backupReadinessCard, backupSetupView } from '~/console/views/backup-setup'
import { testConfig, testSchema, startServer, type TestServer } from './helpers'

const dir = mkdtempSync(join(tmpdir(), 'bunwrite-setup-unit-'))
const databasePath = join(dir, 'bunwrite.sqlite')
const httpDir = mkdtempSync(join(tmpdir(), 'bunwrite-setup-http-'))
const httpDatabasePath = join(httpDir, 'bunwrite.sqlite')

let server: TestServer
let base: string
let cookie = ''

async function form(path: string, fields: Record<string, string>) {
  const body = new URLSearchParams(fields)
  return fetch(`${base}${path}`, {
    method: 'POST',
    body,
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  })
}

const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' })

beforeAll(async () => {
  server = startServer(testSchema, { backupsPath: join(httpDir, 'backups') }, undefined, {}, httpDatabasePath)
  base = server.endpoint.replace(/\/v1$/, '')
  // The archive validator expects a real Bunwrite instance record and project
  // list, which the first-boot bootstrap normally creates.
  bootstrapInstance(server.db, {})
  await new ConsoleAuth(server.db).upsert('admin@example.com', 'console-password')
})

afterAll(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
  rmSync(httpDir, { recursive: true, force: true })
})

describe('backup readiness', () => {
  test('moves from unprotected to verified as milestones are met', () => {
    const config = testConfig({ databasePath, backupsPath: join(dir, 'backups') })
    const empty = sqliteReadiness({ config, backups: [], record: {}, now: Date.parse('2026-11-02T10:00:00Z') })
    expect(empty.stage).toBe('unprotected')
    expect(empty.complete).toBe(false)
    expect(firstIncompleteStep(empty)).toBe(2)

    const configured = sqliteReadiness({
      config: { ...config, backups: { ...config.backups, enabled: true } },
      backups: [],
      record: {},
      now: Date.parse('2026-11-02T10:00:00Z'),
    })
    expect(configured.stage).toBe('configured')

    const backedUp = sqliteReadiness({
      config: { ...config, backups: { ...config.backups, enabled: true } },
      backups: [{ name: 'backup-1.archive.zst', size: 10, modified: '2026-11-02T09:00:00Z' }],
      record: { drillAt: '2026-10-01T09:00:00Z' },
      now: Date.parse('2026-11-02T10:00:00Z'),
    })
    expect(backedUp.stage).toBe('backed-up')
    expect(backedUp.steps.find((step) => step.key === 'drill')?.status).toBe('todo')

    const verified = sqliteReadiness({
      config: { ...config, backups: { ...config.backups, enabled: true } },
      backups: [{ name: 'backup-1.archive.zst', size: 10, modified: '2026-11-02T09:00:00Z' }],
      record: { drillAt: '2026-11-02T09:30:00Z' },
      now: Date.parse('2026-11-02T10:00:00Z'),
    })
    expect(verified.stage).toBe('verified')
    expect(verified.complete).toBe(true)
    expect(firstIncompleteStep(verified)).toBe(5)
  })

  test('Postgres reports WAL and base backup state without inventing a schedule', () => {
    const config = testConfig({ databasePath })
    const report = {
      status: {
        version: '16.4',
        versionNumber: 160004,
        database: 'bunwrite',
        user: 'bunwrite',
        inRecovery: false,
        dataDirectory: '/var/lib/postgresql/16/main',
        settings: { walLevel: 'replica', archiveMode: 'on', archiveCommand: 'wal-g wal-push %p', restoreCommand: 'wal-g wal-fetch %f %p', archiveTimeoutSeconds: 60 },
        archiver: { archivedCount: 3, failedCount: 0, lastArchivedWal: 'w', lastArchivedAt: '2026-11-02T09:00:00Z', lastFailedWal: null, lastFailedAt: null },
      },
      walg: { configured: true, binary: '/usr/local/bin/wal-g', backups: [{ name: 'base_1', modified: '2026-11-02T08:00:00Z' }], checkedAt: '2026-11-02T10:00:00Z' },
      checks: [],
      runbook: '',
      ok: true,
    } as unknown as PostgresDoctorReport
    const readiness = postgresReadiness({ config, report, record: {}, now: Date.parse('2026-11-02T10:00:00Z') })
    expect(readiness.driver).toBe('postgres')
    expect(readiness.steps.find((step) => step.key === 'schedule')?.status).toBe('done')
    expect(readiness.steps.find((step) => step.key === 'archive')?.status).toBe('done')
    expect(readiness.stage).toBe('backed-up')
  })

  test('renders the card and the wizard without leaking a stored secret', () => {
    const config = testConfig({
      databasePath,
      backups: {
        ...testConfig().backups,
        enabled: true,
        s3: { enabled: true, bucket: 'my-bucket', region: 'auto', endpoint: 'https://r2.example.com', accessKey: 'key', secret: 'super-secret', forcePathStyle: true },
      },
    })
    const readiness = sqliteReadiness({ config, backups: [{ name: 'b1', size: 1, modified: '2026-11-02T09:00:00Z' }], record: { drillAt: '2026-11-02T09:30:00Z' } })
    const card = String(backupReadinessCard(readiness))
    expect(card).toContain('Protected and verified')
    expect(card).toContain('Backup protection')
    const page = String(
      backupSetupView({
        driver: 'sqlite',
        step: 1,
        readiness,
        backups: config.backups,
        latestBackup: { name: 'b1', size: 1, modified: '2026-11-02T09:00:00Z' },
      }),
    )
    expect(page).toContain('Back up this instance')
    expect(page).toContain('Step 1 of 4')
    expect(page).not.toContain('super-secret')
  })

  test('records a drill in the data directory', () => {
    const config = testConfig({ databasePath })
    recordDrill(databasePath, 'sqlite', 'tested', new Date('2026-11-02T10:00:00Z'))
    const readiness = sqliteReadiness({ config, backups: [{ name: 'b1', size: 1, modified: '2026-11-02T09:00:00Z' }], now: Date.parse('2026-11-02T11:00:00Z') })
    expect(readiness.stage).toBe('verified')
    expect(readiness.lastDrillAt).toBe('2026-11-02T10:00:00.000Z')
  })
})

describe('backup setup wizard', () => {
  test('walks from storage through a tested restore', async () => {
    const login = await form('/console/login', { email: 'admin@example.com', password: 'console-password' })
    expect(login.status).toBe(303)
    cookie = login.headers.get('set-cookie')!.split(';')[0]!
    cookie += `; console_project=${server.config.projectId}`

    const start = await get('/console/organization/backups/setup')
    expect(start.status).toBe(200)
    const startBody = await start.text()
    expect(startBody).toContain('Back up this instance')
    // A fresh instance starts at the storage choice, even though local disk is
    // a valid default. Returning visitors resume at the first unfinished step.
    expect(startBody).toContain('Step 1 of 4')

    const location = (response: Response) => new URL(response.headers.get('location') ?? '/', base).searchParams

    const storage = await form('/console/organization/backups/setup/storage', { storageMode: 'local', backupPrefix: '' })
    expect(storage.status).toBe(303)
    expect(location(storage).get('step')).toBe('2')

    const schedule = await form('/console/organization/backups/setup/schedule', { backupsEnabled: 'on', backupSchedulePreset: 'daily', backupsKeep: '7' })
    expect(schedule.status).toBe(303)
    expect(location(schedule).get('step')).toBe('3')

    const first = await form('/console/organization/backups/setup/first', {})
    expect(first.status).toBe(303)
    expect(location(first).get('step')).toBe('4')

    const verify = await form('/console/organization/backups/setup/verify', {})
    expect(verify.status).toBe(303)
    expect(location(verify).get('step')).toBe('5')
    expect(location(verify).get('verified')).toBe('1')

    const done = await get('/console/organization/backups/setup?step=5&verified=1')
    expect(done.status).toBe(200)
    expect(await done.text()).toContain('This instance is protected')
  })
})
