import { afterEach, describe, expect, test } from 'bun:test'

import { VersionMonitor } from '~/cluster/versions'
import { openDb, type Db } from '~/db/connection'
import { now } from '~/lib/datetime'
import { sha256 } from '~/lib/ids'
import { apiKeyValid } from '~/settings/service'
import { testConfig } from './helpers'

const databases: Db[] = []

function memory(): Db {
  const db = openDb(':memory:')
  databases.push(db)
  return db
}

function insertKey(db: Db, secret: string, expire: string | null = null): void {
  const stamp = now()
  db.sqlite
    .query(
      `INSERT INTO _api_keys (id, name, secret_hash, hint, expire, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('key-1', 'Test key', sha256(secret), secret.slice(0, 16), expire, stamp, stamp)
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.sqlite.close()
    } catch {
      /* already closed */
    }
  }
})

describe('shared cache versions', () => {
  test('poll reports auth and key counters without a second meta read', () => {
    const db = memory()
    const monitor = new VersionMonitor(db, 0)

    expect(monitor.poll()).toEqual({
      schema: false,
      settings: false,
      catalog: false,
      projects: false,
      auth: false,
      keys: false,
    })

    insertKey(db, 'standard_cached')
    const changed = monitor.poll()
    expect(changed.keys).toBe(true)
    expect(changed.auth).toBe(false)
    expect(monitor.keysVersion()).toBe(1)

    db.sqlite.query("UPDATE _meta SET value = value + 1 WHERE key = 'auth'").run()
    expect(monitor.poll().auth).toBe(true)
    expect(monitor.authVersion()).toBe(1)
    expect(monitor.version('auth')).toBe(monitor.authVersion())
  })

  test('a DB-backed API key is cached and invalidated by the keys counter', () => {
    const db = memory()
    const config = testConfig({ apiKeys: [], internalKey: undefined })
    const versions = new VersionMonitor(db, 0)
    const secret = 'standard_cached_key'

    insertKey(db, secret)
    expect(apiKeyValid(db, config, secret, versions)).toBe(true)

    // The in-memory result stays valid until the poll sees the trigger.
    db.sqlite.query('DELETE FROM _api_keys WHERE id = ?').run('key-1')
    expect(apiKeyValid(db, config, secret, versions)).toBe(true)

    versions.poll()
    expect(apiKeyValid(db, config, secret, versions)).toBe(false)
  })

  test('expired and unknown keys are rejected', () => {
    const db = memory()
    const config = testConfig({ apiKeys: ['env-key'], internalKey: undefined })
    const versions = new VersionMonitor(db, 0)

    insertKey(db, 'standard_expired', '2000-01-01T00:00:00.000Z')
    expect(apiKeyValid(db, config, 'standard_expired', versions)).toBe(false)
    expect(apiKeyValid(db, config, 'standard_missing', versions)).toBe(false)

    // Environment keys bypass the table and the cache entirely.
    expect(apiKeyValid(db, config, 'env-key', versions)).toBe(true)
  })
})
