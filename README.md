# Bunwrite

**A lightweight, Appwrite-compatible backend on Bun + SQLite + Drizzle.**

Bunwrite is a single-process, self-hosted backend that implements the slice of
the Appwrite API most apps use. Existing apps keep using the official
[`appwrite`](https://www.npmjs.com/package/appwrite) and
[`node-appwrite`](https://www.npmjs.com/package/node-appwrite) SDKs unchanged.

> Bunwrite is an independent open-source project. It is not affiliated with,
> endorsed by, or sponsored by Appwrite.

![Bunwrite Console](assets/screenshots/screenshot-2.png)

## Why Bunwrite?

- **One process, one file.** Bun serves the API, realtime, functions and console;
  SQLite stores everything.
- **SDK compatible.** Point the Appwrite SDK at Bunwrite and keep your frontend
  code.
- **Multiple projects.** Each project has its own database, users, teams,
  storage, functions and API keys; switch projects in the console.
- **Admin console included.** Manage databases, users, teams, files, functions,
  schema, storage, backups and logs without a separate dashboard.
- **Functions without Docker.** Node and Python functions run in child
  processes with Appwrite's `context` API. In the Docker image each function
  builds and runs as its own Linux user, so it cannot read the database,
  uploads or other functions.
- **S3-compatible storage.** Uploads and backups can live on local disk or any
  S3-compatible bucket.
- **Auto-tuned.** Sizes image/render/SQLite/upload limits and the JS heap to
  the host's CPU and RAM, including cgroup limits.
- **Small footprint.** Designed for a 1 vCPU / 1 GB VPS.

## Quick start

Requires **Bun 1.4+**.

```bash
cp .env.example .env    # optional: set PUBLIC_ENDPOINT and server tweaks
bun install
bun run dev             # API at http://localhost:8080/v1, console at /console
```

On first start, Bunwrite generates an organization ID, project ID, signing
secret and an initial API key, stores them in the database, and shows them on
the first-run console setup page. After that the database is the source of
truth: manage the project, API keys, allowed origins, email, Google sign-in and
other application settings in the console.

The optional "First start only" values at the end of `.env.example` can seed an
empty database—useful when reusing an existing Appwrite project ID and API key.
They are imported once and then ignored. `.env` itself is for server and
deployment settings such as `PUBLIC_ENDPOINT`, paths, logs and resource limits.

On a fresh database, open `/console/setup` to create the first admin and see the
generated instance credentials, or create the admin from the command line:

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

## Appwrite CLI

The [Appwrite CLI](https://appwrite.io/docs/tooling/command-line/installation)
(tested with 22.0.0) works against Bunwrite. Either point it at a project with an
API key:

```bash
appwrite client --endpoint http://localhost:8080/v1 --project-id your-project-id --key your-api-key
```

or sign in with a console admin (`bun run console:admin you@example.com`) and
link the folder to a project. Settings need the sign-in; everything else works
with either:

```bash
appwrite login --endpoint http://localhost:8080/v1 --email you@example.com --password '...'
appwrite init project --organization-id <org-id> --project-id <project-id> --project-name <name>
```

The organization ID is on the console's Organization page.

| Command | Pull | Push |
| --- | --- | --- |
| `settings` | project name, services, protocols, sign-in methods, security policies, mock phone numbers | same |
| `tables` / `collections` | databases, tables, columns, indexes | create and alter |
| `functions` | settings and the source code of the latest deployment | settings, then deploy and activate the code |
| `buckets` | bucket settings | create and update |
| `teams` | teams | create and rename |
| `webhooks` | webhooks | create and update |
| `topics` | messaging topics | create and update |
| `all` | all of the above | all of the above |

`whoami` and `logout` work too. For scripts, add `--all --force` to push without
questions, and answer the "pull the code?" question with `--no-code` or `y` on
stdin.

Notes for CLI 22:

- Push functions one at a time (`--function-id <id>`): the CLI can mix up
  archives when it packs several functions in the same millisecond.
- `pull teams` saves whole team objects, which the CLI's own config check then
  refuses on push. Keep only `$id` and `name` for each team in
  `appwrite.config.json`. Appwrite behaves the same.
- `init project` tries to clone Appwrite's agent skills from GitHub; without
  network access it prints an error and links the project anyway.

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

## Bunwrite SDK and CLI

Bunwrite also has its own SDK and CLI in `packages/`, each a separate package
with no dependencies and no code shared with the server:

- [`@bunwrite/sdk`](packages/sdk/README.md): one SDK for browsers, Bun,
  Node.js and edge runtimes. Its services and methods are copied from
  Appwrite's Web and Node.js SDKs, keeping only what Bunwrite serves, so
  switching is usually a change of import. Adds `Render` for the HTML-to-PDF
  and image endpoints.
- [`@bunwrite/cli`](packages/cli/README.md): `bunwrite client`, `login`,
  `init project`, `pull`/`push` of the same `appwrite.config.json` format
  (or `bunwrite.config.json`), function deploys, and one command per SDK
  method.

```ts
import { Client, Databases } from '@bunwrite/sdk'
```

```bash
bunwrite client --endpoint http://localhost:8080/v1 --project-id your-project-id --key your-api-key
bunwrite pull all
```

## Console

Server-rendered pages with htmx, styled after Shopify Polaris, and usable on a
phone.

![Bunwrite Projects Overview](assets/screenshots/screenshot-1.png)

| Area | What you can do |
| --- | --- |
| Projects | Create projects, see their IDs and API keys, switch the active project |
| Organization | Rename the organization, copy its ID, invite members by email and manage owner and developer roles |
| Home | Counts, bandwidth chart with top consumers, failed function runs, memory and database size |
| Databases | Create databases and collections; edit attributes, indexes and permissions; browse, filter, create, edit and delete documents |
| Users | Search; edit profile, labels, verification and prefs; block; set a password; end sessions; delete |
| Teams | Create teams; add members by email or ID; edit roles; prefs |
| Storage | Buckets and their rules; upload, open and delete files; local or S3-compatible storage |
| Functions | Schedule, timeout, who may run it, variables; run now; run history with logs |
| Request logs | Requests with status, duration, bytes, auth, IP, error, referer, user agent and request ID; details, search, filters, pagination, retention |
| Backups | Database snapshots; daily auto backups; optional S3 destination |
| Schema | Export the full config or selected collections; paste/file import with review and delete-missing |
| Settings | Project, email, sign-in, storage, caching, backups, functions, logs and HTML rendering |
| API | Project endpoint, project ID and server API keys |

Settings live in the database and take effect immediately when saved in the
console. Each setting shows whether it is customised or still at its default and
can be reset. The optional first-start values in `.env` are imported once into
the database; later environment changes are ignored.

The console index is the organization page: it lists your projects, with tabs
for the organization members and its settings. Open a project to enter its
dashboard. The project switcher in the sidebar changes which project every page
edits. Apps select a project with the `X-Appwrite-Project` header. The first
project is the existing database; additional projects live under
`data/projects/<project-id>/`. Users, databases, storage, functions, request
logs, backups, settings and API keys are scoped to the selected project.

Organization owners can invite teammates by email. The invitation creates the
console account after it is accepted; until then the member is listed as
invited. When SMTP is not configured the invite dialog shows the one-time links
so they can be shared directly.

## What the API covers

| Area | Endpoints |
| --- | --- |
| Databases | document CRUD, bulk create/upsert/update/delete, increment/decrement, queries, row permissions, transactions with conflict detection, database/collection metadata |
| Account | email + password, email OTP, token sessions, Google OAuth2 token flow, recovery, email verification, JWT, sessions, prefs |
| Users | list/search, create, get/delete, updates, labels, prefs, memberships, sessions, tokens, JWTs, identities |
| Teams | teams, prefs, memberships, invites and accept-invite |
| Storage | buckets (create, update, delete), uploads including chunked (`Content-Range`, `x-appwrite-id`), view/download with byte ranges, permissions, local disk or S3, and previews with every Appwrite option: width, height, gravity, quality, borderWidth, borderColor, borderRadius, opacity, rotation, background, output (jpg, png, webp, avif, gif) |
| HTML rendering (extension) | `POST /v1/pdf` and `POST /v1/image`: HTML to PDF, or to png, jpg, webp, avif and gif, with headless Chromium. Returned or saved to a bucket. Off by default; see [docs/RENDER.md](docs/RENDER.md) |
| Functions | executions (sync/async), list/get, in-process cron, one child process per run, `/v1/functions/<id>/http`; deployments from the CLI and their source download; build commands such as `npm install`, `bun install` and `pip install -r requirements.txt`, also in the Docker image (Python needs `BUNWRITE_WITH_PYTHON=true`) |
| Project | services, protocols and sign-in methods on/off; session duration and limit, user limit, password personal-data check and the other security policies; mock phone numbers |
| Webhooks | CRUD and secret rotation; document create/update/delete events POSTed with Appwrite's headers and HMAC signature; ten failures in a row turn a webhook off |
| Messaging | topics (create, list, update, delete) |
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
  login; magic URLs; sending messages (topics are stored only); Sites;
  scheduled executions.
- Switched-off services, protocols and sign-in methods stop clients; API keys
  and console admins are exempt, as on Appwrite. The password dictionary and
  history, session alert and invalidation, membership privacy and email-domain
  policies, and mock phone numbers are stored and read back but not applied.
- Bucket `encryption`, `antivirus` and `compression` are stored as set; files
  are kept as uploaded.
- Webhooks fire for document events only.
- Function builds run on the host, not in Appwrite's runtime images. Where npm
  is missing (as in the Docker image), only `npm install`, `npm ci`, `npm run`
  and `npx` are available, through Bun. Libraries that compile native code
  while installing need a compiler, which the Docker image does not have;
  packages with prebuilt binaries work.
- Functions share the container's CPU, memory and network; Appwrite gives each
  its own container. In the Docker image each function runs as its own user
  and can only read and write its own folder (`FUNCTIONS_SANDBOX`: `auto` by
  default, `on` to refuse to start without isolation, `off`). Outside Docker,
  or with `no-new-privileges` set, functions run as the server's user, so run
  only code you trust there. Functions that run from the code folder
  (`FUNCTIONS_DIR`) need it readable by other users.
- Previews cannot output HEIC (sharp's prebuilt libvips has no HEVC encoder).
- `studio-render` (Chromium) does not fit in 1 GB of memory.

## Commands

| Command | Does |
| --- | --- |
| `bun run dev` | Watch-mode API + console |
| `bun run build` | Build the standalone `dist/bunwrite` executable |
| `bun run demo` | Self-contained demo with sample data |
| `bun run console:admin <email> [--remove]` | Create, reset or remove a console admin |
| `bun run schema:push <appwrite.config.json> [--prune]` | Create/alter the default project's tables, indexes, buckets and functions |
| `bun run migrate --endpoint .. --project .. --key .. --verify` | Copy a live Appwrite project here |
| `bun run snapshot [dir]` | Consistent copy of the default project database while the server runs |
| `bun run autotune` | Show the resource limits detected from the host/cgroup |
| `bun run stress` | Seed and load-test a running instance (see [scripts/stress/README.md](scripts/stress/README.md)) |
| `bun run typecheck` | TypeScript check |
| `bun test` | Contract tests through the real SDKs |
| `bun run sdk:sync` | Copy the Appwrite SDK code Bunwrite serves into `packages/sdk` |
| `bun run sdk:build` / `bun run cli:build` | Build the SDK and CLI packages into their `dist/` |

## Stress testing

`bun run stress` seeds a collection through the normal API and measures
throughput and latency with `oha` (or a built-in Bun client). See
[scripts/stress/README.md](scripts/stress/README.md) for the 2 vCPU / 2 GB
Docker recipe and custom targets.

## Deploy

For an Ubuntu + systemd setup with the standalone binary, see
[docs/DEPLOY.md](docs/DEPLOY.md).

Or run it with Docker Compose. It auto-tunes to the host's CPU and RAM; set
cgroup limits in `docker-compose.yml` if you share the host with other services:

```bash
cp .env.example .env   # set DOMAIN, COMPOSE_PROFILES=caddy for automatic HTTPS, seeds
docker compose up -d --build
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
development workflow, and [SECURITY.md](SECURITY.md) for reporting security
issues.

## License

MIT. See [LICENSE](LICENSE).
