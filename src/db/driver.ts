/**
 * The database port.
 *
 * Bunwrite was built around `bun:sqlite`, whose API is synchronous. Network
 * databases (Postgres, MongoDB) are asynchronous, so the port below is async
 * and is meant to replace direct `db.sqlite` access module by module. The
 * existing synchronous SQLite path stays available through `Db.sqlite` while a
 * service is being migrated; see docs/DATABASE.md for the seam and the
 * migration order.
 *
 * Everything the port accepts is *portable SQLite-flavoured SQL*: `?`
 * placeholders, double-quoted identifiers, ISO strings for dates and JSON text
 * for objects. A driver is responsible for adapting that to its own dialect.
 */

export type Dialect = 'sqlite' | 'postgres' | 'mongodb'
export type SqlDialect = Extract<Dialect, 'sqlite' | 'postgres'>

/** The storage engines Bunwrite can run on. */
export type DatabaseBackend = Dialect

/**
 * Normalize `DB_DRIVER`/`DATABASE_DRIVER`, or infer the backend from the
 * connection URL. An explicit driver always wins over the URL scheme.
 */
export function parseDatabaseBackend(value: string | undefined, url?: string): DatabaseBackend {
  const raw = (value ?? '').trim().toLowerCase()
  if (raw) {
    if (raw === 'sqlite' || raw === 'sqlite3' || raw === 'file') return 'sqlite'
    if (raw === 'postgres' || raw === 'postgresql' || raw === 'pg') return 'postgres'
    if (raw === 'mongodb' || raw === 'mongo') return 'mongodb'
    throw new Error(`Unknown database driver "${value}". Use sqlite, postgres or mongodb.`)
  }
  const scheme = (url ?? '').trim().toLowerCase()
  if (scheme.startsWith('postgres://') || scheme.startsWith('postgresql://')) return 'postgres'
  if (scheme.startsWith('mongodb://') || scheme.startsWith('mongodb+srv://')) return 'mongodb'
  return 'sqlite'
}


/** Values a statement may bind. Mirrors what `bun:sqlite` accepts. */
export type BindValue = string | number | bigint | boolean | null | Uint8Array
export type Bindings = readonly BindValue[]

/** What one mutating statement reports back. */
export interface ExecuteResult {
  /** Rows affected, or 0 when the dialect cannot tell. */
  changes: number
  /**
   * Value of the auto-increment/identity column of an insert. SQLite reports
   * it directly; Postgres only knows it when the statement uses `RETURNING`.
   */
  lastInsertId: number | string | null
}

/**
 * What a backend can do. Callers must check these instead of assuming SQLite;
 * the console and the backup/cluster features use this to hide what a backend
 * cannot support instead of failing halfway through a write.
 */
export interface DriverCapabilities {
  readonly dialect: Dialect
  /** Portable SQL can be executed. */
  readonly sql: boolean
  /** Multi-statement ACID transactions. */
  readonly transactions: boolean
  /** Nested transactions via savepoints. */
  readonly savepoints: boolean
  /** `INSERT ... RETURNING` is supported. */
  readonly returning: boolean
  /** Runtime DDL (creating project collections) is supported. */
  readonly ddl: boolean
  /** The database is a local file this process owns (backups, snapshots, Litestream). */
  readonly localFile: boolean
  /** Drizzle migrations from `drizzle/` apply to this backend. */
  readonly drizzleMigrations: boolean
  /** Full-text indexes are available for collection indexes of type `fulltext`. */
  readonly fullTextSearch: 'fts5' | 'tsvector' | 'none'
  /** Cache-version triggers in `_meta` are available. */
  readonly cacheTriggers: boolean
  /** The cross-process realtime event bus table `_realtime_events` is available. */
  readonly eventBus: boolean
  /** `VACUUM INTO`-style consistent snapshots are available. */
  readonly snapshots: boolean
}

/** A statement executor. Inside a transaction this is the transaction handle. */
export interface SqlExecutor {
  /** Every row of a query. */
  all<T = Record<string, unknown>>(sql: string, params?: Bindings): Promise<T[]>
  /** The first row, or null. */
  get<T = Record<string, unknown>>(sql: string, params?: Bindings): Promise<T | null>
  /** Run a statement and report its effect. */
  run(sql: string, params?: Bindings): Promise<ExecuteResult>
  /** Run one or more statements that take no parameters (DDL, PRAGMA). */
  exec(sql: string): Promise<void>
}

/**
 * A transaction handle. Savepoints isolate one batch operation: when it throws,
 * only that operation rolls back and the surrounding transaction can commit.
 */
export interface SqlTransaction extends SqlExecutor {
  savepoint<T>(name: string, fn: (tx: SqlTransaction) => Promise<T>): Promise<T>
}

/** A SQL driver: SQLite or Postgres. */
export interface SqlDriver extends SqlExecutor {
  readonly kind: 'sql'
  readonly dialect: SqlDialect
  readonly capabilities: DriverCapabilities
  /** Run `fn` atomically. The callback must use `tx`, not the outer driver. */
  transaction<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T>
  /** Round-trip a trivial query. Throws when the backend is unreachable. */
  ping(): Promise<void>
  close(): Promise<void>
}

/**
 * A MongoDB-style filter. The document driver translates Appwrite queries into
 * this shape instead of pretending Mongo understands SQL.
 */
export type DocumentFilter = Record<string, unknown>

export interface DocumentFindOptions {
  sort?: Record<string, 1 | -1>
  limit?: number
  skip?: number
  /** Attribute projection; `_id` is always kept. */
  projection?: Record<string, 0 | 1>
}

export interface DocumentIndex {
  name: string
  /** `1`/`-1` for a B-tree index, `'text'` for a Mongo text index. */
  keys: Record<string, 1 | -1 | 'text'>
  unique?: boolean
}

/** One logical collection (an Appwrite collection, or a built-in table). */
export interface DocumentCollection<T extends Record<string, unknown> = Record<string, unknown>> {
  find(filter: DocumentFilter, options?: DocumentFindOptions): Promise<T[]>
  findOne(filter: DocumentFilter): Promise<T | null>
  insert(document: T): Promise<T>
  insertMany(documents: T[]): Promise<number>
  update(filter: DocumentFilter, patch: Record<string, unknown>): Promise<T | null>
  delete(filter: DocumentFilter): Promise<number>
  count(filter: DocumentFilter): Promise<number>
  /** Insert when the filter matches nothing, otherwise update; returns the row and whether it was created. */
  upsert(filter: DocumentFilter, document: T): Promise<{ value: T; created: boolean }>
  createIndex(index: DocumentIndex): Promise<void>
  drop(): Promise<void>
}

/** A document driver: MongoDB. */
export interface DocumentDriver {
  readonly kind: 'document'
  readonly dialect: 'mongodb'
  readonly capabilities: DriverCapabilities
  collection<T extends Record<string, unknown> = Record<string, unknown>>(name: string): DocumentCollection<T>
  ping(): Promise<void>
  close(): Promise<void>
}

export type DatabaseDriver = SqlDriver | DocumentDriver

/** The driver cannot express this statement or operation. */
export class UnsupportedFeatureError extends Error {
  constructor(
    readonly feature: string,
    message?: string,
  ) {
    super(message ?? `This backend does not support ${feature}.`)
    this.name = 'UnsupportedFeatureError'
  }
}

/** The backend could not be reached, or the connection was closed. */
export class DatabaseConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'DatabaseConnectionError'
  }
}

export interface UniqueViolation {
  /** The constraint/index that rejected the write, when the backend names it. */
  constraint?: string
  /** The table/collection, when the message names it. */
  table?: string
}

/**
 * Recognise a unique-constraint violation across backends. The document store
 * used to match SQLite's `UNIQUE constraint failed` message; callers should use
 * this instead so a Postgres `duplicate key value violates unique constraint`
 * maps to the same Appwrite error.
 */
export function uniqueViolation(error: unknown): UniqueViolation | null {
  if (!error || typeof error !== 'object') return null
  // Bun's Postgres client reports the SQLSTATE in `errno`; the MongoDB driver
  // uses `code`. Node-style clients use `code` for SQLSTATE too.
  const errno = String((error as { errno?: unknown }).errno ?? '')
  const code = String((error as { code?: unknown }).code ?? '')
  const isUnique = errno === '23505' || code === '23505' || code === '11000'
  if (!isUnique) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/UNIQUE constraint failed|duplicate key value violates unique constraint|E11000 duplicate key/i.test(message)) return null
  }
  const message = error instanceof Error ? error.message : String(error)
  const constraint =
    /constraint "([^"]+)"/.exec(message)?.[1] ??
    /index: (\S+)/.exec(message)?.[1] ??
    /UNIQUE constraint failed: ([^.\s]+)/.exec(message)?.[1]
  return { constraint }
}

export const capabilitiesOf = (capabilities: DriverCapabilities): Readonly<DriverCapabilities> => Object.freeze(capabilities)
