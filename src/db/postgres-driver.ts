/**
 * A Postgres driver on Bun's built-in SQL client.
 *
 * Statements arrive in Bunwrite's portable SQLite-flavoured form and are
 * translated by `dialect.ts` before they reach the server. Parameters are
 * copied per call because Bun does not retain them.
 *
 * Bun's client keeps a connection pool; `transaction()` reserves one connection
 * for the whole callback, so the statements inside a transaction never land on
 * a different session.
 */
import { SQL } from 'bun'

import { postgresDialect } from './dialect'
import {
  capabilitiesOf,
  DatabaseConnectionError,
  type Bindings,
  type DriverCapabilities,
  type ExecuteResult,
  type SqlDriver,
  type SqlExecutor,
  type SqlTransaction,
} from './driver'

export interface PostgresDriverOptions {
  /** `postgres://user:pass@host:5432/db` */
  url: string
  /** Pool connections. Default 10. */
  max?: number
  /** Close idle connections after this many seconds. Default 30. */
  idleTimeoutSeconds?: number
  /** Give up opening a connection after this many seconds. Default 30. */
  connectionTimeoutSeconds?: number
  /** TLS: `true`, `false`, or a CA bundle path/contents object passed to Bun. */
  tls?: boolean | { ca?: string | Uint8Array; rejectUnauthorized?: boolean } | string | Uint8Array
  /** Schema search path; defaults to `public`. */
  schema?: string
  /** Optional hook for slow-query logging. */
  onQuery?: (sql: string, durationMs: number) => void
}

const SAVEPOINT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const postgresCapabilities = capabilitiesOf({
  dialect: 'postgres',
  sql: true,
  transactions: true,
  savepoints: true,
  returning: true,
  ddl: true,
  localFile: false,
  drizzleMigrations: false,
  fullTextSearch: 'tsvector',
  cacheTriggers: true,
  eventBus: true,
  snapshots: false,
})

/** Rows returned by Bun's SQL client carry non-enumerable result metadata. */
type BunRows<T> = T[] & { count?: number; affectedRows?: number; command?: string }

export class PostgresDriver implements SqlDriver {
  readonly kind = 'sql' as const
  readonly dialect = 'postgres' as const
  readonly capabilities: DriverCapabilities = postgresCapabilities

  readonly client: SQL
  private readonly onQuery?: (sql: string, durationMs: number) => void
  private readonly schema: string
  private closed = false

  constructor(options: PostgresDriverOptions) {
    this.onQuery = options.onQuery
    this.schema = options.schema ?? 'public'
    this.client = new SQL({
      url: options.url,
      max: options.max ?? 10,
      idleTimeout: options.idleTimeoutSeconds ?? 30,
      connectionTimeout: options.connectionTimeoutSeconds ?? 30,
      // Every pooled connection needs the search path; a one-off `SET` would
      // only apply to whichever connection served that statement.
      connection: { search_path: this.schema === 'public' ? 'public' : `${this.schema}, public` },
      ...(options.tls !== undefined ? { tls: options.tls as never } : {}),
    })
  }

  private executor(client: SQL): SqlTransaction {
    const run = async (statement: string, params: Bindings = []): Promise<ExecuteResult> => {
      const prepared = postgresDialect.prepare(statement, params)
      const started = performance.now()
      try {
        const result = (await client.unsafe(prepared.text, prepared.params as unknown[])) as BunRows<Record<string, unknown>>
        const rows = Array.isArray(result) ? result : []
        this.onQuery?.(prepared.text, performance.now() - started)
        const first = rows[0] as Record<string, unknown> | undefined
        return {
          changes: Number(result.count ?? result.affectedRows ?? rows.length ?? 0),
          lastInsertId: first && 'seq' in first ? (first.seq as number | string) : null,
        }
      } catch (error) {
        throw this.wrap(error, prepared.text)
      }
    }
    const all = async <T>(statement: string, params: Bindings = []): Promise<T[]> => {
      const prepared = postgresDialect.prepare(statement, params)
      const started = performance.now()
      try {
        const rows = await client.unsafe<T[]>(prepared.text, prepared.params as unknown[])
        this.onQuery?.(prepared.text, performance.now() - started)
        return rows as T[]
      } catch (error) {
        throw this.wrap(error, prepared.text)
      }
    }
    const get = async <T>(statement: string, params: Bindings = []): Promise<T | null> => {
      const rows = await all<T>(statement, params)
      return rows[0] ?? null
    }
    const exec = async (statement: string): Promise<void> => {
      const started = performance.now()
      try {
        await client.unsafe(statement)
        this.onQuery?.(statement, performance.now() - started)
      } catch (error) {
        throw this.wrap(error, statement)
      }
    }
    const savepoint = async <T>(name: string, fn: (tx: SqlTransaction) => Promise<T>): Promise<T> => {
      const safe = SAVEPOINT_NAME.test(name) ? name : `bunwrite_sp_${Date.now()}`
      await client.unsafe(`SAVEPOINT "${safe}"`)
      try {
        const value = await fn(tx)
        await client.unsafe(`RELEASE SAVEPOINT "${safe}"`)
        return value
      } catch (error) {
        try {
          await client.unsafe(`ROLLBACK TO SAVEPOINT "${safe}"`)
          await client.unsafe(`RELEASE SAVEPOINT "${safe}"`)
        } catch {
          // The session is no longer in a usable state; the outer transaction reports it.
        }
        throw error
      }
    }
    const tx: SqlTransaction = { all, get, run, exec, savepoint }
    return tx
  }

  private wrap(error: unknown, statement: string): unknown {
    const code = String((error as { code?: unknown })?.code ?? '')
    const errno = String((error as { errno?: unknown })?.errno ?? '')
    if (
      ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '57P02', '57P03', '08006', '08001'].some(
        (value) => value === code || value === errno || code.endsWith(value),
      )
    ) {
      return new DatabaseConnectionError(`Could not reach Postgres while running: ${statement.slice(0, 160)}`, error)
    }
    return error
  }

  all<T = Record<string, unknown>>(sql: string, params?: Bindings): Promise<T[]> {
    return this.executor(this.client).all<T>(sql, params)
  }

  get<T = Record<string, unknown>>(sql: string, params?: Bindings): Promise<T | null> {
    return this.executor(this.client).get<T>(sql, params)
  }

  run(sql: string, params?: Bindings): Promise<ExecuteResult> {
    return this.executor(this.client).run(sql, params)
  }

  exec(sql: string): Promise<void> {
    return this.executor(this.client).exec(sql)
  }

  async transaction<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> {
    try {
      return (await this.client.begin(async (client) => fn(this.executor(client)))) as T
    } catch (error) {
      throw error instanceof DatabaseConnectionError ? error : this.wrap(error, 'transaction')
    }
  }

  /** Verify the connection and the schema search path. */
  async ping(): Promise<void> {
    await this.all(`SELECT 1 AS ok`)
  }

  /** Create the schema when it is not public and it does not exist yet. */
  async ensureSchema(): Promise<void> {
    if (this.schema === 'public') return
    const name = this.schema.replace(/"/g, '""')
    await this.exec(`CREATE SCHEMA IF NOT EXISTS "${name}"`)
  }

  /** Column/table metadata used by `postgres-schema.ts` to migrate safely. */
  async tableExists(name: string): Promise<boolean> {
    const row = await this.get<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2
       ) AS exists`,
      [this.schema, name],
    )
    return Boolean(row?.exists)
  }

  /** Run a `LISTEN`-based notification, used by the realtime bus on Postgres. */
  listen(channel: string, onNotify: (payload: string) => void): Promise<() => Promise<void>> {
    return this.client.listen(channel, onNotify).then((subscription) => () => subscription.unlisten())
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.client.close({ timeout: 5 })
  }
}

export const createPostgresDriver = (options: PostgresDriverOptions): PostgresDriver => new PostgresDriver(options)

export type { SqlExecutor }
