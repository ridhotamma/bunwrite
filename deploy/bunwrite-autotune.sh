#!/bin/sh
# systemd wrapper: apply the startup-only limits before bunwrite starts.
# The rest of the autotune values are applied inside the process.
if tuned=$(/usr/local/bin/bunwrite autotune --shell 2>/dev/null); then
  eval "$tuned"
fi

# One HTTP process per CPU; set WORKERS=1 in .env to opt out.
export WORKERS="${WORKERS:-auto}"

exec /usr/local/bin/bunwrite serve
