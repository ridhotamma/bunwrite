#!/bin/sh
# Fetch a WAL-G base backup into an empty PGDATA, then let Postgres replay WAL.
#
# This entrypoint is for the isolated restore service in
# docker-compose.restore.yml. It refuses to touch a PGDATA that already has a
# database, so pointing it at the production volume fails closed.
set -eu

if [ "$(id -u)" = '0' ]; then
  mkdir -p "$PGDATA"
  chown -R postgres:postgres "$PGDATA"
  exec gosu postgres "$0" "$@"
fi

if [ -f "$PGDATA/PG_VERSION" ]; then
  echo "restore: $PGDATA already contains a database; refusing to overwrite it." >&2
  echo "restore: use a fresh volume, or move the old PGDATA aside first." >&2
  exit 1
fi

if [ -z "${WALG_S3_PREFIX:-}${WALG_FILE_PREFIX:-}${WALG_GS_PREFIX:-}${WALG_AZ_PREFIX:-}${WALG_SWIFT_PREFIX:-}" ]; then
  echo "restore: set WALG_S3_PREFIX (or another WALG_*_PREFIX) before starting." >&2
  exit 1
fi

mkdir -p "$PGDATA"
chmod 700 "$PGDATA"

backup="${RESTORE_BACKUP:-LATEST}"
echo "restore: fetching base backup $backup into $PGDATA"
wal-g backup-fetch "$PGDATA" "$backup"

# recovery.signal is the Postgres 12+ way to request recovery. The settings are
# appended after the backup so they win over the archived postgresql.conf.
if [ -n "${RESTORE_TARGET_TIME:-}" ]; then
  target=$(printf '%s' "$RESTORE_TARGET_TIME" | sed "s/'/''/g")
  {
    echo "restore_command = 'wal-g wal-fetch %f %p'"
    echo "recovery_target_time = '$target'"
    echo "recovery_target_action = 'promote'"
  } >> "$PGDATA/postgresql.conf"
else
  {
    echo "restore_command = 'wal-g wal-fetch %f %p'"
    echo "recovery_target_action = 'promote'"
  } >> "$PGDATA/postgresql.conf"
fi

touch "$PGDATA/recovery.signal"
exec /usr/local/bin/docker-entrypoint.sh postgres
