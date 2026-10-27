# Deploying Bunwrite

Target: one small VPS (Ubuntu 24.04 is a good default) with a reverse proxy or
Cloudflare Tunnel in front. Docker is optional (see Option C).

The `bunwrite` executable is self-contained: the API, console assets, database
migrations and Node/Python function runners are embedded. Python functions also
need `python3` on the host.

## Option A: Ansible playbook (one command)

The playbook provisions a fresh VPS, builds the binary, creates the service
user and `.env`, installs systemd and starts Bunwrite. With a domain it also
installs Caddy for automatic HTTPS.

See [playbook/README.md](../playbook/README.md). Short version:

```bash
cp playbook/inventory.example.ini playbook/inventory.ini
$EDITOR playbook/inventory.ini

ansible-playbook -i playbook/inventory.ini playbook/site.yml \
  -e bunwrite_domain=api.example.com \
  -e bunwrite_admin_email=you@example.com
```

Omit `bunwrite_domain` to run directly on port 8080 without TLS.

## Option B: Manual install

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

### 3. Configure

```bash
sudo -u bunwrite cp /opt/bunwrite/.env.example /opt/bunwrite/.env
sudo -u bunwrite chmod 600 /opt/bunwrite/.env
sudo -u bunwrite vi /opt/bunwrite/.env
```

At minimum set:

- `PROJECT_ID` — the project ID your apps send in `X-Appwrite-Project`.
- `API_KEYS` — one or more server keys, comma-separated.
- `SECRET` — at least 32 random characters (`openssl rand -hex 32`).
- `PUBLIC_ENDPOINT` — the public URL including `/v1`.
- `ALLOWED_ORIGINS` — the browser origins allowed by CORS.
- `HOST` — bind address; defaults to `0.0.0.0`. Set `127.0.0.1` when a
  reverse proxy or tunnel on the same host is the only entry point.
- `CONSOLE_ADMIN_EMAIL` and `CONSOLE_ADMIN_PASSWORD` — optional first admin; the
  server creates it once at startup. Otherwise run the command below.

Create or reset the first console admin:

```bash
cd /opt/bunwrite
sudo -u bunwrite /usr/local/bin/bunwrite console:admin you@example.com
```

Email, Google sign-in, storage, backups, functions and request-log settings can
be changed later in the console.

### 4. Run with systemd

The included unit assumes the app lives in `/opt/bunwrite`, runs as the
`bunwrite` user and executes the installed binary:

```bash
sudo cp /opt/bunwrite/deploy/bunwrite.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bunwrite
curl http://localhost:8080/v1/health
sudo journalctl -u bunwrite -f
```

### 5. Put it online

Use Cloudflare Tunnel, Caddy, nginx or another reverse proxy for TLS. Keep the
hostname stable because OAuth callbacks and file links use `PUBLIC_ENDPOINT`.

Protect `/console` with Cloudflare Access or another access layer. Bunwrite has
its own sign-in and rate limiting, but the admin UI should not be public. Set
`CONSOLE_ENABLED=false` to disable it entirely; use an SSH tunnel to
`localhost:8080/console` when needed.

## Option C: Docker Compose

`docker-compose.yml` runs the same standalone binary on `debian:bookworm-slim`,
limited to **1 vCPU and 512 MB RAM** (no swap). Measured on that limit: about
20 MB idle, 5,000+ API requests/s, and a 114 MB peak while resizing four
3000×3000 images at once.

```bash
cp .env.example .env
$EDITOR .env          # PROJECT_ID, API_KEYS, SECRET, PUBLIC_ENDPOINT, ALLOWED_ORIGINS
docker compose up -d --build
curl http://localhost:8080/v1/health
```

Create the first console admin:

```bash
docker compose exec bunwrite bunwrite console:admin you@example.com
```

Notes:

- Data (database, uploads, backups) lives in the `bunwrite-data` volume at
  `/app/data`. `HOST`, `PORT` and the data paths in `.env` are overridden
  inside the container.
- Change the published port with `BUNWRITE_PORT=9000`. Behind a reverse proxy
  on the same host, publish `127.0.0.1:8080:8080` instead.
- Functions: mount the folder holding `appwrite.config.json` at
  `/app/functions` (see the commented volume) and set
  `SCHEMA_PATH=/app/functions/appwrite.config.json`. Function variables are
  read from `/app/functions/functions.env`.
- Python functions need `BUNWRITE_WITH_PYTHON=true docker compose up -d --build`.
- Each function run is a separate process: about 10 MB for a trivial one, more
  with heavy dependencies. Many large functions running at once are what can
  push a 512 MB container to its limit.
- Low-memory tuning is set in the compose file: `BUN_JSC_forceRAMSize`
  (JS heap target), `MALLOC_ARENA_MAX=2`, `SHARP_CONCURRENCY=1` and
  `SHARP_CACHE_MB=16`. Raise them on a bigger host, or raise the limits under
  `deploy.resources`.

Upgrade with `git pull && docker compose up -d --build`.

## Storage, backups and logs

- Uploaded files use local disk by default. Enable S3-compatible storage in
  **Settings → File storage**; existing files are not migrated automatically.
- The standalone binary extracts its bundled image-processing runtime to
  `data/.runtimes/sharp` on the first preview. Keep the data folder writable.
- Enable daily database backups and optional S3 backup storage in
  **Settings → Backups**. Database snapshots do not include uploaded files.
  `bunwrite snapshot` is available for cron-driven copies.
- Request logs go to stdout and the console. Set `LOG_REQUESTS=false` to silence
  them, or `LOG_FORMAT=json` for a log collector.

## Upgrades

With the Ansible playbook, re-run it. Manually:

```bash
cd /opt/bunwrite
sudo -H -u bunwrite git pull
sudo -H -u bunwrite /usr/local/bin/bun install --production
sudo -H -u bunwrite /usr/local/bin/bun run build
sudo install -m 0755 dist/bunwrite /usr/local/bin/bunwrite
sudo systemctl restart bunwrite
```

Drizzle migrations run automatically at startup. Back up the database and
`/opt/bunwrite/.env` before a major upgrade.
