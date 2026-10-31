import { afterAll, describe, expect, test } from 'bun:test'

import { openDatabase, parseDatabaseBackend, describeDatabase, sqliteDatabase } from '~/db'
import { configFromEnv } from '~/config'
import { openDb } from '~/db/connection'
import { toPostgres } from '~/db/dialect'
import { uniqueViolation, UnsupportedFeatureError } from '~/db/driver'
import {
  postgresDocumentIndexStatements,
  postgresDocumentTableStatements,
  postgresSystemStatements,
} from '~/db/postgres-schema'
import type { MongoDriver } from '~/db/mongo-driver'
import type { PostgresDriver } from '~/db/postgres-driver'

const sqlite = openDb(':memory:')
afterAll(() => sqlite.sqlite.close())

describe('backend selection', () => {
  test('infers the backend from the URL, with an explicit driver winning', () => {
    expect(parseDatabaseBackend(undefined, 'postgres://u:p@h/db')).toBe('postgres')
    expect(parseDatabaseBackend(undefined, 'postgresql://u:p@h/db')).toBe('postgres')
    expect(parseDatabaseBackend(undefined, 'mongodb+srv://u:p@h/db')).toBe('mongodb')
    expect(parseDatabaseBackend(undefined, './data/bunwrite.sqlite')).toBe('sqlite')
    expect(parseDatabaseBackend('pg', 'mongodb://h/db')).toBe('postgres')
    expect(parseDatabaseBackend('mongo', undefined)).toBe('mongodb')
    expect(() => parseDatabaseBackend('mysql', undefined)).toThrow()
  })

  test('DB_DRIVER is the switch; a stray DATABASE_URL never moves the server off SQLite', () => {
    expect(configFromEnv({ DATABASE_URL: 'postgres://h/db' }).databaseDriver).toBe('sqlite')
    expect(configFromEnv({ DB_DRIVER: 'postgres', DATABASE_URL: 'postgres://h/db' }).databaseDriver).toBe('postgres')
    expect(configFromEnv({ DB_DRIVER: 'mongo' }).databaseDriver).toBe('mongodb')
    expect(configFromEnv({ DB_DRIVER: 'postgres', DATABASE_SCHEMA: 'app' }).databaseNamespace).toBe('app')
  })

  test('describes capabilities without pretending Mongo speaks SQL', () => {
    expect(describeDatabase({ backend: 'postgres', capabilities: { ...sqlite.capabilities, dialect: 'postgres' } })).toContain('sql')
    expect(sqlite.capabilities.fullTextSearch).toBe('fts5')
    expect(sqlite.capabilities.localFile).toBe(true)
    expect(sqliteDatabase(sqlite).dialect).toBe('sqlite')
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

  test('recognises unique violations from every backend', () => {
    expect(uniqueViolation(new Error('UNIQUE constraint failed: _users.id'))).not.toBeNull()
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "x"'), { errno: '23505' })
    expect(uniqueViolation(pg)?.constraint).toBe('x')
    expect(uniqueViolation(Object.assign(new Error('E11000 duplicate key error collection: db.users index: id_1 dup key'), { code: 11000 }))).not.toBeNull()
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
const mongoUrl = process.env.BUNWRITE_TEST_MONGO_URL
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

  test('drops the scratch schema', async () => {
    await database.close()
    const cleanup = await openDatabase({ backend: 'postgres', url: postgresUrl!, bootstrap: false })
    await (cleanup.sql as PostgresDriver).exec(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`)
    await cleanup.close()
  })
})

describe.skipIf(!mongoUrl)('mongodb driver (integration)', () => {
  const namespace = `bunwrite_test_${suffix}`
  let database: Awaited<ReturnType<typeof openDatabase>>
  let driver: MongoDriver

  test('bootstraps indexes and stores documents', async () => {
    database = await openDatabase({ backend: 'mongodb', url: mongoUrl!, namespace })
    driver = database.documents as MongoDriver
    const users = driver.collection('_users')
    await users.insert({ id: 'u1', name: 'User', email: 'u1@example.com' })
    expect(await users.findOne({ id: 'u1' })).toMatchObject({ name: 'User' })
    await users.update({ id: 'u1' }, { name: 'Changed' })
    expect(await users.findOne({ id: 'u1' })).toMatchObject({ name: 'Changed' })
    expect((await users.upsert({ id: 'u2' }, { id: 'u2', name: 'Two' })).created).toBe(true)
    expect((await users.upsert({ id: 'u2' }, { id: 'u2', name: 'Two!' })).created).toBe(false)
    expect(await driver.nextSequence('products')).toBe(1)
    expect(await driver.nextSequence('products')).toBe(2)
    // The unique `id` index created by the bootstrap rejects a duplicate.
    await expect(users.insert({ id: 'u1', name: 'Dup' })).rejects.toBeDefined()
  })

  test('drops the scratch database', async () => {
    await driver.database.command({ dropDatabase: 1 })
    await database.close()
  })
})
