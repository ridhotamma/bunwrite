import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isBusyError, openDb, withBusyRetry, type Db } from '~/db/connection'

const dirs: string[] = []
const databases: Db[] = []
const children: Array<ReturnType<typeof Bun.spawn>> = []

const busy = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY', errno: 5 })

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill()
    } catch {
      /* already exited */
    }
  }
  for (const db of databases.splice(0)) {
    try {
      db.sqlite.close()
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('busy errors', () => {
  test('recognizes SQLITE_BUSY, SQLITE_LOCKED and their messages', () => {
    expect(isBusyError(busy())).toBe(true)
    expect(isBusyError(Object.assign(new Error('x'), { code: 'SQLITE_LOCKED', errno: 6 }))).toBe(true)
    expect(isBusyError(Object.assign(new Error('x'), { errno: 5 }))).toBe(true)
    expect(isBusyError(new Error('database is locked'))).toBe(true)
    expect(isBusyError(new Error('no such table: nope'))).toBe(false)
    expect(isBusyError(null)).toBe(false)
  })

  test('retries only busy failures', () => {
    let calls = 0
    const value = withBusyRetry(
      () => {
        calls++
        if (calls < 3) throw busy()
        return 'ok'
      },
      { baseDelayMs: 0 },
    )
    expect(value).toBe('ok')
    expect(calls).toBe(3)

    let plain = 0
    expect(() =>
      withBusyRetry(() => {
        plain++
        throw new Error('no such column')
      }),
    ).toThrow('no such column')
    expect(plain).toBe(1)
  })

  test('stops at the attempt budget and when canRetry says so', () => {
    let calls = 0
    expect(() => withBusyRetry(() => {
      calls++
      throw busy()
    }, { attempts: 3, baseDelayMs: 0 })).toThrow()
    expect(calls).toBe(3)

    calls = 0
    expect(() => withBusyRetry(() => {
      calls++
      throw busy()
    }, { attempts: 5, baseDelayMs: 0, canRetry: () => false })).toThrow()
    expect(calls).toBe(1)
  })

  test('does not retry once a transaction callback has started', () => {
    const db = openDb(':memory:')
    databases.push(db)
    let calls = 0
    expect(() =>
      db.sqlite
        .transaction(() => {
          calls++
          throw busy()
        })
        .immediate(),
    ).toThrow()
    expect(calls).toBe(1)
  })

  test('a transaction waits out a lock held by another process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunwrite-busy-'))
    dirs.push(dir)
    const path = join(dir, 'busy.sqlite')
    const marker = join(dir, 'locked')
    // busy_timeout is 0, so only the wrapper can wait for the other process.
    const db = openDb(path, 16, 0, 1000, 0)
    databases.push(db)
    db.sqlite.run('CREATE TABLE IF NOT EXISTS retry_test (value TEXT)')

    const script = join(dir, 'locker.ts')
    await Bun.write(
      script,
      `import { Database } from 'bun:sqlite'
const [path, marker] = process.argv.slice(2)
const db = new Database(path)
db.run('PRAGMA busy_timeout = 0')
db.run('BEGIN IMMEDIATE')
await Bun.write(marker, '1')
await Bun.sleep(80)
db.run("INSERT INTO retry_test (value) VALUES ('child')")
db.run('COMMIT')
db.close()
`,
    )

    const child = Bun.spawn([process.execPath, script, path, marker], { stdout: 'pipe', stderr: 'pipe' })
    children.push(child)
    const deadline = Date.now() + 5_000
    while (!existsSync(marker) && Date.now() < deadline) Bun.sleepSync(5)
    expect(existsSync(marker)).toBe(true)

    db.sqlite.transaction(() => db.sqlite.run("INSERT INTO retry_test (value) VALUES ('parent')")).immediate()
    await child.exited

    const count = db.sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM retry_test').get()
    expect(count?.n).toBe(2)
  })
})
