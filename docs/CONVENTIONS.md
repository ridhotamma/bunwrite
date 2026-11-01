# Code conventions

This is the rulebook for new code and for modules being refactored. It is
deliberately practical: every rule below is enforced by the formatter, the
linter, or a review checklist item.

Related: [ARCHITECTURE.md](ARCHITECTURE.md), [DATABASE.md](DATABASE.md),
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Formatting

Prettier is the single source of truth. The configuration keeps the existing
look of the project:

- 2 spaces, no tabs
- single quotes, no semicolons, trailing commas
- `printWidth: 160`
- arrow functions keep their parentheses

```bash
bun run format        # write, for the modules that have been migrated
bun run format:check  # CI
```

`format`/`format:check` currently cover the data layer (`src/db`,
`src/documents`, `src/transactions`, `src/settings`, `src/logs`,
`src/variables`, `src/webhooks`, `src/cluster`, `src/schema/push-postgres.ts`).
As a module is refactored it is added to the globs in `package.json`. Do not
reformat a module you are not otherwise touching: it hides the real diff.
`lint` covers all of `src`; keep it at zero errors.

## Linting

```bash
bun run lint        # all of src
```

The ESLint flat config enables `typescript-eslint` recommended rules plus:

- `@typescript-eslint/no-explicit-any` — **error** in the migrated modules
- `@typescript-eslint/consistent-type-imports` — `import type` for types
- `@typescript-eslint/no-unused-vars` — rest-siblings allowed
- `eqeqeq`, `prefer-const`

CI runs the same command, so a new `any` or an unused import fails the build.

## Module shape

One domain per folder:

```
src/<domain>/
  routes.ts    HTTP handlers only: auth/scope checks, params, JSON/shape
  service.ts   Domain rules, validation, orchestration
  ...          Small focused helpers (store, query, codecs, adapters)
```

Rules:

- **Routes are thin.** No SQL, no schema registry access beyond looking up the
  collection, no storage layout knowledge. A route validates input, calls one
  service method, and serialises the result.
- **Services own domain rules.** They may call other services, but a service
  must not know about HTTP (no `Request`/`Response`, no status codes).
- **Storage lives in repositories/ports.** SQL belongs in `src/db`,
  `src/documents`, `src/transactions`, `src/schema` and the still-unmigrated
  services. New code uses the database port (`db.driver`), never a raw
  connection.
- **No cycles.** A helper module may import types from the service, but the
  service must not import the helper's runtime values back. If a cycle appears,
  the shared types belong in a dedicated `types.ts`.

## Database access

The port is documented in [DATABASE.md](DATABASE.md). The rules:

- Use `db.driver` (`all`, `get`, `run`, `exec`) or a service that does.
- Use `db.sqlite` only for a genuinely SQLite-only operation (PRAGMA,
  `VACUUM INTO`, synchronous DDL, backups) and guard it with
  `db.dialect === 'sqlite'` or a capability flag.
- Never open a transaction with raw `BEGIN` in business code. Use
  `db.driver.transaction`, `DocumentStore.runInTransaction` or `runBatch`.
- SQL must be portable: `?` placeholders, quoted identifiers, ISO strings for
  dates, 0/1 for booleans. The Postgres driver translates the documented
  subset and rejects the rest loudly.
- New tables: add them to `src/db/system-schema.ts` and let
  `postgres-schema.ts` derive the Postgres DDL. Do not hand-write a second
  schema.
- Errors: map unique violations through `uniqueViolation()`, not by matching
  one backend's message.

## Async rules

- Database and network work is `async`. Do not add synchronous I/O on a request
  path.
- Do not leave a floating promise. If something is intentionally
  fire-and-forget (`record`, telemetry), write `void promise.catch(log)` and a
  comment saying why.
- A service that loads state at boot exposes `ready()`/`load()`; SQLite may
  load synchronously in the constructor, but a network backend must not block
  the constructor. `services.ready()` and `projects.ready()` are the boot seam.

## Errors and responses

- Use `err('appwrite_type', message, params)` from `src/lib/errors.ts` for
  anything a client can trigger. Do not throw bare `Error` on an API path.
- Internal failures may keep a `cause` (`new Error(message, { cause })`) and are
  logged; the HTTP layer maps them to a generic 500.
- Keep error types stable: clients switch on `type`, not on `message`.

## Naming

| Kind | Convention | Example |
| --- | --- | --- |
| Files, variables, functions | `camelCase` | `collectionVersion` |
| Classes, types, interfaces | `PascalCase` | `DocumentStore` |
| Constants | `SCREAMING_SNAKE_CASE` | `COUNT_LIMIT` |
| Database tables/columns | `snake_case` | `_request_logs`, `created_at` |
| Appwrite API fields | `$` prefix, camelCase | `$createdAt`, `$permissions` |
| React-free console HTML | `html` tagged template | `html\`…\`` |

Plural nouns for collections (`Collection[]`), singular for a service
(`Registry`). Avoid abbreviations unless they are the domain's (`vcs`, `smtp`).

## Types

- No `any` in new or migrated code. Use `unknown` at boundaries and narrow with
  a helper (`recordOf`, `stringOf`, `numberOf` in `documents/access.ts` are the
  pattern).
- Prefer `import type` for type-only imports.
- Non-null assertions (`!`) are only acceptable when the invariant is obvious
  and stated next to them (for example `tx = this.context.getStore()!` inside
  `runInTransaction`).
- Public service methods get an explicit return type.

## Tests

- Behaviour is tested through the public API (the real Appwrite SDK) whenever
  possible; unit tests are for pure helpers and translators.
- Database backends: the SQLite suite must stay green. Postgres tests are
  opt-in through `BUNWRITE_TEST_POSTGRES_URL` and clean up their scratch schema.
- Every refactor step keeps `bun run typecheck`, `bun run lint`,
  `bun run format:check` and `bun test` green before it is committed.
- `test/architecture.test.ts` guards the boundary: the portable modules
  (`documents`, `transactions`, `logs`, `variables`, `webhooks`) may not use
  `.sqlite`, import `bun:sqlite`, or (outside `routes.ts`) import `~/app` or the
  console.

## Refactor rollout

The data layer is done (steps 1–3 in [DATABASE.md](DATABASE.md)). The next
modules, in order, are:

1. `auth/*`, `teams/*` — replace the remaining `this.sql` reads/writes with the
   port; keep password/session rules unchanged.
2. `storage/*`, `functions/*`, `sites/*`, `vcs/*` — service-by-service port and
   split (the largest files: `functions/service.ts`, `sites/service.ts`).
3. Console pages — move their reads behind services; pages stay async and
   render-only.
4. Cluster/backup features can remain SQLite-only behind `db.capabilities`.

Each step: add the module's globs to `format`/`lint`, remove direct SQLite
access or guard it explicitly, and add the module to the integration matrix
when it gains a network backend.

## Review checklist

- [ ] Formatting and lint pass.
- [ ] No new `any`, no floating promises.
- [ ] Routes stay thin; SQL stays in the data layer.
- [ ] Errors are Appwrite types with stable `type` values.
- [ ] Postgres path considered (or explicitly guarded).
- [ ] Tests cover the behaviour, and the full suite is green.
