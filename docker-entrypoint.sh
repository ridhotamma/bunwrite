#!/bin/sh
# Apply the two limits that must exist before the Bun runtime starts (JSC heap
# and glibc malloc arenas), then hand the container over to bunwrite.
set -eu

if tuned=$(/usr/local/bin/bunwrite autotune --shell 2>/dev/null); then
  eval "$tuned"
fi

# Support both `docker run image` (CMD is `serve`) and
# `docker run image bunwrite serve`.
if [ "${1:-}" = "bunwrite" ]; then shift; fi

exec /usr/local/bin/bunwrite "$@"
