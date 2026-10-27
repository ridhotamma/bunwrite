# VPS playbook

This Ansible playbook provisions a fresh Ubuntu/Debian VPS and leaves Bunwrite
running as a systemd service:

- installs the build/runtime packages and Bun
- clones and builds the standalone `bunwrite` binary
- creates the service user, data directories and a secure `.env`
- installs the systemd unit, starts Bunwrite and waits for `/v1/health`
- optionally installs Caddy and obtains a TLS certificate when you set a domain

The server only needs the binary at runtime; Bun is installed so the playbook
can build updates on the VPS.

## Requirements

- A fresh Ubuntu 24.04 (or Debian 12+) VPS with SSH access.
- Ansible on your computer (`pipx install ansible-core` or your package manager).
- Port 8080 reachable for direct access, or ports 80/443 if you use a domain.
- If you use a domain: point its DNS `A`/`AAAA` record at the VPS first.

## Run it

```bash
cp playbook/inventory.example.ini playbook/inventory.ini
$EDITOR playbook/inventory.ini       # add the VPS host

ansible-playbook -i playbook/inventory.ini playbook/site.yml \
  -e bunwrite_admin_email=you@example.com
```

Without a domain, Bunwrite is available at `http://<vps-ip>:8080`, and the
playbook prints the console URL, admin password and API key on the first run.

With a domain and automatic HTTPS:

```bash
ansible-playbook -i playbook/inventory.ini playbook/site.yml \
  -e bunwrite_domain=api.example.com \
  -e bunwrite_admin_email=you@example.com \
  -e bunwrite_allowed_origins=https://app.example.com
```

Caddy obtains the certificate and proxies to Bunwrite on `127.0.0.1:8080`;
with a domain the playbook sets `HOST=127.0.0.1` so Bunwrite is not exposed
directly. Without a domain it binds `0.0.0.0:8080`.

Useful overrides:

| Variable | Default | Meaning |
| --- | --- | --- |
| `bunwrite_domain` | empty | Domain for Caddy and HTTPS; empty means direct `:8080` |
| `bunwrite_admin_email` | `admin@bunwrite.local` | First console admin |
| `bunwrite_admin_password` | generated | First-run admin password; generated and printed if omitted |
| `bunwrite_api_key` | generated | Server API key; generated and printed if omitted |
| `bunwrite_secret` | generated | Session/signing secret |
| `bunwrite_project_id` | `bunwrite` | Project ID apps send |
| `bunwrite_project_name` | `Bunwrite` | Name shown in the console |
| `bunwrite_allowed_origins` | `*` | CORS origins; restrict this in production |
| `bunwrite_port` | `8080` | Local Bunwrite port |
| `bunwrite_public_endpoint` | computed | Public API URL including `/v1`; override for NAT or an external proxy |
| `bunwrite_repo` | GitHub HTTPS URL | Source repository |
| `bunwrite_version` | `main` | Branch, tag or commit to deploy |

Pass overrides with `-e name=value` or an extra-vars YAML file.

## First login

The first run prints the console URL, admin email/password and API key. They are
also stored in `/opt/bunwrite/.env` (mode `0600`). Change the admin password in
the console after signing in.

If you use Caddy, make sure DNS points at the VPS before the first run and open
ports 80/443 in your firewall. Without Caddy, open the chosen Bunwrite port.

## Updating

Re-run the playbook. It pulls `bunwrite_version`, rebuilds the binary, installs
it and restarts the service. Data in `/opt/bunwrite/data` and existing secrets
in `/opt/bunwrite/.env` are preserved.

```bash
ansible-playbook -i playbook/inventory.ini playbook/site.yml
```

To change non-secret settings, edit `/opt/bunwrite/.env` and run
`sudo systemctl restart bunwrite`, or use **Settings** in the console. The
playbook only creates the initial environment file and refreshes the variables
listed in `site.yml` on later runs.

## Manual checks

```bash
systemctl status bunwrite
journalctl -u bunwrite -f
curl http://127.0.0.1:8080/v1/health
cd /opt/bunwrite
sudo -u bunwrite /usr/local/bin/bunwrite console:admin you@example.com
```

Back up `/opt/bunwrite/data` and `/opt/bunwrite/.env` before major upgrades.
