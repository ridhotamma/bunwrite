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

- `PUBLIC_ENDPOINT` — the public URL including `/v1`.
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
$EDITOR .env          # optional: PUBLIC_ENDPOINT and first-start seed values
docker compose up -d --build
curl http://localhost:8080/v1/health
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
- Change the published port with `BUNWRITE_PORT=9000`. Behind a reverse proxy
  on the same host, publish `127.0.0.1:8080:8080` instead.
- Functions: mount the folder holding `appwrite.config.json` at
  `/app/functions` (see the commented volume) and set
  `SCHEMA_PATH=/app/functions/appwrite.config.json`. Function variables are
  read from `/app/functions/functions.env`.
- Python functions need `BUNWRITE_WITH_PYTHON=true docker compose up -d --build`.
- HTML to PDF and images need Chromium in the image:
  `BUNWRITE_WITH_CHROMIUM=true docker compose up -d --build`, then turn it on
  in **Console → Settings → HTML rendering**. This makes the image about
  960 MB on disk (230 MB without it). See [RENDER.md](RENDER.md).
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
