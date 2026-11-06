import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, parseDatabaseBackend, describeDatabase, sqliteDatabase } from '~/db'
import { configFromEnv } from '~/config'
import { openDb } from '~/db/connection'
import { toPostgres } from '~/db/dialect'
import { uniqueViolation, UnsupportedFeatureError } from '~/db/driver'
import { bootstrapInstanceAsync } from '~/instance/bootstrap'
import { createServices } from '~/services'
import { createProjectManager } from '~/projects/manager'
import { projectNamespace } from '~/projects/paths'
import {
  postgresCollectionVersionStatements,
  postgresDocumentIndexStatements,
  postgresDocumentTableStatements,
  postgresSystemStatements,
} from '~/db/postgres-schema'
import type { PostgresDriver } from '~/db/postgres-driver'
import type { SqlDatabase } from '~/db/driver'
import { keyCaller } from '~/auth/caller'
import { RequestLogService } from '~/logs/service'
import { VariablesService } from '~/variables/service'
import { WebhookService } from '~/webhooks/service'
import { SettingsService, resolveApiKey } from '~/settings/service'
import { AccessService } from '~/settings/access'
import { Registry } from '~/schema/registry'
import { VersionMonitor } from '~/cluster/versions'
import { DocumentStore } from '~/documents/store'
import { TransactionService } from '~/transactions/service'
import { normalizeAttribute, normalizeIndex, permsTableName, tableName, type Collection } from '~/schema/types'
import { compileQueries } from '~/documents/query'
import { pushConfigPostgres } from '~/schema/push-postgres'
import { SchemaAdmin } from '~/schema/admin'
import { GithubAppStore } from '~/vcs/credentials'
import { VcsInstallations } from '~/vcs/installations'
import { approvedPulls, RepositoryLinks } from '~/vcs/repositories'
import { RealtimeBus } from '~/realtime/bus'
import { LeaderLease } from '~/cluster/leader'
import { RateLimiter } from '~/lib/limits'
import type { Caller } from '~/auth/caller'
import { testConfig } from './helpers'

const sqlite = openDb(':memory:')
afterAll(() => sqlite.sqlite.close())

describe('backend selection', () => {
  test('infers the backend from the URL, with an explicit driver winning', () => {
    expect(parseDatabaseBackend(undefined, 'postgres://u:p@h/db')).toBe('postgres')
    expect(parseDatabaseBackend(undefined, 'postgresql://u:p@h/db')).toBe('postgres')
    expect(parseDatabaseBackend(undefined, './data/bunwrite.sqlite')).toBe('sqlite')
    expect(parseDatabaseBackend('pg', 'mysql://h/db')).toBe('postgres')
    expect(() => parseDatabaseBackend('mysql', undefined)).toThrow()
  })

  test('DB_DRIVER is the switch; a stray DATABASE_URL never moves the server off SQLite', () => {
    expect(configFromEnv({ DATABASE_URL: 'postgres://h/db' }).databaseDriver).toBe('sqlite')
    expect(configFromEnv({ DB_DRIVER: 'postgres', DATABASE_URL: 'postgres://h/db' }).databaseDriver).toBe('postgres')
    expect(configFromEnv({ DB_DRIVER: 'postgres', DATABASE_SCHEMA: 'app' }).databaseNamespace).toBe('app')
  })

  test('describes capabilities of the SQL backends', () => {
    expect(describeDatabase({ backend: 'postgres', capabilities: { ...sqlite.capabilities, dialect: 'postgres' } })).toContain('sql')
    expect(sqlite.capabilities.fullTextSearch).toBe('fts5')
    expect(sqlite.capabilities.localFile).toBe(true)
    expect(sqliteDatabase(sqlite).dialect).toBe('sqlite')
  })

  test('per-project network namespaces stay readable and within the identifier limit', () => {
    expect(projectNamespace('bunwrite', 'project-b')).toBe('bunwrite_project_b')
    expect(projectNamespace(undefined, 'abcdef')).toBe('bunwrite_abcdef')
    // A reserved Postgres prefix is moved out of the way, and a long ID is hashed.
    expect(projectNamespace('pg_main', 'p1')).toBe('bw_pg_main_p1')
    const long = projectNamespace('a'.repeat(80), 'project-with-a-long-id')
    expect(long.length).toBeLessThanOrEqual(63)
    expect(long).toStartWith('a'.repeat(46))
  })
})

describe('postgres dialect translation', () => {
  test('numbers placeholders outside string literals', () => {
    expect(toPostgres(`SELECT * FROM t WHERE a = ? AND b = ?`)).toBe('SELECT * FROM t WHERE a = $1 AND b = $2')
    expect(toPostgres(`SELECT '?' AS literal, ? AS value`)).toBe(`SELECT '?' AS literal, $1 AS value`)
    expect(toPostgres(`SELECT "a?b" FROM t WHERE c = ?`)).toBe(`SELECT "a?b" FROM t WHERE c = $1`)
  })

  test('rewrites INSERT OR IGNORE with the conflict clause before RETURNING', () => {
    expect(toPostgres(`INSERT OR IGNORE INTO t (a) VALUES (?)`)).toBe(`INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING`)
    expect(toPostgres(`INSERT OR IGNORE INTO t (a) VALUES (?) RETURNING *`)).toBe(
      `INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING RETURNING *`,
    )
  })

  test('maps json_each, LIKE and LIMIT -1', () => {
    expect(toPostgres(`SELECT DISTINCT j.value FROM _users, json_each(_users.labels) j`)).toContain(
      'jsonb_array_elements_text(((_users.labels)::jsonb))',
    )
    expect(toPostgres(`SELECT * FROM t WHERE name LIKE ?`)).toBe('SELECT * FROM t WHERE name ILIKE $1')
    expect(toPostgres(`SELECT * FROM t WHERE name NOT LIKE ?`)).toBe('SELECT * FROM t WHERE name NOT ILIKE $1')
    expect(toPostgres(`SELECT * FROM t LIMIT -1`)).toBe('SELECT * FROM t LIMIT ALL')
    // A value that looks like a keyword is untouched.
    expect(toPostgres(`SELECT * FROM t WHERE note = 'LIKE'`)).toBe(`SELECT * FROM t WHERE note = 'LIKE'`)
  })

  test('refuses SQLite-only constructs instead of guessing', () => {
    expect(() => toPostgres('PRAGMA journal_mode = WAL')).toThrow(UnsupportedFeatureError)
    expect(() => toPostgres('INSERT OR REPLACE INTO t (a) VALUES (?)')).toThrow(UnsupportedFeatureError)
    expect(() => toPostgres(`SELECT * FROM products__fts_name WHERE products__fts_name MATCH ?`)).toThrow(
      UnsupportedFeatureError,
    )
  })
})

describe('document query dialect', () => {
  const attributes = [normalizeAttribute({ key: 'name', type: 'string', required: false, size: 255 })]
  const collection: Collection = {
    seq: 1,
    databaseId: 'main',
    databaseSeq: 1,
    id: 'products',
    name: 'Products',
    enabled: true,
    documentSecurity: true,
    permissions: [],
    attributes,
    indexes: [normalizeIndex({ key: 'fts', type: 'fulltext', attributes: ['name'] })],
    createdAt: '',
    updatedAt: '',
    table: 'd1_products',
    permsTable: 'd1_products__perms',
    attributeMap: new Map(attributes.map((a) => [a.key, a])),
  }

  test('search becomes a tsvector query on Postgres and MATCH on SQLite', () => {
    const pg = compileQueries(collection, [{ method: 'search', attribute: 'name', values: ['chuck taylor'] }], 'postgres')
    expect(pg.where[0]).toContain(`to_tsvector('english', coalesce("name", ''))`)
    expect(pg.where[0]).toContain('@@ plainto_tsquery')
    expect(pg.params).toEqual(['chuck', 'taylor'])
    expect(compileQueries(collection, [{ method: 'notSearch', attribute: 'name', values: ['chuck'] }], 'postgres').where[0]).toStartWith('NOT')

    const sqlite = compileQueries(collection, [{ method: 'search', attribute: 'name', values: ['chuck'] }], 'sqlite')
    expect(sqlite.where[0]).toContain('MATCH ?')
  })
})

describe('sqlite driver port', () => {
  test('runs statements, transactions and savepoints over the same connection', async () => {
    const driver = sqlite.driver
    const stamp = '2026-01-01T00:00:00.000+00:00'
    await driver.run('DELETE FROM _users')
    const inserted = await driver.run(
      `INSERT INTO _users (name, email, registration, created_at, updated_at, id) VALUES (?, ?, ?, ?, ?, ?)`,
      ['One', 'one@example.com', stamp, stamp, stamp, 'u1'],
    )
    expect(inserted.changes).toBe(1)
    expect(inserted.lastInsertId).not.toBeNull()
    expect(await driver.get<{ name: string }>('SELECT name FROM _users WHERE id = ?', ['u1'])).toEqual({ name: 'One' })

    await expect(
      driver.transaction(async (tx) => {
        await tx.run('DELETE FROM _users')
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await driver.get('SELECT id FROM _users WHERE id = ?', ['u1'])).toEqual({ id: 'u1' })

    await driver.transaction(async (tx) => {
      await tx.run('DELETE FROM _users')
      await tx.savepoint('one', async () => {
        await tx.run(
          `INSERT INTO _users (name, email, registration, created_at, updated_at, id) VALUES (?, ?, ?, ?, ?, ?)`,
          ['Two', 'two@example.com', stamp, stamp, stamp, 'u2'],
        )
        throw new Error('only this operation')
      }).catch(() => undefined)
    })
    expect(await driver.all('SELECT id FROM _users')).toEqual([])
  })

  test('recognises unique violations from both SQL backends', () => {
    expect(uniqueViolation(new Error('UNIQUE constraint failed: _users.id'))).not.toBeNull()
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "x"'), { errno: '23505' })
    expect(uniqueViolation(pg)?.constraint).toBe('x')
    expect(uniqueViolation(new Error('no such table'))).toBeNull()
  })
})

describe('postgres schema generation', () => {
  test('derives every built-in table, including identity columns', () => {
    const statements = postgresSystemStatements().join('\n')
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS "_users"')
    expect(statements).toContain('"seq" integer GENERATED BY DEFAULT AS IDENTITY')
    expect(statements).toContain('"id" text NOT NULL UNIQUE')
    // Booleans stay integers so the application's 0/1 contract is unchanged.
    expect(statements).toContain('"status" integer NOT NULL DEFAULT 1')
  })

  test('builds document tables, indexes and a tsvector index', () => {
    const table = postgresDocumentTableStatements('products_1', [
      { key: 'name', type: 'string', format: '', array: false, required: false, size: 255, default: null },
      { key: 'price', type: 'integer', format: '', array: false, required: false, default: 0 },
    ])
    expect(table.join('\n')).toContain('"name" text')
    expect(table.join('\n')).toContain('"price" integer')
    expect(table.join('\n')).toContain('PRIMARY KEY ("type", "role", "doc")')

    const indexes = postgresDocumentIndexStatements(
      'products_1',
      [
        { key: 'name', type: 'fulltext', attributes: ['name'], orders: ['ASC'] },
        { key: 'uniq', type: 'unique', attributes: ['$id'], orders: ['ASC'] },
      ],
      [{ key: 'name', type: 'string', format: '', array: false, required: false, size: 255, default: null }],
    ).join('\n')
    expect(indexes).toContain(`USING GIN (to_tsvector('english', coalesce("name", '')))`)
    expect(indexes).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "products_1__idx_uniq" ON "products_1" ("_id")')
  })
})

const postgresUrl = process.env.BUNWRITE_TEST_POSTGRES_URL
const suffix = Math.random().toString(36).slice(2, 8)

describe.skipIf(!postgresUrl)('postgres driver (integration)', () => {
  const namespace = `bunwrite_test_${suffix}`
  let database: Awaited<ReturnType<typeof openDatabase>>
  let driver: PostgresDriver

  test('bootstraps a schema and runs the portable SQL subset', async () => {
    database = await openDatabase({ backend: 'postgres', url: postgresUrl!, namespace })
    driver = database.sql as PostgresDriver
    const stamp = '2026-01-01T00:00:00.000+00:00'
    await driver.run(
      `INSERT INTO _users (id, name, email, registration, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ['u1', 'User', 'u1@example.com', stamp, stamp, stamp],
    )
    expect(await driver.get<{ name: string }>('SELECT name FROM _users WHERE id = ?', ['u1'])).toEqual({ name: 'User' })
    // The version trigger bumps the auth counter.
    expect((await driver.get<{ value: number }>(`SELECT value FROM _meta WHERE key = 'auth'`))?.value).toBeGreaterThan(0)
    await expect(
      driver.run(`INSERT INTO _users (id, name, email, registration, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [
        'u1',
        'Dup',
        'dupe@example.com',
        stamp,
        stamp,
        stamp,
      ]),
    ).rejects.toBeDefined()
    // `json_each` translation works on the array columns.
    expect(await driver.all(`SELECT DISTINCT j.value AS value FROM _users, json_each(_users.labels) j`)).toEqual([])
    // `INSERT OR IGNORE` translation.
    await driver.run(`INSERT OR IGNORE INTO _teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`, [
      't1',
      'Team',
      stamp,
      stamp,
    ])
  })

  test('rolls back a transaction and isolates a savepoint', async () => {
    const stamp = '2026-01-01T00:00:00.000+00:00'
    await expect(
      driver.transaction(async (tx) => {
        await tx.run(`INSERT INTO _teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`, ['t2', 'Two', stamp, stamp])
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await driver.get(`SELECT id FROM _teams WHERE id = 't2'`)).toBeNull()

    await driver.transaction(async (tx) => {
      await tx.run(`INSERT INTO _teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`, ['t3', 'Three', stamp, stamp])
      await tx
        .savepoint('sp', async () => {
          await tx.run(`INSERT INTO _teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`, ['t4', 'Four', stamp, stamp])
          throw new Error('savepoint')
        })
        .catch(() => undefined)
    })
    expect(await driver.get(`SELECT id FROM _teams WHERE id = 't3'`)).not.toBeNull()
    expect(await driver.get(`SELECT id FROM _teams WHERE id = 't4'`)).toBeNull()
  })

  test('the ported services read and write Postgres', async () => {
    const handle: SqlDatabase = { driver, dialect: 'postgres', capabilities: driver.capabilities }
    const stamp = '2026-01-01T00:00:00.000+00:00'

    const variables = new VariablesService(handle)
    await variables.create('project', 'v1', 'API_URL', 'https://a.example', false)
    expect(await variables.projectEnvironment('live')).toMatchObject({ API_URL: 'https://a.example' })
    await variables.setVariable('project', 'API_URL', 'https://b.example', false)
    expect((await variables.projectEnvironment()).API_URL).toBe('https://b.example')
    expect(await variables.list('project')).toHaveLength(1)
    // The legacy function-variable migration uses ON CONFLICT and a transaction.
    await driver.run(
      `INSERT INTO _function_vars (function_id, key, value, secret, context, created_at, updated_at) VALUES ('*', ?, ?, 0, '', ?, ?)`,
      ['LEGACY', 'kept', stamp, stamp],
    )
    await variables.adoptFunctionGlobals()
    expect((await variables.projectEnvironment()).LEGACY).toBe('kept')
    expect(await driver.get(`SELECT 1 FROM _function_vars WHERE function_id = '*'`)).toBeNull()

    const webhooks = new WebhookService(handle, () => 'test-project', () => 'bunwrite')
    const hook = await webhooks.create('hook-1', {
      name: 'Hook',
      url: 'http://127.0.0.1:9/hook',
      events: ['databases.*.collections.*.documents.*.create'],
    })
    expect(hook.enabled).toBe(1)
    await webhooks.update('hook-1', { enabled: false })
    // Disabled hooks are skipped before any network call.
    await webhooks.dispatch(
      [{ collection: { databaseId: 'main', id: 'products' }, action: 'create', document: { $id: 'x' } } as never],
      keyCaller(),
    )
    await webhooks.delete('hook-1')

    const logs = new RequestLogService(handle, testConfig())
    logs.record({ id: 'r1', method: 'GET', path: '/x', status: 200, durationMs: 1, requestBytes: 10, responseBytes: 20 })
    const listed = await logs.list({ page: 1, limit: 10 })
    expect(listed.total).toBe(1)
    expect(listed.logs[0]).toMatchObject({ path: '/x' })
    const bands = await logs.bandwidthByHour('2000-01-01T00:00:00.000+00:00')
    expect(bands[0]).toMatchObject({ inbound: 10, outbound: 20 })
    const consumers = await logs.topConsumers('2000-01-01T00:00:00.000+00:00', 5)
    expect(consumers[0]).toMatchObject({ path: '/x', bytes: 30 })
    await logs.prune()
    await logs.clear()
    expect((await logs.list({ page: 1, limit: 10 })).total).toBe(0)
  })

  test('the cache services load and write through the port', async () => {
    const handle: SqlDatabase = { driver, dialect: 'postgres', capabilities: driver.capabilities }
    const stamp = '2026-01-01T00:00:00.000+00:00'

    // Version counters.
    const versions = new VersionMonitor(handle, 0)
    await versions.load()
    const before = versions.authVersion()
    await driver.run(`UPDATE _meta SET value = value + 1 WHERE key = 'auth'`)
    const changed = await versions.pollAsync()
    expect(changed.auth).toBe(true)
    expect(versions.authVersion()).toBe(before + 1)

    // Settings overlay and API keys.
    const config = testConfig()
    const settings = new SettingsService(handle, config)
    await settings.load()
    expect(settings.overridden('project')).toBe(false)
    await settings.set('project', { projectName: 'PG Project', allowedOrigins: ['https://pg.example'], sessionDuration: 3600, sessionsLimit: 5 })
    expect(config.projectName).toBe('PG Project')
    expect(settings.overridden('project')).toBe(true)
    const { key, secret } = await settings.createKey('reader', null, ['documents.read'])
    expect((await settings.listKeys()).map((row) => row.id)).toContain(key.id)
    expect((await resolveApiKey(handle, config, secret))?.scopes).toEqual(['documents.read'])
    await settings.deleteKey(key.id)
    expect(await settings.listKeys()).toHaveLength(0)
    await settings.reset('project')
    expect(config.projectName).toBe(testConfig().projectName)

    // Another process writes the row; `load()` is the refresh path.
    await driver.run(`INSERT INTO _settings (key, value, updated_at) VALUES ('project', ?, ?)`, [
      JSON.stringify({ projectName: 'External', allowedOrigins: [], sessionDuration: 60, sessionsLimit: 1 }),
      stamp,
    ])
    await settings.load()
    expect(config.projectName).toBe('External')
    expect(settings.overridden('project')).toBe(true)
    await settings.reset('project')

    // Access switches share the `access` row.
    const access = new AccessService(handle, config, () => settings)
    await access.load()
    expect(access.serviceEnabled('users')).toBe(true)
    await access.setService('users', false)
    expect(access.serviceEnabled('users')).toBe(false)
    await access.updatePolicy('user-limit', { total: 2 })
    expect(access.policy('user-limit').total).toBe(2)
    await access.assertUserLimit()
    expect(await access.createMockPhone('+15555550123', '123456')).toMatchObject({ number: '+15555550123', otp: '123456' })

    // Registry rows.
    await driver.run(
      `INSERT INTO _databases (id, name, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT (id) DO NOTHING`,
      ['main', 'Main', stamp, stamp],
    )
    await driver.run(
      `INSERT INTO _collections (database_id, id, name, enabled, document_security, permissions, attributes, indexes, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, '[]', ?, '[]', ?, ?) ON CONFLICT (database_id, id) DO NOTHING`,
      ['main', 'products', 'Products', JSON.stringify([{ key: 'name', type: 'string', format: '', required: false, array: false, default: null }]), stamp, stamp],
    )
    const registry = new Registry(handle)
    await registry.load()
    expect(registry.collections.get('main/products')?.attributeMap.has('name')).toBe(true)
  })

  test('boots services and opens each project in its own schema', async () => {
    const handle: SqlDatabase = { driver, dialect: 'postgres', capabilities: driver.capabilities }
    const dataDir = mkdtempSync(join(tmpdir(), 'bunwrite-pg-projects-'))
    const config = testConfig({
      databasePath: ':memory:',
      databaseDriver: 'postgres',
      databaseUrl: postgresUrl,
      databaseNamespace: namespace,
      projectId: 'pg-control',
      orgId: 'org_pg',
      projectName: 'PG Control',
      secret: 'p'.repeat(40),
      instanceKey: `pg-${suffix}`,
    })
    const instance = await bootstrapInstanceAsync(
      handle,
      {
        ORG_ID: config.orgId,
        PROJECT_ID: config.projectId,
        SECRET: config.secret,
      },
      { projectName: config.projectName },
    )
    config.projectId = instance.projectId
    config.orgId = instance.orgId
    config.projectName = instance.projectName

    const control = createServices(config, handle)
    const manager = createProjectManager({
      config,
      db: handle,
      services: control,
      dataDir,
      database: { backend: 'postgres', url: postgresUrl, namespace },
    })
    try {
      await manager.ready()
      const created = await manager.create({ id: 'project-pg', name: 'Project PG', orgId: config.orgId })
      expect(created.apiKey).toStartWith('standard_')
      const project = created.project.services
      expect(project.db.dialect).toBe('postgres')
      // The runtime has its own schema and instance record.
      const projectSchema = projectNamespace(namespace, 'project-pg')
      expect(await driver.get(`SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`, [projectSchema])).not.toBeNull()
      const stored = await project.db.driver.get<{ value: string }>(`SELECT value FROM _settings WHERE key = 'instance'`)
      expect(JSON.parse(stored!.value)).toMatchObject({ projectId: 'project-pg' })

      // A collection can be pushed to that project's schema and queried there.
      await pushConfigPostgres(project.db.driver as PostgresDriver, {
        tablesDB: [{ $id: 'main', name: 'Main', enabled: true }],
        tables: [
          {
            $id: 'items',
            databaseId: 'main',
            name: 'Items',
            enabled: true,
            rowSecurity: true,
            $permissions: [],
            columns: [{ key: 'name', type: 'string', required: false, array: false, size: 100 }],
            indexes: [],
          },
        ],
      })
      await project.registry.load()
      const collection = project.registry.collection('main', 'items', true)
      const doc = await project.store.createDocument(keyCaller(), collection, { id: 'pg-item', data: { name: 'Only here' }, permissions: [] })
      expect(doc.name).toBe('Only here')
      // The control schema does not see the project's collection rows.
      expect(await driver.get(`SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`, [namespace, collection.table])).toBeNull()

      await manager.delete('project-pg')
      expect(await driver.get(`SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`, [projectSchema])).toBeNull()
    } finally {
      await manager.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 120_000)

  test('the document store and transactions run on Postgres', async () => {
    const handle: SqlDatabase = { driver, dialect: 'postgres', capabilities: driver.capabilities }
    const stamp = '2026-01-01T00:00:00.000+00:00'
    const database = await driver.get<{ seq: number }>(
      `INSERT INTO _databases (id, name, enabled, created_at, updated_at) VALUES ('docs', 'Docs', 1, ?, ?) RETURNING seq`,
      [stamp, stamp],
    )
    const attributes = [
      normalizeAttribute({ key: 'name', type: 'string', required: true, size: 255 }),
      normalizeAttribute({ key: 'price', type: 'integer', required: false, default: 0 }),
    ]
    const indexes = [
      normalizeIndex({ key: 'idx_name', type: 'key', attributes: ['name'] }),
      normalizeIndex({ key: 'idx_search', type: 'fulltext', attributes: ['name'] }),
    ]
    const table = tableName(database!.seq, 'items')
    for (const sql of postgresDocumentTableStatements(table, attributes)) await driver.exec(sql)
    for (const sql of postgresDocumentIndexStatements(table, indexes, attributes)) await driver.exec(sql)
    for (const sql of postgresCollectionVersionStatements('docs', 'items', table)) await driver.exec(sql)
    await driver.run(
      `INSERT INTO _collections (database_id, id, name, enabled, document_security, permissions, attributes, indexes, created_at, updated_at)
       VALUES ('docs', 'items', 'Items', 1, 1, '[]', ?, ?, ?, ?)`,
      [JSON.stringify(attributes), JSON.stringify(indexes), stamp, stamp],
    )

    const registry = new Registry(handle)
    await registry.load()
    const collection = registry.collection('docs', 'items', true)
    expect(collection.table).toBe(table)
    expect(collection.permsTable).toBe(permsTableName(table))

    const store = new DocumentStore(handle)
    const caller = keyCaller()
    const created = await store.createDocument(caller, collection, { id: 'p1', data: { name: 'One', price: 3 }, permissions: [] })
    expect(created.$id).toBe('p1')
    expect((await store.getDocument(caller, collection, 'p1')).name).toBe('One')
    expect((await store.listDocuments(caller, collection, [])).total).toBe(1)
    // The per-collection version trigger exists on Postgres too.
    expect(await store.collectionVersion(collection)).toBeGreaterThan(0)

    const updated = await store.updateDocument(caller, collection, 'p1', { name: 'Two' }, null, { revision: Number(created.$revision) })
    expect(updated.name).toBe('Two')
    await expect(store.updateDocument(caller, collection, 'p1', { name: 'Nope' }, null, { revision: Number(created.$revision) })).rejects.toBeDefined()
    expect((await store.incrementAttribute(caller, collection, 'p1', 'price', 2, 10, 1)).price).toBe(5)

    // A batch keeps one failing operation from rolling back the others.
    const outcomes = await store.runBatch([
      () => store.createDocumentInTx(caller, collection, { id: 'p2', data: { name: 'Batch' }, permissions: [] }),
      () => store.createDocumentInTx(caller, collection, { id: 'p1', data: { name: 'Dup' }, permissions: [] }),
    ])
    expect(outcomes.map((outcome) => (outcome.ok ? 'ok' : 'fail'))).toEqual(['ok', 'fail'])
    expect((await store.listDocuments(caller, collection, [])).total).toBe(2)

    // Transactions: staged create is visible only inside withStaged, then commits.
    const transactions = new TransactionService(handle, registry, store)
    const tx = await transactions.create(caller)
    await transactions.stage(caller, tx.$id, {
      databaseId: 'docs',
      collectionId: 'items',
      documentId: 't1',
      action: 'create',
      data: { data: { name: 'Staged' }, permissions: [] },
    })
    const staged = await transactions.withStaged(caller, tx.$id, () => store.listDocuments(caller, collection, []))
    expect(staged.total).toBe(3)
    expect((await store.listDocuments(caller, collection, [])).total).toBe(2)
    await transactions.update(caller, tx.$id, true, false)
    expect((await store.getDocument(caller, collection, 't1')).name).toBe('Staged')

    // Full-text search compiles to a tsvector query on Postgres.
    const searched = await store.listDocuments(caller, collection, [
      JSON.stringify({ method: 'search', attribute: 'name', values: ['staged'] }),
    ])
    expect(searched.documents.map((doc) => doc.$id)).toEqual(['t1'])
    const notSearched = await store.listDocuments(caller, collection, [
      JSON.stringify({ method: 'notSearch', attribute: 'name', values: ['staged'] }),
    ])
    expect(notSearched.documents.map((doc) => doc.$id).sort()).toEqual(['p1', 'p2'])
  })

  test('the Postgres schema push creates and updates collections', async () => {
    const handle: SqlDatabase = { driver, dialect: 'postgres', capabilities: driver.capabilities }
    const config = {
      tablesDB: [{ $id: 'shop', name: 'Shop', enabled: true }],
      tables: [
        {
          $id: 'orders',
          databaseId: 'shop',
          name: 'Orders',
          enabled: true,
          rowSecurity: true,
          $permissions: [],
          columns: [
            { key: 'label', type: 'string', required: false, array: false, size: 100 },
            { key: 'qty', type: 'integer', required: false, array: false, default: 0 },
          ],
          indexes: [{ key: 'idx_label', type: 'key', attributes: ['label'], orders: ['ASC'] }],
        },
      ],
      buckets: [],
      functions: [],
    }
    await pushConfigPostgres(driver, config)
    let registry = new Registry(handle)
    await registry.load()
    const first = registry.collection('shop', 'orders', true)
    const store = new DocumentStore(handle)
    await store.createDocument(keyCaller(), first, { id: 'o1', data: { label: 'first', qty: 2 }, permissions: [] })
    expect((await store.getDocument(keyCaller(), first, 'o1')).label).toBe('first')

    // A second push adds a column without dropping the table or its rows.
    config.tables[0]!.columns.push({ key: 'note', type: 'string', required: false, array: false, size: 100 } as never)
    await pushConfigPostgres(driver, config)
    registry = new Registry(handle)
    await registry.load()
    const second = registry.collection('shop', 'orders', true)
    expect(second.attributeMap.has('note')).toBe(true)
    const created = await store.createDocument(keyCaller(), second, { id: 'o2', data: { label: 'second', note: 'n' }, permissions: [] })
    expect(created.note).toBe('n')
    expect((await store.listDocuments(keyCaller(), second, [])).total).toBe(2)

    // Prune removes collections that are no longer in the config.
    await pushConfigPostgres(driver, { ...config, tables: [] }, { prune: true })
    expect(await driver.get(`SELECT 1 FROM _collections WHERE database_id = 'shop' AND id = 'orders'`)).toBeNull()
  })

  test('the schema admin creates, previews and deletes collections on Postgres', async () => {
    const handle: SqlDatabase = { driver, dialect: 'postgres', capabilities: driver.capabilities }
    const registry = new Registry(handle)
    await registry.load()
    const admin = new SchemaAdmin(handle, registry)

    await admin.createDatabase('consolepg', 'Console PG')
    await admin.createCollection('consolepg', 'items', 'Items', true, [])
    await admin.saveAttribute('consolepg', 'items', { key: 'name', type: 'string', required: false, size: 100 })
    await admin.saveIndex('consolepg', 'items', { key: 'idx_name', type: 'key', columns: ['name'], orders: ['ASC'] })
    const collection = registry.collection('consolepg', 'items', true)
    expect(collection.attributeMap.has('name')).toBe(true)
    expect(collection.indexes.map((index) => index.key)).toEqual(['idx_name'])

    // A dry run reports the change but leaves the collection untouched.
    const preview = await admin.importConfig(
      {
        tables: [
          {
            $id: 'items',
            databaseId: 'consolepg',
            name: 'Items',
            enabled: true,
            rowSecurity: true,
            columns: [
              { key: 'name', type: 'string', required: false, size: 100 },
              { key: 'note', type: 'string', required: false, size: 100 },
            ],
            indexes: [],
          },
        ],
      },
      { dryRun: true },
    )
    expect(preview.join('\n')).toContain('note')
    expect(registry.collection('consolepg', 'items', true).attributeMap.has('note')).toBe(false)

    const exported = await admin.export()
    expect((exported.tablesDB as Array<{ $id: string }>).map((database) => database.$id)).toContain('consolepg')

    await admin.deleteCollection('consolepg', 'items')
    await admin.deleteDatabase('consolepg')
    expect(await driver.get(`SELECT 1 FROM _databases WHERE id = 'consolepg'`)).toBeNull()
    expect(await driver.get(`SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`, [namespace, collection.table])).toBeNull()
  })

  test('the VCS stores persist installations, links and the GitHub App on Postgres', async () => {
    const handle: SqlDatabase = { driver, dialect: 'postgres', capabilities: driver.capabilities }
    const installations = new VcsInstallations(handle)
    const installation = await installations.add({ providerInstallationId: 'pg-install', organization: 'acme', accountType: 'Organization' })
    expect((await installations.list()).map((row) => row.id)).toContain(installation.id)
    expect((await installations.byProvider('pg-install'))?.id).toBe(installation.id)

    const links = new RepositoryLinks(handle)
    const link = await links.link({
      projectId: 'pg-control',
      resourceType: 'site',
      resourceId: 'web',
      installationId: installation.id,
      providerInstallationId: 'pg-install',
      providerRepositoryId: '500',
      providerRepositoryName: 'acme/web',
    })
    expect((await links.forResource('pg-control', 'site', 'web'))?.id).toBe(link.id)
    expect((await links.byRepository('500')).map((row) => row.id)).toContain(link.id)
    expect((await links.approve(link.id, '7')).provider_pull_request_ids).toBe('["7"]')
    expect(approvedPulls(await links.get(link.id))).toEqual(['7'])

    await links.setComment('500', 7, 'comment-1')
    expect(await links.comment('500', 7)).toBe('comment-1')
    await expect(links.approve(link.id, '7')).rejects.toBeDefined()

    await links.removeForInstallation(installation.id)
    expect(await links.forResource('pg-control', 'site', 'web')).toBeNull()
    await installations.remove(installation.id)

    const apps = new GithubAppStore(handle, testConfig())
    await apps.load()
    expect(apps.get()).toBeNull()
    await apps.save({
      id: 123,
      slug: 'bunwrite-test',
      name: 'Bunwrite Test',
      owner: { login: 'acme' },
      html_url: 'https://github.com/apps/bunwrite-test',
      client_id: 'client',
      client_secret: 'secret',
      webhook_secret: 'hook',
      pem: 'pem',
    })
    expect(apps.get()).toMatchObject({ appId: '123', slug: 'bunwrite-test', source: 'console' })
    expect(apps.stored()).toBe(true)
    expect(await apps.remove()).toBe(true)
    expect(apps.get()).toBeNull()
  })

  test('realtime events fan out through Postgres LISTEN/NOTIFY', async () => {
    const other = await openDatabase({ backend: 'postgres', url: postgresUrl!, namespace, bootstrap: false })
    const handle: SqlDatabase = { driver, dialect: 'postgres', capabilities: driver.capabilities }
    const peer: SqlDatabase = { driver: other.sql as PostgresDriver, dialect: 'postgres', capabilities: other.capabilities }
    const received: unknown[] = []
    const sender = new RealtimeBus(handle, 'pg-realtime', 20, () => {})
    const listener = new RealtimeBus(peer, 'pg-realtime', 20, (events) => received.push(...events))
    try {
      listener.setSockets(1)
      // LISTEN is established asynchronously; publish after it is ready.
      await Bun.sleep(250)
      sender.send([
        {
          collection: { databaseId: 'main', id: 'items' } as never,
          action: 'create',
          document: { $id: 'rt-1', $permissions: [] } as never,
        },
      ])
      await Bun.sleep(250)
      expect(received).toHaveLength(1)
      expect((received[0] as { document: { $id: string } }).document.$id).toBe('rt-1')
    } finally {
      listener.stop()
      sender.stop()
      await other.close()
    }
  })

  test('the scheduler lease works across Postgres processes', async () => {
    const other = await openDatabase({ backend: 'postgres', url: postgresUrl!, namespace, bootstrap: false })
    const one: SqlDatabase = { driver, dialect: 'postgres', capabilities: driver.capabilities }
    const two: SqlDatabase = { driver: other.sql as PostgresDriver, dialect: 'postgres', capabilities: other.capabilities }
    const first = new LeaderLease(one, { owner: 'lease-one', ttlMs: 60_000, onChange: () => {} })
    const second = new LeaderLease(two, { owner: 'lease-two', ttlMs: 60_000, onChange: () => {} })
    try {
      expect(await first.acquire()).toBe(true)
      expect(await second.acquire()).toBe(false)
      await driver.run("UPDATE _cluster_leases SET expires_at = 0 WHERE name = 'scheduler'")
      expect(await second.acquire()).toBe(true)
      expect(await first.acquire()).toBe(false)
      await second.stop()
      expect(await first.acquire()).toBe(true)
    } finally {
      await second.stop().catch(() => {})
      await other.close()
    }
  })

  test('shared rate limits store millisecond windows in Postgres bigint columns', async () => {
    const handle: SqlDatabase = { driver, dialect: 'postgres', capabilities: driver.capabilities }
    const limiter = new RateLimiter(handle)
    const key = `pg-limit-${suffix}`
    await limiter.hit(key, 2, 60)
    await limiter.hit(key, 2, 60)
    await expect(limiter.hit(key, 2, 60)).rejects.toBeDefined()
    const row = await driver.get<{ reset_at: string | number }>('SELECT reset_at FROM _rate_limits WHERE key = ?', [`rate:${key}`])
    expect(Number(row?.reset_at)).toBeGreaterThan(Date.now())
  })

  test('drops the scratch schema', async () => {
    await database.close()
    const cleanup = await openDatabase({ backend: 'postgres', url: postgresUrl!, bootstrap: false })
    await (cleanup.sql as PostgresDriver).exec(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`)
    await cleanup.close()
  })
})
