# Security policy

Please do not open a public issue for security problems.

Report vulnerabilities privately through GitHub's **Report a vulnerability**
feature (Security → Advisories → Report a vulnerability). Include a description,
reproduction steps and the affected version or commit.

Only the latest release and the `main` branch are supported with security fixes.

## Hardened defaults

- Project credentials are isolated from function and site processes by a
  prefix/suffix denylist (`src/lib/private-env.ts`), not a short exact list.
- CORS reflects a hosted site/function origin only for its own project. A
  literal `*` never gets credentialed CORS, and state-changing requests with
  a browser `Origin` must match a trusted origin (CSRF guard).
- Webhook receivers must resolve to public addresses. Loopback, private,
  link-local, metadata and single-label hosts are refused unless
  `WEBHOOKS_ALLOW_PRIVATE=true`; TLS certificates are always verified.
- Client-chosen deployment IDs and entrypoints are validated as IDs/relative
  paths, archives reject links and special files, and static file serving
  resolves real paths inside the deployment.
- Console setup is available only from a loopback Host/IP, and the bootstrap
  API key is revoked (not merely hidden) once a console admin exists.
- OAuth state is bound to a short-lived HttpOnly browser cookie, so a callback
  URL started in another browser cannot create a session. Legacy flows can set
  `OAUTH_STATE_BINDING=false`.
- New passwords use Argon2id at m=19456/t=2; older Appwrite-format hashes still
  verify and are rehashed after a successful sign-in.
- Bunwrite's native user/session models omit password hashes and provider
  tokens. `API_COMPAT=appwrite` restores the legacy fields for old SDKs.
- Webhooks send an HMAC-SHA256 timestamped signature in addition to Appwrite's
  legacy HMAC-SHA1 header.
- `SECRET`, `DATABASE_URL`, `AWS_*`, `VCS_GITHUB_*`, `SMTP_*`, provider keys
  and similar host variables are never inherited by user code. Configure the
  values a function/site needs as project or resource variables instead.

## Deployment notes

- Keep `TRUSTED_PROXIES` matched to the actual proxy addresses. The default
  `private` trusts RFC1918/loopback peers, which is appropriate for Compose
  and a local reverse proxy but not for a directly exposed host.
- `RENDER_ALLOW_REMOTE` allows a rendered page to reach public URLs; loopback,
  private, link-local and metadata destinations are still checked and blocked
  at request time. `RENDER_ALLOW_PRIVATE=true` is the explicit opt-in for a
  local asset server. Header/footer templates may not load remote resources.
  Run Chromium with its sandbox and without server credentials on the host.
- Set `BACKUP_ENCRYPTION_KEY` for backups; without it every archived secret is
  readable by anyone who obtains the file.
