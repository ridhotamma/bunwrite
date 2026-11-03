# Deploying Bunwrite

Target: one small VPS (Ubuntu 24.04 is a good default) with a reverse proxy or
Cloudflare Tunnel in front. Docker is optional (see Option B).

The `bunwrite` executable is self-contained: the API, console assets, database
migrations and Node/Python function runners are embedded. Python functions also
need `python3` on the host.

Server settings are documented in [CONFIGURATION.md](CONFIGURATION.md).

## One-command Docker installer

The image doubles as its own installer, in the same shape as Appwrite's
`--entrypoint=install` image. It writes a compose file and `.env` into a host
directory, then starts the containers through the mounted Docker socket:

```bash
mkdir -p bunwrite
docker run -it --rm \
  --user 0 \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume "$(pwd)/bunwrite:/usr/src/code/bunwrite:rw" \
  --entrypoint=install \
  ghcr.io/ridhotamma/bunwrite:latest
```

The command:

1. reuses `bunwrite/.env` when it already exists (otherwise copies
   `.env.example` and fills in the install settings);
2. writes `docker-compose.yml`, `Caddyfile`, `Caddyfile.external`,
   `Caddyfile.off` and `caddy-entrypoint.sh` next to it;
3. generates a first console admin unless `--no-admin` is set;
4. pulls the image, runs `docker compose up -d`, waits for the container health
   check and prints the console URL and credentials.

`--user 0` is needed only because the installer writes into the bind mount. The
Bunwrite container itself still runs as the unprivileged `bunwrite` user. Create
the directory on the host first (`mkdir -p bunwrite`) so the generated files
are owned by you rather than root.

Useful options:

```bash
# Do not prompt; install with a domain
... --entrypoint=install ghcr.io/ridhotamma/bunwrite:latest \
  --domain appwrite.example.com --non-interactive

# Write the files but start later
... --entrypoint=install ghcr.io/ridhotamma/bunwrite:latest --no-start

# Bring your own reverse proxy (no Caddy, Bunwrite on 127.0.0.1:8080)
... --entrypoint=install ghcr.io/ridhotamma/bunwrite:latest --no-caddy

# Put Caddy on non-standard host ports and keep Bunwrite on 9090
... --entrypoint=install ghcr.io/ridhotamma/bunwrite:latest \
  --http-port 8080 --https-port 8443 --app-port 9090
```

`--help` lists every flag. The installer is also a normal command in the
binary, so `bunwrite install --help` and `bunwrite upgrade --help` work
anywhere Docker is available.

### Upgrade an install

Run a newer image with the same volume and `--entrypoint=upgrade`:

```bash
docker run -it --rm \
  --user 0 \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume "$(pwd)/bunwrite:/usr/src/code/bunwrite:rw" \
  --entrypoint=upgrade \
  ghcr.io/ridhotamma/bunwrite:0.2.0
```

The upgrade keeps `.env`, rewrites the compose file to the new image (the old
one is kept as `docker-compose.yml.<timestamp>.backup`), pulls the image and
restarts the stack. Drizzle migrations run automatically at startup.

### Building or publishing your own installer image

The image bakes its own reference for the generated compose file, so pass it at
build time:

```bash
docker build \
  --build-arg BUNWRITE_IMAGE=registry.example.com/me/bunwrite:0.1.0 \
  --build-arg BUNWRITE_VERSION=0.1.0 \
  -t registry.example.com/me/bunwrite:0.1.0 .
docker push registry.example.com/me/bunwrite:0.1.0
```

A local `docker build -t bunwrite:latest .` keeps the default
`BUNWRITE_IMAGE=bunwrite:latest`, which uses the image already on the host.
[`.github/workflows/release.yml`](../.github/workflows/release.yml) publishes
`linux/amd64` and `linux/arm64` images to GHCR when a `v*` tag is pushed. GHCR
packages are private by default. Either make the package public, pull the image
on the host first (the installer falls back to a local image when the pull
fails), or mount your Docker client config with
`--volume "$HOME/.docker/config.json:/root/.docker/config.json:ro"`. The
prebuilt image is the base build: for Python or Chromium support, build your own
image with `WITH_PYTHON=true` or `WITH_CHROMIUM=true`, push it, and pass it with
`--image`.

## Option A: Manual install

Build on the target OS and architecture so native dependencies such as `sharp`
match.

### 1. Create the user and source checkout

```bash
sudo apt update
sudo apt install -y git curl unzip python3
curl -fsSL https://bun.sh/install | sudo env BUN_INSTALL=/usr/local bash

sudo adduser --disabled-password --gecos "" bunwrite
sudo mkdir -p /opt/bunwrite
sudo chown bunwrite:bunwrite /opt/bunwrite
sudo -H -u bunwrite git clone https://github.com/ridhotamma/bunwrite.git /opt/bunwrite
```

### 2. Build and install the binary

```bash
cd /opt/bunwrite
sudo -H -u bunwrite /usr/local/bin/bun install --production
sudo -H -u bunwrite /usr/local/bin/bun run build
sudo install -m 0755 dist/bunwrite /usr/local/bin/bunwrite
```

The installed `bunwrite` executable is self-contained and no longer needs Bun
at runtime. Bun remains only for building updates.

Create the data folders:

```bash
sudo -u bunwrite mkdir -p /opt/bunwrite/data/storage /opt/bunwrite/data/backups
```

The first project uses the existing `data/bunwrite.sqlite`, `data/storage` and
`data/backups`. Additional projects created in the console live under
`data/projects/<project-id>/` with their own database, storage, backups and
function folder.

### 3. Configure

```bash
sudo -u bunwrite cp /opt/bunwrite/.env.example /opt/bunwrite/.env
sudo -u bunwrite chmod 600 /opt/bunwrite/.env
sudo -u bunwrite vi /opt/bunwrite/.env
```

The first start generates (or imports from the optional seed values) the
organization ID, project ID, signing secret and an initial API key, then stores
them in the database. `.env` is for server and deployment settings:

- `DOMAIN` — the public hostname (for example `appwrite.example.com`). When set,
  `PUBLIC_ENDPOINT` defaults to `https://<DOMAIN>/v1`; the Docker Compose setup
  also gives Caddy the hostname to obtain a certificate for.
- `PUBLIC_ENDPOINT` — the public URL including `/v1`, if TLS ends somewhere else.
- `SITES_PREFIX` / `FUNCTIONS_PREFIX` — default `sites` and `functions`; site
  and function hosts become `<id>.<prefix>.<DOMAIN>`. `SITES_DOMAIN` and
  `FUNCTIONS_DOMAIN` override the whole base domain.
- `HOST` — bind address; defaults to `0.0.0.0`. Set `127.0.0.1` when a
  reverse proxy or tunnel on the same host is the only entry point.
- `CONSOLE_ADMIN_EMAIL` and `CONSOLE_ADMIN_PASSWORD` — optional first admin; the
  server creates it once at startup.

The optional **First start only** values at the end of `.env.example` can seed
an empty database — useful when reusing an existing Appwrite project ID and API
key. They are imported once into the database and then ignored:

- `ORG_ID`, `PROJECT_ID`, `PROJECT_NAME`
- `API_KEYS` (imported hashed into **Console → API**)
- `SECRET` (at least 32 random characters, `openssl rand -hex 32`)
- `ALLOWED_ORIGINS`, `SESSION_DURATION`, `SESSIONS_LIMIT`
- `SMTP_*`, `GOOGLE_*`, `FUNCTIONS_SKIP_SCHEDULES`

After the first start, manage the mutable settings (API keys, origins,
sessions, SMTP, Google and function schedules) in the console; the project ID
is fixed for the life of the project. Confirm the project ID and API key, then
remove the seed values from `.env`; keeping them only produces a warning that
they are ignored. Keep the API key somewhere safe (or create a fresh key in
**Console → API**) before deleting `API_KEYS` from `.env`, because the
console only stores its hash and cannot show it again.

Create or reset the first console admin:

```bash
cd /opt/bunwrite
sudo -u bunwrite /usr/local/bin/bunwrite console:admin you@example.com
```

Alternatively, start the service first and open `/console/setup` from the
server (or through an SSH tunnel). That page creates the admin and shows the
generated organization ID, project ID and API key. The same values are printed
in the startup log until the first admin exists. If you create the admin with
the command above before the first start, create an API key later in
**Console → API**.

Email, OAuth sign-in, storage, backups, functions and request-log settings can
be changed later in the console.

### 4. Run with systemd

The included unit assumes the app lives in `/opt/bunwrite`, runs as the
`bunwrite` user and runs the autotune wrapper before the installed binary:

```bash
sudo cp /opt/bunwrite/deploy/bunwrite.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bunwrite
curl http://localhost:8080/v1/health
sudo journalctl -u bunwrite -f
```

The unit runs `deploy/bunwrite-autotune.sh`, which applies the startup-only
limits (JSC heap and glibc malloc arenas) before the server starts. The image,
render, SQLite and upload limits are applied inside the process. Run
`bunwrite autotune` to see what was detected. `MemoryMax=80%` leaves the rest
of the host's RAM for the OS and other work; set a fixed value when it shares
the machine.

### Function isolation

In the Docker image each function builds and runs as its own user, so one
function's code cannot read the database, uploads, backups or another
function's files; the Compose file sets `FUNCTIONS_SANDBOX=on` for this. A
manual install can opt in the same way:

```bash
sudo install -o root -g bunwrite -m 0750 /usr/bin/setpriv /usr/local/libexec/bunwrite-sandbox
sudo setcap cap_setuid,cap_setgid+ep /usr/local/libexec/bunwrite-sandbox
```

(`setcap` comes from `libcap2-bin`.) Then set `FUNCTIONS_SANDBOX=on` in `.env`
so the server refuses to start without isolation; `auto`, the default, only
warns and then runs build commands as `bunwrite`. Never add
`NoNewPrivileges=yes` to the unit: it blocks the helper. Unlike the image,
the host keeps its setuid programs, so an isolated function user still has
more to reach for than inside the container; run only code you trust.

### 5. Put it online

Use Cloudflare Tunnel, Caddy, nginx or another reverse proxy for TLS. Keep the
hostname stable because OAuth callbacks and file links use `PUBLIC_ENDPOINT`.

Bunwrite reads the client's IP from `X-Forwarded-For` only when the connection
comes from a trusted proxy (`TRUSTED_PROXIES`, default `private`: loopback and
private networks). That covers a proxy or tunnel on the same host or Docker
network. For a proxy on a public address, list it, for example
`TRUSTED_PROXIES=private,203.0.113.5`. `CF-Connecting-IP` is used only with
`TRUSTED_PROXIES=private,cloudflare`; set that only when Cloudflare is the sole
way in, since anyone reaching the origin directly could send the header.

Protect `/console` with Cloudflare Access or another access layer. Bunwrite has
its own sign-in and rate limiting, but the admin UI should not be public. Set
`CONSOLE_ENABLED=false` to disable it entirely; use an SSH tunnel to
`localhost:8080/console` when needed.

### 6. Proxy timeouts, worker health and capacity

Two settings matter more than any benchmark number:

- **The proxy's upstream keepalive must be shorter than Bun's idle timeout.**
  Bun closes an idle connection after `HTTP_IDLE_TIMEOUT` seconds (30 by
  default). Caddy's default upstream keepalive is **2 minutes**, so it can reuse
  a connection Bun has already closed; the request then waits with no response
  timeout. The bundled Caddyfiles set `keepalive 5s` and
  `response_header_timeout 30s`. With nginx, use `keepalive_timeout 5s` and
  `proxy_read_timeout 30s`. Raise the response timeout if an endpoint
  legitimately renders for longer.
- **Give the proxy a response timeout.** Without one, a stalled worker turns
  into a client timeout instead of a fast `504` that a retry or health check can
  act on.

For per-worker health checks, set `WORKER_PORTS=true` and point Caddy at the
whole range:

```dotenv
WORKERS=4
WORKER_PORTS=true
UPSTREAM=bunwrite:8080-8083
ASK_UPSTREAM=bunwrite:8080
MAX_INFLIGHT=200
```

Each public worker binds its own port, so Caddy's `health_uri /v1/health`
probes them separately and `unhealthy_latency` / `fail_duration` remove a
stalled process. The writer pool listens on loopback ports outside that range
and never receives public traffic. Without `WORKER_PORTS`, the workers share one
port with `SO_REUSEPORT`; that is slightly faster but the proxy cannot see an
individual stalled worker.

`MAX_INFLIGHT` is per public worker. Above it, Bunwrite answers `503` with
`Retry-After: 1` immediately instead of holding the request. Keep it near the
measured safe concurrency per worker (about 200 for the write-heavy booking
mix) and leave headroom for spikes. The total the cluster will admit is the
value times the number of public workers.

**Postgres.** With `DB_DRIVER=postgres`, set `WORKERS` for the public HTTP
processes only. The supervisor does not start writer shards or loopback writer
ports, and requests are not forwarded: every worker uses the Postgres pool.
The scheduler lease and realtime fan-out still work across workers
(`_cluster_leases` and `LISTEN`/`NOTIFY`). Keep `WRITER_PORT` unset or `0` for
clarity; it is ignored on Postgres.

**Scaling beyond one host (SQLite).** Bunwrite uses SQLite. Do not point two
containers or two machines at the same database file over a network
filesystem: SQLite's locking assumes one host. For more capacity, either:

- run one instance per project (the console already keeps each project in its
  own database), or
- use a replicated setup such as LiteFS (one writer, read replicas) or
  Litestream for a warm standby, and put both behind the proxy with health
  checks.

Caddy accepts multiple upstreams (`UPSTREAM="host-a:8080 host-b:8080"`) and will
fail over when one fails its health check. Do not enable retries for
non-idempotent writes unless the client uses an explicit document ID.

## Option B: Docker Compose

`docker-compose.yml` runs the same standalone binary on `debian:trixie-slim`.
It auto-tunes to the host's CPU and RAM, and there are no CPU/memory caps by
default. Measured with a **1 vCPU / 512 MB** cgroup limit: about 20 MB idle,
5,000+ API requests/s, and a 114 MB peak while resizing four 3000×3000 images
at once. With HTML rendering on, 6 large PDFs, 6 full-page
2× screenshots, 6 social cards and 25 image previews with borders, rounded
corners and rotation, all at once, peaked at about 455 MB with no
out-of-memory kills. Chromium stops after a minute idle and memory drops back
to about 70 MB.

```bash
cp .env.example .env
$EDITOR .env          # set DOMAIN=appwrite.example.com and COMPOSE_PROFILES=caddy
docker compose up -d --build
curl https://appwrite.example.com/v1/health
```

`docker compose` can start two containers: `bunwrite` and `caddy`. Caddy
publishes ports 80/443 and obtains a Let's Encrypt certificate for `DOMAIN`
automatically. It is opt-in through a Compose profile stored in `.env`:

```env
# .env
COMPOSE_PROFILES=caddy   # Bunwrite + Caddy (automatic HTTPS)
# COMPOSE_PROFILES=      # Bunwrite only (bring your own reverse proxy)
```

`TLS_MODE` decides who owns the certificate:

```env
TLS_MODE=acme            # Caddy obtains and renews certificates (default)
# TLS_MODE=external      # Caddy serves the files below, e.g. a Cloudflare Origin Certificate
# TLS_MODE=off           # Cloudflare Tunnel / ALB / nginx terminates TLS
```

For `external`, put the PEM files in `./certs` (or set `TLS_CERT_DIR`) and name
them inside the container:

```env
TLS_MODE=external
TLS_CERT_FILE=/certs/origin.pem
TLS_KEY_FILE=/certs/origin.key
```

The loaded certificate covers every host it names; any other host (such as a
seller custom domain) still falls through to on-demand ACME. With `off`, Caddy
stops doing TLS entirely and listens on port 80 for the provider.

`docker compose up -d` reads this value from `.env`, so no extra flag is needed.
Without the profile, `caddy` is not created at all — nothing is installed,
pulled or run.

Requirements when Caddy is enabled:

- `appwrite.example.com` has an **A record** (and AAAA if you use IPv6) pointing
  at this server. Bunwrite and Caddy cannot create that record — add it at your
  DNS provider first.
- Search for `sites.example.com` as well as `functions.example.com` unless you set
  `SITES_DOMAIN` / `FUNCTIONS_DOMAIN`: a wildcard A record
  `*.sites.example.com` and `*.functions.example.com` lets Caddy serve every
  site and function on demand. Custom domains need their own CNAME/A records.
- Ports **80 and 443** are open in `ufw`/`iptables` *and* the provider's firewall.
  Caddy needs 80 for the ACME HTTP challenge.
- No other service on the host is using 80/443.

Issue the certificate with a normal request; watch it with:

```bash
curl -i https://appwrite.example.com/v1/health
docker compose logs -f caddy
```

If DNS was not ready on the first start, nothing to do: Caddy's entrypoint
waits for `DOMAIN` to resolve to this server before it starts (polling every 10
seconds) and logs `[caddy] waiting for …`. As soon as the record appears, Caddy
starts and issues the certificate on the first attempt. Watch it with:

```bash
docker compose logs -f caddy
```

When a proxy or tunnel (Cloudflare, another host) hides the origin address, the
comparison cannot match: set `CADDY_WAIT_IP` to the address the record should
point at, or `CADDY_WAIT_DNS=false` to start immediately. If Caddy has already
started and issuance failed (for example the record changed later), it retries
on its own with exponential backoff for up to 30 days (at most one attempt a
day). `docker compose restart caddy` or a reload only forces an immediate
attempt. Certificate state lives in the `caddy-data` volume, so restarts and
image updates do not re-issue certificates.

`DOMAIN` also sets `PUBLIC_ENDPOINT` to `https://<DOMAIN>/v1` automatically
(Console → Overview shows it). Set `PUBLIC_ENDPOINT` explicitly only when TLS
ends somewhere else.

If you already have a reverse proxy or Cloudflare Tunnel on the host, leave
`COMPOSE_PROFILES` empty and point your proxy at `127.0.0.1:8080`:

```env
# .env
COMPOSE_PROFILES=
```

```bash
docker compose up -d
```

If Caddy was already running from an earlier start, disabling the profile does
not stop it (`docker compose up` only ensures the selected services). Remove it
once:

```bash
docker compose --profile caddy rm -sf caddy
```

Create the first console admin:

```bash
docker compose exec bunwrite bunwrite console:admin you@example.com
```

The first start prints the generated organization ID, project ID and API key to
`docker compose logs bunwrite`. The signing secret is stored in the database
volume. Optional first-start seed values in `.env` (organization/project ID,
API keys, secret and application settings) are imported once and then ignored;
manage them in the console afterwards.

Notes:

- Data (database, uploads, backups) lives in the `bunwrite-data` volume at
  `/app/data`. `HOST`, `PORT` and the data paths in `.env` are overridden
  inside the container.
- The app is published only on `127.0.0.1:${BUNWRITE_PORT:-8080}`, so Caddy is
  the public entry point. For a quick local check use
  `curl http://localhost:8080/v1/health`. Set `BUNWRITE_BIND=0.0.0.0` only if you
  intentionally want the app exposed directly.
- Caddy proxies WebSockets (`/v1/realtime`) and passes `X-Forwarded-*`; keep the
  `/v1` prefix (no path rewriting), or the API routes stop matching.
- To remove the Docker network hop between Caddy and the app on a Linux host,
  use `docker compose -f docker-compose.yml -f docker-compose.host.yml up -d`.
  Both containers use the host network, and Caddy proxies `127.0.0.1:8080`.
  Docker Desktop does not support host networking.
- To use Cloudflare in front, choose one origin setup: `TLS_MODE=acme` and
  **Full (strict)** once Caddy has a certificate; `TLS_MODE=external` with a
  Cloudflare Origin Certificate; or `TLS_MODE=off` behind a Cloudflare Tunnel.
- Functions: mount the folder holding `bunwrite.config.json` (or
  `appwrite.config.json`) at
  `/app/functions` (see the commented volume) and set
  `SCHEMA_PATH=/app/functions/bunwrite.config.json`. Function variables are
  read from `/app/functions/functions.env`.
- Python functions need the image built with `WITH_PYTHON=true`: set
  `BUNWRITE_WITH_PYTHON=true` in `.env`, then `docker compose up -d --build`.
  (Build args are baked in, so rebuild after changing it.)
- HTML to PDF and images need Chromium in the image: set
  `BUNWRITE_WITH_CHROMIUM=true` in `.env` and run
  `docker compose up -d --build`, then turn it on in **Console → Settings →
  HTML rendering**. This makes the image about 960 MB on disk (roughly 350 MB
  without it; the one-command installer's Docker CLI and compose plugin account
  for about 120 MB). See [RENDER.md](RENDER.md).
- Each function run is a separate process: about 10 MB for a trivial one, more
  with heavy dependencies. Many large functions running at once are what can
  push a small container to its limit.
- Bunwrite auto-tunes image previews, rendering, SQLite cache, upload size, the
  JSC heap and malloc arenas from the cgroup (Docker/systemd/Kubernetes) or host
  CPU and RAM. Explicit env values win; `AUTOTUNE=false` disables it. On a shared
  host, uncomment `cpus`/`memory` under `deploy.resources`; autotune will respect
  those cgroup limits. Check the result with
  `docker compose exec bunwrite bunwrite autotune`.

Upgrade with `git pull && docker compose up -d --build`.

## Storage, backups and logs

- Uploaded files use local disk by default. Enable S3-compatible storage in
  **Settings → File storage**; existing files are not migrated automatically.
  Additional projects sharing one S3 bucket use the project ID as a key prefix.
- HTML to PDF and images on a VPS without Docker: `sudo apt install chromium
  fonts-liberation`, then enable it in **Settings → HTML rendering**. See
  [RENDER.md](RENDER.md).
- The standalone binary extracts its bundled image-processing runtime to
  `data/.runtimes/sharp` on the first preview. Keep the data folder writable.
- With SQLite, enable scheduled database backups and optional S3 backup storage in
  **Organization → Backups**. One archive contains the control database and every
  project database; it does not include uploaded files. Backups follow a cron
  schedule in UTC (default daily at 02:00). `bunwrite snapshot` is
  available for cron-driven archives. Restore by uploading the archive in
  **Organization → Backups** and restarting Bunwrite, or run
  `bunwrite restore <archive>` with the server stopped; either way every
  database is validated first and the previous files are kept as
  `*.before-restore-<timestamp>`.
- With Postgres, the same page runs `pg_dump` on the automatic schedule and can
  upload the dump to the backup S3 bucket. Install the PostgreSQL client tools
  on the server, or set `PG_DUMP_BIN`. The archive upload/restore flow and
  Litestream stay SQLite-only; see
  [Restoring a Postgres backup](#restoring-a-postgres-backup).
- Request logs are stored per project and go to stdout and the console. Turn
  recording off, or choose JSON output, in **Settings → Request logs**.

### Continuous SQLite backup and failover (Litestream)

This is the PocketBase Cloud model for SQLite: one instance on local disk,
continuous WAL replication to object storage, and restore onto a replacement
instance when the host is lost. It is **not** active/active HA and does not
make SQLite multi-writer.

The Docker image includes Litestream. Enable it in **Organization → Backups →
Continuous replication** in the console, or use the `.env` values below. The
console writes the replica, credentials, endpoint, sync interval, heartbeat and
retention to `litestream.env`/`litestream.generated.yml` beside the database;
restart Bunwrite after saving. Console settings override `.env` until you press
**Reset to environment**.

```env
LITESTREAM_REPLICA_URL=s3://my-bucket/bunwrite
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_DEFAULT_REGION=us-east-1
LITESTREAM_SYNC_INTERVAL=1s
```

Use a bucket/prefix dedicated to this instance. Enable bucket versioning and
encryption, and give the key access only to that prefix. Do not point
`DATABASE_PATH` at S3 or a network filesystem.

Backups may use the same bucket as the replica if they use a different prefix:
set the backup **Key prefix** (for example `backups`) and keep the replica at
`s3://bucket/litestream`. Use separate credentials scoped to each prefix, and
separate lifecycle rules; the replica churns WAL objects while archives are
large and infrequent.

On `docker compose up`, the entrypoint:

1. restores the control database and any missing project databases from the
   replica;
2. starts `bunwrite` under Litestream;
3. replicates the control database and every
   `data/projects/*/bunwrite.sqlite` it discovers.

A restore point for an existing database is required. For a brand-new instance
with no backup yet, set `LITESTREAM_ALLOW_EMPTY=true` once, then remove it.
Without that flag the container refuses to start rather than silently creating
an empty database over an unavailable backup.

Manual restore after a host loss:

```bash
# Stop the old instance first. Never run two writers against one replica.
docker compose down

# On the replacement host, with the same .env and an empty data volume:
docker compose up -d
```

Or run the restore directly before starting:

```bash
bunwrite failover
bunwrite failover --dry-run       # show what would be restored
bunwrite failover --force         # replace existing local databases
```

`failover` restores `<replica>/bunwrite.sqlite` first, reads `_projects`, then
restores `<replica>/projects/<id>/bunwrite.sqlite` for each project. It keeps
the previous file as `*.before-restore` when `--force` replaces one.

Manual installs: install the `litestream` binary from
[litestream.io/install](https://litestream.io/install/) (the Docker image already
includes it), keep [`deploy/litestream.yml`](../deploy/litestream.yml) in the
checkout and set the same environment. The bundled `deploy/bunwrite-autotune.sh` detects
`LITESTREAM_REPLICA_URL`, runs `bunwrite failover`, then starts:

```bash
litestream replicate \
  -config /opt/bunwrite/deploy/litestream.yml \
  -exec "/usr/local/bin/bunwrite serve"
```

The normal systemd unit already uses that wrapper, so `systemctl restart
bunwrite` performs the restore. For a manual restore, stop the unit first and
run `bunwrite failover` as the `bunwrite` user.

Restore points follow writes; an idle database has no newer point. Litestream
data must be in a bucket outside the server, or a lost host takes the backup
with it. Uploaded files are not in Litestream; back up `STORAGE_PATH` or the
uploads bucket separately.

For S3-compatible storage (R2, MinIO), copy the config and add `endpoint`,
`region` and `force-path-style` under both replicas, then set
`LITESTREAM_CONFIG` to that file. Also set `LITESTREAM_S3_ENDPOINT`,
`LITESTREAM_S3_REGION` and, when needed, `LITESTREAM_S3_FORCE_PATH_STYLE` so
`bunwrite failover` can build a matching one-off restore config. Keep the
replica URL layout unchanged so failover can find the databases.

### Restoring a Postgres backup

With `DB_DRIVER=postgres`, **Organization → Backups** runs `pg_dump` on the
automatic schedule and keeps the dump in `BACKUPS_PATH` or uploads it to the
backup S3 bucket. A dump is a periodic recovery point, not continuous WAL
archiving; if you need point-in-time recovery, use the database provider's
managed PITR or a dedicated backup tool on the host.

Install the PostgreSQL client tools where Bunwrite runs, or point
`PG_DUMP_BIN` at `pg_dump`. Download a dump and restore it while Bunwrite is
stopped:

```bash
bunwrite backup:open backup-....dump.zst bunwrite.dump
pg_restore --clean --if-exists --dbname="$DATABASE_URL" bunwrite.dump
```

Encrypted dumps (`.dump.zst.enc`) need the same `BACKUP_ENCRYPTION_KEY` that
created them. A dump covers the database only; uploaded files, function code and
site builds are not included, so back up `STORAGE_PATH` or the uploads bucket
separately.

The SQLite commands (`bunwrite snapshot`, `bunwrite restore`, `bunwrite
failover`) refuse to run with `DB_DRIVER=postgres`.

## Upgrades

With Docker Compose, see Option B. Manual install:

```bash
cd /opt/bunwrite
sudo -H -u bunwrite git pull
sudo -H -u bunwrite /usr/local/bin/bun install --production
sudo -H -u bunwrite /usr/local/bin/bun run build
sudo install -m 0755 dist/bunwrite /usr/local/bin/bunwrite
sudo systemctl restart bunwrite
```

If the bundled unit or `deploy/bunwrite-autotune.sh` changed, copy the unit
again and run `sudo systemctl daemon-reload` before restarting. Drizzle
migrations run automatically at startup. Back up the databases and
`/opt/bunwrite/.env` before a major upgrade.
