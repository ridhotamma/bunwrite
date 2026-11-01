import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { keyCaller, sessionCaller } from '~/auth/caller'
import { openDb, type Db } from '~/db/connection'
import { DocumentStore } from '~/documents/store'
import { FailedAttempts, pruneRateLimits, RateLimiter } from '~/lib/limits'
import { Registry } from '~/schema/registry'
import { pushConfig } from '~/schema/push'
import { createServices } from '~/services'
import { testConfig, testSchema } from './helpers'

const dirs: string[] = []
const databases: Db[] = []

function tempDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bunwrite-cache-'))
  dirs.push(dir)
  return join(dir, 'bunwrite.sqlite')
}

function open(path: string): Db {
  const db = openDb(path)
  databases.push(db)
  return db
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

describe('shared rate limits', () => {
  test('two workers count into the same window', async () => {
    const path = tempDatabase()
    const one = new RateLimiter(open(path))
    const two = new RateLimiter(open(path))

    await one.hit('login:127.0.0.1', 2, 60)
    await two.hit('login:127.0.0.1', 2, 60)
    await expect(one.hit('login:127.0.0.1', 2, 60)).rejects.toThrow()
    await expect(two.hit('login:127.0.0.1', 2, 60)).rejects.toThrow()
  })

  test('failed token attempts are shared too', async () => {
    const path = tempDatabase()
    const one = new FailedAttempts(open(path), 2)
    const two = new FailedAttempts(open(path), 2)

    expect(await one.fail('u1')).toBe(false)
    expect(await two.fail('u1')).toBe(true)
    await one.clear('u1')
    expect(await two.fail('u1')).toBe(false)
  })

  test('expired windows are pruned', async () => {
    const path = tempDatabase()
    const db = open(path)
    await new RateLimiter(db).hit('login', 5, 60)
    db.sqlite.query('UPDATE _rate_limits SET reset_at = 0').run()
    await pruneRateLimits(db)
    expect((db.sqlite.query('SELECT count(*) AS n FROM _rate_limits').get() as { n: number }).n).toBe(0)
  })
})

describe('document cache invalidation', () => {
  test('a write on one connection invalidates another connection’s list cache', async () => {
    const path = tempDatabase()
    const writerDb = open(path)
    pushConfig(writerDb, testSchema)
    const readerDb = open(path)
    const writer = new DocumentStore(writerDb)
    const reader = new DocumentStore(readerDb)
    const writerCollection = new Registry(writerDb).collection('main', 'products', true)
    const readerCollection = new Registry(readerDb).collection('main', 'products', true)
    const caller = keyCaller()

    await writer.createDocument(caller, writerCollection, { id: 'one', data: { tenantId: 't', name: 'One' }, permissions: [] })
    expect((await reader.listDocuments(caller, readerCollection, [], true)).total).toBe(1)
    // Warm the reader's cache, then write elsewhere.
    expect((await reader.listDocuments(caller, readerCollection, [], true)).total).toBe(1)

    await writer.createDocument(caller, writerCollection, { id: 'two', data: { tenantId: 't', name: 'Two' }, permissions: [] })
    const afterCreate = await reader.listDocuments(caller, readerCollection, [], true)
    expect(afterCreate.total).toBe(2)

    await writer.updateDocument(caller, writerCollection, 'one', { name: 'One updated' }, null)
    const afterUpdate = await reader.listDocuments(caller, readerCollection, [], true)
    expect(afterUpdate.documents.find((doc) => doc.$id === 'one')!.name).toBe('One updated')

    await writer.deleteDocument(caller, writerCollection, 'two')
    expect((await reader.listDocuments(caller, readerCollection, [], true)).total).toBe(1)
  })
})

describe('session cache', () => {
  test('roles and revocation are visible to another connection on the next request', async () => {
    const path = tempDatabase()
    const servicesA = createServices(testConfig({ databasePath: path }), open(path))
    const servicesB = createServices(testConfig({ databasePath: path }), open(path))
    const dbA = servicesA.db
    const dbB = servicesB.db

    const user = await servicesA.auth.createUser({ id: 'u1', email: 'u1@example.com', name: 'U', emailVerification: true })
    const { session, secret } = await servicesA.auth.createSession(user.id, {
      provider: 'email',
      factors: [],
      info: { ip: '127.0.0.1', userAgent: 'test' },
    })

    // Warm both caches.
    expect((await sessionCaller(dbA, secret))!.roles.has('user:u1')).toBe(true)
    expect((await sessionCaller(dbB, secret))!.roles.has('users/verified')).toBe(true)

    await servicesA.teams.create(keyCaller(), { teamId: 't1', name: 'Team', roles: [] })
    await servicesA.teams.createMembership(keyCaller(), 't1', { userId: 'u1', roles: ['manager'] })
    const withTeam = (await sessionCaller(dbB, secret))!
    expect(withTeam.roles.has('team:t1')).toBe(true)
    expect(withTeam.roles.has('team:t1/manager')).toBe(true)

    await servicesA.auth.updateUser('u1', { status: 0 })
    expect((await sessionCaller(dbB, secret))!.user!.status).toBeFalsy()

    await servicesA.auth.deleteSession('u1', session.id)
    expect(await sessionCaller(dbB, secret)).toBeNull()
  })
})
