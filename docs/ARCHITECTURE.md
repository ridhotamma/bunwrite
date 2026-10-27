# Architecture

One Bun process serves the Appwrite-compatible API (`/v1`), realtime
(`/v1/realtime`), function HTTP endpoints (`/v1/functions/<id>/http`) and the
admin console (`/console`). It keeps all of its state in one SQLite file plus a
folder of uploaded files.

```
 Pesanle apps (Workers, browsers)        Admin (browser)
   appwrite / node-appwrite SDKs              │
            │ HTTPS (Cloudflare)              │
            ▼                                 ▼
 ┌──────────────────────────── Bun.serve ────────────────────────────┐
 │ /v1/*  router → caller (key │ session │ JWT │ guest) → services   │
 │ /v1/realtime  WebSocket hub ◄── document events                   │
 │ /console/*  htmx pages → the same services                        │
 │                                                                   │
 │ services: DocumentStore · Transactions · Auth · Teams · Storage   │
 │           Functions (+cron) · Settings · Registry (schema)        │
 └───────────┬─────────────────────────────┬─────────────────────────┘
             ▼                             ▼
     SQLite (WAL) data/pesanle.sqlite    data/storage/<bucket>/<file>
             ▲
   child processes: one per function run (bun runner / python3 runner)
```

## Source layout

| Path | Holds |
| --- | --- |
| `src/app.ts` | Builds the services, routes `/v1`, resolves the caller, CORS, publishes realtime events after a request succeeds |
| `src/db/` | SQLite connection (WAL, foreign keys) and the Drizzle schema of built-in tables; migrations in `drizzle/` |
| `src/schema/` | Registry of databases/collections, `push.ts` (config → tables, used by CLI, import and console), `admin.ts` (console edits, export) |
| `src/documents/` | Query parser/compiler, codec (validation, encoding), `store.ts` (reads, writes, permissions), routes |
| `src/transactions/` | Staged operations and commit with conflict detection |
| `src/auth/` | Caller resolution, permissions and roles, passwords, sessions, tokens, Google OAuth, JWT, account and users routes |
| `src/teams/`, `src/storage/`, `src/functions/`, `src/realtime/` | One service and its routes each |
| `src/settings/` | Console-edited settings over env, console API keys |
| `src/console/` | Console request lifecycle, shared UI/htmx/form helpers and page modules |
| `src/migrate/` | Import from a live Appwrite project |

### Console

The console keeps the same boundaries as the API:

- `src/console/app.ts` is only the request lifecycle: assets, sign-in/setup,
  origin checks, admin auth, routing and error rendering.
- `context.ts` defines the handler context. `ctx.go()` and `ctx.back()` choose
  between an htmx `HX-Location` swap and a plain 303 redirect.
- `forms.ts`, `query.ts` and `ui.ts` hold shared form parsing, paging/query
  builders and UI pieces (list cards, live search, pagers, badges, polling).
- `pages/` has one module per console area. `pages/databases/` splits databases,
  documents, attributes, indexes and collection settings.

## Data model

- **Built-in tables** (`_users`, `_sessions`, `_tokens`, `_teams`, `_memberships`,
  `_identities`, `_files`, `_buckets`, `_functions`, `_executions`,
  `_transactions`, `_settings`, `_api_keys`, `_console_*`) are a Drizzle schema
  in `src/db/system-schema.ts`. Drizzle migrations run on start.
- **Each collection** is a real table `d<dbSeq>_<collectionId>`, with one column
  per attribute plus `_seq` (`$sequence`), `_id`, `_createdAt`, `_updatedAt` and
  `_permissions`. Arrays are stored as JSON text, booleans as 0/1, and datetimes
  as Appwrite's `…+00:00` strings, so ordering them as text orders them by time.
- **Permissions** are stored twice: as `_permissions` for output, and as rows
  of `<table>__perms (doc, type, role)` for filtering. A read checks the caller's
  roles with one indexed `IN`.
- **Full-text indexes** are FTS5 tables using the porter stemmer, kept in sync
  by triggers. They match the PostgreSQL English config that live Appwrite uses.
- **Users, teams, memberships, files and executions** are queried through SQL
  views (`v_users`, …) that look like collection tables. That lets Appwrite
  queries on them go through the same compiler.

## Request path

1. Strip `/v1`, match the route, and check `X-Appwrite-Project` (or `?project=`).
2. Resolve the caller:
   - an API key (env, console key, or the functions' internal key) bypasses permissions;
   - a session (header, `a_session_<project>` cookie or fallback cookie) or a JWT is a user with roles
     `any`, `users`, `user:ID`, verified variants, `team:ID`, `team:ID/role`, `member:ID` and `label:X`;
   - otherwise the caller is a guest.
3. The handler runs synchronously against SQLite (bun:sqlite is synchronous), so
   one request's reads and writes never interleave with another's.
4. On success, the changed documents go to realtime subscribers who may read
   them. On failure, the events are dropped.

## Transactions

Writes sent with a `transactionId` are validated and stored in
`_transaction_logs`. A read sent with that `transactionId` replays them inside a
savepoint and then rolls back, so the transaction sees its own writes.

Commit replays the operations in one `BEGIN IMMEDIATE` transaction. If a
document changed after its operation was staged, the commit fails with
`transaction_conflict` (409) and nothing is applied. That is what
`runTransaction` in Pesanle builds on.

## Functions

Each execution is a child process: `bun src/functions/runner-node.ts <entry>` or
`python3 src/functions/runner-python.py <entry>`. The runner builds Appwrite's
`context` (`req`, `res`, `log`, `error`) and gets the same `APPWRITE_FUNCTION_*`
env that Appwrite gives.

`APPWRITE_API_KEY` is a per-process internal key, so functions need no key in
env. Variables come from three places; a later one wins:
1. the server env, minus its private keys;
2. `FUNCTIONS_ENV_FILE`;
3. the console's function variables.

A 15-second loop fires cron schedules (UTC). It never starts a function while
that function's previous run is still going, and it skips functions on the
pause list.

## Settings and schema: who wins

- **Settings:** env vars are the defaults, and a value saved in the console
  overrides them until it is reset to env.
- **Schema:** the database is the source of truth.
  - `appwrite.config.json` is an import/export format: `schema:push`, the console's Schema page, or `SCHEMA_SYNC_ON_START=true`.
  - Console edits change the database directly; export them to keep Pesanle's repo file in step.
  - Startup sync is off by default, so a restart never undoes a console change.

## Security notes

- Secrets (sessions, tokens, invites, console sessions, API keys) are stored as
  sha256. Passwords use argon2id with Appwrite's parameters, and imported
  bcrypt/sha/md5/scrypt hashes still verify.
- The console cookie is `HttpOnly`, `SameSite=Strict` and scoped to `/console`.
  POSTs with a foreign `Origin` are refused.
  - Console sign-in is limited to 10 tries per 15 minutes per IP.
  - The first-admin setup page is only served to loopback requests.
- Put the console behind Cloudflare Access (or turn it off with
  `CONSOLE_ENABLED=false`) when the API hostname is public.
