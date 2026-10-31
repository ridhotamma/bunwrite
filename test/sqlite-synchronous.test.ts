import { afterEach, describe, expect, test } from 'bun:test'

import { openDb, type Db } from '~/db/connection'
import { SettingsService } from '~/settings/service'
import { testConfig } from './helpers'

const databases: Db[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.sqlite.close()
})

const synchronousOf = (db: Db) => (db.sqlite.query('PRAGMA synchronous').get() as { synchronous: number }).synchronous

describe('SQLite synchronous mode', () => {
  test('defaults to NORMAL', () => {
    const db = openDb(':memory:')
    databases.push(db)
    expect(synchronousOf(db)).toBe(1)
  })

  test('uses FULL when requested', () => {
    const db = openDb(':memory:', 16, 0, 1000, 0, 'FULL')
    databases.push(db)
    expect(synchronousOf(db)).toBe(2)
  })

  test('a stored project setting overrides the environment default on open', () => {
    const db = openDb(':memory:', 16, 0, 1000, 0, 'NORMAL')
    databases.push(db)
    db.sqlite
      .query('INSERT INTO _settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('database', JSON.stringify({ synchronous: 'FULL' }), new Date().toISOString())

    const config = testConfig({ sqliteSynchronous: 'NORMAL' })
    new SettingsService(db, config)

    expect(config.sqliteSynchronous).toBe('FULL')
    expect(synchronousOf(db)).toBe(2)
  })
})
