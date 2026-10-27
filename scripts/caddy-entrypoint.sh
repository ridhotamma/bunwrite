#!/bin/sh
# Start Caddy only once DOMAIN points at this server.
#
# A fresh install often runs `docker compose up` before the DNS record has
# propagated. Caddy would then fail its first ACME attempt and back off (up to
# a day between tries), even though a retry minutes later would succeed. Waiting
# here means the certificate is issued on the first attempt after propagation,
# without restarting the container.
set -eu

domain="${DOMAIN:-localhost}"
if [ "$domain" = "localhost" ] || [ "${CADDY_WAIT_DNS:-true}" = "false" ]; then
	exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
fi

# Accept a pasted URL as well as a bare hostname.
host=$(printf '%s' "$domain" | sed -e 's|^[Hh][Tt][Tt][Pp][Ss]\{0,1\}://||' -e 's|/.*$||')

interval="${CADDY_WAIT_INTERVAL:-10}"

# Public A/AAAA addresses. Query a public resolver so Docker's DNS cache cannot
# hide a recent change.
addresses() {
	nslookup "$host" 1.1.1.1 2>/dev/null | awk '
		/^Name:/ { want = 1; next }
		want && /^Address: / { print $2; want = 0 }
	'
}

# Compare against this host's egress address unless one was given. Set
# CADDY_WAIT_IP when a proxy (Cloudflare, a tunnel) sits in front of the origin,
# or CADDY_WAIT_DNS=false to skip the wait entirely.
expected="${CADDY_WAIT_IP:-}"
if [ -z "$expected" ]; then
	for url in https://api.ipify.org https://icanhazip.com https://ifconfig.me/ip; do
		expected=$(wget -qO- -T 5 "$url" 2>/dev/null | tr -d '[:space:]') || expected=''
		[ -n "$expected" ] && break
	done
fi

if [ -n "$expected" ]; then
	echo "[caddy] waiting for $host to point at $expected (CADDY_WAIT_DNS=false skips this)" >&2
else
	echo "[caddy] waiting for $host to resolve (public IP unknown; set CADDY_WAIT_IP to compare)" >&2
fi

checks=0
while :; do
	for address in $(addresses); do
		if [ -z "$expected" ] || [ "$address" = "$expected" ]; then
			echo "[caddy] $host -> $address; starting" >&2
			exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
		fi
	done
	checks=$((checks + 1))
	if [ $((checks % 6)) -eq 0 ]; then
		echo "[caddy] still waiting for $host after $((checks * interval))s" >&2
	fi
	sleep "$interval"
done
