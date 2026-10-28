# Bunwrite architecture

One Bun process serves the Appwrite-compatible API (`/v1`), realtime
(`/v1/realtime`), function HTTP endpoints (`/v1/functions/<id>/http`) and the
admin console (`/console`). The default project uses the main SQLite file;
additional projects each use their own database under `data/projects/<id>/`,
plus their own storage, backups and function folder.

```
 Client apps (Web, mobile, server)        Admin (browser)
   appwrite / node-appwrite SDKs              │
            │ HTTPS (Cloudflare)              │
            ▼                                 ▼
 ┌──────────────────────────── Bun.serve ────────────────────────────┐
 │ /v1/*  router → project → caller (key │ session │ JWT) → services│
 │ /v1/realtime  WebSocket hub ◄── document events                   │
 │ /console/*  htmx pages → the selected project's services         │
 │                                                                   │
 │ ProjectManager: control project + one Services set per project   │
 │ services: DocumentStore · Transactions · Auth · Teams · Storage   │
 │           Functions (+cron) · Settings · Registry (schema)        │
 └───────────┬─────────────────────────────┬─────────────────────────┘
             ▼                             ▼
   default: data/bunwrite.sqlite       data/storage/<bucket>/<file>
   others:  data/projects/<id>/        data/projects/<id>/storage/...
             ▲
   child processes: one per function run (bun runner / python3 runner)
```

## Source layout

| Path | Holds |
| --- | --- |
| `src/app.ts` | Builds the services, routes `/v1`, resolves the caller (API key, console admin in admin mode, session or JWT), applies switched-off services and protocols, CORS, publishes realtime events and webhooks after a request succeeds |
| `src/db/` | SQLite connection (WAL, foreign keys) and the Drizzle schema of built-in tables; migrations in `drizzle/` |
| `src/schema/` | Registry of databases/collections, `push.ts` (config → tables, used by CLI, import and console), `admin.ts` (console edits, export) |
| `src/documents/` | Query parser/compiler, codec (validation, encoding), `store.ts` (reads, writes, permissions), routes |
| `src/transactions/` | Staged operations and commit with conflict detection |
| `src/auth/` | Caller resolution, permissions and roles, passwords, sessions, tokens, Google OAuth, JWT, account and users routes |
| `src/teams/`, `src/storage/`, `src/functions/`, `src/realtime/`, `src/webhooks/`, `src/messaging/` | One service and its routes each |
| `src/sites/` | Sites: `service.ts` (sites, deployments, lookup by Host, build), `serve.ts` (static files, fallback, `/api/*` to a function), `ssr.ts` (an SSR app's process, proxy and idle reaper), `routes.ts` (Appwrite's Sites API). `app.ts` serves a request as a site when its Host is `<id>.<SITES_DOMAIN>` or a custom domain, before anything else |
| `src/vcs/` | Git deployments: `hub.ts` (one per server: GitHub webhooks, builds from a commit, commit statuses, the PR comment, fork approval), `github.ts` (REST client, app JWT, installation tokens), `credentials.ts` (the GitHub App from `VCS_GITHUB_*` or the console), `repositories.ts` (control-DB links from a repository to each project's sites and functions), `installations.ts` (per project), `detect.ts`, `routes.ts` (Appwrite's VCS API). Previews are served by `src/sites/previews.ts` hosts. See [GIT.md](GIT.md) |
| `src/proxy/` | Appwrite-compatible custom domains: `service.ts` stores one `_proxy_rules` row per domain for a site or function, `routes.ts` serves `/v1/proxy/rules`. A site/function keeps its default `<id>.<sites/functions domain>` and any number of custom domains |
| `src/platform/` | What the Appwrite CLI needs beyond the client APIs: the console-project API (`appwrite login`, organizations, projects) and the Project API (`pull/push settings`) |
| `src/system/` | Query views and resource auto-tuning (`autotune.ts`) |
| `src/settings/` | Console-edited project settings and API keys; `access.ts` holds services, protocols, sign-in methods, policies and mock phones |
| `src/instance/` | First-run organization/project IDs, signing secret, initial API key and one-time env seed |
| `src/projects/` | `_projects` registry and one cached `Services` set per project database |
| `src/logs/` | Batched request-log storage for the console, retention pruning |
| `src/backups/` | SQLite snapshots, local/S3 backup storage, daily automatic backups |
| `src/console/` | Console request lifecycle, shared UI/htmx/form helpers and page modules |
| `src/migrate/` | Import from a live Appwrite project |
| `src/lib/compat.ts` | Both naming families: reads `X-Bunwrite-*` and `X-Appwrite-*` headers and both session cookies; `API_COMPAT` picks the webhook headers, function variables and default cookie the server sends |
| `packages/sdk/` | `@bunwrite/sdk`, its own package. `src/services`, the helpers, models and enums are generated from Appwrite's SDKs by `scripts/sdk-sync.ts`, which keeps the methods whose HTTP method and path the server routes; the client is written by hand |
| `packages/cli/` | `@bunwrite/cli`, its own package on top of the SDK (bundled into its build): sign-in, `pull`/`push` of the project config, function deploys with its own tar.gz writer, and generic service commands |
| `skills/` | Agent Skills for AI coding agents (`bunwrite`, `bunwrite-cli`, `bunwrite-functions`, `bunwrite-sites`), installed with `npx skills add ridhotamma/bunwrite` or `bunwrite skills` |

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
- `views/` holds the markup for pages that mix a lot of HTML with data loading.
  Page modules keep writes, validation and redirects; view functions render the
  active page. Markup stays in TypeScript `html` templates, so it is escaped by
  default and checked by the compiler.
- Page and view modules do not run SQL. Queries live with the service that owns
  the data (`DocumentStore`, `AuthService`, `TeamService`, `StorageService`,
  `FunctionService`, `RequestLogService`), and the page calls that service.
- `instance/bootstrap.ts` runs at startup. Stored values win; environment
  values only seed an empty (or legacy partial) instance, and are imported once
  into `_settings` / `_api_keys` behind an `env_seed` marker. After that,
  project identity, API keys and application settings live in the database and
  are managed in the console. The generated API key is shown once on
  `/console/setup` and kept hashed in `_api_keys`.
- `projects/manager.ts` owns `_projects` in the control database and a cached
  `Services` set per project. The control database is the default project's
  database, so an existing single-project install keeps its data. Additional
  projects get `data/projects/<id>/` and their own signing secret, API keys,
  storage prefix and backups prefix.
- The console index (`/console`) lists projects, like Appwrite's organization
  page; opening one goes to `/console/overview`. The selected project is kept in
  the `console_project` cookie, and the project switcher changes which project's
  services every page uses. Console admins remain global in the control
  database. API request logs live in each project's database; console page
  traffic goes to the default project.
- `organizations/service.ts` owns the single organization in the control
  database, its members and invitations. Console admins become members
  automatically; owners invite by email, change roles and revoke access.
  Invitation tokens are stored as SHA-256 hashes, can be used once, and create
  the console account when accepted unless the account already exists (then the
  member signs in first). Owners are protected from demoting or removing
  themselves and from leaving the organization without an owner.
- Function HTTP endpoints may omit the project header; the server finds the
  owning project by function ID. Send the header when the same function ID
  exists in more than one project.

## Data model

- **Built-in tables** (`_users`, `_sessions`, `_tokens`, `_teams`, `_memberships`,
  `_identities`, `_files`, `_buckets`, `_functions`, `_executions`,
  `_transactions`, `_settings`, `_api_keys`, `_request_logs`, `_projects`,
  `_organizations`, `_organization_members`, `_console_*`) are a Drizzle schema
  in `src/db/system-schema.ts`. Drizzle migrations run on start. `_projects`,
  `_organizations` and `_organization_members` live in the control/default
  database.
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

1. Strip `/v1`, match the route, and check the project header (`X-Bunwrite-Project` or
   `X-Appwrite-Project`, or `?project=`). `src/lib/compat.ts` holds both naming families:
   requests may use either; `API_COMPAT` picks the names the server sends.
2. Resolve the caller:
   - an API key (env, console key, or the functions' internal key) bypasses permissions;
   - a session (header, `bw_session_<project>` or `a_session_<project>` cookie, or fallback cookie) or a JWT is a user with roles
     `any`, `users`, `user:ID`, verified variants, `team:ID`, `team:ID/role`, `member:ID` and `label:X`;
   - otherwise the caller is a guest.
3. The handler runs synchronously against SQLite (bun:sqlite is synchronous), so
   one request's reads and writes never interleave with another's.
4. On success, the changed documents go to realtime subscribers who may read
   them. On failure, the events are dropped.
5. Every response carries `X-Request-Id`. When `LOG_REQUESTS` is on, one line
   per request (method, path, status, duration, request/response bytes, auth,
   IP, project, error) goes to stdout as text or JSON, and the same entry is
   batched into `_request_logs` for the console's Request logs page. The page
   stores referer and user agent too, and has a detail view. Static assets and
   successful Request logs page requests are skipped; rows older than the
   configured retention (env or Console Settings) are pruned. The Home page
   charts hourly inbound/outbound bytes and lists the top paths.

## Transactions

Writes sent with a `transactionId` are validated and stored in
`_transaction_logs`. A read sent with that `transactionId` replays them inside a
savepoint and then rolls back, so the transaction sees its own writes.

Commit replays the operations in one `BEGIN IMMEDIATE` transaction. If a
document changed after its operation was staged, the commit fails with
`transaction_conflict` (409) and nothing is applied. Apps can build
transactional flows on this.

## Functions

Each execution is a child process: `bun src/functions/runner-node.mjs <entry>` (or
`bunwrite __bunwrite-runner-node <entry>` in a compiled binary) or
`python3 src/functions/runner-python.py <entry>`. The runner builds Appwrite's
`context` (`req`, `res`, `log`, `error`) and gets `BUNWRITE_FUNCTION_*`
variables; with `API_COMPAT=appwrite` also the `APPWRITE_FUNCTION_*` ones that
Appwrite gives.

`BUNWRITE_API_KEY` (and `APPWRITE_API_KEY`) is a per-process internal key, so
functions need no key in env. Variables come from three places; a later one wins:
1. the server env, minus its private keys;
2. `FUNCTIONS_ENV_FILE`;
3. the console's function variables.

Console variables can be global (Settings → Functions) or set on one function.
A function-specific value overrides a global one with the same name. Both
places can bulk import pasted `KEY=value` lines; malformed lines are reported
with line numbers before anything is written.

Code comes from one of two places. `appwrite push functions` uploads a
deployment: a `.tar.gz` (in 5 MB chunks when larger) unpacked to
`<data>/deployments/<function>/<deployment>/`, where the function's build
command runs with `sh -c` (skipped with `FUNCTIONS_BUILD_COMMANDS=false`).
The build's PATH ends with `<data>/.runtimes/bin`, which has `bun`, `bunx`,
`npm` and `npx` backed by the server binary (`BUN_BE_BUN=1`), so `npm install`,
`npm ci`, `npm run` and `bun install` work where neither is installed, such
as the Docker image; a real npm or bun earlier on PATH wins. Python builds get
`PIP_TARGET=<deployment>/.python_packages`, so `pip install -r
requirements.txt` installs there, never into the system Python. The Python
runner imports from the entrypoint's folder, then the function's folder, then
`.python_packages`. The source is kept as uploaded (before the build) for
`appwrite pull functions`.

Isolation (`src/functions/sandbox.ts`): when the setpriv helper works (the
Docker image installs it with the setuid/setgid capabilities, runnable only by
the server's group), each function gets its own user ID (20000 and up, kept in
`<data>/.runtimes/function-users.json`). After unpacking, the deployment
folder and the function's home (`deployments/<function>/.home`, its HOME and
TMPDIR) are handed to that user; builds and runs then go through the helper
with no-new-privs and no capabilities. The server creates files with umask 077
and tightens the data folder at start, so only the folders on the way to code
allow passing through. Function users own their files, so the server deletes,
downloads and reads code for the console through the helper too. The
active deployment runs; older ready ones are kept two deep, then deleted.
Without one, the code is read from the function's `path` under the code
folder, as `schema:push` sets it.

A 15-second loop fires cron schedules (UTC). It never starts a function while
that function's previous run is still going, and it skips functions on the
pause list. The same loop starts one-off executions deferred with
`scheduledAt` once their time has arrived; those keep the id they were
created with, so the execution returned to the caller is the one that runs.

## Files and backups

- Uploads are stored under `STORAGE_PATH`, or in an S3-compatible bucket when
  enabled in **Settings → File storage**. Switching storage does not migrate
  existing files; that is a manual step.
- Backups are consistent SQLite snapshots made with `VACUUM INTO` in
  `BACKUPS_PATH`, or in a separate S3 bucket when enabled in
  **Settings → Backups**. Manual backups can be created, downloaded and
  deleted there; automatic backups run daily at 02:00 UTC and keep the
  configured number. Database snapshots do not include uploaded files.

## Settings and schema: who wins

- **Settings:** the database is the source of truth. Environment project
  settings are imported once into `_settings` when an instance is first seeded
  and are ignored afterwards; console edits take effect immediately.
- **Schema:** the database is the source of truth.
  - The project config file (`bunwrite.config.json`, `bunwrite.json` or Appwrite's `appwrite.config.json`) is an import/export format: `schema:push`, the console's Schema page, `SCHEMA_SYNC_ON_START=true`, or `bunwrite push tables` / `appwrite push tables` (through `/v1/tablesdb` and `/v1/databases`).
  - Columns read back in the shape they were defined (an email column shows a size only if it was given one), because `appwrite push` drops and recreates a column whose type, size, format or encrypt reads back differently.
  - The Schema page can export selected collections and import a pasted/uploaded
    collection array with a dry-run review and an optional delete-missing pass.
  - Console edits change the database directly; export them to keep your repo file in step.
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
