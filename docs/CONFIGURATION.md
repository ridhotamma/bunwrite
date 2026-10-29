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

## Server

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `0.0.0.0` (example: `127.0.0.1`) | Address Bun listens on. Use `127.0.0.1` when Caddy, nginx or cloudflared runs on the same host. Docker sets it to `0.0.0.0` inside the container. |
| `PORT` | `8080` | HTTP port. Must be a number; an empty value is parsed as `0` (random port). |
| `API_COMPAT` | `bunwrite` | Names Bunwrite sends: `bunwrite` or `appwrite`. Both naming families are always accepted. |
| `COMPOSE_PROFILES` | `caddy` in `.env.example` | `caddy` starts the bundled Caddy container in Docker Compose. Remove it for your own proxy or a Cloudflare Tunnel. |

`API_COMPAT` only changes what the server sends, not what it reads:

| | `bunwrite` | `appwrite` |
| --- | --- | --- |
| Session cookie | `bw_session_<project>` | `a_session_<project>` |
| Webhook headers | `X-Bunwrite-Webhook-*` | `X-Appwrite-Webhook-*` |
| Function variables | `BUNWRITE_*` | `BUNWRITE_*` and `APPWRITE_*` |

Use `appwrite` when moving an existing Appwrite app so webhook receivers and
functions keep working unchanged.

## Domains and HTTPS

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOMAIN` | unset | Public hostname, without `https://` or a path. Also sets `PUBLIC_ENDPOINT` to `https://<DOMAIN>/v1`. |
| `PUBLIC_ENDPOINT` | derived | Public API URL including `/v1`, used by OAuth callbacks and file links. Set it when TLS ends at a tunnel or another host. |
| `SITES_PREFIX` | `sites` | Site host prefix: `<site-id>.<prefix>.<DOMAIN>`. |
| `FUNCTIONS_PREFIX` | `functions` | Function host prefix: `<function-id>.<prefix>.<DOMAIN>`. |
| `SITES_DOMAIN` | `sites.<DOMAIN>` or `sites.localhost` | Overrides the whole site base domain. |
| `FUNCTIONS_DOMAIN` | `functions.<DOMAIN>` or `functions.localhost` | Overrides the whole function base domain. |
| `CADDY_WAIT_DNS` | `true` | With the bundled Caddy, wait for `DOMAIN` to resolve before starting. |
| `CADDY_WAIT_IP` | unset | Address `DOMAIN` should resolve to while Caddy waits. |
| `TRUSTED_PROXIES` | `private` | Which peers may supply `X-Forwarded-For` / `CF-Connecting-IP`. See [request logs](#request-logs-and-client-ip). |

With `DOMAIN=appwrite.example.com`:

- Site `landing` answers on `landing.sites.appwrite.example.com`
- Function `hello` answers on `hello.functions.appwrite.example.com`

Each site and function also keeps its default address when you add custom
domains. Custom domains can be added in the console, with a `domains` array on
the API, or through Appwrite's proxy rules.

### Caddy

The bundled Caddy container terminates TLS and asks Bunwrite
(`/.well-known/bunwrite/host`) before issuing a certificate for a host. It needs:

- A DNS A/AAAA record for `DOMAIN`
- Wildcard A/AAAA records for `*.sites.<DOMAIN>` and `*.functions.<DOMAIN>`
- Ports 80 and 443 open

Custom domains need their own CNAME (to `<site-id>.<SITES_DOMAIN>` or the
function's default host) or A record, plus a certificate through Caddy's
on-demand TLS.

### Cloudflare Tunnel

When a hostname is routed through Cloudflare Tunnel, Cloudflare terminates TLS.
Do not also run Caddy's automatic HTTPS for that hostname:

- Remove the `caddy` profile, or run Caddy HTTP-only with `auto_https off`.
- Point `cloudflared` at `http://bunwrite:8080` or `http://127.0.0.1:8080`.
- Let Cloudflare manage certificates. Universal SSL covers `example.com` and
  `*.example.com`, not `*.sites.example.com`; use Total TLS / Advanced
  Certificate Manager or a certificate that covers the deeper wildcard.
- For arbitrary customer-owned domains, use Cloudflare for SaaS custom
  hostnames, or point those domains directly at the server and let Caddy issue
  their certificates.

Do not send the same hostname through both Caddy and the tunnel. Choose one TLS
terminator per host.

## Data, uploads and backups

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_PATH` | `./data/bunwrite.sqlite` | SQLite file for the default project. |
| `STORAGE_PATH` | `./data/storage` | Uploaded files when S3 storage is off. |
| `BACKUPS_PATH` | `./data/backups` | Local database snapshots when backup S3 storage is off. |

Additional projects live under `data/projects/<project-id>/`, each with its own
database, storage, backups and functions folder.

S3 for uploads and backups is configured in **Console → Settings → File storage**
and **Settings → Backups**, not in `.env`. Backups contain the database only;
back up `STORAGE_PATH` or the uploads bucket separately.

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

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOG_REQUESTS` | `true` | Write one line per HTTP request to stdout and the console's request log. |
| `LOG_FORMAT` | `text` | `text` for journald, `json` for a log collector. |
| `LOG_RETENTION_DAYS` | `7` | Days to keep request logs; `0` keeps them until cleared. |
| `LOG_IP` | `true` | Store client IP addresses in request logs. |
| `TRUSTED_PROXIES` | `private` | Comma-separated proxy sources trusted for client IP headers. |

`TRUSTED_PROXIES` values:

- `private` — loopback and private networks: Caddy, nginx, Cloudflare Tunnel
- `cloudflare` — Cloudflare edge addresses, and trust `CF-Connecting-IP`
- `none` — always use the connection's address
- a CIDR such as `10.1.0.0/16` or a single address

Use `cloudflare` when Cloudflare is the only way in (origin firewalled or a
tunnel). Headers from other clients are ignored, so they cannot spoof a new IP
to dodge sign-in limits.

## Functions

| Variable | Default | Meaning |
| --- | --- | --- |
| `FUNCTIONS_ENV_FILE` | unset | dotenv file with variables available to every function execution. |
| `FUNCTIONS_DIR` | schema folder or `.` | Base folder for relative function `path`s. Can also be set in **Console → Settings → Functions**. |
| `FUNCTIONS_BUILD_COMMANDS` | `true` | Run a function's `commands` during deployment. |
| `PYTHON_BIN` | `python3` | Python executable for `python-*` runtimes. |
| `FUNCTIONS_SKIP_SCHEDULES` | unset | Comma-separated function IDs whose schedules should be ignored. |

Function-specific variables can also be set in the console. Console values win
over the env file, and a function's own variable wins over a global one.

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
| `SITES_SSR_MAX_PROCESSES` | `2` | Most SSR apps running at once per project. The least recently used app is stopped first. Memory, not CPU, is the limit: a warm Next/Nuxt app is often 80–150 MB. |
| `SITES_SSR_KEEP_PREVIOUS` | `2` | Ready SSR deployments kept besides the live one, for rollback. Each one is a full app folder on disk; set `0` or `1` on a small disk. |

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
| `MAX_REQUEST_BODY_MB` | auto, 16–256 | Largest accepted HTTP request body. |
| `BUN_JSC_forceRAMSize` | unset | JS heap size in bytes. Startup-only; the Docker entrypoint and systemd wrapper set it. |
| `MALLOC_ARENA_MAX` | unset | glibc malloc arena count. Startup-only; set by the deployment wrapper. |

## Caching and compression

| Variable | Default | Meaning |
| --- | --- | --- |
| `CACHE_FILES_MAX_AGE` | `3888000` | Browser cache lifetime for file views/downloads, in seconds. |
| `CACHE_PREVIEWS_MAX_AGE` | `2592000` | Browser cache lifetime for image previews, in seconds. |
| `PREVIEW_CACHE_DAYS` | `30` | Days a generated preview stays on disk; `0` keeps it until the file changes. |
| `COMPRESSION` | `true` | Compress responses (Brotli, else gzip) and realtime messages. |

These can also be changed in **Console → Settings → Caching**.

## Image previews

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHARP_CONCURRENCY` | auto, 1–4 | libvips worker threads. |
| `SHARP_CACHE_MB` | auto, 16–128 | libvips operation cache; `0` disables it. |
| `PREVIEW_CONCURRENCY` | auto, 1–8 | Previews rendered at once; the rest wait in line. |
| `AVIF_MAX_MEGAPIXELS` | auto, 2–16 | Largest AVIF output. AVIF needs about 30 bytes per pixel. |

## HTML rendering

Used by `POST /v1/pdf` and `POST /v1/image`. Also switchable in
**Console → Settings → HTML rendering**.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RENDER_ENABLED` | `false` | Turn rendering on. Needs Chromium on the host. |
| `RENDER_ALLOW_REMOTE` | `false` | Allow pages to load remote images, fonts and stylesheets. Off blocks all remote requests. |
| `CHROME_PATH` | found on PATH | Chrome/Chromium executable. |
| `CHROME_ARGS` | unset | Extra Chromium flags, space-separated. |
| `CHROME_NO_SANDBOX` | unset | `true` in containers without user namespaces; `docker-compose.yml` sets it. |
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

## Project schema

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCHEMA_PATH` | unset | Project config (`bunwrite.config.json` or `appwrite.config.json`) used by `schema:push` and the console's Schema page. |
| `SCHEMA_SYNC_ON_START` | `false` | Apply `SCHEMA_PATH` on every start. Off so console edits are not overwritten. |

## First-start seeds

These values seed an **empty** database once. After the instance exists they are
ignored; change the project, keys and settings in the console.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORG_ID` | generated | Organization ID shown in the console. |
| `PROJECT_ID` | generated | Project ID apps send in `X-Bunwrite-Project` / `X-Appwrite-Project`. Reuse an Appwrite project ID when migrating. |
| `PROJECT_NAME` | `Bunwrite` | Console and email name. |
| `API_KEYS` | generated | Comma-separated keys, imported hashed and revocable like console keys. |
| `SECRET` | generated | Signs JWTs and OAuth state. At least 32 random characters when set. |
| `ALLOWED_ORIGINS` | `localhost` | Comma-separated browser origins for CORS and redirects. `*.example.com` matches subdomains. |
| `SESSION_DURATION` | `31536000` | Session lifetime in seconds. |
| `SESSIONS_LIMIT` | `10` | Sessions kept per user. |

Generate a secret with:

```bash
openssl rand -hex 32
```

### Email

SMTP can also be configured in **Console → Settings → Email & sign-in**.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMTP_HOST` | unset | SMTP server. Without it email is disabled. |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_USERNAME` | unset | SMTP user. |
| `SMTP_PASSWORD` | unset | SMTP password. |
| `SMTP_SECURE` | empty | `tls` for implicit TLS on 465; empty uses STARTTLS when offered. |
| `SMTP_SENDER_EMAIL` | `no-reply@example.com` | From address. |
| `SMTP_SENDER_NAME` | `<PROJECT_NAME> Team` | From name. |

### Google sign-in

Can also be configured in the console.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | unset | Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | unset | Google OAuth client secret. |
| `GOOGLE_AUTH_URL` | Google default | Override for a compatible provider. |
| `GOOGLE_TOKEN_URL` | Google default | Override for a compatible provider. |
| `GOOGLE_USERINFO_URL` | Google default | Override for a compatible provider. |

## Other references

- [README quick start](../README.md#setup-from-zero)
- [Deployment](DEPLOY.md)
- [Sites and domains](SITES.md)
- [HTML rendering](RENDER.md)
- [Architecture](ARCHITECTURE.md)
