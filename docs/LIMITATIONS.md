# Limitations and production gaps

Status: 2026-10-31.

This is the honest list of what Bunwrite is **not** yet, separate from bugs in
the issue tracker. It is written for people deciding whether to run Bunwrite in
production, and for contributors choosing what to work on next.

Bunwrite is a single-node, Appwrite-compatible backend on Bun and SQLite. The
core API, permissions, tests and SQLite tuning are solid. The gaps below are
mostly architectural and compatibility limits, not small missing endpoints.

Related documents:

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the processes and caches fit together
- [CONFIGURATION.md](CONFIGURATION.md) — every runtime setting
- [DEPLOY.md](DEPLOY.md) — deployment, backups and operations
- [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md) — measured bottlenecks and tuning
- [SITES.md](SITES.md), [GIT.md](GIT.md), [QUEUE.md](QUEUE.md), [RENDER.md](RENDER.md)

## At a glance

| Area | Current state | Risk |
| --- | --- | --- |
| High availability | One host, one SQLite writer, no replication | **High** |
| API key permissions | Project-wide keys without scopes | **High** |
| Backups | Off by default, snapshots only, no PITR | **High** |
| Function isolation | Shared CPU/memory/network, no quotas | **High** |
| Console authentication | Password only, no MFA | **High** |
| Appwrite compatibility | Partial; some settings are stored but not applied | **High/Medium** |
| Deployments and migrations | Restart-based, startup migrations, live DDL | **Medium** |
| Write throughput | One writer per database; no horizontal write scale | **Medium** |
| Observability | Request logs only; no metrics or tracing | **Medium** |
| Realtime | Cross-process SQLite event bus and polling | **Medium** |
| Multi-tenancy | Per-project databases, but one shared writer process | **Medium** |
| Public HTTP caching | Opt-in; default off, with a multi-project caveat | **Low/Medium** |

## P0 — can cause a breach, outage or data loss

### 1. Single-node SQLite, no high availability

There is one SQLite writer per database file and one host. There is no
replication, no automatic failover, no read replica and no multi-writer mode.

- If the host or disk fails, Bunwrite is down until the machine is rebuilt and
  a backup is restored.
- The supervisor restarts crashed worker processes, but only on the same host.
- `WORKERS` gives more HTTP processes, not more machines.
- Running the database on NFS/SMB or another network filesystem is not safe;
  SQLite locking depends on a local filesystem.
- More than one machine is listed as future work in
  [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md#later-more-than-one-machine), not an
  implemented feature.

Mitigations: keep the database on local disk, monitor disk health, take
off-host backups, and plan a Postgres or replicated-SQLite migration if the
service must survive a host failure.

### 2. API keys are all-or-nothing

`_api_keys` has no scopes. `requireKey()` only checks whether the caller is
privileged, so every valid API key can perform every API-key action in the
project: users, databases, storage, functions, settings and console-facing
platform APIs.

- A leaked key is effectively full project admin.
- Environment `API_KEYS` behave the same way.
- Appwrite's scoped API keys are not implemented.
- Rotation, expiry and separate keys per integration are the only current
  mitigations.

This is one of the highest-value gaps to close before exposing Bunwrite to
third-party integrations.

### 3. Backups are off by default and are not point-in-time recovery

`backups.enabled` defaults to `false`. When enabled, Bunwrite takes periodic
SQLite snapshots; it does not continuously archive WAL or support PITR.

- Losing the host loses everything written since the last snapshot.
- Database backups do not include uploaded files; back up `STORAGE_PATH` or the
  S3 bucket separately.
- Backup encryption is optional (`BACKUP_ENCRYPTION_KEY`). Without it, backups
  are plaintext; if the key is lost, encrypted backups cannot be opened.
- Restore is a manual file replacement, not an online operation.
- There is no built-in restore verification or scheduled restore drill.

See [DEPLOY.md](DEPLOY.md) for the backup and restore procedure.

### 4. Functions and site builds share the host

Function builds and runs execute on the same machine as the API. They share its
CPU, memory and network.

- `FUNCTIONS_SANDBOX=on` (the Docker Compose default) separates users and
  folders, but not CPU, memory, network or file descriptors.
- Outside Docker, or with `no-new-privileges`, `FUNCTIONS_SANDBOX=auto`/`off`
  can run function code as the server user.
- A function can starve the API, exhaust memory, open many connections or reach
  internal services.
- There are no per-function CPU/memory/time quotas beyond the function timeout.
- Native modules that need a compiler during install do not build in the
  standard Docker image; functions that need them must use prebuilt binaries or
  a custom image.

Do not run untrusted third-party code here. Appwrite's per-function container
isolation is not implemented.

### 5. Console authentication is password-only

Console admins sign in with email and password. There is no second factor,
hardware-key support or console-specific audit trail.

- The console login is rate-limited, but a stolen password is enough.
- The first-run setup is restricted to loopback; remote deployments should
  create the first admin with `bunwrite console:admin` or a one-time env seed.
- Admin sessions are bearer cookies; protect the console host and use HTTPS.
- There is no admin action audit log separate from request logs.

MFA settings exist in the project policy model but are not enforced as a
sign-in factor.

### 6. Deployments and migrations are restart-based

Workers run migrations when they open the database. A cluster serializes this
with a migration lock, but it is still a startup migration.

- A long migration blocks worker boot; other workers wait for the lock.
- A process that dies while holding the lock can delay others until the stale
  lock timeout.
- Schema pushes and console schema edits run DDL against a live database.
- Deploys restart the process group. There is no rolling or blue/green deploy;
  in-flight requests can fail during a restart.
- There is no online migration framework for large tables.

## P1 — compatibility, correctness and security expectations

### 7. Appwrite compatibility is partial

Bunwrite implements the common Appwrite API surface, but not all of it. Some
features are missing; some are accepted and stored but do not change behavior.
That second category is the dangerous one: the console or SDK can make a
feature look enabled when it is not enforced.

Current known gaps:

- Queries: `regex`, geo, vector and `exists` are not implemented.
- Auth: MFA, phone/SMS sign-in and magic URLs are not implemented (magic-url
  token types exist in the token model, but the full client flow is not there).
- Messaging: topics are stored, but sending messages is not implemented.
- GraphQL: the protocol/service toggle exists, but there is no GraphQL route in
  this codebase.
- Webhooks fire for document events only; user, team, storage, function and
  other events are not delivered.
- Password dictionary/history, session alert/invalidation policies, membership
  privacy and email-domain policies, and mock phone numbers are stored and read
  back but not applied.
- Bucket `encryption`, `antivirus` and `compression` settings are stored as set;
  files are kept as uploaded.
- Sorting and full-text search differ from PostgreSQL/Appwrite: accented first
  letters sort after `Z`, and English stop words are kept.
- Every document exposes `$revision`; Appwrite's SDK types do not declare it.
- HEIC output previews are unsupported by the bundled libvips build.

See the “Known differences from Appwrite” section in the
[README](../README.md#known-differences-from-appwrite) for the version this doc
was written against.

### 8. Public HTTP caching has a multi-project caveat

`CACHE_PUBLIC_MAX_AGE` is `0` by default, so every document response is private.
When set above zero, guest requests to collections readable by `any` receive:

```http
Cache-Control: public, max-age=N
```

The project is selected by the `X-Appwrite-Project` / `X-Bunwrite-Project`
header, not by the URL. A browser or shared cache that keys only by host, path
and query can therefore serve project A's response for project B on the same
host.

Mitigations:

- Keep `CACHE_PUBLIC_MAX_AGE=0` unless you need public caching.
- Use one hostname per project.
- Or add `Vary: X-Appwrite-Project, X-Bunwrite-Project, Origin` and configure
  the shared cache's key to include the project header.
- Keep the TTL short; there is no purge-on-write for browser/CDN caches.

### 9. Cache invalidation has a configurable window

Cross-process caches use counters in `_meta`. Workers compare them on each
request by default. `CACHE_CHECK_MS` can throttle the check.

- With `CACHE_CHECK_MS=0`, sessions and API keys are invalidated on the next
  request.
- With a positive interval, a revoked session or key can remain usable for up to
  that interval.
- Schema, settings, project and catalog changes have the same window.

Default `0` is safest; `100–250` is a reasonable performance trade-off for many
deployments.

### 10. Logs, rate limits and real application data share SQLite

Request logs are stored in `_request_logs`, rate limits in `_rate_limits`, and
the application data in the same database file.

- `LOG_REQUESTS` defaults to `true`; at high traffic this adds stdout and
  batched SQLite writes.
- Log retention adds pruning work and disk usage.
- Login and token rate limits are database writes.
- These writes compete with document writes on the same writer.

For throughput-sensitive deployments, turn request logging off or sample it,
and prune aggressively.

### 11. Multi-tenancy is logical, not isolated at the infrastructure level

Each additional project has its own SQLite file, storage folder and backups, but
all projects share the same host, the same writer process and the same console.

- A noisy project can affect the writer and therefore other projects' writes.
- All project databases are opened by every process (the project registry).
- The writer process routes all short writes, not one writer per project.
- Console admins can access every project on the instance.
- File permissions are enforced by the sandbox/user model, not by separate
  containers.

For strong tenant isolation, run separate Bunwrite instances per trust boundary.

### 12. Realtime is not a distributed message bus

Realtime writes events to `_realtime_events`; other workers poll that table and
deliver to their own WebSocket clients.

- Cross-process delivery depends on SQLite polling.
- The event table is pruned, but high fan-out adds database load.
- Socket limits depend on file descriptors and per-process backpressure.
- The documented 10k-socket target is a design goal, not a CI-verified
  production guarantee.
- Realtime is not replicated across hosts.

## P2 — performance, operations and maintenance

### 13. Performance has a hard write ceiling and unsafe defaults

SQLite has one writer per file. `WRITE_BATCH_MS`, `BEGIN IMMEDIATE`, WAL and the
dedicated writer reduce contention, but they do not create parallel writers.

- 10k cached read requests/s is a realistic target after tuning on a multi-core
  host; 10k writes/s on one project is not.
- `bun:sqlite` is synchronous; a long query, checkpoint or busy wait blocks the
  worker's event loop.
- All short writes go through one writer process over a loopback HTTP hop. If
  that writer stalls, public workers retry and then fall back to local writes.
- `WORKERS=auto` on 4 vCPU starts 4 public workers plus 1 writer; Caddy may be a
  sixth process on the same cores.
- Defaults that commonly need tuning: `LOG_REQUESTS=true`, `CACHE_CHECK_MS=0`,
  `MAX_INFLIGHT=200`, `COMPRESSION` depending on the proxy.

See [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md) for the measurement plan and
known tuning.

### 14. Observability is thin

- `/health` is a ping, not a database/disk readiness check.
- There is no Prometheus/OpenTelemetry metrics or tracing endpoint.
- Request logs and the console are the main diagnostics.
- There is no built-in alerting for disk space, WAL growth, backup failure,
  writer failure, queue depth or realtime lag.
- Multi-process issues require correlating stdout from several workers.

For production, add external monitoring, log shipping, disk alerts and a
database/backup check.

### 15. Testing is broad but not a production safety net

The test suite is substantial and CI runs typecheck, tests, the build, and the
SDK/CLI packages. It is not the same as production validation.

- No HA/failover/chaos tests.
- No security audit or fuzzing.
- No sustained soak or performance regression gate in CI.
- Stress scripts exist but are manual.
- Linux CI and macOS local runs can use different SQLite builds and query
  fallbacks (`RETURNING` is disabled on macOS).

### 16. Maintenance surface is large

Bunwrite implements a large Appwrite-compatible surface with raw SQL, a custom
query compiler, generated SDK/CLI packages, sites, functions, VCS, storage,
messaging and backups.

- Appwrite SDK/API changes require ongoing compatibility work.
- Some features are intentionally partial; the README and this document must be
  updated when they change.
- Raw SQL and schema triggers make some database changes harder to port to
  another engine.
- The project is small; plan for bus-factor and upgrade testing.

### 17. Encryption at rest is the operator's responsibility

- SQLite files and local storage are not encrypted by Bunwrite.
- Backup encryption is optional and only covers backups created with a key.
- S3 encryption, disk encryption and key management are outside the app.
- TLS protects traffic, not data at rest.

Use full-disk encryption, encrypted volumes, or an encrypted S3 bucket as
appropriate.

### 18. Feature-specific limits

Some limits are documented in their own guides rather than here:

- Sites: no WebSocket/HTTP upgrades into SSR apps and no background workers that
  outlive a request; uploaded archives with `node_modules` are not supported.
  See [SITES.md](SITES.md#not-supported).
- Git: GitHub only; GitLab and Bitbucket are not supported. See
  [GIT.md](GIT.md).
- Queue: see [QUEUE.md](QUEUE.md) for worker and delivery semantics.
- Render: Chromium is opt-in, serialized and memory-hungry; see
  [RENDER.md](RENDER.md).

## What this means for production

Reasonable today:

- one team or a small number of trusted projects,
- one VPS with local disk,
- read-heavy or moderate-write traffic,
- trusted function code,
- backups, monitoring and an external proxy managed by the operator.

Not a safe drop-in for:

- multi-tenant SaaS running untrusted function code,
- deployments that require HA or zero-downtime,
- apps that depend on full Appwrite behavior, MFA, scoped keys or messaging,
- one hot project that needs more than one SQLite writer.

## Suggested order of work

1. **Scoped API keys and console MFA.** Least privilege and admin account
   protection have the highest security return.
2. **Backups: PITR, restore drills, storage backup guidance.** Make data loss
   recoverable before scaling traffic.
3. **Function resource isolation.** Per-function CPU/memory/network limits, or
   an external runner.
4. **HA and write scaling.** Postgres for one hot project, or a replicated
   SQLite design for read scaling and failover.
5. **Observability.** Metrics, readiness checks, disk/WAL/backup alerts.
6. **Compatibility gaps.** Query operators, messaging, webhooks, GraphQL, and
   the stored-but-not-applied policies.
