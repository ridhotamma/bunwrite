# Performance plan: what's left

Status as of 2026-10-30. Throughput targets are estimates to check against
measurements, not promises.

## Background

Bunwrite used to run as one Bun process, and Bun runs request handling on a
single core. Throughput stayed flat however many CPUs the host had: ~790 mixed
rps on a 1 vCPU host and ~766 on a 4-core host. The same code on an 8-core Mac
(one core used) did:

| Path | Production (remote) | Local, logging off | Local, logging on |
| --- | ---: | ---: | ---: |
| services list | ~880 | 8,600 | 8,200 |
| availability | ~930 | 8,600 | 7,900 |
| point read | ~2,200 | 29,000 | 21,400 |
| create (write) | ~580 | 7,200 | 5,900 |

SQLite was never the limit. The ~10x gap between local and production is
larger than a slower VPS core explains, so part of it is likely Caddy, TLS,
Docker networking or the network.

## Done

- [x] **One HTTP worker per CPU** (`WORKERS=auto`, Linux), with a leader for
  background work, cross-process cache reloads and a realtime event bus.
  Design: [ARCHITECTURE.md](ARCHITECTURE.md). Commit `0f2b650`.
- [x] **Request log sampling** (`LOG_SAMPLE_RATE`); errors are always logged.
- [x] **Immediate write transactions.** Every write transaction now starts with
  `BEGIN IMMEDIATE` (`DocumentStore.tx()`, schema, settings, auth, teams,
  storage, sites, functions, variables, request logs, import and the leader
  lease), so a second worker waits on `busy_timeout` instead of failing when a
  read-then-write transaction tries to upgrade.
- [x] **Cache versions on every request.** The `_meta` counters are compared on
  each request by default, so a schema push is visible immediately even in a
  write burst. `CACHE_CHECK_MS` can throttle the check at the cost of a short
  stale window.
- [x] **One version read per request.** `VersionMonitor` now carries the session
  (`auth`) and API-key (`keys`) counters too. The session and key caches reuse
  the request's poll instead of issuing their own `_meta` SELECT.
- [x] **Prefix-indexed router.** `Router` buckets routes by method and first
  static segment, with a small generic list for `/:id` and `/*`. Registration
  order is preserved, so route precedence is unchanged.
- [x] **Cached DB-backed API keys.** Console-created keys are cached per worker
  and invalidated by a trigger on `_api_keys` (`_meta.keys`). Environment keys
  still skip the database entirely.
- [x] **Verified statement reuse.** Hot reads use `db.query()`, which Bun caches
  per `Database` (LRU). `prepare()` remains only for explicit batch work; a
  test guards the assumption.
- [x] **Opt-in public HTTP caching.** Guest document GETs may send a plain
  `public, max-age` when `CACHE_PUBLIC_MAX_AGE` is set; ETag/304 handling is
  unchanged, and session/API-key responses stay private.
- [x] **SQLite mmap** (`SQLITE_MMAP_MB`, default 256 MB, `0` disables it).
- [x] **WAL tuning.** `SQLITE_WAL_AUTOCHECKPOINT` (default 10000 pages) is set
  per connection, so checkpoint stalls are less frequent under several writers.
- [x] **HTTP compression in one place.** `docker-compose.yml` sets
  `COMPRESSION=false` because Caddy compresses at the edge.
  `WEBSOCKET_COMPRESSION` stays independent for realtime frames.
- [x] **Host networking option.** `docker-compose.host.yml` runs Caddy and
  Bunwrite in the host network namespace on Linux, removing the bridge hop.
- [x] **Shared rate limits and sessions.** Login and token counters live in
  `_rate_limits`; session and role lookups are cached for 30 seconds and
  cleared by `_meta.auth` triggers on sessions, users, memberships and teams.
- [x] **Read caches.** Compiled queries, per-collection list results keyed by a
  trigger-maintained version, and `ETag`/304 on document GETs.
- [x] **Session and permission stress variant.** `booking.ts setup` creates a
  logged-in user and a document-security collection; `booking.ts session` runs
  the same paths with a session header.

Verified after the last change: two workers behind one port served 600
concurrent document creates (48 at a time) with 600 successes and no "database
is locked" errors. The new tests cover a write on one connection invalidating
another connection's list cache, a session revocation across connections,
shared rate limits, and ETag invalidation.

## Stress-test follow-up (implemented, not yet measured)

The 2026-10-30 booking run showed a hard tail above ~200 concurrent clients:
`/health` at 400 connections had 0.6–2.4% timeouts while p50 stayed at 13–27 ms,
and some mixed paths went to 0% for a whole run. The likely causes were a proxy
keepalive mismatch and worker 0 doing public traffic plus every SQLite write.

- [x] **Caddy keepalive below Bun's idle timeout.** Caddy's 2m default outlives
  Bun's 10s; the bundled Caddyfiles now use `keepalive 5s`,
  `response_header_timeout 15s`, active health checks and `least_conn`.
- [x] **Dedicated writer process.** A cluster starts `WORKERS` public processes
  plus one writer that never accepts public traffic (`clusterProcessCount`).
- [x] **Per-worker ports.** `WORKER_PORTS=true` binds `PORT..PORT+N-1` so the
  proxy can health-check each process and route around a stalled one.
- [x] **Load shedding.** `MAX_INFLIGHT` (default 200, total across public
  workers) returns `503` + `Retry-After` instead of holding a black-holed
  request; health checks are exempt.
- [x] **Fast reader lock waits.** `SQLITE_READER_BUSY_TIMEOUT_MS` (default
  500 ms) replaces the 5 s wait on public workers; the writer keeps 5 s.
- [ ] Re-run the booking matrix at 200/300/400 clients with `WORKER_PORTS=true`
  to confirm the tail is gone before treating 300+ as safe.

## Still to do, in order

### 1. Measure on the server (first, no app changes)

Confirms the multi-process gain on Linux and shows where the remaining time goes.

- [ ] Run the booking test three ways with the same manifest:
  - directly against `http://127.0.0.1:8080` (app only)
  - against `https://<domain>` from the server itself (app + Caddy + TLS)
  - from a remote machine (everything, including the network)
- [ ] Repeat with `WORKERS=1` and `WORKERS=auto` to measure the multi-process gain.
- [ ] Record CPU per process (`top` / `pidstat`): each worker vs Caddy.
- [ ] Take a 30 s CPU profile of one worker under load (`bun --cpu-prof`).
- [x] Add two variants to [scripts/stress/booking.ts](../scripts/stress/booking.ts):
  a logged-in user (session instead of API key) and a collection with
  per-document permissions. `setup` creates both; `session` runs them.

Done when: one baseline table shows app vs proxy vs network cost, for one and
many workers, and for API-key and session users.

### 2. Make writes safe under several workers

- [x] **Immediate write transactions.** All write transactions use
  `.immediate()`; `busy_timeout` is set before the WAL pragma so workers
  starting together also wait instead of failing.
- [x] **Shared rate limits.** Counters live in `_rate_limits`; every worker
  increments and reads the same window, so N workers no longer give N times the
  limit.
- [x] Load test with several workers: 600 concurrent creates over two workers,
  600 successes, no "database is locked" errors.

### 3. Deployment quick wins

- [x] Compress in one place only: `docker-compose.yml` sets `COMPRESSION=false`
  and keeps Caddy's `encode`. Set `COMPRESSION=true` when Bunwrite is exposed
  directly.
- [x] Remove the Docker network hop: `docker-compose.host.yml` runs both
  containers with `network_mode: host` and points Caddy at `127.0.0.1:8080`.
- [x] Add `PRAGMA mmap_size` (`SQLITE_MMAP_MB`, default 256 MB) in
  [src/db/connection.ts](../src/db/connection.ts).
- [x] Set `LOG_SAMPLE_RATE` (for example 0.1) in production, or turn
  `LOG_REQUESTS` off. Available as an env setting; choose the value per host.
- [ ] If the profile shows CPU steal, move to a VPS with dedicated cores.

Check: rerun step 1.

### 4. Caching

Done. SQLite mmap and the per-worker page cache are in place, as are the
compiled-query, list-result and session caches.

| Step | What | Files |
| --- | --- | --- |
| 4a | [x] **Collection version counter**, increased on every insert, update or delete by triggers on the document table. Visible to every worker through `_meta`. | [src/documents/store.ts](../src/documents/store.ts), [src/db/cluster-schema.ts](../src/db/cluster-schema.ts) |
| 4b | [x] **Parsed-query cache:** query string → compiled SQL in a `WeakMap` keyed by `Collection`, so a registry reload drops it. | [src/documents/query.ts](../src/documents/query.ts) |
| 4c | [x] **Session cache:** session hash → user and roles for 30 s, cleared on logout, user block or update, label and membership changes through `_meta.auth` in every worker. | [src/auth/caller.ts](../src/auth/caller.ts) |
| 4d | [x] **List result cache:** size-limited, keyed by collection, version, the caller's roles and the query string. Views are never cached. | [src/documents/store.ts](../src/documents/store.ts) |
| 4e | [x] **HTTP caching:** ETag/304 on document GETs. `CACHE_PUBLIC_MAX_AGE` allows public caching only when the collection's read permission is `any`; a per-collection override is still open. | [src/documents/routes.ts](../src/documents/routes.ts) |

The cross-worker tests in [test/caching.test.ts](../test/caching.test.ts) cover
"write on worker A, read on worker B" and session revocation. New caches should
keep the same rule: an explicit version or clear on write, checked on the next
request.

### 5. Write path (only if writes still limit)

- [x] Use `RETURNING` on Linux instead of re-reading each inserted row (the
  macOS SQLite 3.39 bug does not apply; Bun bundles its own SQLite on Linux).
  Inserts, updates and increments now use it there.
- [x] Tune `wal_autocheckpoint` (`SQLITE_WAL_AUTOCHECKPOINT`, default 10000 pages).
- [x] **Group several writes into one transaction during peaks.** Single-document
  writes that arrive together now share one transaction (`WRITE_BATCH_MS`,
  default 1 ms in a cluster), each in its own savepoint so one failure does not
  roll back the others. The transaction API and the bulk document endpoints
  already batched; this covers the ordinary one-document-per-request path.
- [x] **Send short database writes to a dedicated writer process.** A cluster
  starts `WORKERS` public processes plus one writer that only opens a loopback
  listener (`WRITER_PORT`, default `PORT + 1`, or `PORT + 100` with
  `WORKER_PORTS`). Public workers forward every short `POST`/`PUT`/`PATCH`/
  `DELETE` API request, not only `/v1/databases`, and short console forms, then
  return the response. This is done in-process rather than in Caddy, so it
  works with any proxy and in direct installs; `WRITER_PORT=0` reverts it. If
  the writer is restarting, readers retry and then serve the write locally.
  Uploads, function executions and deployments, function HTTP endpoints, site
  deployments, render jobs, VCS work, and console forms that upload, build,
  back up or call out stay on the accepting worker, so the split does not
  serialise uploads or function CPU work.
- [x] **Retry a busy write lock.** Write transactions retry `SQLITE_BUSY` /
  `SQLITE_LOCKED` up to five times with jittered exponential backoff. Retries
  only happen before the transaction callback runs, so events or generated IDs
  cannot be duplicated; `busy_timeout` still handles ordinary contention first.

### 5b. Write scaling beyond one writer (not done)

This is an architecture change, not a tuning flag. A single SQLite file still
has one writer, so these are the only ways past it:

- [ ] **Per-project writer pool.** Multiple writer processes, each responsible
  for a hash of project IDs; the public workers choose the writer from the
  project they resolved. This helps only when writes are spread over several
  project databases. It does not help a single hot project, which is the usual
  case.
- [ ] **Postgres for the document path.** The largest change: raw SQL, Drizzle
  dialect, SQLite triggers, FTS, `RETURNING` behavior, transaction staging and
  migration tooling all need porting. This is the only option here that gives
  several writers for one project.
- [ ] **Turso Cloud `BEGIN CONCURRENT`.** Real parallel writers, but a hosted
  `tursodb` database, an async client and an early-preview feature. It is not a
  local-file drop-in and does not fit the current synchronous `bun:sqlite` code
  without a broad refactor.

Do not promise 10k writes/s on one SQLite file. Measure the ceiling first; if
writes dominate and sharding by project does not apply, plan the Postgres
migration separately.

### 6. Fewer calls from the app (pesanle frontend repo)

- [ ] `total=false` unless the UI shows a count (`total=true` runs a second query of up to 5,000 rows).
- [ ] Combine a page's calls into one.
- [ ] Realtime instead of polling.
- [ ] Client-side caching (SWR / React Query).

Capacity is modelled at 5 calls per user per minute; halving that doubles the
user capacity.

## Later: more than one machine

SQLite read replicas (LiteFS; Litestream for backups) can add machines. One
well-tuned 4–8 core box with caching should handle tens of thousands of active
users first.
