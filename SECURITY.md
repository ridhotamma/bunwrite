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
- `SECRET`, `DATABASE_URL`, `AWS_*`, `VCS_GITHUB_*`, `SMTP_*`, provider keys
  and similar host variables are never inherited by user code. Configure the
  values a function/site needs as project or resource variables instead.

## Deployment notes

- Keep `TRUSTED_PROXIES` matched to the actual proxy addresses. The default
  `private` trusts RFC1918/loopback peers, which is appropriate for Compose
  and a local reverse proxy but not for a directly exposed host.
- Enabling `RENDER_ALLOW_REMOTE` lets a rendered page reach public URLs and
  private hosts that are not in the built-in metadata/internal blocklist. Run
  Chromium with its sandbox and without server credentials on the host.
- Set `BACKUP_ENCRYPTION_KEY` for backups; without it every archived secret is
  readable by anyone who obtains the file.
