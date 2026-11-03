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
| High availability | One host, one SQLite writer; Litestream DR but no automatic multi-host failover | **High** |
| Database backends | SQLite and Postgres serve the API and console (Postgres per-project schemas) | **Medium** |
| API key permissions | Console keys can be scoped per API group; old keys without scopes stay full access | **Low/Medium** |
| Backups | Off by default; whole-instance archives plus optional Litestream PITR | **High/Medium** |
| Function isolation | Shared CPU/memory/network, no quotas | **High** |
| Console authentication | Password plus optional email MFA; no hardware keys or admin audit trail | **Medium** |
| Appwrite compatibility | Partial; some settings are stored but not applied | **High/Medium** |
| Deployments and migrations | Restart-based, startup migrations, live DDL | **Medium** |
| Write throughput | SQLite: one writer per database and a project-sharded writer pool; Postgres uses the connection pool | **Medium** |
| Observability | Console pages with bounded local telemetry; optional OTLP/Datadog/PostHog export; no Prometheus scrape endpoint or built-in alerting | **Low/Medium** |
| Realtime | SQLite: cross-process event table + polling; Postgres: `LISTEN`/`NOTIFY` | **Medium** |
| Multi-tenancy | Per-project databases/schemas; SQLite control writes share one writer | **Low/Medium** |
| Public HTTP caching | Opt-in; default off, with a multi-project caveat | **Low/Medium** |

## P0 — can cause a breach, outage or data loss

### 1. Single-node SQLite, no high availability

There is one SQLite writer per database file and one host. There is no
automatic multi-host failover, no read replica and no multi-writer mode.
Litestream can continuously replicate the databases to S3-compatible storage
and `bunwrite failover` restores them onto a replacement host, but the
promotion is still manual and the old host must be stopped first.

- If the host or disk fails, Bunwrite is down until the machine is rebuilt and
  a backup is restored.
- The supervisor restarts crashed worker processes, but only on the same host.
- `WORKERS` gives more HTTP processes, not more machines.
- Running the database on NFS/SMB or another network filesystem is not safe;
  SQLite locking depends on a local filesystem.
- More than one machine is listed as future work in
  [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md#later-more-than-one-machine), not an
  implemented feature.

Mitigations: keep the database on local disk, monitor disk health, use
Litestream plus `bunwrite failover` for host-loss recovery, and plan a
replicated-SQLite design (for example LiteFS) if automatic failover is
required.

A database port now exists under the data layer (`src/db/driver.ts`) with a
working Postgres driver, runtime schema bootstrap and integration tests against
a real server. Postgres serves the API request path and the console, including
one schema per project and Postgres schema DDL. The scheduler lease and
cross-worker realtime fan-out also work there. Writer sharding and the local
archive/Litestream snapshot flow stay SQLite-only by design; Postgres uses
periodic `pg_dump` backups from the Backups page, or managed PITR. See
[DATABASE.md](DATABASE.md) for the current state and the migration order.

### 2. API key scopes are available, but legacy full-access keys bypass them

Console-created keys carry scopes such as `documents.read`, `users.write` or
`files.write`, and `requireKey()` / `requireScope()` refuse anything outside
them with `general_unauthorized_scope`. A key with no scopes means full access,
so older keys keep working.

- Keys made from the console offer a full-access checkbox; most keys should be
  scoped instead.
- The functions' internal key is always full access and cannot be scoped.
- A scoped key is still a server credential: it is not tied to a user, an IP or
  a session, and cannot be limited to one collection or bucket (only to the API
  group).
- Rotation and expiry remain the way to retire a credential; there is no
  per-request approval.

Legacy full-access keys are the remaining reason this is not fully closed.
Create scoped keys for new integrations and remove unused full-access keys.

### 3. Backups are off by default and are not point-in-time recovery

`backups.enabled` defaults to `false`. When enabled, Bunwrite writes one archive
of the control database and every project database. The optional Litestream
integration provides continuous WAL replication and point-in-time restore to
object storage, but it is not enabled by default and covers databases only, not
uploaded files.

- Without Litestream, losing the host loses everything written since the last archive.
- Archives do not include uploaded files, function code or site builds; back up
  `STORAGE_PATH` and the functions/sites folders separately.
- Backup encryption is optional (`BACKUP_ENCRYPTION_KEY`). Without it, archives
  are plaintext; if the key is lost, encrypted archives cannot be opened.
- Restore is offline: upload an archive in **Organization → Backups** and restart
  Bunwrite, or run `bunwrite restore <archive>` with the server stopped. The
  upload is validated before it is staged; the swap happens on the next start.
- There is no scheduled restore drill; `restore --dry-run` checks an archive but
  does not run automatically.

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

### 5. Console authentication is password plus optional email MFA

Console admins sign in with email and password. An admin can turn on email MFA
on **Security**: after the password, Bunwrite emails a single-use six-digit code.
There is no TOTP/authenticator app, hardware-key support or console-specific
audit trail.

- With MFA off, a stolen password is enough. Turn it on for every production
  admin.
- Email MFA depends on SMTP. If mail delivery stops, sign-in is blocked until an
  operator runs `bunwrite console:admin <email> --no-mfa` on the server.
- The console login and code step are rate-limited, but the code is delivered by
  email, so the admin mailbox is part of the trust boundary.
- The console shows MFA state; it does not provide recovery codes or an
  admin-level "reset another admin's MFA" button.
- The first-run setup is restricted to loopback; remote deployments should
  create the first admin with `bunwrite console:admin` or a one-time env seed.
- Admin sessions are bearer cookies; protect the console host and use HTTPS.
- There is no admin action audit log separate from request logs.

Project-user MFA is still not implemented; this feature protects the console,
not end users. The Appwrite CLI's console sign-in also cannot complete the email
step; with MFA on, use the browser console, or an API key for everything except
the console-only project settings commands.

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

- Queries: `regex`, geo, vector and `exists` are not implemented. Bunwrite has a
  separate built-in `/vectors` and `/rag` extension (see
  [VECTORS.md](VECTORS.md)); Appwrite's VectorsDB endpoints are not implemented.
- Auth: project-user MFA (TOTP or email), phone/SMS sign-in and magic URLs are
  not implemented (magic-url token types exist in the token model, but the full
  client flow is not there). Console admins have optional email MFA.
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

The console's **Public document responses** cache setting is `0` by default, so every document response is private.
When set above zero, guest requests to collections readable by `any` receive:

```http
Cache-Control: public, max-age=N
```

The project is selected by the `X-Appwrite-Project` / `X-Bunwrite-Project`
header, not by the URL. A browser or shared cache that keys only by host, path
and query can therefore serve project A's response for project B on the same
host.

Mitigations:

- Keep the console's **Public document responses** cache at `0` unless you need public caching.
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

- Request logging is on by default; at high traffic this adds stdout and
  batched SQLite writes.
- Log retention adds pruning work and disk usage.
- Login and token rate limits are database writes.
- These writes compete with document writes on the same project's writer.

For throughput-sensitive deployments, turn request logging off or sample it,
and prune aggressively.

### 11. Multi-tenancy is logical, not isolated at the infrastructure level

Each additional project has its own SQLite file, storage folder and backups, but
all projects share the same host and the same console.

- Every process opens the project registry, so a large number of projects costs
  a connection and mmap per project in every process.
- On SQLite, write traffic is sharded by project ID: `WRITER_SHARDS` (default:
  one writer per two public workers, capped at 8) starts a pool of writer
  processes, and a public worker forwards a project's short writes to the
  writer that owns that project. A loud project therefore contends with the
  projects on its own shard, not with every project on the instance, and a
  stalled writer only affects writes for its shard. A single hot project still
  has one writer. Postgres does not use writer shards or forwarding.
- Console forms follow the selected project to its shard. Project-list,
  organization and other control-database pages use the writer that owns the
  default project, because the console reads `_projects`, console sessions and
  organization data there.
- Console admins can access every project on the instance.
- File permissions are enforced by the sandbox/user model, not by separate
  containers.

For strong tenant isolation, run separate Bunwrite instances per trust boundary.
The writer pool removes the shared write bottleneck; it does not turn one
instance into a hard multi-tenant boundary.

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
writer pool reduce contention, but they do not create parallel writers for the
same database.

- 10k cached read requests/s is a realistic target after tuning on a multi-core
  host; 10k writes/s on one project is not.
- `bun:sqlite` is synchronous; a long query, checkpoint or busy wait blocks the
  worker's event loop.
- All short writes go through a writer process over a loopback HTTP hop. The
  pool is selected by project ID (`WRITER_SHARDS`), so different projects write
  on different writers; the same project always uses one writer. If that writer
  stalls, public workers retry and then fall back to local writes.
- `WORKERS=auto` on 4 vCPU starts 3 public workers plus 1 writer; the
  supervisor and Caddy add two more processes on the same cores.
- Defaults that commonly need tuning: `CACHE_CHECK_MS=0`,
  `MAX_INFLIGHT=200`, `COMPRESSION` depending on the proxy.

See [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md) for the measurement plan and
known tuning.

### 14. Observability is opt-in and export-only

- `/health` is a ping, not a database/disk readiness check.
- The console's Observability pages keep a bounded local copy (per-minute
  metrics, sampled spans and document events); traces, metrics and request logs
  can also be exported over OTLP, Datadog or PostHog
  ([OBSERVABILITY.md](OBSERVABILITY.md)). There is no Prometheus scrape endpoint
  and no database query span.
- Request logs and the console remain the main built-in diagnostics.
- There is no built-in alerting for disk space, WAL growth, backup failure,
  writer failure, queue depth or realtime lag.
- Exporters are best-effort: a provider outage drops the oldest queued events
  instead of slowing the API.
- Multi-process issues require correlating stdout or traces from several
  workers; each one exports `service.instance.id`.

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
- several projects whose combined write load is spread across the writer pool,
- one VPS with local disk,
- read-heavy or moderate-write traffic,
- trusted function code,
- continuous backup or periodic backups, monitoring and an external proxy
  managed by the operator,
- accepting a manual restore (minutes of downtime) after a host failure.

Not a safe drop-in for:

- multi-tenant SaaS running untrusted function code,
- deployments that require HA or zero-downtime,
- apps that depend on full Appwrite behavior, project-user MFA or messaging,
- one hot project that needs more than one SQLite writer.

## Suggested order of work

1. **Scoped API keys and console MFA.** Console keys can be scoped and admins
   can opt into email MFA. Remaining work: add TOTP/recovery codes and an admin
   audit log.
2. **Backups: PITR, restore drills, storage backup guidance.** Make data loss
   recoverable before scaling traffic.
3. **Function resource isolation.** Per-function CPU/memory/network limits, or
   an external runner.
4. **HA and write scaling for one hot project.** A replicated-SQLite design
   (for example LiteFS) for automatic failover. Multi-project write scaling
   already ships as the project-sharded writer pool (`WRITER_SHARDS`); a single
   hot project still has one writer.
5. **Observability.** Metrics, readiness checks, disk/WAL/backup alerts.
6. **Compatibility gaps.** Query operators, messaging, webhooks, GraphQL, and
   the stored-but-not-applied policies.
