/**
 * An async port over `bun:sqlite`.
 *
 * SQLite itself is synchronous, so every method here finishes before it
 * returns a promise. That keeps the semantics of the existing synchronous path
 * (one request's database work never interleaves with another's) while giving
 * callers the same async shape as Postgres.
 *
 * Transactions are the exception: an async callback may await work outside the
 * database, so a lock serialises transactions on this driver. Statements
 * outside a transaction still run immediately.
 */
import type { Database, SQLQueryBindings } from 'bun:sqlite'

import { busyBackoff, isBusyError } from './errors'
import { sqliteDialect } from './dialect'
import {
  capabilitiesOf,
  type Bindings,
  type DriverCapabilities,
  type ExecuteResult,
  type SqlDriver,
  type SqlTransaction,
} from './driver'

export interface SqliteDriverOptions {
  /** The connection to wrap. The driver never closes it unless `close()` is called. */
  db: Database
  /** Retries when SQLite reports SQLITE_BUSY/SQLITE_LOCKED. Default 5. */
  busyAttempts?: number
}

/** Serialises async transactions on one connection. */
class Mutex {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const ticket = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.tail
    this.tail = previous.then(() => ticket).catch(() => ticket)
    await previous.catch(() => undefined)
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

const SAVEPOINT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `bun:sqlite` reports a bigint when the value exceeds `Number.MAX_SAFE_INTEGER`. */
const normalizeRowId = (value: number | bigint | null | undefined): number | null =>
  value === null || value === undefined ? null : typeof value === 'bigint' ? Number(value) : value

const sqliteCapabilities = capabilitiesOf({
  dialect: 'sqlite',
  sql: true,
  transactions: true,
  savepoints: true,
  returning: true,
  ddl: true,
  localFile: true,
  drizzleMigrations: true,
  fullTextSearch: 'fts5',
  cacheTriggers: true,
  eventBus: true,
  snapshots: true,
})

export class SqliteDriver implements SqlDriver {
  readonly kind = 'sql' as const
  readonly dialect = 'sqlite' as const
  readonly capabilities: DriverCapabilities = sqliteCapabilities

  /** The underlying `bun:sqlite` connection, for SQLite-only operations (backups, PRAGMAs). */
  readonly raw: Database

  private readonly mutex = new Mutex()
  private readonly busyAttempts: number
  private depth = 0
  private savepointSeq = 0

  constructor(options: SqliteDriverOptions) {
    this.raw = options.db
    this.busyAttempts = Math.max(1, Math.round(options.busyAttempts ?? 5))
  }

  private async retry<T>(fn: () => T): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return fn()
      } catch (error) {
        if (attempt + 1 >= this.busyAttempts || !isBusyError(error)) throw error
        await Bun.sleep(busyBackoff(attempt))
      }
    }
  }

  /** A statement executor that does not retry (used inside a transaction). */
  private executor(): SqlTransaction {
    const all = async <T>(sql: string, params: Bindings = []): Promise<T[]> => {
      const statement = sqliteDialect.prepare(sql, params)
      return this.raw.query(statement.text).all(...(statement.params as SQLQueryBindings[])) as T[]
    }
    const get = async <T>(sql: string, params: Bindings = []): Promise<T | null> => {
      const statement = sqliteDialect.prepare(sql, params)
      return (this.raw.query(statement.text).get(...(statement.params as SQLQueryBindings[])) as T | null) ?? null
    }
    const run = async (sql: string, params: Bindings = []): Promise<ExecuteResult> => {
      const statement = sqliteDialect.prepare(sql, params)
      const result = this.raw.query(statement.text).run(...(statement.params as SQLQueryBindings[]))
      return { changes: Number(result.changes ?? 0), lastInsertId: normalizeRowId(result.lastInsertRowid) }
    }
    const exec = async (sql: string): Promise<void> => {
      this.raw.exec(sql)
    }
    const savepoint = async <T>(name: string, fn: (tx: SqlTransaction) => Promise<T>): Promise<T> => {
      if (this.depth === 0) return this.transaction(fn)
      const safe = SAVEPOINT_NAME.test(name) ? name : `bunwrite_sp_${++this.savepointSeq}`
      this.raw.run(`SAVEPOINT "${safe}"`)
      try {
        const value = await fn(tx)
        this.raw.run(`RELEASE SAVEPOINT "${safe}"`)
        return value
      } catch (error) {
        try {
          this.raw.run(`ROLLBACK TO SAVEPOINT "${safe}"`)
          this.raw.run(`RELEASE SAVEPOINT "${safe}"`)
        } catch {
          // The transaction is unusable; the outer rollback will report it.
        }
        throw error
      }
    }
    const tx: SqlTransaction = { all, get, run, exec, savepoint }
    return tx
  }

  all<T = Record<string, unknown>>(sql: string, params?: Bindings): Promise<T[]> {
    return this.retry(() => {
      const statement = sqliteDialect.prepare(sql, params)
      return this.raw.query(statement.text).all(...(statement.params as SQLQueryBindings[])) as T[]
    })
  }

  get<T = Record<string, unknown>>(sql: string, params?: Bindings): Promise<T | null> {
    return this.retry(() => {
      const statement = sqliteDialect.prepare(sql, params)
      return (this.raw.query(statement.text).get(...(statement.params as SQLQueryBindings[])) as T | null) ?? null
    })
  }

  run(sql: string, params?: Bindings): Promise<ExecuteResult> {
    return this.retry(() => {
      const statement = sqliteDialect.prepare(sql, params)
      const result = this.raw.query(statement.text).run(...(statement.params as SQLQueryBindings[]))
      return { changes: Number(result.changes ?? 0), lastInsertId: normalizeRowId(result.lastInsertRowid) }
    })
  }

  exec(sql: string): Promise<void> {
    return this.retry(() => {
      this.raw.exec(sql)
    })
  }

  async transaction<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> {
    // A nested call is a savepoint, not a second BEGIN.
    if (this.depth > 0) return this.executor().savepoint(`bunwrite_sp_${++this.savepointSeq}`, fn)
    return this.mutex.run(async () => {
      const tx = this.executor()
      await this.retry(() => this.raw.run('BEGIN IMMEDIATE'))
      this.depth++
      try {
        const value = await fn(tx)
        await this.retry(() => this.raw.run('COMMIT'))
        return value
      } catch (error) {
        try {
          this.raw.run('ROLLBACK')
        } catch {
          // Nothing to roll back (SQLite already closed the transaction).
        }
        throw error
      } finally {
        this.depth--
      }
    })
  }

  async ping(): Promise<void> {
    await this.get('SELECT 1 AS ok')
  }

  async close(): Promise<void> {
    this.raw.close()
  }
}

export const createSqliteDriver = (options: SqliteDriverOptions): SqliteDriver => new SqliteDriver(options)
