# Database abstraction

Status: 2026-11-10.

Bunwrite started as a SQLite-only backend and still defaults to it. This
document describes the database port that lets the same code run on SQLite and
Postgres, what each backend supports today, and how to move a service over.

Related: [ARCHITECTURE.md](ARCHITECTURE.md), [CONFIGURATION.md](CONFIGURATION.md),
[LIMITATIONS.md](LIMITATIONS.md).

## The short version

| Backend | Driver | Schema bootstrap | Used by the request path |
| --- | --- | --- | --- |
| SQLite | `bun:sqlite` (synchronous) | Drizzle migrations + cluster schema | **Yes**, the default |
| Postgres | `Bun.SQL` (async pool) | Derived from the Drizzle schema + triggers + views, once per project schema | **Yes** — the server boots on it, see [Boot path](#boot-path) |

The port, both drivers, schema bootstrapping, dialect translation, the
operational CLI and the cache/services layer (logs, variables, webhooks,
settings, registry, versions, access, email templates) are complete and tested
against real Postgres. The document layer, auth (users, sessions, tokens and
OAuth identities), teams, console admins/sessions, organizations, the rate/abuse
limits, storage (buckets, files, uploads, previews), functions (definitions,
deployments, executions), sites, messaging topics, the proxy/domain rules and
the queue run on either backend. The project manager opens one Postgres schema
per project, and `startServer` opens the configured backend. The console schema
admin, settings, logs, VCS stores, scheduler lease and cross-worker realtime
fan-out also run on Postgres. Writer sharding, whole-instance SQLite archives
and Litestream are SQLite-only by design; Postgres uses the same Backups page to
take periodic `pg_dump` dumps. [Migration order](#migration-order) lists them.
Nothing in the existing SQLite path changed behaviour.

## Configuration

SQLite stays the default: leave everything unset and Bunwrite opens
`DATABASE_PATH`.

```dotenv
DB_DRIVER=postgres            # sqlite | postgres
DATABASE_URL=postgres://user:password@localhost:5432/bunwrite

# Postgres schema.
DATABASE_SCHEMA=bunwrite

DATABASE_POOL_MAX=10
DATABASE_SSL=false
```

`DB_DRIVER` accepts `sqlite`, `sqlite3`, `file`, `postgres`, `postgresql` and
`pg`, and is the switch: a `DATABASE_URL` left in the environment by another
tool does not move Bunwrite off SQLite. An unknown value fails at startup instead
of silently falling back. The `db:*` CLI can also infer the backend from
`--url` when `--driver` is omitted.

For Postgres, `DATABASE_SCHEMA` is the base schema. The first/legacy project
uses that schema directly; the control store uses `CONTROL_DATABASE_SCHEMA`
(default `<base>_console`); every additional project gets a sibling schema named
`<base>_<project-id>` (sanitized to 63 bytes and hashed when the ID is long).
Every pooled connection opens with `search_path=<schema>` only, not a one-off
`SET`, so a missing table cannot silently resolve to another project's schema.

## Operations CLI

```bash
bun run db:check        # connect, bootstrap, print capabilities and tables
bun run db:migrate      # create/upgrade the schema only
bun run db:ping         # connection check

bun run db:check --driver postgres --url postgres://localhost/bunwrite --database bunwrite --json

# Apply a project config (collections, buckets, functions) to the backend.
bun run db:migrate --schema appwrite.config.json --prune

# Move a stopped SQLite install to Postgres (dry-run first).
bun run migrate:postgres --url postgres://user@localhost:5432/bunwrite --dry-run
```

The CLI reads the same environment variables as the server. `--no-bootstrap`
opens a read-only replica without touching the schema. `bun run schema:push`,
`bun run migrate` and `bun run db:migrate --schema` all target the configured
backend, including Postgres.

The legacy SQLite file commands (`bunwrite snapshot`, `restore` and `failover`)
only work with local SQLite databases and stop with a clear message on Postgres.
`bunwrite backup:open` also unpacks a downloaded Postgres dump.

On Postgres, **Organization → Backups** runs `pg_dump` on the same automatic
cron schedule and keeps the dump in `BACKUPS_PATH` or uploads it to the backup
S3 bucket. Restore it with `bunwrite backup:open` and `pg_restore`; see
[DEPLOY.md](DEPLOY.md#restoring-a-postgres-backup).

`DB_DRIVER=postgres` boots the server and serves API traffic. The boot path
opens the control schema, runs the instance bootstrap through the driver, loads
every service cache with `services.ready()`, and opens each project in its own
schema.

## Moving from SQLite to Postgres

The migration is offline and one-way per run. Start this Bunwrite version once
on the existing SQLite install (then stop it) so the latest schema migrations
and the separate control store are in place. Keep the SQLite files, then copy
the control store and every project into a set of Postgres schemas:

```bash
# 1. Preview the projects and target schemas. No writes.
bun run migrate:postgres \
  --url postgres://user:password@localhost:5432/bunwrite \
  --schema bunwrite \
  --dry-run

# 2. Copy the data. The target schemas must be empty unless --force is given.
bun run migrate:postgres \
  --url postgres://user:password@localhost:5432/bunwrite \
  --schema bunwrite

# 3. Start Bunwrite on Postgres.
DB_DRIVER=postgres \
DATABASE_URL=postgres://user:password@localhost:5432/bunwrite \
DATABASE_SCHEMA=bunwrite \
CONTROL_DATABASE_SCHEMA=bunwrite_console \
bun run start
```

From a source checkout use `bun run migrate:postgres`; in the compiled binary or
Docker image use `bunwrite migrate:postgres`. Run it with the same environment and
volumes as the server so it can see the SQLite files. For Compose:

```bash
docker compose stop bunwrite
docker compose run --rm bunwrite migrate:postgres \
  --url postgres://user:password@db.example.com/bunwrite --dry-run
```

The command:

- Reads `DATABASE_PATH` and `control/bunwrite.sqlite` (override with `--source`
  and `--control`).
- Handles both the current separate control store and the older single-database
  layout.
- Creates the control schema and every project schema, then copies system
  tables, dynamic collection tables (including permissions), vector/RAG tables
  and settings.
- Recreates collection indexes and cache-version triggers, and advances every
  identity sequence past the copied rows.
- Verifies source and target row counts and exits non-zero on a mismatch.
- Leaves SQLite untouched, so rollback is simply unsetting `DB_DRIVER` and
  restarting on SQLite.

Useful options:

| Option | Meaning |
| --- | --- |
| `--ssl` | Require TLS for the Postgres connection. Defaults to `DATABASE_SSL`. |
| `--schema <name>` | Base Postgres schema. Defaults to `DATABASE_SCHEMA` or `bunwrite`. |
| `--control-schema <name>` | Control schema. Defaults to `CONTROL_DATABASE_SCHEMA` or `<base>_console`. |
| `--source <path>` / `--control <path>` | Explicit SQLite files. |
| `--data-dir <path>` | Folder containing `projects/`; defaults to the source database's folder. |
| `--skip-logs` | Skip request logs and telemetry tables. |
| `--force` | Replace non-empty non-public target schemas. |
| `--dry-run` | Print projects, source table counts and target schemas without writing. |
| `--json` | Machine-readable report. |

After the switch, `bunwrite snapshot`, `restore` and `failover` are unavailable;
use **Organization → Backups** (`pg_dump`) or managed Postgres PITR. If the
Postgres host is new, copy `STORAGE_PATH`, function code and site files as well.
The optional Qdrant vector index can be rebuilt from the migrated SQL data.

The command does not publish or modify `.env`; set `DB_DRIVER`,
`DATABASE_URL`, `DATABASE_SCHEMA` and `CONTROL_DATABASE_SCHEMA` explicitly.
Use a dedicated non-`public` schema for a clean migration.

### Scaling after the move

Postgres removes SQLite's single-writer and writer-shard hop, but it does not
remove database limits. Size the pool for the worker count and the server's
connection limit:

```dotenv
WORKERS=4
DATABASE_POOL_MAX=10
```

- Every worker opens a pool for the control schema and one for each project, so
  budget roughly `WORKERS * (projects + 1) * DATABASE_POOL_MAX`. Keep that below
  the Postgres `max_connections` limit, leaving room for migrations, backups and
  operators. A transaction-mode pooler such as PgBouncer can sit in front, but
  the server must support the session behavior the driver uses.
- Bunwrite uses one Postgres URL and does not split reads to replicas. A managed
  HA primary plus provider PITR is the supported production shape.
- More projects use more schemas, not more databases. Monitor connections,
  autovacuum, index bloat and per-schema disk use.
- Backups move from archives/Litestream to the **Organization → Backups**
  `pg_dump` job or provider PITR. The legacy `snapshot`, `restore` and `failover`
  commands refuse to run on Postgres.
- Vector search can stay in SQL for small collections or move to Qdrant; the
  migration copies the SQL vector tables, and Qdrant can be rebuilt from them.

## The port

`src/db/driver.ts` defines the contract:

- `SqlExecutor` — `all`, `get`, `run`, `exec`. Inside a transaction this is the
  transaction handle.
- `SqlTransaction` — a `SqlExecutor` plus `savepoint(name, fn)`, which isolates
  one batch operation.
- `SqlDriver` — a `SqlExecutor` plus `transaction`, `ping`, `close`, `dialect`
  and `capabilities`.
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

const sql = database.sql                        // SqlDriver
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
await services.ready()   // no-op on SQLite; loads caches on Postgres
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
settings map. Deleting a project drops its Postgres schema after closing the
pool. SQLite still removes the project folder.

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
- The built-in vector store (`_vector_collections`, `_vector_points`) is part of
  the same derived schema, so `/vectors` and `/rag` work on both backends
  without a native extension. Search ranks points in the process; see
  [VECTORS.md](VECTORS.md).
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

- Whole-instance archives (`VACUUM INTO`), Litestream and the
  `_realtime_events` file locks are SQLite-only. On Postgres, the same
  **Organization → Backups** page creates periodic `pg_dump` dumps instead;
  point-in-time recovery requires the provider's managed PITR or a separate
  backup tool. See [DEPLOY.md](DEPLOY.md#restoring-a-postgres-backup).
- The scheduler lease works on both backends: `_cluster_leases` is decided by a
  conditional upsert. Cross-process realtime fan-out uses `_realtime_events`
  polling on SQLite and `LISTEN`/`NOTIFY` on Postgres.
- The writer-shard cluster (`WRITER_SHARDS`, `WRITER_PORT`) is only for SQLite's
  single-writer file. With `DB_DRIVER=postgres` no writer processes or loopback
  listeners are started and every worker writes through the pool; the
  cache-version triggers already work across hosts.
- `db.sqlite` remains SQLite-only. Services must be on `db.driver` before they
  can run on Postgres. Everything else, including schema DDL, the console schema
  admin and the VCS stores, runs on Postgres.

## Migration order

Move services to `db.driver` from the outside in; each step must keep the
SQLite test suite green:

1. **Done.** `logs/service.ts`, `variables/service.ts`, `webhooks/service.ts`
   use `db.driver` and `SqlDatabase`, so they accept either SQLite or Postgres.
   `test/database-drivers.test.ts` exercises both against a real Postgres
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
4. **Done.** `auth/*`, `teams/*`, `console/auth.ts`,
   `organizations/service.ts`, `lib/limits.ts`, `storage/service.ts`,
   `functions/service.ts`, `functions/deployments.ts`, `sites/service.ts`,
   `proxy/service.ts`, `queue/service.ts`, `messaging/topics.ts`,
   `mail/templates.ts`, the console schema admin and the VCS stores use
   `db.driver`; their routes, console pages, caches and tests are async. Auth,
   teams, storage, the proxy/site/queue layers, schema DDL and the VCS stores
   have been exercised against real Postgres. Sites and proxy keep synchronous
   reads over a cache filled by `ready()`, with async writes and reloads. The
   project manager opens each project as a Postgres schema and loads its caches
   before serving it. Schema import keeps the console's dry-run preview by
   running the Postgres apply inside a transaction and rolling it back.
5. **Done.** The scheduler lease and cross-process realtime bus run on both
   backends. Writer sharding and local archive/Litestream snapshots stay
   SQLite-only: Postgres scales with workers + the pool and uses the Backups
   page's `pg_dump` dumps (or managed PITR) for backup.

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

# Run the integration tests against a real server:
BUNWRITE_TEST_POSTGRES_URL=postgres://user@localhost:5432/postgres \
bun test test/database-drivers.test.ts test/postgres-migrate.test.ts
```

The Postgres test creates a random schema, bootstraps the full schema, runs
CRUD, a rolled-back transaction, a savepoint and the cache triggers, then boots
`createServices` + `ProjectManager` on the same connection, creates a second
project in its own schema, writes a document there, deletes the project and
drops both schemas. It also runs the schema admin (create, dry-run import,
export, delete) and the VCS stores (installations, links, comments, GitHub App
credentials) against Postgres. The test workflow provisions Postgres 16 and sets
`BUNWRITE_TEST_POSTGRES_URL`, so these run in CI; locally, without the variable,
the integration suites are skipped.
