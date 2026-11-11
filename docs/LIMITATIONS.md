# Limitations and production gaps

Status: 2026-11-12 (Bunwrite 0.9.4).

This is the honest list of what Bunwrite is **not** yet, separate from bugs in
the issue tracker. It is written for people deciding whether to run Bunwrite in
production, and for contributors choosing what to work on next.

Bunwrite is a single-host, Appwrite-compatible backend on Bun with SQLite or
Postgres. The core API, permissions, tests, SQLite tuning and the optional
vector/RAG extension are solid. The gaps below are mostly architectural,
operational and compatibility limits, not small missing endpoints.

Related documents:

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the processes and caches fit together
- [CONFIGURATION.md](CONFIGURATION.md) — every runtime setting
- [DEPLOY.md](DEPLOY.md) — deployment, backups and operations
- [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md) — measured bottlenecks and tuning
- [SITES.md](SITES.md), [GIT.md](GIT.md), [QUEUE.md](QUEUE.md),
  [RENDER.md](RENDER.md), [VECTORS.md](VECTORS.md)

## At a glance

| Area | Current state | Risk |
| --- | --- | --- |
| High availability | One Bunwrite host; SQLite single writer or external Postgres, but no automatic app-level failover | **High** |
| Database backends | SQLite default; Postgres serves the API and console with per-project schemas; offline `migrate:postgres` | **Medium** |
| API key permissions | Console keys can be scoped per API group; old keys without scopes stay full access | **Low/Medium** |
| Backups | Off by default; database archives/PITR, but uploads and external indexes are separate | **High/Medium** |
| Function isolation | Shared CPU/memory/network by default; optional cgroup quotas and bubblewrap sandbox | **High** |
| Console authentication | Password plus optional email MFA; no hardware keys or admin audit trail | **Medium** |
| Appwrite compatibility | Partial; some settings are stored but not applied | **High/Medium** |
| Deployments and migrations | Restart-based, startup migrations, live DDL | **Medium** |
| Write throughput | SQLite: one writer per database and a project-sharded writer pool; Postgres uses the connection pool | **Medium** |
| Observability | Console pages with bounded local telemetry; optional OTLP/Datadog/PostHog export; no Prometheus scrape endpoint or built-in alerting | **Low/Medium** |
| Realtime | SQLite: cross-process event table + polling; Postgres: `LISTEN`/`NOTIFY` | **Medium** |
| Multi-tenancy | Per-project databases/schemas; SQLite control writes share one writer | **Low/Medium** |
| Vector / RAG | Built-in SQL scan with ACLs; optional Qdrant ANN; OCR, evaluation and guardrails | **Low/Medium** |
| Public HTTP caching | Opt-in; default off, with a multi-project caveat | **Low/Medium** |

## P0 — can cause a breach, outage or data loss

### 1. Single-host deployment with no automatic failover

Bunwrite runs the API, console, queue and schedulers on one Bunwrite host.
SQLite adds a single-writer database file; Postgres moves storage to a shared
database, but Bunwrite still has no leader election, read replica or automatic
application failover. Litestream can continuously replicate SQLite databases to
S3-compatible storage and `bunwrite failover` restores them onto a replacement
host, but the promotion is still manual and the old host must be stopped first.

- If the Bunwrite host or its disk fails, Bunwrite is down until the machine is
  rebuilt and a backup is restored.
- On SQLite, one writer handles each database file. `WRITER_SHARDS` spreads
  different projects across writer processes, but a single hot project still
  has one writer.
- Running a SQLite database on NFS/SMB or another network filesystem is not
  safe; SQLite locking depends on a local filesystem.
- A Postgres deployment can use a managed HA database, read replicas and PITR,
  but the Bunwrite application host remains a single point of failure until it
  is replaced.
- The backend is per instance. `bunwrite migrate:postgres` copies a stopped
  SQLite install into Postgres; there is no dual-write or live cross-backend
  replication.
- The supervisor restarts crashed worker processes, but only on the same host.
- `WORKERS` gives more HTTP processes, not more machines.
- More than one Bunwrite machine is listed as future work in
  [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md#later-more-than-one-machine), not an
  implemented feature.

Mitigations: keep the SQLite database on local disk, monitor disk health, use
Litestream plus `bunwrite failover` for host-loss recovery, and plan a
replicated-SQLite design (for example LiteFS) if automatic failover is
required. For Postgres, use a managed HA endpoint with provider PITR and still
plan how to replace the application host. See [DATABASE.md](DATABASE.md) for
the backend details and migration order.

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

### 3. Backups are off by default; PITR is optional

`backups.enabled` defaults to `false`. On SQLite, Bunwrite writes one archive of
the control database and every project database. The optional Litestream
integration provides continuous WAL replication and point-in-time restore to
object storage, but it is not enabled by default and covers databases only.
With Postgres, the Backups page produces periodic `pg_dump` dumps; PITR depends
on the provider.

- Without Litestream or provider PITR, losing the host loses everything written
  since the last archive.
- Archives do not include uploaded files, function code, site builds or the
  optional Qdrant vector index; back up `STORAGE_PATH`, the functions/sites
  folders and Qdrant separately, or rebuild the index from SQL.
- Backup encryption is optional (`BACKUP_ENCRYPTION_KEY`). Without it, archives
  are plaintext; if the key is lost, encrypted archives cannot be opened.
- Restore is offline: upload an archive in **Organization → Backups** and restart
  Bunwrite, or run `bunwrite restore <archive>` with the server stopped. The
  upload is validated before it is staged; the swap happens on the next start.
- There is no scheduled restore drill; `restore --dry-run` checks an archive but
  does not run automatically.

See [DEPLOY.md](DEPLOY.md) for the backup and restore procedure. For vectors,
see [VECTORS.md](VECTORS.md#external-ann-index-qdrant).

### 4. Functions and site builds share the host

Function builds and runs execute on the same machine as the API. They share its
CPU, memory and network.

- `FUNCTIONS_SANDBOX=on` (the Docker Compose default) separates users and
  folders, but not CPU, memory, network or file descriptors.
- `FUNCTIONS_SANDBOX=bwrap` adds private mount, PID, IPC and UTS namespaces, a
  read-only system root and bounded temporary files, and
  `FUNCTIONS_SANDBOX_NETWORK=none` can remove network access. It still shares
  the host kernel.
- Outside Docker, or with `no-new-privileges`, `FUNCTIONS_SANDBOX=auto`/`off`
  can run function code as the server user.
- A function can starve the API, exhaust memory, open many connections or reach
  internal services unless cgroup limits and a network policy are configured.
- Cgroup v2 limits are optional in the default setpriv mode: `FUNCTIONS_CGROUPS=auto`
  does nothing when no writable delegated subtree exists. Bubblewrap mode
  defaults to `on` and refuses to start without limits; use `off` to opt out.
- There are no per-function CPU/memory/time quotas beyond the function timeout
  when cgroups are unavailable.
- Native modules that need a compiler during install do not build in the
  standard Docker image; functions that need them must use prebuilt binaries or
  a custom image.

Bubblewrap is a strong process sandbox, not a virtual machine: a kernel exploit
can still escape it. Do not run hostile multi-tenant code here. For that trust
boundary use a separate Bunwrite instance, a Docker/OCI executor, a microVM or
gVisor.

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

- Queries: `regex`, geo and `exists` are not implemented in the document query
  language. Appwrite's VectorsDB endpoints are not implemented either; Bunwrite
  has a separate `/vectors` and `/rag` extension with point ACLs, hybrid search,
  optional Qdrant ANN, evaluation and OCR (see [VECTORS.md](VECTORS.md)).
- Auth: project-user MFA (TOTP or email) and phone/SMS sign-in are not
  implemented. Console admins have optional email MFA. Magic URL sign-in and
  per-language email templates are supported.
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
- On SQLite, sorting and full-text search differ from PostgreSQL/Appwrite:
  accented first letters sort after `Z`, and English stop words are kept.
  Postgres uses GIN/`tsvector` indexes, but query semantics still differ from
  Appwrite's implementation.
- Every document exposes `$revision`; Appwrite's SDK types do not declare it.
- HEIC output previews are unsupported by the bundled libvips build.

See [README](../README.md#features) for the implemented surface and this
document for the remaining gaps.

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

### 10. Logs, rate limits and control data share the control database

Request logs are stored in `_request_logs`, rate limits in `_rate_limits`, and
project registry/settings data in the control database. Document rows live in
each project's own database or schema.

- Request logging is on by default; at high traffic this adds stdout and
  batched database writes.
- Log retention adds pruning work and disk usage.
- Login and token rate limits are database writes.
- On SQLite, control-database writes share the console writer; project document
  writes use their project writer. On Postgres, both paths use the connection
  pool. A busy control database can still slow console and registry operations.
- The vector/RAG tables (`_vector_points`, `_vector_collections`, evaluation and
  audit rows) live in the project database, so ingest, evaluation and audit
  writes compete with project writes. Qdrant only offloads ANN search.

For throughput-sensitive deployments, turn request logging off or sample it,
and prune aggressively.

### 11. Multi-tenancy is logical, not isolated at the infrastructure level

Each additional project has its own SQLite file or Postgres schema, storage
folder and logical backup set, but all projects share the same host and the
same console.

- On SQLite, every process opens each project database, so a large number of
  projects costs a connection and mmap per project in every process. Postgres
  shares the pool across schemas, but every project still has its own services
  cache and schema.
- On SQLite, write traffic is sharded by project ID: `WRITER_SHARDS` (default:
  one writer per two public workers, capped at 8) starts a pool of writer
  processes, and a public worker forwards a project's short writes to the
  writer that owns that project. A loud project therefore contends with the
  projects on its own shard, not with every project on the instance, and a
  stalled writer only affects writes for its shard. A single hot project still
  has one writer. Postgres does not use writer shards or forwarding.
- On SQLite, console forms follow the selected project to its writer shard.
  Project-list, organization and other control-database pages use the writer
  that owns the synthetic `console` identity, because the console reads
  `_projects`, console sessions and organization data from the separate control
  database. Postgres routes all of these through the pool.
- Console admins can access every project on the instance.
- File permissions are enforced by the sandbox/user model, not by separate
  containers.

For strong tenant isolation, run separate Bunwrite instances per trust boundary.
The SQLite writer pool removes the shared write bottleneck; neither it nor
Postgres schemas turn one instance into a hard multi-tenant boundary.

### 12. Realtime is not a distributed message bus

Realtime writes events to `_realtime_events` and each worker delivers them to
its own WebSocket clients. SQLite workers poll the table; Postgres workers use
`LISTEN`/`NOTIFY`.

- Cross-process delivery on SQLite depends on polling; Postgres uses
  notifications but still on one application host.
- The event table is pruned, but high fan-out adds database load.
- Socket limits depend on file descriptors and per-process backpressure.
- The documented 10k-socket target is a design goal, not a CI-verified
  production guarantee.
- Realtime is not replicated across hosts.
- Custom events are at-most-once for live delivery. They are kept for
  `REALTIME_EVENT_RETENTION_SECONDS` (default one hour) and can be replayed
  with `GET /v1/realtime/events`; there is no automatic WebSocket resume, so a
  client stores its last sequence and asks for the next page. Presence rows
  expire after 60 seconds without a client ping and are cleaned up on
  disconnect.
- Custom publishing is rate-limited per project (`REALTIME_PUBLISH_RATE`,
  default 600 per minute, `0` disables it). The counter is database-backed and
  shared by every worker. A leaked `realtime.write` key still shares that
  project budget.
- Per WebSocket, a client is disconnected after 300 messages per 10 seconds;
  presence updates are limited to 60 per 10 seconds, and presence ping writes
  are throttled to once per 10 seconds. These are fixed safety limits, not
  project settings.
- The console has a **Realtime** page for publishing custom events, inspecting
  active presence and reading the replay buffer. Document-event history and
  WebSocket resume remain unavailable.

## P2 — performance, operations and maintenance

### 13. SQLite has a hard write ceiling; Postgres moves the bottleneck

SQLite has one writer per file. `WRITE_BATCH_MS`, `BEGIN IMMEDIATE`, WAL and the
writer pool reduce contention, but they do not create parallel writers for the
same database. Postgres removes the single-file writer and writer-shard hop,
but a hot row/index and the connection pool still limit one project.

- 10k cached read requests/s is a realistic target after tuning on a multi-core
  host; 10k writes/s on one project is not.
- On SQLite, `bun:sqlite` is synchronous; a long query, checkpoint or busy wait
  blocks the worker's event loop. Postgres uses an async pool.
- On SQLite, all short writes go through a writer process over a loopback HTTP
  hop. The pool is selected by project ID (`WRITER_SHARDS`), so different
  projects write on different writers; the same project always uses one writer.
  If that writer stalls, public workers retry and then fall back to local
  writes. Postgres writes directly through the pool.
- `WORKERS=auto` on 4 vCPU starts 3 public workers plus 1 SQLite writer; the
  supervisor and Caddy add two more processes on the same cores. Postgres does
  not start writer processes.
- Defaults that commonly need tuning: `CACHE_CHECK_MS=0`,
  `MAX_INFLIGHT=200`, `COMPRESSION` depending on the proxy, and the Postgres
  pool size when running many workers.

See [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md) for the measurement plan and
known tuning.

### 14. Observability is opt-in and export-only

- `/health` is a ping, not a database/disk readiness check. It does not check
  Tesseract OCR availability, the Qdrant external index or the ingestion queue.
- The console's Observability pages keep a bounded local copy (per-minute
  metrics, sampled spans and document events); traces, metrics and request logs
  can also be exported over OTLP, Datadog or PostHog
  ([OBSERVABILITY.md](OBSERVABILITY.md)). There is no Prometheus scrape endpoint
  and no database query span.
- Request logs and the console remain the main built-in diagnostics.
- There is no built-in alerting for disk space, WAL growth, backup failure,
  writer failure, queue depth, realtime lag, a stale vector index or OCR
  failures. `GET /vectors/:collectionId/index` reports counts and health, and
  the console can rebuild an index, but neither is a monitored health check.
- Exporters are best-effort: a provider outage drops the oldest queued events
  instead of slowing the API.
- Multi-process issues require correlating stdout or traces from several
  workers; each one exports `service.instance.id`.

For production, add external monitoring, log shipping, disk alerts and a
database/backup check.

### 15. Testing is broad but not a production safety net

The suite has roughly 950 tests. CI runs typecheck, formatting, lint, the test
suite, the server build, and the SDK/CLI/MCP typechecks and builds. It is not the
same as production validation.

- No HA/failover/chaos tests.
- No security audit or fuzzing.
- No sustained soak or performance regression gate in CI.
- CI provisions Postgres for the driver and SQLite-to-Postgres migration tests.
  Qdrant tests run only when `QDRANT_URL` points at a live server, and OCR tests
  skip when Tesseract is not installed; run those integrations in staging or a
  dedicated job.
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
- The optional Qdrant index, OCR/Tesseract host dependency and embedding/chat
  providers add operational surface beyond one Bun process and one database.
- The project is small; plan for bus-factor and upgrade testing.

### 17. Encryption at rest is the operator's responsibility

- SQLite files, Postgres storage and local/S3 storage are not encrypted by
  Bunwrite itself.
- Backup encryption is optional and only covers backups created with a key.
- External Qdrant payloads contain chunk text, metadata and permission strings;
  encrypt its disk and network traffic separately.
- S3 encryption, disk encryption, Postgres provider encryption and key
  management are outside the app.
- TLS protects traffic, not data at rest.

Use full-disk encryption, encrypted volumes, or an encrypted S3 bucket as
appropriate.

### 18. Feature-specific limits

Some limits are documented in their own guides rather than here:

- Vectors/RAG: the built-in store uses a bounded in-process scan, so the point
  cap matters. Qdrant is the only external ANN adapter; pgvector, OpenSearch and
  Vespa are not implemented. Qdrant is a separate service and is not included in
  Bunwrite database backups. The index must be rebuilt after switching providers
  or changing a collection's dimension. Point ACLs exist per chunk; there is no
  separate document ACL or permission inheritance. Evaluation is synchronous,
  multi-hop planning is optional, and guardrails are advisory rather than a
  compliance control. The local embedder is lexical, not semantic.
- OCR/tables: Tesseract and its language data must be installed on the host (or
  enabled in the Docker build). OCR is limited to 20 scanned pages per document
  by default, images above 40 megapixels are rejected, and PDF pages are
  rendered at most at 2000×3000 pixels. Table reconstruction handles simple
  aligned rows, not merged cells, rotated scans or complex financial layouts.
  See [VECTORS.md](VECTORS.md#ocr-tables-and-structure).
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
- SQLite on local disk, or Postgres against a managed database,
- several projects whose combined SQLite write load is spread across the writer
  pool,
- read-heavy or moderate-write traffic,
- trusted function code,
- continuous backup or periodic backups, monitoring and an external proxy
  managed by the operator,
- RAG over trusted documents, with Qdrant treated as an optional external
  service and Tesseract installed where OCR is used,
- accepting a manual restore (minutes of downtime) after a host failure.

Not a safe drop-in for:

- multi-tenant SaaS running untrusted function code,
- deployments that require HA or zero-downtime,
- apps that depend on full Appwrite behavior, project-user MFA or messaging,
- one hot project that needs more than one SQLite writer,
- RAG over hostile documents or untrusted uploads without an independent
  security review, prompt-injection controls and source review,
- an external index or OCR deployment without monitoring and a rebuild plan.

## Suggested order of work

1. **Scoped API keys and console MFA.** Console keys can be scoped and admins
   can opt into email MFA. Remaining work: add TOTP/recovery codes and an admin
   audit log.
2. **Backups: PITR, restore drills, storage and Qdrant guidance.** Make data
   loss recoverable before scaling traffic, including uploads and any external
   vector index.
3. **Function resource isolation.** Optional cgroup v2 CPU/memory/PID limits
   and the bubblewrap process sandbox now ship; remaining work is per-function
   network policy, seccomp profiles, and an external runner for hostile code.
4. **HA and write scaling.** A replicated-SQLite design (for example LiteFS)
   for automatic failover. Postgres provider HA covers the database but not the
   Bunwrite application host. Multi-project SQLite write scaling already ships
   as the project-sharded writer pool (`WRITER_SHARDS`); a single hot project
   still has one writer.
5. **Observability.** Metrics, readiness checks, disk/WAL/backup alerts, and
   health/queue metrics for OCR and the external vector index.
6. **Compatibility and retrieval breadth.** Query operators, messaging,
   webhooks, GraphQL, stored-but-not-applied policies, pgvector/OpenSearch/
   Vespa adapters, and better OCR/table handling.
