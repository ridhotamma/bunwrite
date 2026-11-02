import { describe, expect, test } from 'bun:test'

import {
  listWalgBackups,
  maskDatabaseUrl,
  parseGucSeconds,
  parseWalgBackupList,
  postgresDoctor,
  postgresRunbook,
  readPostgresStatus,
  type PostgresStatus,
} from '~/backups/postgres'
import { backupsView } from '~/console/views/backups'
import type { SqlDriver } from '~/db/driver'

const healthyStatus: PostgresStatus = {
  version: '16.4',
  versionNumber: 160004,
  database: 'bunwrite',
  user: 'bunwrite',
  inRecovery: false,
  dataDirectory: '/var/lib/postgresql/16/main',
  settings: {
    walLevel: 'replica',
    archiveMode: 'on',
    archiveCommand: 'wal-g wal-push %p',
    restoreCommand: 'wal-g wal-fetch %f %p',
    archiveTimeoutSeconds: 60,
  },
  archiver: {
    archivedCount: 12,
    failedCount: 0,
    lastArchivedWal: '000000010000000000000012',
    lastArchivedAt: '2026-11-02T09:59:00.000Z',
    lastFailedWal: null,
    lastFailedAt: null,
  },
}

function mockSql(rows: { status: Record<string, unknown>; archiver?: Record<string, unknown> | null }): SqlDriver {
  const driver = {
    kind: 'sql' as const,
    dialect: 'postgres' as const,
    capabilities: {} as SqlDriver['capabilities'],
    async get<T>(sql: string): Promise<T | null> {
      if (sql.includes('pg_stat_archiver')) return (rows.archiver ?? null) as T | null
      return rows.status as T
    },
    async all<T>(): Promise<T[]> {
      return []
    },
    async run() {
      return { changes: 0, lastInsertId: null }
    },
    async exec() {},
    async transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      return fn(driver as never)
    },
    async ping() {},
    async close() {},
  }
  return driver
}

describe('postgres backup doctor', () => {
  test('reads settings and archiver counters', async () => {
    const sql = mockSql({
      status: {
        database: 'bunwrite',
        db_user: 'bunwrite',
        version: '16.4',
        version_number: '160004',
        in_recovery: false,
        data_directory: '/var/lib/postgresql/16/main',
        wal_level: 'replica',
        archive_mode: 'on',
        archive_command: 'wal-g wal-push %p',
        restore_command: 'wal-g wal-fetch %f %p',
        archive_timeout: '60s',
      },
      archiver: {
        archived_count: 3,
        failed_count: 1,
        last_archived_wal: 'wal-3',
        last_archived_time: '2026-11-02T09:00:00Z',
        last_failed_wal: 'wal-4',
        last_failed_time: '2026-11-02T09:01:00Z',
      },
    })
    const status = await readPostgresStatus(sql)
    expect(status.versionNumber).toBe(160004)
    expect(status.inRecovery).toBe(false)
    expect(status.settings.archiveTimeoutSeconds).toBe(60)
    expect(status.archiver?.failedCount).toBe(1)
    expect(status.archiver?.lastFailedAt).toBe('2026-11-02T09:01:00.000Z')
  })

  test('parses Postgres duration settings', () => {
    expect(parseGucSeconds('60s')).toBe(60)
    expect(parseGucSeconds('5min')).toBe(300)
    expect(parseGucSeconds('1h')).toBe(3600)
    expect(parseGucSeconds('0')).toBe(0)
  })

  test('treats the disabled archive command as unset', async () => {
    const status = await readPostgresStatus(
      mockSql({
        status: {
          database: 'bunwrite',
          db_user: 'bunwrite',
          version: '16.4',
          version_number: 160004,
          in_recovery: false,
          data_directory: null,
          wal_level: 'replica',
          archive_mode: 'off',
          archive_command: '(disabled)',
          restore_command: '',
          archive_timeout: '0',
        },
      }),
    )
    expect(status.settings.archiveCommand).toBe('')
  })

  test('parses wal-g backup-list output', () => {
    const output = `name                          last_modified
base_000000010000000000000010 2026-11-01T02:00:00Z
base_000000010000000000000020 2026-11-02T02:00:00Z
`
    expect(parseWalgBackupList(output)).toEqual([
      { name: 'base_000000010000000000000010', modified: '2026-11-01T02:00:00Z' },
      { name: 'base_000000010000000000000020', modified: '2026-11-02T02:00:00Z' },
    ])
  })

  test('reports a healthy deployment without failures', async () => {
    const report = await postgresDoctor({
      sql: mockSql({ status: {}, archiver: null }),
      status: healthyStatus,
      env: { WALG_S3_PREFIX: 's3://bucket/bunwrite', WALG_LIBSODIUM_KEY: 'secret' },
      now: new Date('2026-11-02T10:00:00Z').getTime(),
      walg: {
        configured: true,
        binary: '/usr/local/bin/wal-g',
        backups: [{ name: 'base_000000010000000000000012', modified: '2026-11-02T02:00:00Z' }],
        checkedAt: '2026-11-02T10:00:00.000Z',
      },
    })
    expect(report.ok).toBe(true)
    expect(report.checks.some((check) => check.status === 'fail')).toBe(false)
    expect(report.checks.find((check) => check.id === 'walg-base-backup')?.status).toBe('ok')
  })

  test('fails when archiving is disabled and no base backup exists', async () => {
    const status: PostgresStatus = {
      ...healthyStatus,
      settings: { ...healthyStatus.settings, walLevel: 'minimal', archiveMode: 'off', archiveCommand: '', restoreCommand: '' },
      archiver: { ...healthyStatus.archiver!, archivedCount: 0, lastArchivedAt: null, failedCount: 1, lastFailedAt: '2026-11-02T09:00:00Z', lastFailedWal: 'wal-1' },
    }
    const report = await postgresDoctor({
      sql: mockSql({ status: {}, archiver: null }),
      status,
      env: {},
      now: Date.now(),
      walg: { configured: false, binary: null, backups: [], checkedAt: new Date().toISOString() },
    })
    expect(report.ok).toBe(false)
    expect(report.checks.filter((check) => check.status === 'fail').map((check) => check.id)).toContain('wal-level')
    expect(report.checks.filter((check) => check.status === 'fail').map((check) => check.id)).toContain('archiver-failure')
    expect(report.checks.filter((check) => check.status === 'fail').map((check) => check.id)).toContain('walg-prefix')
  })

  test('lists wal-g backups through the injected runner and sorts newest first', async () => {
    const result = await listWalgBackups({
      env: { WALG_S3_PREFIX: 's3://bucket/bunwrite' },
      binary: '/bin/sh',
      cacheMs: 0,
      run: async () => ({
        code: 0,
        stdout: 'name last_modified\nbase_0002 2026-11-01T00:00:00Z\nbase_0001 2026-11-02T00:00:00Z\n',
        stderr: '',
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.backups.map((backup) => backup.name)).toEqual(['base_0001', 'base_0002'])
  })

  test('masks database passwords and generates an executable runbook', () => {
    expect(maskDatabaseUrl('postgres://bunwrite:secret@db.example.com:5432/bunwrite')).toBe('postgres://bunwrite:***@db.example.com:5432/bunwrite')
    expect(maskDatabaseUrl('postgres://bunwrite@db.example.com/bunwrite?password=secret')).not.toContain('secret')
    const runbook = postgresRunbook({
      status: healthyStatus,
      env: { WALG_S3_PREFIX: 's3://bucket/bunwrite' },
      pgdata: '/var/lib/postgresql/16/main',
      targetTime: '2026-11-02 10:00:00+00',
      databaseUrl: 'postgres://bunwrite:secret@db.example.com/bunwrite',
    })
    expect(runbook).toContain('wal-g backup-fetch')
    expect(runbook).toContain("recovery_target_time = '2026-11-02 10:00:00+00'")
    expect(runbook).toContain('/var/lib/postgresql/16/main')
    expect(runbook).not.toContain('secret')
  })

  test('renders the Postgres backups page with live checks and a runbook', async () => {
    const sql = mockSql({
      status: {
        database: 'bunwrite',
        db_user: 'bunwrite',
        version: '16.4',
        version_number: 160004,
        in_recovery: false,
        data_directory: '/var/lib/postgresql/16/main',
        wal_level: 'replica',
        archive_mode: 'on',
        archive_command: 'wal-g wal-push %p',
        restore_command: 'wal-g wal-fetch %f %p',
        archive_timeout: '60s',
      },
      archiver: {
        archived_count: 2,
        failed_count: 0,
        last_archived_wal: 'wal-2',
        last_archived_time: '2026-11-02T09:59:00Z',
        last_failed_wal: null,
        last_failed_time: null,
      },
    })
    const ctx = {
      url: new URL('http://localhost/console/organization/backups'),
      projects: {
        control: {
          config: { databaseUrl: 'postgres://bunwrite:secret@db.example.com/bunwrite' },
          db: { driver: sql, capabilities: { localFile: false } },
        },
      },
    } as unknown as Parameters<typeof backupsView>[0]
    const old = process.env.WALG_S3_PREFIX
    delete process.env.WALG_S3_PREFIX
    try {
      const body = String(await backupsView(ctx))
      expect(body).toContain('Postgres continuous backup (WAL-G)')
      expect(body).toContain('Restore readiness')
      expect(body).toContain('Postgres restore runbook')
      expect(body).toContain('wal-g backup-fetch')
      expect(body).toContain('bunwrite postgres:doctor')
      expect(body).toContain('cannot see the Postgres host environment')
    } finally {
      if (old === undefined) delete process.env.WALG_S3_PREFIX
      else process.env.WALG_S3_PREFIX = old
    }
  })
})
