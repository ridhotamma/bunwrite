#!/bin/sh
# systemd wrapper: apply the startup-only limits before bunwrite starts.
# The rest of the autotune values are applied inside the process.
if tuned=$(/usr/local/bin/bunwrite autotune --shell 2>/dev/null); then
  eval "$tuned"
fi

# One HTTP process per CPU; set WORKERS=1 in .env to opt out.
export WORKERS="${WORKERS:-auto}"

# Optional PocketBase Cloud-style continuous replication. Keep the database on
# local disk; Litestream streams WAL frames to object storage. The failover
# command restores the control database and every project database first.
if [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
  litestream_bin="${LITESTREAM_BIN:-litestream}"
  if ! command -v "$litestream_bin" >/dev/null 2>&1; then
    echo "LITESTREAM_REPLICA_URL is set but $litestream_bin is not installed" >&2
    exit 1
  fi
  database="${DATABASE_PATH:-/opt/bunwrite/data/bunwrite.sqlite}"
  export DATABASE_PATH="$database"
  export DATA_DIR="${DATA_DIR:-$(dirname "$database")}"
  export LITESTREAM_DATABASE_NAME="${LITESTREAM_DATABASE_NAME:-$(basename "$database")}"
  export LITESTREAM_SYNC_INTERVAL="${LITESTREAM_SYNC_INTERVAL:-1s}"
  export LITESTREAM_REPLICA_URL="${LITESTREAM_REPLICA_URL%/}"
  mkdir -p "$DATA_DIR/projects"

  # A restore staged from the console replaces every database; apply it before
  # Litestream opens anything.
  /usr/local/bin/bunwrite restore --pending || exit 1

  /usr/local/bin/bunwrite failover

  exec "$litestream_bin" replicate \
    -config "${LITESTREAM_CONFIG:-/opt/bunwrite/deploy/litestream.yml}" \
    -exec "/usr/local/bin/bunwrite serve"
fi

exec /usr/local/bin/bunwrite serve
