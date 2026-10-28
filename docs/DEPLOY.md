# Deploying Bunwrite

Target: one small VPS (Ubuntu 24.04 is a good default) with a reverse proxy or
Cloudflare Tunnel in front. Docker is optional (see Option B).

The `bunwrite` executable is self-contained: the API, console assets, database
migrations and Node/Python function runners are embedded. Python functions also
need `python3` on the host.

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

Email, Google sign-in, storage, backups, functions and request-log settings can
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
- To use Cloudflare in front, set SSL/TLS mode to **Full (strict)** after Caddy
  has a certificate, or keep the record DNS-only.
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
  HTML rendering**. This makes the image about 960 MB on disk (230 MB without
  it). See [RENDER.md](RENDER.md).
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
- Enable daily database backups and optional S3 backup storage in
  **Settings → Backups**. Backups are per project; database snapshots do not
  include uploaded files. `bunwrite snapshot` is available for cron-driven
  copies of the default project.
- Request logs are stored per project and go to stdout and the console. Set
  `LOG_REQUESTS=false` to silence them, or `LOG_FORMAT=json` for a log collector.

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
migrations run automatically at startup. Back up the database and
`/opt/bunwrite/.env` before a major upgrade.
