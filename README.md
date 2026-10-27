# pesanle-backend

A small Appwrite-compatible server for Pesanle: **Bun + SQLite + Drizzle**, one
process, sized for a 1 vCPU / 1 GB VPS. Pesanle's apps keep using the
`appwrite` (27) and `node-appwrite` (29) SDKs unchanged.

It implements the slice of Appwrite that Pesanle uses, not all of Appwrite:
no Console, messaging, GraphQL, MFA, or Docker function runtimes.

On Pesanle's real data (8,758 documents, copied from production): ~80 MB of
memory and ~4,000 list requests a second on a laptop.

## Run

```bash
cp .env.example .env    # PROJECT_ID, API_KEYS, SECRET at minimum
bun install
bun run dev             # http://localhost:8080/v1
bun test                # 90 contract tests through the real SDKs
```

| Command | Does |
| --- | --- |
| `bun run schema:push <appwrite.config.json>` | Create/alter tables, indexes, buckets, functions (`--prune` drops removed collections) |
| `bun run migrate --endpoint .. --project .. --key .. --verify` | Copy a live Appwrite project here, read-only on Appwrite |
| `bun run snapshot [dir]` | Consistent copy of the database while it runs |

Deploying and the cutover plan: [docs/DEPLOY.md](docs/DEPLOY.md).

## What it covers

| Area | Endpoints |
| --- | --- |
| Databases | documents CRUD, bulk create/upsert/update/delete, increment/decrement, every query Pesanle uses, row permissions, transactions with conflict detection, read-only database/collection metadata |
| Account | email + password, email OTP, token sessions, Google OAuth2 token flow, recovery, email verification, JWT, sessions, prefs |
| Users | list/search, create, get/delete, every update Pesanle calls, labels, prefs, memberships, sessions, tokens, JWTs, identities |
| Teams | teams, prefs, memberships (API-key adds confirm at once; owner invites email a link), accept invite |
| Storage | buckets from config, upload incl. chunked (`Content-Range`, `x-appwrite-id`), view/download with byte ranges, resized previews (sharp), permissions |
| Functions | executions (sync/async), list/get, in-process cron, Node functions run by Bun, Python by python3, each in its own process; `/functions/<id>/http` replaces Appwrite's function domains |
| Realtime | WebSocket at `/v1/realtime`: document events to subscribers who may read them (JWT or session) |
| Email | SMTP via nodemailer, Appwrite's English templates |

## How it maps Appwrite onto SQLite

- **Built-in tables** (`_users`, `_sessions`, `_teams`, `_memberships`, `_files`, `_executions`, …)
  are a Drizzle schema in `src/db/system-schema.ts`, migrated from `drizzle/` at startup.
  Views (`v_users`, `v_teams`, …) let Appwrite queries run on them with the same compiler.
- **Each collection** is a real table `d<dbSeq>_<collectionId>` with one column per attribute,
  plus `_seq` (`$sequence`), `_id`, `_createdAt`, `_updatedAt`, `_permissions`.
- **Permissions** live in `<table>__perms (doc, type, role)`, so read filtering is one indexed `IN`.
- **Full-text indexes** are FTS5 tables with the porter stemmer, kept in sync by triggers.
- **Transactions** stage operations and replay them in one SQLite transaction on commit; a
  document changed after its operation was staged fails with `transaction_conflict`.
- **Secrets** (sessions, tokens, invites) are stored as sha256 only. Passwords are argon2id with
  Appwrite's parameters; imported bcrypt/sha/md5/scrypt hashes still verify.

## Checked against the live server

- 21 query patterns on the copied `products` collection: 19 return identical results; the other two (sort by name, both directions) differ only by the accented-letter rule below.
- User, session, team and membership responses: same fields, same order, same types.
- Full migration of production with document-by-document comparison: 0 mismatches.
- Error bodies use Appwrite's exact types and messages (generated from `app/config/errors.php`).

Known differences:

- An accented first letter sorts after `Z` (`Éclair` after `Yogurt`); PostgreSQL sorts it with `E`.
- Search keeps English stop words ("the", "and") that PostgreSQL drops.
- On the raw wire some documents list `$id` before their attributes where live lists it after;
  the SDKs parse both to the same object.
- `regex`, geo, vector and `exists` queries, MFA, phone/SMS login, magic URLs, messaging,
  scheduled executions (`scheduledAt`) and the Console are not implemented.
- `studio-render` (Chromium) does not fit in 1 GB of memory.
