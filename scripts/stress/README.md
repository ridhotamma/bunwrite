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

## Booking-app scenario

`bun run stress:booking` builds a disposable booking dataset and measures the
paths a booking user generates. It creates the `booking_stress` database and
three collections (`services`, `slots`, `bookings`) through the normal API,
seeds them, then runs either one path at a time or a concurrent mix.

```bash
export STRESS_API_KEY=your-api-key

# Create the schema and seed services, slots and bookings.
bun run stress:booking setup \
  --base https://bunwrite.example.com/v1 \
  --project booking-app \
  --reset

# Per-path throughput and latency (uses oha).
bun run stress:booking run \
  --manifest data/stress/booking-bkg-202610301200.json \
  --concurrency 1,10,50,100,200,400

# Real concurrent mix: 30% booking writes, 70% reads.
bun run stress:booking mix \
  --manifest data/stress/booking-bkg-202610301200.json \
  --mix-concurrency 50,75,100,125,150 \
  --mix-duration 30 --mix-warmup 3
```

`setup` prints the manifest path. The mix assigns clients as 15% services,
35% availability, 15% bookings, 5% point read and 30% create. The report gives
the highest client count that stays under a p95 latency SLO with at least 99%
success, plus an active-user estimate based on five API calls per user per
minute. Change that assumption for your real page.

This scenario deliberately writes more than most booking apps (30% of calls).
It is useful for finding the SQLite write ceiling; a read-heavy storefront mix
will sustain more throughput. HTML rendering is not included.

Delete the disposable database when done:

```bash
bun run stress:booking cleanup --yes \
  --base https://bunwrite.example.com/v1 --project booking-app
```

### Logged-in user and per-document permissions

`setup` also creates `booking_private` (document security on) and a
`stress-session@example.com` user, grants `read`/`create` on the booking
collections to `users`, and gives each private document a read grant for that
user. Run the same paths as that user, without an API key:

```bash
bun run stress:booking session --manifest data/stress/booking-....json \
  --concurrency 10,50,100
```

This adds `private` (list `booking_private`) and `private-point`. Compare it
with an API-key run to see what the session lookup and permission filters cost;
API keys skip both. Re-run `setup --reset` on an older dataset to create the
user and the private collection.

## Social-media scenario

`bun run stress:social` builds a disposable social dataset and measures the
paths a social user generates: home feed, following feed, trending, post detail,
comments, profile, profile posts, full-text search, create post, post likes,
comments, comment likes, reposts, follows, and the counter increments those
actions trigger.

It creates the `social_stress` database with seven collections (`profiles`,
`posts`, `comments`, `post_likes`, `comment_likes`, `reposts`, `follows`),
seeds them, then runs per-path matrices or a concurrent mix.

```bash
export STRESS_API_KEY=your-api-key

# Create the schema and seed 86,000 documents.
bun run stress:social setup \
  --base https://bunwrite.example.com/v1 \
  --project social-media-app \
  --prefix soc-20261030 --reset

# Per-path throughput and latency.
bun run stress:social run \
  --manifest data/stress/social-soc-20261030.json \
  --concurrency 1,10,50,100 \
  --write-concurrency 1,10,25,50

# Only some paths.
bun run stress:social run \
  --manifest data/stress/social-soc-20261030.json \
  --paths feed,post,comments,like,create-post

# Real concurrent mix: 8 read paths and 10 write/counter paths.
bun run stress:social mix \
  --manifest data/stress/social-soc-20261030.json \
  --mix-concurrency 50,100,200 \
  --mix-duration 20 --mix-warmup 5

# The same reads/writes as a logged-in user (session + permissions).
bun run stress:social session \
  --manifest data/stress/social-soc-20261030.json \
  --concurrency 10,50,100
```

The default mix is feed-heavy (27% home feed) with roughly 30% writes. Counter
paths (`like-count`, `comment-like-count`, `repost-count`, `follow-count`) use
`PATCH .../documents/<id>/<attribute>/increment`, targeting 100 hot rows to
model viral posts. If your client updates counters differently, adjust the mix
or skip those paths with `--paths`.

Seed sizes are configurable (`--profiles`, `--posts`, `--comments`,
`--post-likes`, `--comment-likes`, `--reposts`, `--follows`); `--profiles`,
`--posts` and `--comments` must be at least 100 because the counter paths use a
regex over the first 100 IDs. The report estimates active users from 20 API
calls per user per 60 s.

Delete the disposable database when done:

```bash
bun run stress:social cleanup --yes \
  --base https://bunwrite.example.com/v1 --project social-media-app
```

## Realtime WebSocket scenario

`bun run stress:realtime` opens real WebSocket clients against
`/v1/realtime` and measures two things:

- `connect`: how many sockets can connect and subscribe, how long the handshake
  takes, and whether they stay alive under a ping cadence.
- `fanout`: how many document events each subscribed socket receives when REST
  writes are made, plus delivery latency, loss and duplicates.

```bash
export STRESS_API_KEY=your-api-key

# Connection capacity: 100, 500 and 1000 sockets, held for 30s.
bun run stress:realtime connect \
  --base https://bunwrite.example.com/v1 \
  --project social-media-app \
  --connections 100,500,1000 --duration 30 --ping-interval 5

# Event fan-out: N listeners, M REST writes, measure delivery to every socket.
bun run stress:realtime fanout \
  --base https://bunwrite.example.com/v1 \
  --project social-media-app \
  --manifest data/stress/social-soc-20261030.json \
  --fanout-connections 100,290 --writes 100 --write-concurrency 10
```

The listener channel defaults to `databases.<db>.collections.<collection>.documents`.
Use `--channels` with collection names (`posts,comments,...`), `social` for all
six social collections, or `all` for the global `documents` channel. The
`--collection` flag also picks the write body, so the fan-out test can create
posts, comments, post likes, comment likes, reposts or follows.

Auth modes:

```bash
--auth key                  # X-Appwrite-Key header (default)
--auth session              # session header, signs in the social stress user
--auth session --auth-message  # guest socket, then browser-style authentication message
--auth guest                # no auth; events are filtered by collection permissions
```

The session login defaults to `stress-social@example.com`; set
`STRESS_SESSION_PASSWORD` if the password differs.

### Connection ceiling

The published test host originally stalled at **~290–300 concurrent
connections**. At 300, REST writes also timed out, which pointed at a
file-descriptor budget shared by Caddy and Bun (roughly 3 descriptors per
WebSocket). The bundled `docker-compose.yml` now sets `nofile=65536` on both
`bunwrite` and `caddy`; redeploy for it to take effect and check the host's
`fs.file-max` / `net.core.somaxconn` as well.

The realtime hub was also changed to:

- queue fan-out instead of running it inside the document-write request;
- index sockets by channel instead of scanning every socket per event;
- serialize the event payload once and only append per-socket subscription IDs;
- bound subscriptions and close slow clients via Bun's `backpressureLimit`;
- let `/realtime` upgrades bypass `MAX_INFLIGHT`, so a reconnect storm does not
  turn into 503s.

On a local single-process instance with the new hub:

| Check | Result |
| --- | --- |
| 10,000 socket attempt | 9,917 connected, 0 closed during hold, every ping answered |
| 1,000 listeners × 100 writes | 100,000 events, 0% loss, p95 387 ms |
| 1,000 listeners, unique subscription IDs | 100,000 events, 0% loss, p95 543 ms |
| 5,000 listeners × 20 writes | 99,260 events, 0% loss, p95 387 ms |
| Old hub vs new, 290 listeners | 378 → 1,493 write RPS |

`WEBSOCKET_COMPRESSION=false` is worth testing for a 1 vCPU host with many
connected clients: per-message deflate spends CPU on every event. The stress
report prints attempted vs connected vs subscribed and lists write errors, so a
capacity failure is visible instead of looking like 0% event loss.

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

## Measuring on the server itself

A run from your laptop includes TLS, Caddy, the network and the Wi-Fi hop. To
see the server's own ceiling, run the load generator in the same box and call
loopback:

```bash
# Copy oha into the running container, then measure without Caddy or TLS.
docker cp "$(command -v oha)" bunwrite-stress:/tmp/oha
docker exec bunwrite-stress /tmp/oha -z 30s -c 50 http://127.0.0.1:8080/v1/health
```

Run the same command against the published port from the host
(`http://127.0.0.1:18080/v1/health`) to see what the proxy and network add.
Production numbers are often about ten times lower than a local loopback run,
more than a slower VPS core alone explains; connections and the proxy usually
account for most of the gap. The 1–5% errors sometimes seen at 200+ clients are
also usually connection- or proxy-side rather than application errors.

Request logging is on by default and costs 5–25%. For a ceiling test set
`LOG_REQUESTS=false`, or keep it on with `LOG_SAMPLE_RATE=0.1` to log a tenth of
successful requests (errors are still always logged). A run with an API key
also skips the session lookup and permission filters that logged-in SDK users
pay for, so expect lower numbers for session clients.

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
