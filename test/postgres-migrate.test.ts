/**
 * Offline SQLite -> Postgres migration integration test.
 *
 * Runs only with a real server:
 *   BUNWRITE_TEST_POSTGRES_URL=postgres://user@localhost:5432/postgres \
 *     bun test test/postgres-migrate.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { databaseOptionsOf, dropDatabase, openDatabase, sqlDatabaseOf } from '~/db'
import { migrateSqliteToPostgres, planSqliteMigration } from '~/db/migrate-sqlite-postgres'
import { configFromEnv } from '~/config'
import { controlDatabaseOptions, initialiseControlStore } from '~/projects/control'
import { adminClient, startServer, type TestServer } from './helpers'

const postgresUrl = process.env.BUNWRITE_TEST_POSTGRES_URL
const suffix = Math.random().toString(36).slice(2, 8)
const base = `bunwrite_migrate_${suffix}`
const control = `${base}_console`
const baseCurrent = `${base}_cur`
const controlCurrent = `${baseCurrent}_console`

let directory = ''
let databasePath = ''
let server: TestServer | null = null

afterAll(async () => {
  if (postgresUrl) {
    await dropDatabase({ backend: 'postgres', url: postgresUrl, namespace: base }).catch(() => {})
    await dropDatabase({ backend: 'postgres', url: postgresUrl, namespace: control }).catch(() => {})
    await dropDatabase({ backend: 'postgres', url: postgresUrl, namespace: baseCurrent }).catch(() => {})
    await dropDatabase({ backend: 'postgres', url: postgresUrl, namespace: controlCurrent }).catch(() => {})
  }
  server?.stop()
  if (directory) rmSync(directory, { recursive: true, force: true })
})

describe.skipIf(!postgresUrl)('SQLite -> Postgres migration', () => {
  test('copies a legacy install, dynamic tables, vectors and skips logs', async () => {
    directory = mkdtempSync(join(tmpdir(), 'bunwrite-migrate-'))
    databasePath = join(directory, 'bunwrite.sqlite')
    server = startServer(undefined, {}, directory, {}, databasePath)
    const admin = adminClient(server.endpoint)
    await admin.databases.createDocument({
      databaseId: 'main',
      collectionId: 'products',
      documentId: 'prod-1',
      data: { tenantId: 'acme', name: 'Migrated product', price: 42, active: true },
    })
    await server.services.vectors.createCollection({ id: 'migrate-vectors', dimension: 64 })
    await server.services.vectors.ingest({ collectionId: 'migrate-vectors', documentId: 'guide', text: 'Vector content survives the migration.' })
    server.db
      .sqlite!.query('INSERT INTO _request_logs (id, method, path, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('log-1', 'GET', '/v1/health', 200, new Date().toISOString())
    server.db.sqlite!.run('PRAGMA wal_checkpoint(TRUNCATE)')
    server.stop()
    server = null

    const plan = await planSqliteMigration({ source: databasePath, url: postgresUrl!, schema: base, controlSchema: control })
    expect(plan.controlCurrentLayout).toBe(false)
    expect(plan.projects).toHaveLength(1)
    expect(plan.projects[0]).toMatchObject({ legacy: true, schema: base })

    const report = await migrateSqliteToPostgres({ source: databasePath, url: postgresUrl!, schema: base, controlSchema: control, skipLogs: true })
    expect(report.ok).toBe(true)
    expect(report.control?.rows).toBeGreaterThan(0)
    expect(report.projects[0]?.rows).toBeGreaterThan(0)

    const targetControl = await openDatabase({ backend: 'postgres', url: postgresUrl!, namespace: control, bootstrap: false })
    try {
      expect(await targetControl.sql.get<{ id: string }>('SELECT id FROM _projects')).toMatchObject({ id: plan.projects[0]!.id })
      expect(await targetControl.sql.get<{ key: string }>('SELECT key FROM _settings WHERE key = ?', ['control'])).toMatchObject({ key: 'control' })
    } finally {
      await targetControl.close()
    }

    const targetProject = await openDatabase({ backend: 'postgres', url: postgresUrl!, namespace: base, bootstrap: false })
    try {
      expect(await targetProject.sql.get<{ name: string }>('SELECT name FROM d1_products WHERE _id = ?', ['prod-1'])).toMatchObject({
        name: 'Migrated product',
      })
      expect(Number((await targetProject.sql.get<{ n: number }>('SELECT count(*) AS n FROM _vector_points'))?.n)).toBeGreaterThan(0)
      expect(Number((await targetProject.sql.get<{ n: number }>('SELECT count(*) AS n FROM _request_logs'))?.n)).toBe(0)
      const databases = await targetProject.sql.get<{ id: string }>('SELECT id FROM _databases WHERE id = ?', ['main'])
      expect(databases).toMatchObject({ id: 'main' })
      const next = await targetProject.sql.get<{ next: string }>('SELECT nextval(pg_get_serial_sequence(?, ?)) AS next', [`"${base}"."d1_products"`, '_seq'])
      expect(Number(next?.next)).toBeGreaterThan(1)
    } finally {
      await targetProject.close()
    }

    await expect(migrateSqliteToPostgres({ source: databasePath, url: postgresUrl!, schema: base, controlSchema: control, skipLogs: true })).rejects.toThrow(
      /already contains data/,
    )
    const forced = await migrateSqliteToPostgres({ source: databasePath, url: postgresUrl!, schema: base, controlSchema: control, skipLogs: true, force: true })
    expect(forced.ok).toBe(true)
  })

  test('copies the current separate-control layout', async () => {
    const currentDir = join(directory, 'current')
    mkdirSync(join(currentDir, 'control'), { recursive: true })
    const currentDatabase = join(currentDir, 'bunwrite.sqlite')
    copyFileSync(databasePath, currentDatabase)
    const currentControl = join(currentDir, 'control', 'bunwrite.sqlite')

    const config = configFromEnv({ DATABASE_PATH: currentDatabase, CONTROL_DATABASE_PATH: currentControl })
    const options = databaseOptionsOf(config)
    const controlDatabase = await openDatabase(controlDatabaseOptions(config, options))
    try {
      const migrated = await initialiseControlStore({ config, databaseOptions: options, control: sqlDatabaseOf(controlDatabase) })
      await migrated.legacy?.close()
    } finally {
      await controlDatabase.close()
    }

    const plan = await planSqliteMigration({ source: currentDatabase, url: postgresUrl!, schema: baseCurrent, controlSchema: controlCurrent })
    expect(plan.controlCurrentLayout).toBe(true)
    expect(plan.projects).toHaveLength(1)
    const report = await migrateSqliteToPostgres({
      source: currentDatabase,
      url: postgresUrl!,
      schema: baseCurrent,
      controlSchema: controlCurrent,
      skipLogs: true,
    })
    expect(report.ok).toBe(true)
    expect(report.control?.rows).toBeGreaterThan(0)

    const target = await openDatabase({ backend: 'postgres', url: postgresUrl!, namespace: baseCurrent, bootstrap: false })
    try {
      expect(await target.sql.get<{ name: string }>('SELECT name FROM d1_products WHERE _id = ?', ['prod-1'])).toMatchObject({ name: 'Migrated product' })
    } finally {
      await target.close()
    }
  })
})
