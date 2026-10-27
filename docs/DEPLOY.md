# Deploying Bunwrite

Target: one small VPS (Ubuntu 24.04 is a good default) with a reverse proxy or
Cloudflare Tunnel in front. No Docker is required.

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
