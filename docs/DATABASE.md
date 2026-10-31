# Database abstraction

Status: 2026-11-01.

Bunwrite started as a SQLite-only backend and still defaults to it. This
document describes the database port that lets the same code run on SQLite,
Postgres and MongoDB, what each backend supports today, and how to move a
service over.

Related: [ARCHITECTURE.md](ARCHITECTURE.md), [CONFIGURATION.md](CONFIGURATION.md),
[LIMITATIONS.md](LIMITATIONS.md).

## The short version

| Backend | Driver | Schema bootstrap | Used by the request path |
| --- | --- | --- | --- |
| SQLite | `bun:sqlite` (synchronous) | Drizzle migrations + cluster schema | **Yes**, the default |
| Postgres | `Bun.SQL` (async pool) | Derived from the Drizzle schema + triggers + views | Not yet — see [Migration order](#migration-order) |
| MongoDB | `mongodb` (async, optional) | Indexes + `_counters` | Not yet — see [Migration order](#migration-order) |

The port, both network drivers, schema bootstrapping, dialect translation, the
operational CLI and the cache/services layer (logs, variables, webhooks,
settings, registry, versions, access) are complete and tested against real
Postgres and MongoDB. The document, auth, teams, storage, functions and console
layers still use the synchronous SQLite fast path; [Migration
order](#migration-order) lists what is left. Nothing in the existing SQLite
path changed behaviour.

## Configuration

SQLite stays the default: leave everything unset and Bunwrite opens
`DATABASE_PATH`.

```dotenv
DB_DRIVER=postgres            # sqlite | postgres | mongodb
DATABASE_URL=postgres://user:password@localhost:5432/bunwrite
# DATABASE_URL=mongodb://user:password@localhost:27017/?replicaSet=rs0

# Postgres schema, or the MongoDB database name.
DATABASE_SCHEMA=bunwrite
MONGO_DATABASE=bunwrite

DATABASE_POOL_MAX=10
DATABASE_SSL=false
```

`DB_DRIVER` accepts `sqlite`, `sqlite3`, `file`, `postgres`, `postgresql`, `pg`,
`mongodb` and `mongo`, and is the switch: a `DATABASE_URL` left in the
environment by another tool does not move Bunwrite off SQLite. An unknown value
fails at startup instead of silently falling back. The `db:*` CLI can also infer
the backend from `--url` when `--driver` is omitted.

For Postgres, `DATABASE_SCHEMA` creates and uses a schema
(`CREATE SCHEMA IF NOT EXISTS`); every pooled connection is opened with
`search_path=<schema>, public`, not with a one-off `SET`. For MongoDB,
`MONGO_DATABASE` selects the database; each Bunwrite project can use its own.

## Operations CLI

```bash
bun run db:check        # connect, bootstrap, print capabilities and tables
bun run db:migrate      # create/upgrade the schema only
bun run db:ping         # connection check

bun run db:check --driver postgres --url postgres://localhost/bunwrite --database bunwrite
bun run db:check --driver mongodb --url mongodb://localhost:27017 --database bunwrite --json
```

The CLI reads the same environment variables as the server. `--no-bootstrap`
opens a read-only replica without touching the schema.

While the request path is still SQLite, setting `DB_DRIVER` to `postgres` or
`mongodb` makes the server stop with an explicit message instead of silently
writing to the local file. Remove `DB_DRIVER` (or set it to `sqlite`) to start
normally; use the CLI to prepare and verify the network backend in the
meantime.

## The port

`src/db/driver.ts` defines the contract:

- `SqlExecutor` — `all`, `get`, `run`, `exec`. Inside a transaction this is the
  transaction handle.
- `SqlTransaction` — a `SqlExecutor` plus `savepoint(name, fn)`, which isolates
  one batch operation.
- `SqlDriver` — a `SqlExecutor` plus `transaction`, `ping`, `close`, `dialect`
  and `capabilities`.
- `DocumentDriver` — `collection(name)` returning a `DocumentCollection` with
  `find`, `findOne`, `insert`, `insertMany`, `update`, `delete`, `count`,
  `upsert`, `createIndex`, `drop`.
- `DriverCapabilities` — what a backend can do (`sql`, `transactions`,
  `savepoints`, `returning`, `ddl`, `localFile`, `drizzleMigrations`,
  `fullTextSearch`, `cacheTriggers`, `eventBus`, `snapshots`). Callers must
  check these instead of assuming SQLite.

`src/db/index.ts` selects the backend:

```ts
import { openDatabase } from '~/db'

const database = await openDatabase({
  backend: 'postgres',
  url: process.env.DATABASE_URL,
  namespace: 'bunwrite',
})

const sql = database.sql!                       // SqlDriver | null
const rows = await sql.all('SELECT * FROM _users WHERE id = ?', ['u1'])
await sql.transaction(async (tx) => {
  await tx.run('UPDATE _users SET name = ? WHERE id = ?', ['New', 'u1'])
  await tx.savepoint('audit', async (sp) => { /* … */ })
})
await database.close()
```

Statements are written once, in portable SQLite-flavoured SQL (`?`
placeholders, double-quoted identifiers, ISO strings for dates, JSON text for
objects). Each driver adapts them.

### Using it inside the app

`openDb()` still returns the synchronous `Db` used everywhere:

```ts
const db = openDb('./data/bunwrite.sqlite')
db.sqlite.query('SELECT 1').get()   // existing synchronous path
db.driver                            // the same connection behind the async port
db.capabilities                      // DriverCapabilities
```

`db.driver` lets a service move to the port one module at a time. The intended
order is listed in [Migration order](#migration-order).

### Boot seam

SQLite services that keep an in-memory cache (settings, the schema registry,
the access switches, the version counters) load it synchronously in their
constructor, exactly as before. A network backend starts empty and the boot
path awaits `services.ready()`:

```ts
const services = createServices(config, db)
await services.ready()   // no-op on SQLite; loads caches on Postgres/Mongo
```

`startServer` awaits `projects.ready()`, which does the same for the control
project and every project runtime.

Reads stay synchronous (`settings` mutates the config in place, `registry`
exposes its maps), so the per-request paths did not change. Writes and reloads
go through `db.driver` and are awaited.

## Postgres

- The built-in tables are **derived from `src/db/system-schema.ts`** at runtime,
  so a new column cannot be forgotten. Column storage matches SQLite: dates and
  JSON stay `text`, booleans stay `integer` (0/1), so the codec and every
  service read the same JS values on both backends. `seq` is an
  `integer GENERATED BY DEFAULT AS IDENTITY` primary key; Postgres keeps it
  numeric (int4) so it round-trips to JS as a number.
- `CREATE TABLE IF NOT EXISTS`, indexes, the five list views
  (`v_users`, `v_teams`, `v_memberships`, `v_files`, `v_executions`), the
  cluster tables (`_meta`, `_rate_limits`, `_cluster_leases`,
  `_cluster_processes`, `_realtime_events`) and the cache-version triggers are
  created by `ensurePostgresSchema()` under a transaction-level advisory lock,
  which is the Postgres equivalent of SQLite's migration file lock.
- Cache versions use one trigger function, `bunwrite_bump_version()`, with the
  counter key as a trigger argument.
- Attribute columns for dynamic collections are generated by
  `postgresDocumentTableStatements()` / `postgresDocumentIndexStatements()`:
  a `fulltext` index becomes a GIN `to_tsvector('english', …)` index, an
  `_id` index stays unique, and the permission table keeps SQLite's layout.

### Dialect translation

`src/db/dialect.ts` translates only the constructs the codebase actually uses,
and refuses the rest with `UnsupportedFeatureError`:

| SQLite | Postgres |
| --- | --- |
| `?` placeholders | `$1`, `$2`, … (strings/identifiers untouched) |
| `INSERT OR IGNORE` | `INSERT … ON CONFLICT DO NOTHING` (before `RETURNING`) |
| `json_each(x)` | `jsonb_array_elements_text((x)::jsonb)` |
| `json_array_length(x)` | `jsonb_array_length((x)::jsonb)` |
| `json_extract(x, '$.a.b')` | `(x::jsonb #>> '{a,b}')` |
| `group_concat(x, ', ')` | `string_agg(x, ', ')` |
| `iif(a, b, c)` | `CASE WHEN a THEN b ELSE c END` |
| `LIKE` / `NOT LIKE` | `ILIKE` / `NOT ILIKE` (SQLite's ASCII case-insensitivity) |
| `LIMIT -1` | `LIMIT ALL` |
| `x IS ?` | `x IS NOT DISTINCT FROM ?` |

Rejected on purpose: `PRAGMA`, `INSERT OR REPLACE`, FTS5 `MATCH`. Rewrite those
with the backend's own mechanism before sending them.

### Not available on Postgres yet

- Backups and snapshots (`VACUUM INTO`, Litestream, `_realtime_events` file
  locks) are SQLite-only. Use `pg_dump`/managed PITR and Postgres `LISTEN`/
  `NOTIFY` (the driver exposes `listen()`) instead.
- The writer-shard cluster (`WRITER_SHARDS`, `WRITER_PORT`) is a SQLite
  file-lock design. On Postgres, scale with more processes and the pool; the
  cache-version triggers already work across hosts.
- `db.sqlite` remains SQLite-only. Services must be on `db.driver` before they
  can run on Postgres.

## MongoDB

MongoDB is **not** a SQL backend, so the SQL dialect is never translated. The
driver exposes document collections and the platform primitives:

- `collection(name)` with `find`, `findOne`, `insert`, `insertMany`, `update`,
  `delete`, `count`, `upsert`, `createIndex`, `drop`.
- `nextSequence(name)` — an atomic `$inc` in `_counters`, used to emulate
  SQLite's `_seq` for new documents.
- `ensureMongoSchema()` — the uniqueness/lookup indexes the services rely on
  (see `MONGO_INDEXES` in `src/db/mongo-schema.ts`), mirroring the SQLite
  indexes by name.
- `mongoDocumentIndexes(table, indexes, attributes)` — a collection's indexes,
  with `fulltext` mapped to a Mongo text index.

`mongodb` is loaded lazily: a deployment that never selects MongoDB does not
pay for the import. Install it with `bun add mongodb` (it is already in
`package.json`); the error message says so if it is missing.

Transactions on MongoDB require a replica set (`mongodb://…?replicaSet=…`).
Permission tables have no Mongo counterpart: document permissions live in the
document's `_permissions` field, which is what the permission filter expects.

### Not available on MongoDB yet

- SQL-shaped services: a repository layer must replace the queries in
  `DocumentStore`, auth, teams, storage, functions and the console before those
  features can run on Mongo. The driver gives that layer its primitives.
- The cross-process event bus and cache-version triggers (they are SQL tables /
  triggers). Use Mongo change streams or an external bus in that layer.

## Migration order

Move services to `db.driver` from the outside in; each step must keep the
SQLite test suite green:

1. **Done.** `logs/service.ts`, `variables/service.ts`, `webhooks/service.ts`
   use `db.driver` and `SqlDatabase`, so they accept either SQLite or Postgres.
   `test/database-drivers.test.ts` exercises all three against a real Postgres
   schema. The console handlers that call them are async; `record()` stays
   synchronous because it only queues in memory.
2. **Done.** `settings/service.ts`, `schema/registry.ts`, `cluster/versions.ts`
   and `settings/access.ts` load their caches through `db.driver` and keep
   synchronous in-memory reads (`settings` overlays the config, `registry`
   exposes its maps, access switches are booleans). SQLite still loads in the
   constructor; a network backend calls `services.ready()` before serving.
   `test/database-drivers.test.ts` covers the overlay, API keys, access
   switches, version counters and the registry against Postgres.
3. `documents/store.ts` + `documents/batcher.ts` + `transactions/service.ts` —
   the data plane. This is the step that makes the document API portable, and
   the one that needs the Mongo repository.
4. `auth/*`, `teams/*`, `storage/*`, `functions/*`.
5. Console pages and the cluster/backup features, which can stay SQLite-only
   behind `db.capabilities`.

A converted method looks like this:

```ts
// before
list(scope: string): VariableRow[] {
  return this.db.sqlite.query<VariableRow, [string]>(
    'SELECT * FROM _variables WHERE scope = ? ORDER BY key, context',
  ).all(scope)
}

// after
async list(scope: string): Promise<VariableRow[]> {
  return this.db.driver.all<VariableRow>(
    'SELECT * FROM _variables WHERE scope = ? ORDER BY key, context',
    [scope],
  )
}
```

Callers gain `await`; route handlers are already `async`. Transactions use
`db.driver.transaction(async (tx) => …)` and `tx.savepoint(...)` instead of
`db.sqlite.transaction(fn).immediate()`.

## Testing

```bash
bun test test/database-drivers.test.ts

# Run the integration tests against real servers:
BUNWRITE_TEST_POSTGRES_URL=postgres://user@localhost:5432/postgres \
BUNWRITE_TEST_MONGO_URL=mongodb://localhost:27017 \
bun test test/database-drivers.test.ts
```

The Postgres test creates a random schema, bootstraps the full schema, runs
CRUD, a rolled-back transaction, a savepoint and the cache triggers, then drops
the schema. The Mongo test creates a random database, bootstraps indexes, runs
CRUD/upsert, allocates `_seq` values, checks the unique index and drops the
database. Without the environment variables both are skipped.
