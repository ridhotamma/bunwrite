# Bunwrite container image: the standalone binary on a slim Debian base.
#
#   docker compose up -d --build
#
# Build and run on the same architecture so sharp's native addon matches.

# ---- Build the standalone binary ----
FROM oven/bun:1.4.4-debian AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN bun run build && ./dist/bunwrite --help >/dev/null

# ---- Runtime ----
FROM debian:bookworm-slim
# Python functions need python3. Off by default to keep the image small:
#   docker compose build --build-arg WITH_PYTHON=true
ARG WITH_PYTHON=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && if [ "$WITH_PYTHON" = "true" ]; then apt-get install -y --no-install-recommends python3; fi \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --home-dir /home/bunwrite bunwrite \
 && mkdir -p /app/data/storage /app/data/backups /app/functions \
 && chown -R bunwrite:bunwrite /app

COPY --from=build /src/dist/bunwrite /usr/local/bin/bunwrite

WORKDIR /app
USER bunwrite
ENV HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_PATH=/app/data/bunwrite.sqlite \
    STORAGE_PATH=/app/data/storage \
    BACKUPS_PATH=/app/data/backups
VOLUME ["/app/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["bunwrite", "health"]
CMD ["bunwrite", "serve"]
