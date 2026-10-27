# pesanle-backend

An Appwrite-compatible server for Pesanle, with a built-in admin console.
**Bun + SQLite + Drizzle**, one process, sized for a 1 vCPU / 1 GB VPS.
Pesanle's apps keep using the `appwrite` (27) and `node-appwrite` (29) SDKs unchanged.

It implements the slice of Appwrite that Pesanle uses, not all of Appwrite:
no messaging, GraphQL, MFA or Docker function runtimes.

On Pesanle's real data (8,758 documents, copied from production): ~80 MB of
memory and ~4,000 list requests a second on a laptop.

## Run

```bash
cp .env.example .env    # PROJECT_ID, API_KEYS, SECRET at minimum
bun install
bun run dev             # API at http://localhost:8080/v1, console at /console
bun test                # 131 contract tests through the real SDKs
```

On first run, create a console admin with `bun run console:admin you@example.com`.
Opened from the server itself, `/console` offers to create one instead.

| Command | Does |
| --- | --- |
| `bun run console:admin <email> [--remove]` | Create a console admin, reset their password, or remove them |
| `bun run schema:push <appwrite.config.json>` | Create/alter tables, indexes, buckets and functions (`--prune` drops removed collections) |
| `bun run migrate --endpoint .. --project .. --key .. --verify` | Copy a live Appwrite project here, read-only on Appwrite |
| `bun run snapshot [dir]` | Consistent copy of the database while it runs |
| `bun scripts/console-demo.ts` | Throwaway demo with sample data on :8790 |

- **How it works:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Deploying and cutting over:** [docs/DEPLOY.md](docs/DEPLOY.md)

## The console (`/console`)

Server-rendered pages with htmx, styled after Shopify Polaris, and usable on a phone.

| Area | What you can do |
| --- | --- |
| Home | Counts, bandwidth chart with top consumers, failed function runs, memory and database size |
| Databases | Create databases and collections; edit attributes (a type change keeps the data), indexes and permissions; browse, filter, create, edit and delete documents |
| Users | Search; edit profile, labels, verification and prefs; block; set a password; end sessions; delete |
| Teams | Create teams; add members by email or ID; edit roles; prefs |
| Storage | Buckets and their rules; upload, open and delete files; local or S3-compatible file storage |
| Backups | Create, download and delete database snapshots; daily auto backups; optional S3 backup destination |
| Functions | Schedule, timeout, who may run it, variables; run now; run history with logs |
| Request logs | Requests with status, duration, bytes, auth, IP, error, referer, user agent and request ID; open details, search, filter, paginate, clear; retention/IP settings |
| Schema | Export as `appwrite.config.json`; import with a preview before anything changes |
| Settings | Project name, allowed origins, session length; SMTP with a test email; Google sign-in; API keys; console admins; paused schedules; global function variables with bulk `.env` import |

Settings saved in the console override the matching env vars and take effect
immediately. Each setting shows whether it comes from env or from the console,
and can be reset to env.

## What the API covers

| Area | Endpoints |
| --- | --- |
| Databases | documents CRUD, bulk create/upsert/update/delete, increment/decrement, every query Pesanle uses, row permissions, transactions with conflict detection, read-only database/collection metadata |
| Account | email + password, email OTP, token sessions, Google OAuth2 token flow, recovery, email verification, JWT, sessions, prefs |
| Users | list/search, create, get/delete, every update Pesanle calls, labels, prefs, memberships, sessions, tokens, JWTs, identities |
| Teams | teams, prefs, memberships (API-key adds confirm at once; owner invites email a link), accept invite |
| Storage | upload incl. chunked (`Content-Range`, `x-appwrite-id`), view/download with byte ranges, resized previews (sharp), permissions |
| Functions | executions (sync/async), list/get, in-process cron, each run in its own process; `/v1/functions/<id>/http` replaces Appwrite's function domains |
| Realtime | WebSocket at `/v1/realtime`: document events to subscribers who may read them |
| Email | SMTP via nodemailer, Appwrite's English templates |

Abuse limits match Appwrite's: 10 tries an hour per IP and account on
sign-in, codes and recovery for browsers (API keys are exempt), and ten
wrong codes cancel the real one.

## Checked against the live server

- Of 21 query patterns on the copied `products` collection, 19 return identical results. The other two (sort by name, both directions) differ only by the accented-letter rule below.
- User, session, team and membership responses have the same fields, order and types.
- A full migration of production, compared document by document: 0 mismatches.
- Error bodies use Appwrite's exact types and messages (generated from `app/config/errors.php`).

Known differences:

- An accented first letter sorts after `Z` (`Éclair` after `Yogurt`); PostgreSQL sorts it with `E`.
- Search keeps English stop words ("the", "and") that PostgreSQL drops.
- On the raw wire, some documents list `$id` before their attributes where live lists it after;
  the SDKs parse both to the same object.
- Not implemented: `regex`, geo, vector and `exists` queries; MFA; phone/SMS login; magic URLs;
  messaging; scheduled executions (`scheduledAt`).
- `studio-render` (Chromium) does not fit in 1 GB of memory.
