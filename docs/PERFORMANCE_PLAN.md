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
- [ ] Add two variants to [scripts/stress/booking.ts](../scripts/stress/booking.ts):
  a logged-in user (session instead of API key) and a collection with
  per-document permissions.

Done when: one baseline table shows app vs proxy vs network cost, for one and
many workers, and for API-key and session users.

### 2. Make writes safe under several workers

- [ ] **Immediate write transactions.** `DocumentStore.tx()` in
  [src/documents/store.ts](../src/documents/store.ts) opens a deferred
  transaction. Update, upsert, delete and increment read the row first, then
  write; when two workers do this at once, SQLite returns "database busy" at
  once instead of waiting on `busy_timeout`. Use `.immediate()` for write
  transactions, as [src/transactions/service.ts](../src/transactions/service.ts)
  and [src/instance/bootstrap.ts](../src/instance/bootstrap.ts) already do.
  Check the other services' write transactions for the same pattern.
- [ ] **Shared rate limits.** [src/lib/limits.ts](../src/lib/limits.ts) counts
  in memory, so with N workers a client gets up to N times the limit. Move the
  counters to a SQLite table, or accept the looser limit and document it.
- [ ] Load test with 30% writes and several workers; expect zero
  "database is locked" errors.

### 3. Deployment quick wins

- [ ] Compress in one place only: `COMPRESSION=false` in the app and keep
  Caddy's `encode` with a 1 KB minimum, or the other way round.
- [ ] Remove the Docker network hop: `network_mode: host`, or a Unix socket
  between Caddy and Bun.
- [ ] Add `PRAGMA mmap_size` (for example 256 MB) in
  [src/db/connection.ts](../src/db/connection.ts).
- [ ] Set `LOG_SAMPLE_RATE` (for example 0.1) in production, or turn
  `LOG_REQUESTS` off.
- [ ] If the profile shows CPU steal, move to a VPS with dedicated cores.

Check: rerun step 1.

### 4. Caching

| Step | What | Files |
| --- | --- | --- |
| 4a | **Collection version counter**, increased on every insert, update or delete. Must be visible to every worker (a `_meta`-style counter, like the cluster cache versions). | [src/documents/store.ts](../src/documents/store.ts) |
| 4b | **Parsed-query cache:** query string → compiled SQL, cleared when the schema reloads. | [src/documents/query.ts](../src/documents/query.ts) |
| 4c | **Session cache:** session hash → user and roles, kept 30 s. Cleared on logout, user block or update, label and membership changes, in every worker. | [src/auth/caller.ts](../src/auth/caller.ts), [src/auth/service.ts](../src/auth/service.ts), teams |
| 4d | **List result cache:** size-limited, keyed by collection, version, the caller's roles and the query string. | [src/documents/store.ts](../src/documents/store.ts) |
| 4e | **HTTP caching:** ETag/304 on GETs. Optional `Cache-Control: public, max-age=N` per collection, only when its read permission is `any`. | [src/documents/routes.ts](../src/documents/routes.ts), collection settings |

Main risk: stale data or stale permissions, now across workers. Every cache
needs an explicit clear on write, with tests such as "write on worker A, read
on worker B sees it" and "block user, their next request on any worker fails".

### 5. Write path (only if writes still limit)

- [ ] Use `RETURNING` on Linux instead of re-reading each inserted row (the
  macOS SQLite 3.39 bug does not apply; Bun bundles its own SQLite on Linux).
- [ ] Tune `wal_autocheckpoint`.
- [ ] Group several writes into one transaction during peaks.
- [ ] If lock waits dominate profiles, send write methods to a single writer
  worker through Caddy (the transaction API and writes from functions too).

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
