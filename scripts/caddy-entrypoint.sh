#!/bin/sh
# Pick the Caddy configuration for the requested TLS mode, then start Caddy
# only once DOMAIN points at this server (ACME mode only).
#
# A fresh install often runs `docker compose up` before the DNS record has
# propagated. Caddy would then fail its first ACME attempt and back off (up to
# a day between tries), even though a retry minutes later would succeed. Waiting
# here means the certificate is issued on the first attempt after propagation,
# without restarting the container.
#
# TLS_MODE:
#   acme      Caddy obtains certificates from an ACME CA (default)
#   external  Caddy serves TLS_CERT_FILE / TLS_KEY_FILE, with on-demand ACME for
#             hosts the certificate does not cover
#   off       an upstream proxy or tunnel terminates TLS; Caddy serves HTTP
set -eu

domain="${DOMAIN:-localhost}"
mode=$(printf '%s' "${TLS_MODE:-acme}" | tr '[:upper:]' '[:lower:]')

case "$mode" in
	acme|caddy|letsencrypt)
		mode=acme
		config=/etc/caddy/Caddyfile
		;;
	external|files|file|cert|origin)
		mode=external
		config=/etc/caddy/Caddyfile.external
		cert="${TLS_CERT_FILE:-}"
		key="${TLS_KEY_FILE:-}"
		if [ -z "$cert" ] || [ -z "$key" ]; then
			echo "[caddy] TLS_MODE=external needs TLS_CERT_FILE and TLS_KEY_FILE" >&2
			exit 1
		fi
		if [ ! -r "$cert" ] || [ ! -r "$key" ]; then
			echo "[caddy] certificate or key is not readable: $cert / $key" >&2
			exit 1
		fi
		;;
	off|proxy|tunnel|none)
		mode=off
		config=/etc/caddy/Caddyfile.off
		;;
	*)
		echo "[caddy] unknown TLS_MODE=\"${TLS_MODE}\" — expected acme, external or off" >&2
		exit 1
		;;
esac

echo "[caddy] TLS_MODE=$mode ($config)" >&2

run() {
	exec caddy run --config "$config" --adapter caddyfile
}

# External and off modes have nothing to issue, so they never wait for DNS.
# ACME mode waits unless CADDY_WAIT_DNS explicitly says otherwise.
wait_dns="${CADDY_WAIT_DNS:-}"
if [ -z "$wait_dns" ]; then
	if [ "$mode" = "acme" ]; then wait_dns=true; else wait_dns=false; fi
fi

if [ "$mode" = "off" ] || [ "$domain" = "localhost" ] || [ "$wait_dns" = "false" ]; then
	run
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
			run
		fi
	done
	checks=$((checks + 1))
	if [ $((checks % 6)) -eq 0 ]; then
		echo "[caddy] still waiting for $host after $((checks * interval))s" >&2
	fi
	sleep "$interval"
done
