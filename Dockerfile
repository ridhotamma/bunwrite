# Bunwrite container image: the standalone binary on a slim Debian base.
#
#   docker compose up -d --build
#
# Build and run on the same architecture so sharp/canvas native addons match.

# ---- Build the standalone binary ----
FROM oven/bun:1.4.4-debian AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN bun run build && ./dist/bunwrite --help >/dev/null

# ---- Litestream ----
# Keep the database on local disk and stream WAL frames to S3-compatible
# storage. The binary is copied into the runtime image; the Docker entrypoint
# wraps `serve` when LITESTREAM_REPLICA_URL is set.
FROM debian:trixie-slim AS litestream
ARG LITESTREAM_VERSION=0.5.17
ARG TARGETARCH
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    arch="${TARGETARCH:-$(uname -m)}"; \
    case "$arch" in \
      amd64|x86_64) asset=x86_64 ;; \
      arm64|aarch64) asset=arm64 ;; \
      *) echo "Unsupported architecture for Litestream: $arch" >&2; exit 1 ;; \
    esac; \
    asset_name="litestream-${LITESTREAM_VERSION}-linux-${asset}.tar.gz"; \
    curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/checksums.txt" \
      -o /tmp/litestream-checksums.txt; \
    curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${asset_name}" \
      -o /tmp/${asset_name}; \
    (cd /tmp && grep " ${asset_name}$" litestream-checksums.txt | sha256sum -c -); \
    tar -xzf /tmp/${asset_name} -C /usr/local/bin litestream; \
    chmod +x /usr/local/bin/litestream; \
    rm -f /tmp/${asset_name} /tmp/litestream-checksums.txt; \
    rm -rf /var/lib/apt/lists/*

# ---- Docker CLI for the one-command installer ----
# The installer enters the host daemon through the mounted socket, so the
# runtime image needs `docker` and the compose plugin. Both are static Go
# binaries and work on the Debian runtime below.
FROM docker:27-cli AS dockercli

# ---- Runtime ----
# Same Debian release as the build stage.
FROM debian:trixie-slim
# The image name and version the one-command installer writes into the generated
# compose file. Release builds pass the registry reference; a local build keeps
# `bunwrite:latest` and uses the image that is already on the host.
ARG BUNWRITE_IMAGE=bunwrite:latest
ARG BUNWRITE_VERSION=dev
# Optional extras, off by default to keep local images small. Release builds pass
# them as true so the published GHCR image is feature-complete:
#   WITH_PYTHON=true    python3 and pip for python-* functions (~70 MB)
#   WITH_CHROMIUM=true  Chromium + fonts for HTML to PDF and images (~730 MB more on disk)
#   WITH_OCR=true       Tesseract + English language data for scanned PDFs/images
ARG WITH_PYTHON=false
ARG WITH_CHROMIUM=false
ARG WITH_OCR=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libcap2-bin bubblewrap \
 && if [ "$WITH_PYTHON" = "true" ]; then apt-get install -y --no-install-recommends python3 python3-pip; fi \
 && if [ "$WITH_CHROMIUM" = "true" ]; then apt-get install -y --no-install-recommends chromium fonts-liberation fonts-dejavu-core fonts-noto-color-emoji; fi \
 && if [ "$WITH_OCR" = "true" ]; then apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng fonts-dejavu-core libfontconfig1; fi \
 && useradd --uid 10001 --create-home --home-dir /home/bunwrite bunwrite \
 # Function isolation (src/functions/sandbox.ts): each function builds and runs
 # as its own user. setpriv may switch users, and only the server's group may
 # run it. Functions get no-new-privs and no setuid programs to climb with.
 # bubblewrap is the optional FUNCTIONS_SANDBOX=bwrap layer. It needs
 # unprivileged user namespaces; the default Docker seccomp profile may block
 # them, so enable it only with a profile that allows user namespaces.
 && mkdir -p /usr/local/libexec \
 && install -o root -g bunwrite -m 0750 /usr/bin/setpriv /usr/local/libexec/bunwrite-sandbox \
 && setcap cap_setuid,cap_setgid+ep /usr/local/libexec/bunwrite-sandbox \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
 && apt-get purge -y --auto-remove libcap2-bin \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app/data/storage /app/data/backups /app/functions \
 && chown -R bunwrite:bunwrite /app

COPY --from=build /src/dist/bunwrite /usr/local/bin/bunwrite
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY deploy/litestream.yml /app/litestream.yml
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && chmod 0755 /usr/local/bin/docker /usr/local/libexec/docker/cli-plugins/docker-compose \
 && mkdir -p /usr/local/share/bunwrite \
 && printf '%s\n' "$BUNWRITE_IMAGE" > /usr/local/share/bunwrite/image \
 && printf '%s\n' "$BUNWRITE_VERSION" > /usr/local/share/bunwrite/version \
 && chmod 0755 /usr/local/share/bunwrite \
 && printf '#!/bin/sh\n[ "${1:-}" = "serve" ] && shift\nexec /usr/local/bin/bunwrite install "$@"\n' > /usr/local/bin/install \
 && printf '#!/bin/sh\n[ "${1:-}" = "serve" ] && shift\nexec /usr/local/bin/bunwrite upgrade "$@"\n' > /usr/local/bin/upgrade \
 && chmod 0755 /usr/local/bin/install /usr/local/bin/upgrade

LABEL org.opencontainers.image.title="Bunwrite" \
      org.opencontainers.image.description="A lightweight, Appwrite-compatible backend on Bun + SQLite + Drizzle" \
      org.opencontainers.image.source="https://github.com/ridhotamma/bunwrite" \
      org.opencontainers.image.version="$BUNWRITE_VERSION"

WORKDIR /app
USER bunwrite
# One HTTP process per CPU, sharing the port with SO_REUSEPORT.
# Set WORKERS=1 to run a single process.
# Chromium cannot start its sandbox in a default container (no user
# namespaces, and the setuid helpers are removed above), so the browser runs
# with --no-sandbox and the container is the isolation boundary. Set
# CHROME_NO_SANDBOX=false only when the container can provide user namespaces.
ENV HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_PATH=/app/data/bunwrite.sqlite \
    STORAGE_PATH=/app/data/storage \
    BACKUPS_PATH=/app/data/backups \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=true \
    WORKERS=auto
VOLUME ["/app/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["bunwrite", "health"]
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["serve"]
