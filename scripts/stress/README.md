# Stress testing

`bun run stress` seeds a collection through the normal Appwrite-compatible API
and measures HTTP throughput with `oha` (or a small built-in Bun client).

It is a development tool. Point it at a disposable database or Docker volume,
not at production data.

## Requirements

- Bun 1.4+ (already required by the project).
- `oha` for accurate results:

  ```bash
  brew install oha        # macOS
  # or see https://github.com/hatoo/oha for Linux packages
  ```

  Without `oha`, the script falls back to `--tool builtin`. That client runs in
  one Bun process, so it can become the bottleneck at high concurrency.

## Quick start against a running instance

```bash
export STRESS_API_KEY=your-api-key

# Seed 20,000 products into the collection in appwrite.config.json.
bun run stress seed \
  --base http://localhost:8080/v1 \
  --config ./appwrite.config.json \
  --count 20000

# The seed prints a ready-to-copy "next" command, including the generated
# prefix and the first document ID.
bun run stress run \
  --base http://localhost:8080/v1 \
  --config ./appwrite.config.json \
  --prefix stress-20261028120000 \
  --concurrency 1,10,50,100,200 \
  --duration 10
```

If the config has no `projectId`, add `--project <project-id>`. You can also
pass `--key`, `--session` or `--jwt` instead of the environment variable.

`seed` requires an API key because it uses the bulk-create endpoint. `run` can
use an API key, a session or a JWT.

## Docker at 2 vCPU / 2 GB

This is the setup used for the published measurements:

```bash
docker build -t bunwrite:stress .
docker volume create bunwrite-stress-data

# 1. Apply the schema from the config (the config folder is mounted read-only).
docker run --rm --cpus=2 --memory=2g --memory-swap=2g \
  -v bunwrite-stress-data:/app/data \
  -v "$PWD/../pesanle/packages/appwrite-config:/config:ro" \
  bunwrite:stress bunwrite schema:push /config/appwrite.config.json

# 2. Start the server. Add -e LOG_REQUESTS=true for the realistic default.
docker run -d --name bunwrite-stress --init \
  --cpus=2 --memory=2g --memory-swap=2g \
  -p 18080:8080 \
  -v bunwrite-stress-data:/app/data \
  -e PROJECT_ID=your-project-id \
  -e API_KEYS=stress-key \
  -e SECRET=0123456789abcdef0123456789abcdef01234567 \
  -e PUBLIC_ENDPOINT=http://localhost:18080/v1 \
  -e CONSOLE_ENABLED=false \
  -e LOG_REQUESTS=false \
  bunwrite:stress

# 3. Wait for /v1/health, then seed and run.
export STRESS_API_KEY=stress-key
bun run stress seed --base http://localhost:18080/v1 \
  --config ../pesanle/packages/appwrite-config/appwrite.config.json --count 20000
bun run stress run --base http://localhost:18080/v1 \
  --config ../pesanle/packages/appwrite-config/appwrite.config.json \
  --prefix stress-... --concurrency 1,10,50,100,200

# 4. Clean up.
docker rm -f bunwrite-stress
docker volume rm bunwrite-stress-data
```

`PROJECT_ID` must match the project ID your apps send in
`X-Appwrite-Project`. The config's `projectId` is used automatically when
present. If the server printed generated bootstrap credentials at startup, use
that `PROJECT_ID` and API key instead. `SECRET` is only needed by the server,
not by the stress tool.

## Custom endpoints

Single URL:

```bash
bun run stress run \
  --url http://localhost:8080/v1/health \
  --concurrency 10,50,100 \
  --duration 10
```

Custom method/body:

```bash
# Repeated upserts of one document (every request succeeds).
bun run stress run \
  --url http://localhost:8080/v1/databases/main/collections/products/documents/stress-1 \
  --method PUT \
  --body '{"data":{"name":"Test","status":"active"}}' \
  --key "$STRESS_API_KEY"
```

Multiple targets from a JSON file:

```json
[
  {
    "name": "health",
    "url": "http://localhost:8080/v1/health",
    "concurrency": [10, 50]
  },
  {
    "name": "list",
    "url": "http://localhost:8080/v1/databases/main/collections/products/documents?queries[0]=...",
    "headers": { "X-Appwrite-Key": "..." }
  }
]
```

```bash
bun run stress run --targets stress-targets.json --duration 10
```

Common auth headers are merged into every target; headers in the file override
them. `randomUrl` marks a URL as an `oha` regex and is only supported by
`--tool oha`.

## What the built-in targets do

When you pass `--config` and do not pass `--url`/`--targets`, the runner builds:

- `health`: `GET /v1/health`.
- `list`: the collection documents endpoint with an optional tenant filter,
  `status` filter, `order`, `limit`, `select` and `total`.
- `point`: `GET .../documents/<point-id>` (default `<prefix>-000000`).
- `write`: optional (`--write`) `PUT .../<write-collection>/documents/write-<random>`
  using a generated body from the write collection's definition.

Attributes that do not exist in the collection definition are skipped, so the
same command works with the small example schema and a large production schema.

## Results

Every run writes `data/stress/stress-<timestamp>.json` and prints:

```
list           c=  50    5318 rps  p50= 8.7ms  p95=12.6ms  p99=19.6ms  ok=100.00%  30.8 KB  1338.7 Mbps  users@5s≈26594
```

`users@5s` is `RPS × 5`. It assumes each user makes one request every five
seconds; divide by the number of API calls a real page makes. It is not a
measurement of logged-in or WebSocket users.

`total=true` and request logging (`LOG_REQUESTS=true`) both cost throughput.
Run both modes if you need a realistic estimate.

## Safety and cleanup

- Seeding and `--write` create data. Use a disposable database, Docker volume or
  a unique `--prefix`.
- The tool does not delete seeded documents. Drop the database/volume or delete
  them yourself.
- The Docker commands above use a separate volume named `bunwrite-stress-data`;
  they never touch the normal `bunwrite-data` volume.
- `--duration` is in seconds. The full default matrix is 5 concurrency levels ×
  3 targets × 10 seconds plus warmups, so it takes a few minutes.

Run `bun run stress --help` for every option.
