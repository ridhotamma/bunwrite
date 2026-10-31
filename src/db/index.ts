/**
 * Database selection.
 *
 * `openDatabase` is the only place that knows how a backend is configured.
 * Everything below it speaks the `src/db/driver.ts` port. SQLite remains the
 * default so an existing deployment keeps its zero-config file; Postgres and
 * MongoDB are opt-in through `DB_DRIVER` + `DATABASE_URL` (see docs/DATABASE.md).
 *
 * SQLite is synchronous under the port, so the existing `Db.sqlite` fast path
 * keeps working while services migrate to `db.driver`.
 */
import { openDb, type Db } from './connection'
import type { DatabaseBackend, Dialect, DocumentDriver, DriverCapabilities, SqlDriver } from './driver'
import { parseDatabaseBackend } from './driver'
import { MongoDriver } from './mongo-driver'
import { ensureMongoSchema } from './mongo-schema'
import { PostgresDriver } from './postgres-driver'
import { ensurePostgresSchema } from './postgres-schema'

export type { DatabaseBackend } from './driver'

export const DATABASE_BACKENDS: readonly DatabaseBackend[] = ['sqlite', 'postgres', 'mongodb']

export { parseDatabaseBackend }

export interface DatabaseOptions {
  backend: DatabaseBackend
  /** SQLite file path. Ignored by the network backends. */
  path?: string
  /** Postgres or MongoDB connection URL. */
  url?: string
  /** Postgres schema or MongoDB database. Defaults per backend. */
  namespace?: string
  /** Pool size for network backends. */
  poolMax?: number
  /** Postgres TLS. */
  ssl?: boolean
  /**
   * Create/upgrade the schema on open. Default true. A read-only replica or a
   * CLI that only inspects data can turn it off.
   */
  bootstrap?: boolean
  log?: (line: string) => void
}

export interface Database {
  backend: DatabaseBackend
  dialect: Dialect
  capabilities: DriverCapabilities
  /** SQL executor for sqlite/postgres; null for MongoDB. */
  sql: SqlDriver | null
  /** Document collections for MongoDB; null for the SQL backends. */
  documents: DocumentDriver | null
  /** The SQLite handle when `backend === 'sqlite'`. */
  sqlite: Db | null
  close(): Promise<void>
  ping(): Promise<void>
}

/** The options a `Config` implies. Exported for the CLI and tests. */
export function databaseOptionsOf(config: {
  databaseDriver?: DatabaseBackend
  databaseUrl?: string
  databaseNamespace?: string
  databasePoolMax?: number
  databaseSsl?: boolean
  databasePath: string
}): DatabaseOptions {
  const backend = config.databaseDriver ?? parseDatabaseBackend(undefined, config.databaseUrl)
  return {
    backend,
    path: config.databasePath,
    url: config.databaseUrl,
    namespace: config.databaseNamespace,
    poolMax: config.databasePoolMax,
    ssl: config.databaseSsl,
  }
}

/** Wrap the existing synchronous SQLite connection in the async port. */
export function sqliteDatabase(db: Db): Database {
  return {
    backend: 'sqlite',
    dialect: 'sqlite',
    capabilities: db.capabilities,
    sql: db.driver,
    documents: null,
    sqlite: db,
    close: async () => {
      await db.driver.close()
    },
    ping: () => db.driver.ping(),
  }
}

/** Open the configured backend and make sure its schema exists. */
export async function openDatabase(options: DatabaseOptions): Promise<Database> {
  const log = options.log ?? (() => {})
  const bootstrap = options.bootstrap !== false

  if (options.backend === 'sqlite') {
    // `openDb` runs the Drizzle migrations and the cluster schema, exactly as
    // the SQLite-only build always has.
    const db = openDb(options.path ?? './data/bunwrite.sqlite')
    return sqliteDatabase(db)
  }

  const url = options.url
  if (!url) {
    throw new Error(`DATABASE_URL is required when DB_DRIVER=${options.backend}.`)
  }

  if (options.backend === 'postgres') {
    const driver = new PostgresDriver({
      url,
      max: options.poolMax,
      tls: options.ssl,
      schema: options.namespace,
    })
    try {
      await driver.ping()
      if (bootstrap) await ensurePostgresSchema(driver, { log })
      log(`connected to postgres (${driver.capabilities.dialect})`)
    } catch (error) {
      await driver.close().catch(() => {})
      throw error
    }
    return {
      backend: 'postgres',
      dialect: 'postgres',
      capabilities: driver.capabilities,
      sql: driver,
      documents: null,
      sqlite: null,
      close: () => driver.close(),
      ping: () => driver.ping(),
    }
  }

  const driver = await MongoDriver.open({
    url,
    database: options.namespace ?? 'bunwrite',
    maxPoolSize: options.poolMax,
  })
  try {
    if (bootstrap) await ensureMongoSchema(driver, { log })
    log(`connected to mongodb (${driver.capabilities.dialect})`)
  } catch (error) {
    await driver.close().catch(() => {})
    throw error
  }
  return {
    backend: 'mongodb',
    dialect: 'mongodb',
    capabilities: driver.capabilities,
    sql: null,
    documents: driver,
    sqlite: null,
    close: () => driver.close(),
    ping: () => driver.ping(),
  }
}

/** Short human-readable description for logs and `bunwrite db:check`. */
export function describeDatabase(database: Pick<Database, 'backend' | 'capabilities'>): string {
  const caps = database.capabilities
  const features = [
    caps.sql ? 'sql' : 'documents',
    caps.transactions ? 'transactions' : 'no transactions',
    caps.savepoints ? 'savepoints' : 'no savepoints',
    caps.localFile ? 'local file' : 'network',
    caps.fullTextSearch === 'none' ? 'no full-text' : `full-text:${caps.fullTextSearch}`,
  ]
  return `${database.backend} (${features.join(', ')})`
}

export type { Db } from './connection'
export type {
  Bindings,
  DocumentCollection,
  DocumentDriver,
  DocumentFilter,
  DriverCapabilities,
  SqlDriver,
  SqlExecutor,
  SqlTransaction,
} from './driver'
export { DatabaseConnectionError, UnsupportedFeatureError, uniqueViolation } from './driver'
export { PostgresDriver } from './postgres-driver'
export { MongoDriver } from './mongo-driver'
export { SqliteDriver } from './sqlite-driver'
export { dialectAdapter, postgresDialect, sqliteDialect, toPostgres } from './dialect'
export { ensurePostgresSchema } from './postgres-schema'
export { ensureMongoSchema } from './mongo-schema'
