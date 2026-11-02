# Postgres with WAL-G, used by docker-compose.restore.yml for an isolated
# restore target. Production Postgres can use the same image or any host with
# wal-g installed.
FROM postgres:16-bookworm

ARG WALG_VERSION=3.0.9

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl libbrotli1 liblz4-1 libzstd1 libsodium23; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) walg_arch=amd64 ;; \
      arm64) walg_arch=aarch64 ;; \
      *) echo "Unsupported architecture for WAL-G: $arch" >&2; exit 1 ;; \
    esac; \
    asset="wal-g-pg-22.04-${walg_arch}.tar.gz"; \
    base="https://github.com/wal-g/wal-g/releases/download/v${WALG_VERSION}"; \
    curl -fsSL "$base/$asset" -o "/tmp/$asset"; \
    curl -fsSL "$base/$asset.sha256" -o "/tmp/$asset.sha256"; \
    (cd /tmp && sha256sum -c "$asset.sha256"); \
    tar -xzf "/tmp/$asset" -C /usr/local/bin; \
    mv "/usr/local/bin/wal-g-pg-22.04-${walg_arch}" /usr/local/bin/wal-g; \
    chmod +x /usr/local/bin/wal-g; \
    rm -f "/tmp/$asset" "/tmp/$asset.sha256"; \
    rm -rf /var/lib/apt/lists/*

COPY restore-entrypoint.sh /usr/local/bin/postgres-restore-entrypoint.sh
RUN chmod +x /usr/local/bin/postgres-restore-entrypoint.sh
