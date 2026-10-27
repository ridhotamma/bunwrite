# Deploying and cutting over

Target: one 1 vCPU / 1 GB VPS (Ubuntu 24.04), Cloudflare in front for TLS. No Docker.

Because the new server keeps the **same hostname, project ID and API key**, the
Pesanle apps need no code or env change: the cutover is pointing
`appwrite.pesanle.com` at the VPS. The only env change is `RENDER_FUNCTION_URL`
(see step 6).

## 1. Prepare the VPS

```bash
adduser --disabled-password pesanle && su - pesanle
curl -fsSL https://bun.sh/install | bash
git clone <pesanle-backend repo> /opt/pesanle-backend   # as root, then chown -R pesanle /opt/pesanle-backend
git clone <pesanle repo> /opt/pesanle                   # for appwrite.config.json and the function code
cd /opt/pesanle-backend && bun install --production
```

For the `render` function (PDF/PNG via WeasyPrint): `apt install weasyprint python3-pip`
then `pip install pypdfium2==5.14.0 Pillow==11.3.0`. Skip it if you render locally
in the apps (they do when `RENDER_FUNCTION_URL` is unset).

`studio-render` (Remotion + Chromium video) does not fit in 1 GB; AI Studio is not
live, so it is left unsupported.

## 2. Configure

```bash
cp .env.example .env    # fill in API_KEYS (the existing key), SECRET, SMTP_*, GOOGLE_*
SCHEMA_PATH=/opt/pesanle/packages/appwrite-config/appwrite.config.json
```

Copy function variables into `functions.env` (`APPWRITE_DATABASE_ID`,
`STORAGE_S3_*` for `backup`, `RENDER_FUNCTION_KEY`, WhatsApp and payment keys
the cron jobs use). On live Appwrite the `backup` function has none set and has
been failing nightly with "Missing function variables: APPWRITE_API_KEY"; here
it gets the API key automatically.

## 3. Copy the data (dry run, any time)

```bash
bun run migrate --endpoint https://appwrite.pesanle.com/v1 --project 6aca6eb80032e8a805a9 \
  --key "$APPWRITE_API_KEY" --functions /opt/pesanle/packages/appwrite-config/appwrite.config.json --verify
```

Reads only. A trial run against production on 2026-10-27 copied 133 collections,
8,758 documents, 9 users, 17 teams and 230 files (46 MB) in 18 s, and the
document comparison found 0 mismatches. Users keep their passwords (argon2id
hashes carry over); sessions do not, so everyone signs in once after cutover.

## 4. Run it

```bash
sudo cp deploy/pesanle-backend.service /etc/systemd/system/
sudo systemctl enable --now pesanle-backend
curl localhost:8080/v1/health
```

Expose it with a Cloudflare Tunnel (`cloudflared`, ~20 MB, no open ports, no
certificates on the box), hostname `appwrite-new.pesanle.com` first, to test the
apps against it from a staging build.

## 5. Cutover (about 5 minutes)

1. Pause writes: maintenance banner, or just pick a quiet hour.
2. Stop the service, move the trial `data/` aside, and run the migrate command
   into a fresh database (a re-run replaces rows by ID but would keep rows
   deleted on live since the trial). Start the service.
3. Point `appwrite.pesanle.com` at the tunnel instead of the old server.
4. Sign in to each app once; check an order, a product image, and the
   Google button.
5. Keep the old Appwrite stopped but intact for a week, in case you roll back.

## 6. After cutover

- `RENDER_FUNCTION_URL=https://appwrite.pesanle.com/v1/functions/render/http`
  (Appwrite gave the function its own domain; here it is a path).
- Schema changes: edit `appwrite.config.json` as today, then `bun run schema:push`
  on the VPS (or restart: it applies `SCHEMA_PATH` on start). `appwrite push`
  and the Appwrite Console no longer apply.
- Backups: `bun run snapshot` daily from cron, and copy `data/snapshots` off the
  box (rclone to R2). The `backup` function's API dump keeps working too.

```cron
15 2 * * * cd /opt/pesanle-backend && /home/pesanle/.bun/bin/bun run snapshot && rclone sync data/snapshots r2:pesanle-backups/sqlite
```
