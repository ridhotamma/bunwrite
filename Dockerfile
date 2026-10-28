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
# Same Debian release as the build stage.
FROM debian:trixie-slim
# Optional extras, off by default to keep the image small:
#   WITH_PYTHON=true    python3 and pip for python-* functions (~70 MB)
#   WITH_CHROMIUM=true  Chromium + fonts for HTML to PDF and images (~730 MB more on disk)
ARG WITH_PYTHON=false
ARG WITH_CHROMIUM=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && if [ "$WITH_PYTHON" = "true" ]; then apt-get install -y --no-install-recommends python3 python3-pip; fi \
 && if [ "$WITH_CHROMIUM" = "true" ]; then apt-get install -y --no-install-recommends chromium fonts-liberation fonts-dejavu-core fonts-noto-color-emoji; fi \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --home-dir /home/bunwrite bunwrite \
 && mkdir -p /app/data/storage /app/data/backups /app/functions \
 && chown -R bunwrite:bunwrite /app

COPY --from=build /src/dist/bunwrite /usr/local/bin/bunwrite
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /app
USER bunwrite
ENV HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_PATH=/app/data/bunwrite.sqlite \
    STORAGE_PATH=/app/data/storage \
    BACKUPS_PATH=/app/data/backups \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=true
VOLUME ["/app/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["bunwrite", "health"]
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["serve"]
