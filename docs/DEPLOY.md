# Deploying Bunwrite

Target: one small VPS (Ubuntu 24.04 is a good default) with Bun and a reverse
proxy or Cloudflare Tunnel in front. No Docker is required.

## 1. Install

```bash
sudo adduser --disabled-password --gecos "" bunwrite
su - bunwrite
curl -fsSL https://bun.sh/install | bash
git clone <your-bunwrite-repo> /opt/bunwrite   # as root, then chown -R bunwrite /opt/bunwrite
cd /opt/bunwrite
bun install --production
```

## 2. Configure

```bash
cp .env.example .env
```

At minimum set:

- `PROJECT_ID` — the project ID your apps send in `X-Appwrite-Project`.
- `API_KEYS` — one or more server keys, comma-separated.
- `SECRET` — at least 32 random characters (`openssl rand -hex 32`).
- `PUBLIC_ENDPOINT` — the public URL including `/v1`.
- `ALLOWED_ORIGINS` — the browser origins allowed by CORS.

Then create the first console admin:

```bash
bun run console:admin you@example.com
```

Email, Google sign-in, storage, backups, functions and request-log settings can
be changed later in the console.

## 3. Run with systemd

The included unit assumes the app lives in `/opt/bunwrite` and runs as the
`bunwrite` user:

```bash
sudo cp deploy/bunwrite.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bunwrite
curl http://localhost:8080/v1/health
sudo journalctl -u bunwrite -f
```

## 4. Put it online

Use Cloudflare Tunnel, Caddy, nginx or another reverse proxy for TLS. Keep the
hostname stable because OAuth callbacks and file links use
`PUBLIC_ENDPOINT`.

Protect `/console` with Cloudflare Access or another access layer. Bunwrite has
its own sign-in and rate limiting, but the admin UI should not be public. Set
`CONSOLE_ENABLED=false` to disable it entirely; use an SSH tunnel to
`localhost:8080/console` when needed.

## 5. Storage, backups and logs

- Uploaded files use local disk by default. Enable S3-compatible storage in
  **Settings → File storage**; existing files are not migrated automatically.
- Enable daily database backups and optional S3 backup storage in
  **Settings → Backups**. Database snapshots do not include uploaded files.
  `bun run snapshot` is still available for cron-driven copies.
- Request logs go to stdout and the console. Set `LOG_REQUESTS=false` to silence
  them, or `LOG_FORMAT=json` for a log collector.

## 6. Upgrades

```bash
cd /opt/bunwrite
git pull
bun install --production
sudo systemctl restart bunwrite
```

Drizzle migrations run automatically at startup. Back up the database before a
major upgrade.

## Pesanle cutover example

The original Pesanle production cutover notes are kept in
[DEPLOY-PESANLE.md](DEPLOY-PESANLE.md) as a real-world example of migrating an
Appwrite project to Bunwrite.
