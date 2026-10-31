import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

/**
 * Hot reads use `db.query()` throughout (documents, `_meta`, sessions, API
 * keys). Bun caches the compiled statement per Database, so these paths do not
 * recompile SQL per request. Keep this assumption visible: a future change to
 * `prepare()` on a hot path would be explicit and needs its own lifecycle.
 */
describe('prepared statement reuse', () => {
  test('Database.query returns the cached statement for the same SQL', () => {
    const db = new Database(':memory:')
    try {
      const first = db.query('SELECT 1 AS n')
      const second = db.query('SELECT 1 AS n')
      expect(first).toBe(second)
      expect(first.get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })
})
