# Configuration reference

Bunwrite reads `.env` from the working directory. Project identity and most
application settings live in the database and are managed in the console; this
file is about the server process, deployment and first-start values.

[`.env.example`](../.env.example) is a short starting point. This page is the
full reference.

## Minimal setup

```bash
cp .env.example .env
# set DOMAIN for a public server; leave it empty for localhost
docker compose up -d --build
# or: bun install && bun run dev
```

The only value most deployments need is `DOMAIN`. Everything else has a default.
Project settings (SMTP, OAuth, origins, sessions, API keys, render, cache,
vectors/RAG, logs and observability) are configured in the console, not here.

## Server

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `0.0.0.0` (example: `127.0.0.1`) | Address Bun listens on. Use `127.0.0.1` when Caddy, nginx or cloudflared runs on the same host. Docker sets it to `0.0.0.0` inside the container. |
| `PORT` | `8080` | HTTP port. Must be a number; an empty value is parsed as `0` (random port). |
| `API_COMPAT` | `bunwrite` | Names Bunwrite sends: `bunwrite` or `appwrite`. Both naming families are always accepted. |
| `OAUTH_STATE_BINDING` | `true` | Bind OAuth callbacks to a browser cookie. Set `false` only for legacy server-side flows that cannot preserve `Set-Cookie`. |
| `COMPOSE_PROFILES` | `caddy` in `.env.example` | `caddy` starts the bundled Caddy container in Docker Compose. Remove it for your own proxy or a Cloudflare Tunnel. |

`API_COMPAT` only changes what the server sends, not what it reads. A request
may mix the two header families; the same header in both must carry the same
value, and an empty header counts as absent:

| | `bunwrite` | `appwrite` |
| --- | --- | --- |
| Session cookie | `bw_session_<project>` | `a_session_<project>` |
| Webhook headers | `X-Bunwrite-Webhook-*` | `X-Appwrite-Webhook-*` |
| Function variables | `BUNWRITE_*` | `BUNWRITE_*` and `APPWRITE_*` |
| User/session secrets | omitted/redacted | legacy Appwrite fields only for keys with `users.secrets` |

Use `appwrite` when moving an existing Appwrite app so webhook receivers and
functions keep working unchanged. Bunwrite mode is the secure native model;
Appwrite mode is the compatibility shim.

## Domains and HTTPS

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOMAIN` | unset | Public hostname, without `https://` or a path. Also sets `PUBLIC_ENDPOINT` to `https://<DOMAIN>/v1`. |
| `PUBLIC_ENDPOINT` | derived | Public API URL including `/v1`, used by OAuth callbacks and file links. Set it when TLS ends at a tunnel or another host. |
| `SITES_PREFIX` | `sites` | Site host prefix: `<site-id>.<prefix>.<DOMAIN>`. |
| `FUNCTIONS_PREFIX` | `functions` | Function host prefix: `<function-id>.<prefix>.<DOMAIN>`. |
| `SITES_DOMAIN` | `sites.<DOMAIN>` or `sites.localhost` | Overrides the whole site base domain. |
| `FUNCTIONS_DOMAIN` | `functions.<DOMAIN>` or `functions.localhost` | Overrides the whole function base domain. |
| `TLS_MODE` | `acme` | `acme` lets the bundled Caddy obtain certificates; `external` serves `TLS_CERT_FILE`/`TLS_KEY_FILE` (a Cloudflare Origin Certificate, certbot, a private CA) and still uses on-demand ACME for hosts the certificate does not cover; `off` leaves TLS to an upstream proxy or tunnel and serves HTTP only. |
| `TLS_CERT_FILE` | unset | PEM certificate chain for `TLS_MODE=external`, inside the Caddy container (for example `/certs/origin.pem`). |
| `TLS_KEY_FILE` | unset | Private key for `TLS_MODE=external`, inside the Caddy container. |
| `TLS_CERT_DIR` | `./certs` | Host directory mounted at `/certs` in the Caddy container. |
| `CADDY_WAIT_DNS` | `true` in `acme`, `false` otherwise | With the bundled Caddy, wait for `DOMAIN` to resolve before starting. |
| `CADDY_WAIT_IP` | unset | Address `DOMAIN` should resolve to while Caddy waits. |
| `TRUSTED_PROXIES` | `private` | Which peers may supply `X-Forwarded-For` / `CF-Connecting-IP`. See [request logs](#request-logs-and-client-ip). |

With `DOMAIN=appwrite.example.com`:

- Site `landing` answers on `landing.sites.appwrite.example.com`
- Function `hello` answers on `hello.functions.appwrite.example.com`

Each site and function also keeps its default address when you add custom
domains. Custom domains can be added in the console, with a `domains` array on
the API, or through Appwrite's proxy rules.

### Caddy

The bundled Caddy container can terminate TLS itself or sit behind a provider.
`TLS_MODE` selects which:

| `TLS_MODE` | TLS terminates at | Certificates |
| --- | --- | --- |
| `acme` (default) | Caddy | Caddy obtains and renews them from an ACME CA |
| `external` | Caddy | The files in `TLS_CERT_FILE` / `TLS_KEY_FILE`; on-demand ACME covers hosts they do not include |
| `off` | An upstream proxy or tunnel | The provider's; Caddy listens on port 80 and forwards |

In `acme` mode Caddy asks Bunwrite (`/.well-known/bunwrite/host`) before issuing
a certificate for a host. It needs:

- A DNS A/AAAA record for `DOMAIN`
- Wildcard A/AAAA records for `*.sites.<DOMAIN>` and `*.functions.<DOMAIN>`
- Ports 80 and 443 open

Custom domains need their own CNAME (to `<site-id>.<SITES_DOMAIN>` or the
function's default host) or A record, plus a certificate through Caddy's
on-demand TLS.

In `external` mode, put the PEM files in `TLS_CERT_DIR` (default `./certs`) and
point `TLS_CERT_FILE` / `TLS_KEY_FILE` at their paths inside the container:

```env
TLS_MODE=external
TLS_CERT_DIR=./certs
TLS_CERT_FILE=/certs/origin.pem
TLS_KEY_FILE=/certs/origin.key
```

The certificate is used for every host it covers; anything else still falls
through to on-demand ACME. This is the mode for a Cloudflare Origin Certificate
or any certificate managed outside Caddy. If you do not want Caddy to request
public certificates at all, include every host in the certificate or use
`TLS_MODE=off` with the provider terminating TLS.

In `off` mode, leave `PUBLIC_ENDPOINT` at its `https://` value and point the
provider at this container's port 80 (or at Bunwrite's `127.0.0.1:8080` and skip
the `caddy` profile entirely).

### Cloudflare Tunnel

When a hostname is routed through Cloudflare Tunnel, Cloudflare terminates TLS.
Do not also run Caddy's automatic HTTPS for that hostname:

- Set `TLS_MODE=off`, or remove the `caddy` profile and point `cloudflared`
  directly at Bunwrite.
- Point `cloudflared` at `http://caddy:80`, `http://bunwrite:8080` or
  `http://127.0.0.1:8080`.
- Let Cloudflare manage certificates. Universal SSL covers `example.com` and
  `*.example.com`, not `*.sites.example.com`; use Total TLS / Advanced
  Certificate Manager or a certificate that covers the deeper wildcard.
- For arbitrary customer-owned domains, use Cloudflare for SaaS custom
  hostnames, or point those domains directly at the server and let Caddy issue
  their certificates.

### Cloudflare proxy (orange cloud)

When Cloudflare is proxied instead of Tunnel, it terminates TLS at its edge but
still connects to your origin. Two origin setups work:

- **Caddy obtains the origin certificate:** keep `TLS_MODE=acme` and set
  Cloudflare SSL/TLS mode to **Full (strict)** once Caddy has a certificate.
  The ACME HTTP challenge must reach port 80 through Cloudflare.
- **Cloudflare Origin Certificate:** set `TLS_MODE=external` and mount the
  certificate as `origin.pem` / `origin.key` under `TLS_CERT_DIR`. This avoids
  origin ACME entirely for the hosts it covers; seller domains outside the zone
  still use on-demand ACME unless Cloudflare for SaaS terminates them.

Do not send the same hostname through both Caddy and the tunnel. Choose one TLS
terminator per host.

## Data, uploads and backups

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_PATH` | `./data/bunwrite.sqlite` | SQLite file for the first project. |
| `CONTROL_DATABASE_PATH` | `./data/control/bunwrite.sqlite` | SQLite file for console admins, the organization and the project registry. |
| `CONTROL_DATABASE_SCHEMA` | `<DATABASE_SCHEMA>_console` | Postgres schema for the control store. |
| `DB_DRIVER` | `sqlite` | Storage backend: `sqlite` or `postgres`. This is the switch; a `DATABASE_URL` alone does not move the server off SQLite. See [DATABASE.md](DATABASE.md). |
| `DATABASE_URL` | unset | Postgres connection URL for `DB_DRIVER`. |
| `DATABASE_SCHEMA` | `public` | Postgres schema for the first project. Additional projects use `<schema>_<project-id>`; see [DATABASE.md](DATABASE.md#boot-path). |
| `DATABASE_POOL_MAX` | `10` | Connection-pool size for Postgres. |
| `DATABASE_SSL` | `false` | Require TLS for Postgres. |
| `STORAGE_PATH` | `./data/storage` | Uploaded files when S3 storage is off. |
| `BACKUPS_PATH` | `./data/backups` | Local backup folder when backup S3 storage is off: SQLite archives or Postgres dumps. |
| `PG_DUMP_BIN` | `pg_dump` | PostgreSQL client used for Postgres backups. Set an absolute path when it is not on `PATH`. |
| `BACKUP_ENCRYPTION_KEY` | unset | Encrypts backups (AES-256-GCM, key derived with scrypt). At least 16 characters; `openssl rand -base64 32` is a good value. Keep a copy off the server. Unset: backups are compressed only. Never passed to functions or sites. Restores read it from the environment or `.env`, or from `--key`. |

Additional projects live under `data/projects/<project-id>/`, each with its own
database, storage and functions folder. One SQLite archive covers every
database; a Postgres backup is one dump. There is no per-project backup.

### Continuous SQLite replication (Litestream) and failover

The replica, S3 credentials, sync interval, heartbeat and retention can also be
configured in **Organization → Backups → Continuous replication**. The console
writes `litestream.env` and a generated `litestream.generated.yml` beside the
SQLite database; those values override the environment on the next restart.
**Reset to environment** removes the files and restores the `.env` fallback.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LITESTREAM_REPLICA_URL` | unset | Base Litestream replica URL, for example `s3://bucket/bunwrite`. Setting it enables restore-on-start and continuous replication on Docker `serve`. |
| `LITESTREAM_SYNC_INTERVAL` | `1s` | How often Litestream pushes WAL frames. Lower means less data at risk and more object-storage requests. |
| `LITESTREAM_ALLOW_EMPTY` | unset | Allow startup when no restore point exists. Use only for the first deployment of a new instance; otherwise a missing backup fails closed. |
| `LITESTREAM_FORCE_RESTORE` | unset | Replace existing local databases from the replica during startup. Dangerous; stop the old instance first. |
| `LITESTREAM_HEARTBEAT_URL` | unset | Optional dead-man switch. Litestream pings it only while every database syncs successfully. |
| `LITESTREAM_S3_ENDPOINT` | unset | S3-compatible endpoint for R2/MinIO. Omit for AWS S3. `bunwrite failover` uses it for restore too. |
| `LITESTREAM_S3_REGION` | `auto` with an endpoint | Region for the S3-compatible endpoint. |
| `LITESTREAM_S3_FORCE_PATH_STYLE` | unset | Use path-style addressing; most non-AWS providers need it. |
| `LITESTREAM_CONFIG` | `/app/litestream.yml`, or the generated file | Litestream config file for replication tuning. Console-managed settings point this at `litestream.generated.yml`. Keep the same replica URL layout as `bunwrite failover`. |
| `LITESTREAM_BIN` | `litestream` | Litestream executable used by `bunwrite failover` and the Docker entrypoint. |

Litestream reads `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_DEFAULT_REGION` and `LITESTREAM_*` credentials from the environment. The
included [`deploy/litestream.yml`](../deploy/litestream.yml) replicates the
control database and discovers project databases under
`data/projects/*/bunwrite.sqlite`. The Docker entrypoint restores missing
databases with `bunwrite failover` before starting the app and Litestream.

This is a single-writer disaster-recovery setup, not active/active HA. Run only
one instance against a replica prefix at a time. Uploaded files are not part of
Litestream; back up `STORAGE_PATH` or the uploads bucket separately. See
[DEPLOY.md](DEPLOY.md#continuous-sqlite-backup-and-failover-litestream).

S3 for uploads and backups is configured in **Console → Settings → File storage**
and **Organization → Backups**, not in `.env`. A SQLite archive covers every
database; a Postgres backup is one `pg_dump`. Neither includes uploaded files, so
back up `STORAGE_PATH` or the uploads bucket separately. Automatic backups
follow a five-field UTC cron schedule (default `0 2 * * *`, daily at 02:00);
choose a preset or a custom cron in **Organization → Backups → Automatic
backups**. With `DB_DRIVER=postgres`, install the PostgreSQL client tools or set
`PG_DUMP_BIN`.

Backups and Litestream may share one bucket if they use different key prefixes.
Set the backup **Key prefix** in Organization → Backups (for example `backups`)
and keep the replica at a different prefix such as `s3://bucket/litestream`.
Scope each credential to its own prefix so the backup key cannot delete the
replica.

## Server processes

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKERS` | `1` (`auto` in the Docker image) | Public HTTP processes. `auto` uses the CPUs the container may use, less one for the proxy and supervisor (Linux only); a number pins the count; `1` keeps one process. A SQLite cluster also starts a pool of writer processes; Postgres does not. |
| `WORKER_PORTS` | `false` | With `WORKERS` > 1, bind one port per public worker (`PORT`, `PORT+1`, ...) instead of sharing one port with `SO_REUSEPORT`. Set the proxy upstream to the same range so it can health-check and route around a stalled worker. |
| `MAX_INFLIGHT` | `200` | In-flight requests allowed per public worker before that worker returns `503` with `Retry-After: 1`. It is per process, not a cluster total, so adding workers adds headroom instead of dividing it. Health checks are always allowed. `0` disables shedding. |
| `HTTP_IDLE_TIMEOUT` | `30` | Seconds Bun keeps an idle HTTP connection open (maximum 255, `0` disables). Keep it above the proxy's upstream keepalive; the bundled Caddyfile uses 5s. |
| `CACHE_CHECK_MS` | `0` | Check for settings, schema, session and API-key changes made by another worker on every request. Set a positive interval to throttle the check; a change can then take that long to be noticed. 100–250 is a good production trade-off. |
| `REALTIME_BUS_POLL_MS` | `100` | How often a worker with WebSocket clients reads events published by the other workers. |
| `WRITER_PORT` | `PORT + 1` (`PORT + 100` with `WORKER_PORTS`) | First loopback port of the SQLite writer pool; ignored with `DB_DRIVER=postgres`. Shard `i` listens on `WRITER_PORT + i`. Public workers forward `POST`/`PUT`/`PATCH`/`DELETE` API requests to the writer that owns the request's project, including `/v1/databases`, auth, teams, storage metadata, schema, variables, proxy rules, queues and settings, so one process owns each project's write connection. Short console forms follow the selected project; project-list and organization pages go to the writer that owns the default project, because they read the control database. Uploads, function executions and deployments, function HTTP endpoints, site deployments, render jobs, VCS work, and console forms that upload, build, back up or call out stay on the accepting worker. `0` disables the listeners and forwarding; each worker then writes locally. |
| `WRITER_SHARDS` | `auto` | SQLite writer processes in the pool. `auto` uses one writer per two public workers, capped at `8`; a number pins it; the value never exceeds `WORKERS`. Not used on Postgres. Shard `i` handles the projects whose ID hashes to `i`, so different projects write on different processes. A single hot project still uses one writer. The shards occupy loopback ports `WRITER_PORT` through `WRITER_PORT + WRITER_SHARDS - 1`. |
| `WRITER_HOST` | `127.0.0.1` | Interface for the writer listener. The workers are processes in the same container/network namespace, so loopback is reachable and the port is never public. |
| `WRITE_BATCH_MS` | `1` with `WORKERS` > 1, `0` otherwise | Group document writes that arrive within this window into one SQLite transaction. `0` writes each request immediately. Every write keeps its own savepoint, permissions and events; one failure never rolls back the others. |

With `WORKERS` above 1, the supervisor starts `WORKERS` public processes plus
a writer pool of `WRITER_SHARDS` processes. The public processes either share
one port with `SO_REUSEPORT`, or bind `PORT` through `PORT + WORKERS - 1` when
`WORKER_PORTS` is on. A writer only listens on its loopback writer port, so a
synchronous WAL checkpoint or lock wait cannot stall client connections. A
proxy can use the per-worker ports to health-check each process and route
around a stalled one. Work that must not run once per worker uses a database
lease: cron schedules, automatic backups, the queue reaper, the render queue
and pruning run only in the elected leader. If the leader stops, another worker
takes over within ten seconds.

With `DB_DRIVER=postgres`, the supervisor starts only the public workers. There
is no writer pool or loopback writer listener and no request forwarding: the
connection pool serializes work on the server, and every worker writes
independently. The leader lease still elects one scheduler, and realtime fans
out through `LISTEN`/`NOTIFY`.

Database writes are forwarded to the writer selected by the request's project
ID, so the public processes never queue on SQLite's write lock for document
writes; they forward the request and return the writer's response unchanged.
Different projects write on different writers; the same project always uses the
same one. If a writer is restarting, the readers retry for a moment and then
serve the write locally rather than failing it. Writes that arrive together are
committed in one transaction up to `WRITE_BATCH_MS`, which removes one commit
per request under load. Storage uploads, function and site deployments,
function runs and renders are not forwarded: they keep running on the worker
that accepted them.

Reads run in parallel, so expect roughly 3–3.5× read throughput on four cores.
`FUNCTIONS_CONCURRENCY` applies per process, and request-log batches are per
process; rate limits are shared through SQLite. Each worker keeps its own
`SQLITE_CACHE_MB` page cache and maps up to `SQLITE_MMAP_MB` of the database
file; the OS shares the mapped pages. Restoring an archive replaces the control
database and every project database, so stop the server and run
`bunwrite restore` instead of restoring in place.

## Console

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONSOLE_ENABLED` | `true` | Serve `/console`. Set `false` on a public API-only host. |
| `CONSOLE_ADMIN_EMAIL` | unset | Create this admin at startup if it does not exist. Needs `CONSOLE_ADMIN_PASSWORD`. |
| `CONSOLE_ADMIN_PASSWORD` | unset | Password for the admin above, at least 8 characters. |

You can also create or reset an admin with:

```bash
bun run console:admin you@example.com
```

## Request logs and client IP

Request log recording, sampling, output format, retention and IP storage are
configured per project in **Console → Settings → Request logs**. The values are
stored in that project's database and apply without a restart. There are no
`LOG_*` environment variables.

`TRUSTED_PROXIES` is server configuration for resolving client addresses:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRUSTED_PROXIES` | `private` | Comma-separated proxy sources trusted for client IP headers. |

`TRUSTED_PROXIES` values:

- `private` — loopback and private networks: Caddy, nginx, Cloudflare Tunnel
- `cloudflare` — Cloudflare edge addresses, and trust `CF-Connecting-IP`
- `none` — always use the connection's address
- a CIDR such as `10.1.0.0/16` or a single address

Use `cloudflare` when Cloudflare is the only way in (origin firewalled or a
tunnel). Headers from other clients are ignored, so they cannot spoof a new IP
to dodge sign-in limits.

## Observability

Request logs, traces, metrics and product analytics are kept locally for the
console's **Observability** pages, and can also be exported to a third party
without an SDK. External export is off until a provider is configured; the
local console copy is on by default. See
[OBSERVABILITY.md](OBSERVABILITY.md) for setup examples.

Everything is configured per project in **Console → Observability → Settings**,
and local feature flags in **Console → Observability → Feature flags**. The
values are stored in that project's database and apply without a restart. There
are no observability environment variables: the old `OBSERVABILITY_*`, `OTEL_*`,
`DD_*`, `POSTHOG_*` and `FEATURE_FLAGS` variables are no longer read.

| Setting | Default | Meaning |
| --- | --- | --- |
| Local console | on | Keep sampled traces, per-minute metrics and document events for the console's Observability pages. |
| Console trace sampling | `1%` | Fraction of requests kept as detailed traces. Metrics are counted for every request. |
| Spans kept | `2000` | Most recent sampled spans kept per project; older spans are trimmed. |
| Events kept | `5000` | Most recent analytics events kept per project. |
| Retention | `7 days` | How long local console telemetry is kept. |
| External exporters | off | Master switch for every outbound exporter. |
| Trace sampling | `100%` | Head-based trace sampling. Logs and metrics are not sampled here. |
| Flush interval / timeout / queue limit | `5000 ms` / `5000 ms` / `5000` | Batching, per-request provider timeout and the bounded queue size per signal. |
| OTLP/HTTP | unset | Base and per-signal endpoints, comma-separated headers and enabled signals. |
| Datadog | unset | API key, site, and whether logs and metrics are sent. |
| PostHog | unset | Project API key, host, analytics, feature flags and flag cache TTL. |
| Local feature flags | `{}` | Boolean or text overrides. They win over PostHog. |

Every response carries `X-Request-Id`; when observability is enabled it also
carries `X-Trace-Id`. Incoming W3C `traceparent` headers are honoured, so a
caller's trace continues through Bunwrite.

`GET /v1/flags` returns the evaluated flags for the caller:

```bash
curl -s https://your-host/v1/flags \
  -H "X-Appwrite-Project: booking-app" \
  -H "X-Appwrite-Key: $API_KEY"
```

```json
{ "flags": { "new-checkout": true, "theme": "dark" } }
```

## Functions

| Variable | Default | Meaning |
| --- | --- | --- |
| `FUNCTIONS_ENV_FILE` | unset | dotenv file with variables available to every function execution. |
| `FUNCTIONS_DIR` | schema folder or `.` | Base folder for relative function `path`s. Can also be set in **Console → Settings → Functions**. |
| `FUNCTIONS_BUILD_COMMANDS` | `true` | Run a function's `commands` during deployment. |
| `FUNCTIONS_SANDBOX` | `auto` (`on` in Docker Compose) | `on`/`setpriv` builds and runs each function as its own user and refuses to start when the helper cannot switch users; `bwrap` adds bubblewrap mount/PID/IPC/UTS/network namespaces and a read-only system root; `auto` warns and runs code as the server's user instead; `off` never isolates. |
| `FUNCTIONS_SANDBOX_NETWORK` | `none` in `bwrap` mode, `shared` otherwise | `none` puts functions in an empty network namespace (no API or internet access); `shared` keeps the host network. Sites and builds always share the host network. |
| `FUNCTIONS_SANDBOX_BWRAP` | `bwrap` | Path to the bubblewrap binary. |
| `FUNCTIONS_SANDBOX_TMP_MB` | `64` | Size of the private `/tmp` and `/dev/shm` in `bwrap` mode. |
| `FUNCTIONS_CGROUPS` | `auto` (`on` in `bwrap` mode) | `auto` applies cgroup v2 limits when a writable delegated subtree exists; `on` refuses to start without one; `off` disables limits. |
| `FUNCTIONS_CGROUP_ROOT` | detected | Writable cgroup v2 subtree for per-build/run limit cgroups. |
| `FUNCTIONS_MEMORY_MB` / `FUNCTIONS_CPUS` / `FUNCTIONS_PIDS` | `512` / `1` / `128` | Default limits for one function execution. |
| `SITES_MEMORY_MB` / `SITES_CPUS` / `SITES_PIDS` | `1024` / `1` / `256` | Default limits for one SSR site app. |
| `BUILD_MEMORY_MB` / `BUILD_CPUS` / `BUILD_PIDS` | `2048` / `2` / `512` | Default limits for one function or site build. |
| `PYTHON_BIN` | `python3` | Python executable for `python-*` runtimes. |

Paused schedules are a project setting in **Console → Settings → Functions**.
Function-specific variables can also be set in the console; they win over the
env file. Variables for every function and site are edited in
**Settings → Variables**, and a function's own variable wins over a global one.

## Sites

Project and site variables are not environment settings on the Bunwrite
process; they are stored per project and edited in **Settings → Variables** or
**Sites → a site → Variables**. They are applied to install/build commands and
to the SSR app. Precedence is server environment < project variables < site
variables. Secret values are write-only through the API. See
[SITES.md](SITES.md#variables).

| Variable | Default | Meaning |
| --- | --- | --- |
| `SITES_BUILD_COMMANDS` | `true` | Run an SSR site's `installCommand` and `buildCommand` on this server. Set `false` to upload an already-built app and only run its start command. |
| `SITES_SSR` | `true` | Allow sites with `adapter: ssr` to build and run. `false` answers those hosts with a "turned off" page. |
| `SITES_SSR_IDLE_MS` | `300000` | Stop an SSR app that has had no requests for this long. `0` keeps apps running until the site changes. |
| `SITES_SSR_MAX_PROCESSES` | `2` | Most SSR apps running at once per HTTP worker. The least recently used app is stopped first. Each worker keeps its own copy, so set `WORKERS=1` when hosting many SSR sites, or raise this to cover the sites you expect to be warm. Memory, not CPU, is the limit: a warm Next/Nuxt app is often 80–150 MB. |
| `STICKY_SESSIONS` | `off` | Sticky requests for SSR sites and `/api/*` on sites with an API function: `off`, `ip` (hash client IP + site host) or `cookie` (a `bw_sticky` cookie with IP fallback). Use `cookie` for apps that keep sessions or SSE streams in process memory. API, console, standalone function and WebSocket traffic keeps its existing routing. |
| `STICKY_PORT` | `PORT + 200` | First loopback port for the per-worker sticky listeners. They are private; keep the range away from `PORT`/`WORKER_PORTS`, `WRITER_PORT` and the SSR app range (10000–31999). `0` disables the listeners. |
| `STICKY_HOST` | `127.0.0.1` | Interface for the sticky listeners. Workers share the same network namespace, so loopback is enough. |
| `SITES_SSR_KEEP_PREVIOUS` | `2` | Ready SSR deployments kept besides the live one, for rollback, when the site's deployment retention is above 0. Each one is a full app folder on disk; set `0` or `1` on a small disk. |

SSR apps are started on the first request and always listen on loopback; the
server proxies to them, so Caddy and custom domains need no extra setup.

## Runtimes

Sites and functions build and run on the Node.js or Bun version they choose.
It is downloaded on first use; see [SITES.md](SITES.md#runtimes).

| Variable | Default | Meaning |
| --- | --- | --- |
| `RUNTIMES_DOWNLOAD` | `true` | Download Node.js and Bun builds when a site or function needs them. `false` runs them all on this server's Bun (no network needed). |
| `RUNTIMES_NODE_MIRROR` | `https://nodejs.org/dist` | Where Node.js builds come from: a mirror with the same layout (`index.json`, `v<version>/SHASUMS256.txt`). |
| `RUNTIMES_BUN_RELEASES` | GitHub's oven-sh/bun releases API | Where Bun releases are listed. |

## Git deployments

The server's GitHub App. Leave these unset to create the app from the console
instead (Organization → Settings → GitHub App); set values win over it.
Appwrite's `_APP_VCS_GITHUB_*` names are read too. See [GIT.md](GIT.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `VCS_GITHUB_APP_ID` | unset | The GitHub App's ID. |
| `VCS_GITHUB_APP_NAME` | unset | The app's URL slug, as in `github.com/apps/<slug>`. |
| `VCS_GITHUB_PRIVATE_KEY` | unset | The app's private key: the PEM (with `\n` for newlines) or base64 of it. |
| `VCS_GITHUB_CLIENT_ID` | unset | The app's OAuth client ID, used to check who installed it. |
| `VCS_GITHUB_CLIENT_SECRET` | unset | The app's OAuth client secret. |
| `VCS_GITHUB_WEBHOOK_SECRET` | unset | Verifies GitHub's webhooks; deliveries without a matching signature are refused. |
| `VCS_GITHUB_URL` | `https://github.com` | GitHub's web address; set it for GitHub Enterprise Server. |
| `VCS_GITHUB_API_URL` | `https://api.github.com` | GitHub's REST API, such as `https://github.example.com/api/v3`. |

## Resource tuning

Bunwrite detects host or cgroup CPU and RAM at startup and sizes limits from it.
Explicit values always win.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTOTUNE` | `true` | Set `false` to use built-in defaults instead of detecting resources. |
| `AUTOTUNE_CPUS` | detected | Override the CPU count when cgroups are not visible. |
| `AUTOTUNE_MEMORY_MB` | detected | Override memory in MB when cgroups are not visible. |
| `SQLITE_CACHE_MB` | auto, 8–64 | SQLite page cache in MB. |
| `SQLITE_MMAP_MB` | `256` | Memory-mapped database window per connection in MB; `0` disables mmap. |
| `SQLITE_WAL_AUTOCHECKPOINT` | `10000` | WAL pages before an automatic checkpoint; `0` turns automatic checkpoints off. A larger WAL means fewer synchronous checkpoints on the writer. |
| `SQLITE_BUSY_TIMEOUT_MS` | `5000` | How long the writer waits for SQLite's lock before failing. |
| `SQLITE_READER_BUSY_TIMEOUT_MS` | `500` | How long a public worker waits for a lock before failing fast. Keep this short: a synchronous wait blocks that process's event loop. |
| `MAX_REQUEST_BODY_MB` | auto, 16–256 | Largest accepted HTTP request body. |
| `BUN_JSC_forceRAMSize` | unset | JS heap size in bytes. Startup-only; the Docker entrypoint and systemd wrapper set it. |
| `MALLOC_ARENA_MAX` | unset | glibc malloc arena count. Startup-only; set by the deployment wrapper. |

SQLite commit durability is a per-project setting in **Console → Settings →
Database**. `NORMAL` (the default) skips the fsync on each commit: an
application crash is safe, but a power loss or OS crash can roll back
transactions committed since the last checkpoint. The database stays consistent
either way. Use `FULL` for payments, accounting ledgers, or any write that must
be on disk before the response is returned; it adds one fsync per commit.

## Caching and compression

Cache lifetimes (file views, image previews, generated previews and public
document responses) are project settings in **Console → Settings → Cache**.
There are no environment variables for them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMPRESSION` | `true` | Compress HTTP responses (Brotli, else gzip). Turn it off when Caddy or another proxy compresses at the edge; `docker-compose.yml` does. |
| `WEBSOCKET_COMPRESSION` | `true` | Compress realtime WebSocket messages (perMessageDeflate); independent of HTTP compression. |

## Image previews

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHARP_CONCURRENCY` | auto, 1–4 | libvips worker threads. |
| `SHARP_CACHE_MB` | auto, 16–128 | libvips operation cache; `0` disables it. |
| `PREVIEW_CONCURRENCY` | auto, 1–8 | Previews rendered at once; the rest wait in line. |
| `AVIF_MAX_MEGAPIXELS` | auto, 2–16 | Largest AVIF output. AVIF needs about 30 bytes per pixel. |

## Vectors and RAG

The built-in vector store and retrieval-augmented generation endpoints. Local
embeddings are the default and need no network; any OpenAI-compatible endpoint
can be used instead. Embeddings, answer generation, the optional Qdrant ANN
index, OCR/table extraction, chunking and limits are edited at **Console →
Settings → Vectors & RAG**. There are no environment variables for them. OCR
uses the `tesseract` executable, which must be installed on the host with the
language data you need. See [VECTORS.md](VECTORS.md) for the API and limits.

## HTML rendering

Used by `POST /v1/pdf` and `POST /v1/image`. Enable it and allow remote assets
in **Console → Settings → HTML rendering**. Needs Chromium on the host.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RENDER_ALLOW_PRIVATE` | `false` | Explicitly allow loopback/private destinations while remote loading is on (local asset servers). |
| `CHROME_PATH` | found on PATH | Chrome/Chromium executable. |
| `CHROME_ARGS` | unset | Extra Chromium flags, space-separated. |
| `CHROME_NO_SANDBOX` | `auto` | `true` forces `--no-sandbox`; `false` forces the sandbox. `auto` turns it off for root and containers, where user namespaces are usually unavailable. The Docker image and compose default to `true`; the container is the isolation boundary. |
| `RENDER_MAX_MEGAPIXELS` | auto, 4–30 | Largest image `/v1/image` may produce. |

Rendering is serialized and adds Chromium's memory cost. See
[docs/RENDER.md](RENDER.md).

## Docker image build

These are build arguments read by `docker-compose.yml`, not runtime settings.
Change them, then rebuild with `docker compose up -d --build`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUNWRITE_WITH_PYTHON` | `false` | Include python3 for `python-*` functions (~50 MB). |
| `BUNWRITE_WITH_CHROMIUM` | `false` | Include Chromium and fonts for HTML rendering (~730 MB more on disk). |
| `BUNWRITE_WITH_OCR` | `false` | Include Tesseract and English data for scanned PDF/image OCR. |

The published GHCR image is built with both set to `true`. These defaults apply
to local images built with `docker compose`.

## Project schema

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCHEMA_PATH` | unset | Project config (`bunwrite.config.json` or `appwrite.config.json`) used by `schema:push` and the console's Schema page. |
| `SCHEMA_SYNC_ON_START` | `false` | Apply `SCHEMA_PATH` on every start. Off so console edits are not overwritten. |

## First-start seeds

These identity values seed an **empty** database once. After the instance
exists they are ignored; change the project name and settings in the console.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORG_ID` | generated | Organization ID shown in the console. |
| `PROJECT_ID` | generated | Project ID apps send in `X-Bunwrite-Project` / `X-Appwrite-Project`. Reuse an Appwrite project ID when migrating. |
| `SECRET` | generated | Signs JWTs and OAuth state. At least 32 random characters when set. |

API keys, allowed origins, session lifetime and session limits are project
settings in the console; they are never read from `.env`.

Generate a secret with:

```bash
openssl rand -hex 32
```

### Email

Console sign-in codes, MFA and organization invitations use the SMTP configured
in **Organization → Settings → Email delivery**. Each project sets its own SMTP
in **Project Settings → Email & sign-in**, and projects never inherit the
console SMTP. SMTP is console-only; there are no `SMTP_*` environment
variables. Non-secure connections require STARTTLS (TLS 1.2+).

### OAuth sign-in

Google, Facebook, GitHub and Apple are configured in the console
(**Settings → Email & sign-in**); there are no OAuth environment variables.
Register this redirect URI with the provider:

```
<PUBLIC_ENDPOINT>/account/sessions/oauth2/callback/<provider>/<PROJECT_ID>
```

Apple uses `response_mode=form_post`, so its callback arrives as a POST. Its
client secret is an ES256 JWT signed with the `.p8` key on each token exchange.

### OAuth endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/account/tokens/oauth2/:provider` | Redirects to the provider with a signed `state`. |
| `GET` | `/account/sessions/oauth2/callback/:provider/:projectId` | Provider callback (token flow). |
| `POST` | `/account/sessions/oauth2/callback/:provider/:projectId` | Same, for Apple's form-post callback. |

## Other references

- [README quick start](../README.md#setup-from-zero)
- [Deployment](DEPLOY.md)
- [Sites and domains](SITES.md)
- [Vectors and RAG](VECTORS.md)
- [HTML rendering](RENDER.md)
- [Architecture](ARCHITECTURE.md)
