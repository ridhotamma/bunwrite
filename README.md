# Bunwrite

**A lightweight, Appwrite-compatible backend on Bun + SQLite + Drizzle.**

Bunwrite is a single-process, self-hosted backend that implements the slice of
the Appwrite API most apps use. Existing apps keep using the official
[`appwrite`](https://www.npmjs.com/package/appwrite) and
[`node-appwrite`](https://www.npmjs.com/package/node-appwrite) SDKs unchanged.

> Bunwrite is an independent open-source project. It is not affiliated with,
> endorsed by, or sponsored by Appwrite.

## Why Bunwrite?

- **One process, one file.** Bun serves the API, realtime, functions and console;
  SQLite stores everything.
- **SDK compatible.** Point the Appwrite SDK at Bunwrite and keep your frontend
  code.
- **Admin console included.** Manage databases, users, teams, files, functions,
  schema, storage, backups and logs without a separate dashboard.
- **Functions without Docker.** Node and Python functions run in child
  processes with Appwrite's `context` API.
- **S3-compatible storage.** Uploads and backups can live on local disk or any
  S3-compatible bucket.
- **Small footprint.** Designed for a 1 vCPU / 1 GB VPS.

## Quick start

Requires **Bun 1.4+**.

```bash
cp .env.example .env    # set PROJECT_ID, API_KEYS, SECRET, PUBLIC_ENDPOINT
bun install
bun run dev             # API at http://localhost:8080/v1, console at /console
```

On a fresh database, create an admin:

```bash
bun run console:admin you@example.com
```

Build a single executable instead—migrations, console assets and function
runners are embedded:

```bash
bun run build             # dist/bunwrite
./dist/bunwrite           # API at http://localhost:8080/v1
./dist/bunwrite console:admin you@example.com
```

Build on the target OS and architecture so native dependencies match. The
resulting binary needs no Bun at runtime.

Or try the self-contained demo:

```bash
bun run demo            # http://localhost:8790/console
                        # demo@bunwrite.test / demo-password
```

Import the example schema first if you want sample collections:

```bash
bun run schema:push examples/appwrite.config.json
```

## Connect an app

```ts
import { Client, Databases } from 'node-appwrite'

const client = new Client()
  .setEndpoint('http://localhost:8080/v1')
  .setProject('your-project-id')
  .setKey('your-api-key')

const databases = new Databases(client)
```

The same endpoint works with the browser `appwrite` SDK. `X-Appwrite-*`
headers, sessions, cookies and error shapes follow Appwrite.

## Console

Server-rendered pages with htmx, styled after Shopify Polaris, and usable on a
phone.

| Area | What you can do |
| --- | --- |
| Home | Counts, bandwidth chart with top consumers, failed function runs, memory and database size |
| Databases | Create databases and collections; edit attributes, indexes and permissions; browse, filter, create, edit and delete documents |
| Users | Search; edit profile, labels, verification and prefs; block; set a password; end sessions; delete |
| Teams | Create teams; add members by email or ID; edit roles; prefs |
| Storage | Buckets and their rules; upload, open and delete files; local or S3-compatible storage |
| Functions | Schedule, timeout, who may run it, variables; run now; run history with logs |
| Request logs | Requests with status, duration, bytes, auth, IP, error, referer, user agent and request ID; details, search, filters, pagination, retention |
| Backups | Database snapshots; daily auto backups; optional S3 destination |
| Schema | Export the full config or selected collections; paste/file import with review and delete-missing |
| Settings | Project, email, sign-in, storage, backups, functions, logs and access |

Settings saved in the console override the matching env vars and take effect
immediately. Each setting shows whether it comes from env or from the console
and can be reset to env.

## What the API covers

| Area | Endpoints |
| --- | --- |
| Databases | document CRUD, bulk create/upsert/update/delete, increment/decrement, queries, row permissions, transactions with conflict detection, database/collection metadata |
| Account | email + password, email OTP, token sessions, Google OAuth2 token flow, recovery, email verification, JWT, sessions, prefs |
| Users | list/search, create, get/delete, updates, labels, prefs, memberships, sessions, tokens, JWTs, identities |
| Teams | teams, prefs, memberships, invites and accept-invite |
| Storage | uploads including chunked (`Content-Range`, `x-appwrite-id`), view/download with byte ranges, resized previews (sharp), permissions |
| Functions | executions (sync/async), list/get, in-process cron, one child process per run, `/v1/functions/<id>/http` |
| Realtime | WebSocket at `/v1/realtime`: document events to subscribers who may read them |
| Email | SMTP via nodemailer, Appwrite's English templates |

Abuse limits match Appwrite's: 10 tries an hour per IP and account on sign-in,
codes and recovery for browsers (API keys are exempt), and ten wrong codes
cancel the real one.

## Known differences from Appwrite

- An accented first letter sorts after `Z` (`Éclair` after `Yogurt`);
  PostgreSQL sorts it with `E`.
- Search keeps English stop words ("the", "and") that PostgreSQL drops.
- On the raw wire, some documents list `$id` before their attributes where live
  lists it after; the SDKs parse both to the same object.
- Not implemented: `regex`, geo, vector and `exists` queries; MFA; phone/SMS
  login; magic URLs; messaging; scheduled executions.
- `studio-render` (Chromium) does not fit in 1 GB of memory.

## Commands

| Command | Does |
| --- | --- |
| `bun run dev` | Watch-mode API + console |
| `bun run build` | Build the standalone `dist/bunwrite` executable |
| `bun run demo` | Self-contained demo with sample data |
| `bun run console:admin <email> [--remove]` | Create, reset or remove a console admin |
| `bun run schema:push <appwrite.config.json> [--prune]` | Create/alter tables, indexes, buckets and functions |
| `bun run migrate --endpoint .. --project .. --key .. --verify` | Copy a live Appwrite project here |
| `bun run snapshot [dir]` | Consistent database copy while the server runs |
| `bun run typecheck` | TypeScript check |
| `bun test` | Contract tests through the real SDKs |

## Deploy

Use the [Ansible playbook](playbook/README.md) to provision a VPS and run the
standalone binary in one command, including optional Caddy HTTPS. For a manual
Ubuntu + systemd setup, see [docs/DEPLOY.md](docs/DEPLOY.md).

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
development workflow, and [SECURITY.md](SECURITY.md) for reporting security
issues.

## License

MIT. See [LICENSE](LICENSE).
