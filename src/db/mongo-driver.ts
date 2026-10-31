/**
 * A MongoDB document driver.
 *
 * MongoDB is not a SQL database, so this driver does not implement the SQL
 * port. It exposes the subset of storage Bunwrite needs for project documents
 * and built-in resources: named collections with find/insert/update/delete,
 * an atomic counter for `_seq`, and index creation.
 *
 * `mongodb` is loaded lazily so a deployment that never selects this backend
 * does not pay for the import. Install it with `bun add mongodb`.
 */
import {
  capabilitiesOf,
  DatabaseConnectionError,
  type DocumentCollection,
  type DocumentDriver,
  type DocumentFindOptions,
  type DocumentIndex,
  type DriverCapabilities,
} from './driver'

/** The pieces of the `mongodb` package this driver uses. */
interface MongoCollectionLike<T = Record<string, unknown>> {
  find(filter: Record<string, unknown>, options?: Record<string, unknown>): {
    sort(sort: Record<string, 1 | -1>): {
      skip(n: number): { limit(n: number): { project(p: Record<string, 0 | 1>): { toArray(): Promise<T[]> } } }
    }
    project(p: Record<string, 0 | 1>): { toArray(): Promise<T[]> }
    toArray(): Promise<T[]>
  }
  findOne(filter: Record<string, unknown>): Promise<T | null>
  insertOne(document: T): Promise<{ insertedId: unknown }>
  insertMany(documents: T[]): Promise<{ insertedCount: number }>
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ matchedCount: number; modifiedCount: number; upsertedCount: number }>
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ value?: T | null; ok?: number } | T | null>
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>
  countDocuments(filter: Record<string, unknown>): Promise<number>
  createIndex(keys: Record<string, 1 | -1 | 'text'>, options?: Record<string, unknown>): Promise<string>
  drop(): Promise<unknown>
}

interface MongoDatabaseLike {
  collection<T = Record<string, unknown>>(name: string): MongoCollectionLike<T>
  command(command: Record<string, unknown>): Promise<unknown>
  listCollections(filter?: Record<string, unknown>, options?: Record<string, unknown>): { toArray(): Promise<Array<{ name: string }>> }
}

interface MongoClientLike {
  connect(): Promise<MongoClientLike>
  db(name: string): MongoDatabaseLike
  close(): Promise<void>
}

interface MongoModule {
  MongoClient: new (url: string, options?: Record<string, unknown>) => MongoClientLike
}

let modulePromise: Promise<MongoModule> | null = null

/** Import `mongodb` on first use with a message that says how to install it. */
function loadMongo(): Promise<MongoModule> {
  modulePromise ??= import('mongodb' as string)
    .then((module) => module as unknown as MongoModule)
    .catch((error) => {
      modulePromise = null
      throw new Error(
        'The MongoDB backend needs the optional `mongodb` package. Install it with `bun add mongodb` and restart.',
        { cause: error },
      )
    })
  return modulePromise
}

export interface MongoDriverOptions {
  /** `mongodb://user:pass@host:27017/bunwrite?replicaSet=rs0` */
  url: string
  /** Logical database. Each Bunwrite project uses a different one. */
  database: string
  /** Pool size per process. Default 10. */
  maxPoolSize?: number
  /** Give up selecting a server after this many milliseconds. Default 10_000. */
  serverSelectionTimeoutMs?: number
  /** Set to false when the driver is handed an already-connected client (tests). */
  connect?: boolean
  /** Inject a client (tests, or a shared connection). */
  client?: MongoClientLike
}

const mongoCapabilities = capabilitiesOf({
  dialect: 'mongodb',
  sql: false,
  transactions: true,
  savepoints: false,
  returning: false,
  ddl: false,
  localFile: false,
  drizzleMigrations: false,
  fullTextSearch: 'none',
  cacheTriggers: false,
  eventBus: false,
  snapshots: false,
})

/** A `DocumentCollection` backed by one Mongo collection. */
class MongoCollection<T extends Record<string, unknown>> implements DocumentCollection<T> {
  constructor(private readonly collection: MongoCollectionLike<T>) {}

  async find(filter: Record<string, unknown>, options: DocumentFindOptions = {}): Promise<T[]> {
    let cursor: any = this.collection.find(filter)
    if (options.sort) cursor = cursor.sort(options.sort)
    if (options.skip) cursor = cursor.skip(options.skip)
    if (options.limit) cursor = cursor.limit(options.limit)
    if (options.projection) cursor = cursor.project(options.projection)
    return (await cursor.toArray()) as T[]
  }

  findOne(filter: Record<string, unknown>): Promise<T | null> {
    return this.collection.findOne(filter)
  }

  async insert(document: T): Promise<T> {
    const copy = { ...document }
    const result = await this.collection.insertOne(copy)
    return { ...copy, _id: result.insertedId } as T
  }

  async insertMany(documents: T[]): Promise<number> {
    if (documents.length === 0) return 0
    const result = await this.collection.insertMany(documents.map((document) => ({ ...document })))
    return result.insertedCount
  }

  async update(filter: Record<string, unknown>, patch: Record<string, unknown>): Promise<T | null> {
    // `_id` is immutable in MongoDB; a caller that passes a document it just
    // read must not make the update fail.
    const { _id: _ignored, ...rest } = patch
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: rest },
      { returnDocument: 'after', includeResultMetadata: false },
    )
    return unwrapFindOneAndUpdate(result)
  }

  async delete(filter: Record<string, unknown>): Promise<number> {
    const result = await this.collection.deleteMany(filter)
    return result.deletedCount
  }

  count(filter: Record<string, unknown>): Promise<number> {
    return this.collection.countDocuments(filter)
  }

  async upsert(filter: Record<string, unknown>, document: T): Promise<{ value: T; created: boolean }> {
    const { _id: _ignored, ...rest } = document
    const result = await this.collection.findOneAndUpdate(
      filter,
      { $set: rest },
      { upsert: true, returnDocument: 'after', includeResultMetadata: true },
    )
    const updated = result as { value?: T | null; lastErrorObject?: { updatedExisting?: boolean } } | T | null
    const value = unwrapFindOneAndUpdate<T>(updated)
    if (!value) throw new DatabaseConnectionError('MongoDB upsert returned no document')
    return { value, created: !(updated as { lastErrorObject?: { updatedExisting?: boolean } })?.lastErrorObject?.updatedExisting }
  }

  async createIndex(index: DocumentIndex): Promise<void> {
    await this.collection.createIndex(index.keys, { name: index.name, ...(index.unique ? { unique: true } : {}) })
  }

  async drop(): Promise<void> {
    try {
      await this.collection.drop()
    } catch (error) {
      // 26 = NamespaceNotFound: dropping a collection that never existed is fine.
      if ((error as { code?: number }).code !== 26) throw error
    }
  }
}

function unwrapFindOneAndUpdate<T>(result: { value?: T | null } | T | null): T | null {
  if (!result) return null
  if (typeof result === 'object' && 'value' in result) return (result as { value?: T | null }).value ?? null
  return result as T
}

export class MongoDriver implements DocumentDriver {
  readonly kind = 'document' as const
  readonly dialect = 'mongodb' as const
  readonly capabilities: DriverCapabilities = mongoCapabilities

  private readonly options: MongoDriverOptions
  private readonly client: MongoClientLike
  private closed = false

  private constructor(options: MongoDriverOptions, client: MongoClientLike) {
    this.options = options
    this.client = client
  }

  /** Connect (or wrap an injected client) and verify the server answers. */
  static async open(options: MongoDriverOptions): Promise<MongoDriver> {
    let client = options.client
    if (!client) {
      const { MongoClient } = await loadMongo()
      client = new MongoClient(options.url, {
        maxPoolSize: options.maxPoolSize ?? 10,
        serverSelectionTimeoutMS: options.serverSelectionTimeoutMs ?? 10_000,
      })
    }
    if (options.connect !== false) {
      try {
        await client.connect()
      } catch (error) {
        throw new DatabaseConnectionError(`Could not reach MongoDB at ${redact(options.url)}`, error)
      }
    }
    const driver = new MongoDriver(options, client)
    await driver.ping()
    return driver
  }

  /** The underlying Mongo database handle. */
  get database(): MongoDatabaseLike {
    return this.client.db(this.options.database)
  }

  collection<T extends Record<string, unknown> = Record<string, unknown>>(name: string): DocumentCollection<T> {
    return new MongoCollection<T>(this.database.collection<T>(name))
  }

  /** Atomic per-collection counter used to emulate SQLite's `_seq`. */
  async nextSequence(name: string): Promise<number> {
    const counters = this.database.collection<{ _id: string; value: number }>('_counters')
    const result = await counters.findOneAndUpdate(
      { _id: name },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: 'after', includeResultMetadata: true },
    )
    const value = unwrapFindOneAndUpdate<{ _id: string; value: number }>(result)
    if (!value) throw new DatabaseConnectionError(`Could not allocate a sequence for ${name}`)
    return value.value
  }

  async ping(): Promise<void> {
    try {
      await this.database.command({ ping: 1 })
    } catch (error) {
      throw new DatabaseConnectionError(`Could not reach MongoDB at ${redact(this.options.url)}`, error)
    }
  }

  /** The names of the collections that exist in this database. */
  async collections(): Promise<string[]> {
    const list = await this.database.listCollections({}, { nameOnly: true }).toArray()
    return list.map((entry) => entry.name)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.client.close()
  }
}

export const openMongoDriver = (options: MongoDriverOptions): Promise<MongoDriver> => MongoDriver.open(options)

/** Hide the password before a URL reaches a log line or an error message. */
export function redact(url: string): string {
  return url.replace(/\/\/([^:/@]+):([^@]*)@/, '//$1:***@')
}
