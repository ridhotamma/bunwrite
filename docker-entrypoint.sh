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

# PocketBase Cloud-style continuous SQLite replication. The app keeps its
# local database; Litestream streams WAL frames to S3-compatible storage and
# restores missing databases before the app starts. Only one container may
# write to a replica prefix at a time.
if [ "${1:-serve}" = "serve" ] && [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
  database="${DATABASE_PATH:-/app/data/bunwrite.sqlite}"
  data_dir="${DATA_DIR:-$(dirname "$database")}"
  export DATABASE_PATH="$database"
  export DATA_DIR="$data_dir"
  export LITESTREAM_DATABASE_NAME="${LITESTREAM_DATABASE_NAME:-$(basename "$database")}"
  export LITESTREAM_SYNC_INTERVAL="${LITESTREAM_SYNC_INTERVAL:-1s}"
  export LITESTREAM_REPLICA_URL="${LITESTREAM_REPLICA_URL%/}"
  mkdir -p "$data_dir/projects"

  # A restore staged from the console replaces every database; apply it before
  # Litestream opens anything.
  /usr/local/bin/bunwrite restore --pending

  /usr/local/bin/bunwrite failover

  config="${LITESTREAM_CONFIG:-/app/litestream.yml}"
  exec /usr/local/bin/litestream replicate \
    -config "$config" \
    -exec "/usr/local/bin/bunwrite serve"
fi

exec /usr/local/bin/bunwrite "$@"
