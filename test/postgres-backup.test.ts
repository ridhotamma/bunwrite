import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { unpackBackup } from '~/backups/format'
import { createPostgresBackup, pgDumpArgs, postgresConnection } from '~/backups/postgres'
import { BackupService } from '~/backups/service'
import { backupsView } from '~/console/views/backups'
import { testConfig } from './helpers'

describe('Postgres dump command', () => {
  test('keeps the password out of the command line', () => {
    const connection = postgresConnection('postgres://bunwrite:p%40ss@db.example.com:5432/bunwrite?sslmode=require')
    expect(connection.database).toBe('postgres://bunwrite@db.example.com:5432/bunwrite?sslmode=require')
    expect(connection.password).toBe('p@ss')

    const args = pgDumpArgs('/usr/bin/pg_dump', connection.database, '/tmp/bunwrite.dump')
    expect(args).toContain('--format=custom')
    expect(args).toContain('--no-owner')
    expect(args).toContain('--no-privileges')
    expect(args).toContain('--dbname=postgres://bunwrite@db.example.com:5432/bunwrite?sslmode=require')
    expect(args.join(' ')).not.toContain('p%40ss')
    expect(args.join(' ')).not.toContain('p@ss')
  })

  test('rejects a non-Postgres URL', () => {
    expect(() => postgresConnection('sqlite:///tmp/db.sqlite')).toThrow('postgres://')
  })
})

describe('Postgres dump file', () => {
  test('runs pg_dump, then compresses and encrypts the output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-pg-backup-'))
    try {
      const secret = 'correct horse battery staple'
      let command: string[] = []
      let env: Record<string, string | undefined> = {}
      const backup = await createPostgresBackup({
        databaseUrl: 'postgres://bunwrite:secret@db.example.com:5432/bunwrite',
        outputDir: root,
        secret,
        now: new Date('2026-11-02T10:00:00Z'),
        run: async (args, runEnv) => {
          command = args
          env = runEnv
          const file = args.find((arg) => arg.startsWith('--file='))!.slice('--file='.length)
          writeFileSync(file, 'PGDUMP')
          return { code: 0, stderr: '' }
        },
      })

      expect(backup.name).toBe('backup-2026-11-02T10-00-00-000Z.dump.zst.enc')
      expect(command).toContain('--format=custom')
      expect(command.join(' ')).not.toContain('secret')
      expect(env.PGPASSWORD).toBe('secret')
      expect(readFileSync(backup.path).subarray(0, 4).toString()).toBe('BWBK')

      const plain = join(root, 'restored.dump')
      await unpackBackup(backup.path, plain, secret)
      expect(readFileSync(plain, 'utf8')).toBe('PGDUMP')
      expect(readdirSync(root).filter((name) => name.startsWith('.pgdump-'))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('surfaces pg_dump failures and leaves no partial backup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-pg-backup-fail-'))
    try {
      await expect(
        createPostgresBackup({
          databaseUrl: 'postgres://bunwrite@db.example.com/bunwrite',
          outputDir: root,
          run: async () => ({ code: 1, stderr: 'permission denied' }),
        }),
      ).rejects.toThrow('pg_dump exited 1: permission denied')
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Postgres backup service', () => {
  test('lists, serves and deletes dumps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-pg-service-'))
    try {
      const name = 'auto-2026-11-02T02-00-00-000Z.dump.zst'
      writeFileSync(join(root, name), 'dump')
      const service = new BackupService(testConfig({ backupsPath: root }), false)

      const files = await service.list()
      expect(files.map((file) => file.name)).toEqual([name])

      const response = await service.serve(name)
      expect(response.headers.get('content-type')).toBe('application/zstd')
      expect(await response.text()).toBe('dump')

      await service.delete(name)
      expect(await service.list()).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('requires DATABASE_URL before creating a dump', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-pg-service-url-'))
    try {
      const service = new BackupService(testConfig({ backupsPath: root, databaseUrl: undefined }), false)
      await expect(service.create('manual')).rejects.toThrow('DATABASE_URL is required')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Postgres backups page', () => {
  test('shows the cron and S3 settings without WAL-G or a runbook', async () => {
    const config = testConfig({
      databaseUrl: 'postgres://bunwrite:secret@db.example.com/bunwrite',
      databasePath: join(tmpdir(), 'bunwrite-backups-view.sqlite'),
      backupsPath: join(tmpdir(), 'bunwrite-backups-view'),
      backups: {
        enabled: true,
        schedule: '0 2 * * *',
        keep: 7,
        s3: {
          enabled: true,
          bucket: 'backups',
          region: 'auto',
          endpoint: 'https://s3.example.com',
          accessKey: 'key',
          secret: 'secret',
          forcePathStyle: true,
        },
        prefix: 'backups',
      },
    })
    const ctx = {
      url: new URL('http://localhost/console/organization/backups'),
      projects: {
        control: {
          config,
          db: { capabilities: { localFile: false } },
          backups: { list: async () => [] },
          settings: { overridden: () => false },
        },
      },
    } as unknown as Parameters<typeof backupsView>[0]

    const body = String(await backupsView(ctx))
    expect(body).toContain('Backup status')
    expect(body).toContain('id="backup-status"')
    expect(body).toContain('Automatic backups')
    expect(body).toContain('Store dumps in S3 storage')
    expect(body).toContain('pg_dump')
    expect(body).toContain('Restore a Postgres backup')
    expect(body).toContain('pg_restore')
    expect(body).not.toContain('WAL-G')
    expect(body).not.toContain('postgres:doctor')
    expect(body).not.toContain('Restore readiness')
    expect(body).not.toContain('Continuous replication (Litestream)')
  })
})
