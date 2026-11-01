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
| Postgres | `Bun.SQL` (async pool) | Derived from the Drizzle schema + triggers + views, once per project schema | **Yes** — the server boots on it, see [Boot path](#boot-path) |
| MongoDB | `mongodb` (async, optional) | Indexes + `_counters` | Not yet — repositories are still missing |

The port, both network drivers, schema bootstrapping, dialect translation, the
operational CLI and the cache/services layer (logs, variables, webhooks,
settings, registry, versions, access, email templates) are complete and tested
against real Postgres and MongoDB. The document layer, auth (users, sessions,
tokens and OAuth identities), teams, console admins/sessions, organizations, the
rate/abuse limits, storage (buckets, files, uploads, previews), functions
(definitions, deployments, executions), sites, messaging topics, the
proxy/domain rules and the queue now run on either backend as well. The project
manager opens one Postgres schema per project, and `startServer` opens the
configured backend. The remaining console screens (settings, schema admin, logs,
queue views), the VCS console and the cluster/backup features still use
synchronous SQLite paths; [Migration order](#migration-order) lists them.
Nothing in the existing SQLite path changed behaviour.

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

For Postgres, `DATABASE_SCHEMA` creates and uses the control schema
(`CREATE SCHEMA IF NOT EXISTS`); every pooled connection is opened with
`search_path=<schema>, public`, not with a one-off `SET`. Each additional
Bunwrite project gets a sibling schema named `<DATABASE_SCHEMA>_<project-id>`
(sanitized to 63 bytes and hashed when the ID is long). For MongoDB,
`MONGO_DATABASE` selects the control database; the same namespace helper derives
`<MONGO_DATABASE>_<project-id>` for when the repository layer can open a
project there.

## Operations CLI

```bash
bun run db:check        # connect, bootstrap, print capabilities and tables
bun run db:migrate      # create/upgrade the schema only
bun run db:ping         # connection check

bun run db:check --driver postgres --url postgres://localhost/bunwrite --database bunwrite
bun run db:check --driver mongodb --url mongodb://localhost:27017 --database bunwrite --json

# Apply a project config (collections, buckets, functions) to the backend.
bun run db:migrate --schema appwrite.config.json --prune
```

The CLI reads the same environment variables as the server. `--no-bootstrap`
opens a read-only replica without touching the schema.

`DB_DRIVER=postgres` now boots the server and serves API traffic. The boot path
opens the control schema, runs the instance bootstrap through the driver,
loads every service cache with `services.ready()`, and opens each project in its
own schema. MongoDB still stops with an explicit message until the remaining
SQL-shaped services have repositories; use the CLI to prepare and verify a
MongoDB database in the meantime.

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

### Boot path

`startServer` no longer constructs a SQLite handle directly. It calls

```ts
const database = await openDatabase(databaseOptionsOf(config))
const db = sqlDatabaseOf(database)       // driver + dialect + capabilities (+ sqlite)
if (db.dialect === 'sqlite') bootstrapInstance(db)
else await bootstrapInstanceAsync(db)
```

`bootstrapInstance` keeps the synchronous SQLite transaction the tests and local
path have always used. `bootstrapInstanceAsync` computes the same plan from one
snapshot and applies it in one driver transaction; on Postgres it takes an
advisory lock first, so two workers booting together cannot store different
instance secrets. `clearInstanceApiKeyAsync` is the matching async version used
after the first console admin is created.

`ProjectManager` now opens projects through `openDatabase` too. The default
project reuses the control handle; every other project gets a derived namespace
and its own pool. A project's services are not returned until `services.ready()`
has loaded its caches, so the first request cannot observe an empty registry or
settings map. Deleting a project drops its Postgres schema or MongoDB database
after closing the pool. SQLite still removes the project folder.

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
- Schema DDL and the schema admin console still build SQLite tables. Apply a
  project with `bun run db:migrate --schema …` on Postgres. The VCS console
  stores, the remaining settings/logs/queue screens and the cluster lease are
  also still on the synchronous path.

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

`mongodb` is an **optional peer dependency**: SQLite and Postgres installs do
not download it, so the Docker image (`bun install --production`) and the
compiled binary stay lean. Install it with `bun add mongodb` when you select
MongoDB; the driver loads it lazily and its error message says how to install it
if it is missing. The repository keeps it in `devDependencies` so the Mongo
integration tests can run locally.

Transactions on MongoDB require a replica set (`mongodb://…?replicaSet=…`).
Permission tables have no Mongo counterpart: document permissions live in the
document's `_permissions` field, which is what the permission filter expects.

### MongoDB document backend

`MongoDocumentStore` implements `DocumentBackend`: CRUD, bulk writes, filters,
sorting, cursors, projections, permissions, revisions and text search. Its
limits are explicit:

- `runInTransaction` runs the callback directly and `runBatch` does not roll
  back earlier operations. Multi-document transactions need a replica set and
  a session-aware driver; the current driver does not open sessions.
- Staged transaction reads (`preview`) are rejected with
  `UnsupportedFeatureError`.
- `orderRandom` is rejected (it needs an aggregation `$sample`).
- The list cache and cache-version triggers are SQL features; Mongo has no
  cross-process version counter, only `_doc_versions` for ETags.

The remaining SQL-shaped services (auth, teams, storage, functions and the
console) still need their own repository layer before those features can run on
Mongo.

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
3. **Done.** `documents/store.ts`, `documents/batcher.ts` and
   `transactions/service.ts` use the port and an `AsyncLocalStorage` transaction
   context, so document CRUD, bulk writes, `runBatch` savepoints, optimistic
   revisions, permissions, staged transaction reads and commit conflict
   detection run on SQLite and Postgres. `Query.search` compiles to
   `to_tsvector`/`plainto_tsquery` on Postgres (matching the GIN index) and to
   FTS5 `MATCH` on SQLite. `bun run db:migrate --schema …` creates and updates
   collection tables, indexes and version triggers on Postgres via
   `push-postgres.ts`.
   `MongoDocumentStore` (`documents/mongo-store.ts`) implements the same
   `DocumentBackend` for MongoDB with its own Appwrite-query → Mongo-filter
   compiler. It stores documents natively (booleans, arrays, `_permissions` as
   an array) and supports CRUD, bulk operations, filters, text search,
   permissions, revisions and `runBatch`; staged transaction reads, random
   order and multi-document transactions need a replica set/session support and
   are rejected explicitly rather than silently emulated.
4. **Done for the boot path.** `auth/*`, `teams/*`, `console/auth.ts`,
   `organizations/service.ts`, `lib/limits.ts`, `storage/service.ts`,
   `functions/service.ts`, `functions/deployments.ts`, `sites/service.ts`,
   `proxy/service.ts`, `queue/service.ts`, `messaging/topics.ts` and
   `mail/templates.ts` use `db.driver`; their routes, console pages, caches and
   tests are async. Auth, teams, storage and the proxy/site/queue layers have
   been exercised against real Postgres; functions are covered by the SQLite
   suite and use the proxy cache for custom-domain rules. Sites and proxy keep
   synchronous reads over a cache filled by `ready()`, with async writes and
   reloads. The project manager now opens each project as a Postgres schema or
   MongoDB database and loads its caches before serving it.
   The remaining synchronous screens are the console settings/schema admin and
   the logs/queue views, plus the VCS console stores.
5. Console pages and the cluster/backup features, which can stay SQLite-only
   behind `db.capabilities`. Schema DDL (`schema/admin.ts`, `schema/push.ts`) is
   still SQLite-only; on Postgres apply a project with
   `bun run db:migrate --schema …`.

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
CRUD, a rolled-back transaction, a savepoint and the cache triggers, then boots
`createServices` + `ProjectManager` on the same connection, creates a second
project in its own schema, writes a document there, deletes the project and
drops both schemas. The Mongo test creates a random database, bootstraps indexes, runs
CRUD/upsert, allocates `_seq` values, checks the unique index and drops the
database. Without the environment variables both are skipped.
