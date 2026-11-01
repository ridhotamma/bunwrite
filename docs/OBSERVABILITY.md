# Observability

Bunwrite can export request logs, traces, metrics, product analytics and feature
flags to a third party, and keeps a local copy for the console's Observability
pages. Everything is optional, configured from the environment, and implemented
as plain HTTPS calls: there is no vendor SDK and no sidecar.

The local console copy is on by default; external export is off until a provider
is configured. The request path only pays for a minute counter and, when the
console is disabled, a single boolean check.

## Signals

| Signal | Sinks | What it contains |
| --- | --- | --- |
| Request logs | OTLP/HTTP logs, Datadog Logs | One record per request: method, route, status, duration, project, auth label, optional client IP, user agent, error. |
| Traces | OTLP/HTTP traces | One server span per request, with W3C context propagation. |
| Metrics | OTLP/HTTP metrics, Datadog series | Request counters and latency histograms, in-flight gauge, process memory. |
| Product analytics | PostHog | Document create/update/delete events, metadata only. |
| Feature flags | PostHog, local overrides | Evaluated per user or project and cached. |

Request logs shipped this way are independent of `LOG_REQUESTS`: turning off the
SQLite/stdout request log does not stop the exporters, and vice versa.

## Console pages

The console has an **Observability** section with four tabs:

| Page | What it shows |
| --- | --- |
| Overview | Requests, error rate, p95, traces kept, analytics and flags for this project; one-hour traffic chart; recent routes; exporter status. |
| Traces | Sampled request spans, with route/status/search filters and a detail page (trace ID, span ID, request ID, attributes, error). |
| Analytics | Document events per hour, top events, distinct subjects and a filterable event list. |
| Feature flags | Flags evaluated for a user or project, with local overrides and the PostHog source. |

This copy is local and works without a provider:

- **Metrics** are counted for every request and upserted once per minute per
  project (`_telemetry_minutes`), so the chart is accurate and costs one write
  per minute instead of one per request.
- **Traces** are sampled at `OBSERVABILITY_CONSOLE_SAMPLE_RATE` (default `0.01`)
  into `_telemetry_spans`, capped at `OBSERVABILITY_CONSOLE_SPANS`.
- **Analytics** stores document metadata in `_telemetry_events`, capped at
  `OBSERVABILITY_CONSOLE_EVENTS`.
- Everything is pruned after `OBSERVABILITY_CONSOLE_RETENTION_DAYS` (default 7).

Set `OBSERVABILITY_CONSOLE=false` to turn the local copy off. Metrics and traces
still export to a configured provider.

## Server and frontend responsibilities

Bunwrite captures everything that reaches the API:

- Request logs, request spans and per-minute request metrics.
- `document.created`, `document.updated` and `document.deleted` for writes made
  through the API, an SDK, a function or the console.
- Feature-flag evaluation when `GET /v1/flags` is called.

It does **not** see the browser. These still come from the frontend:

| Need | Who sends it |
| --- | --- |
| Page views, clicks, search, booking/checkout steps | `posthog-js`, or a call to your own function that forwards the event. There is no generic analytics-ingest endpoint. |
| Session replay, autocapture, heatmaps, browser errors, RUM | PostHog browser SDK or Datadog RUM. |
| Feature flags in the UI | The app calls `GET /v1/flags`. No event is recorded; the call returns the evaluated flags. |
| Frontend-to-backend trace correlation | The browser or gateway sends a W3C `traceparent`; Bunwrite continues the trace and returns `X-Trace-Id`. |

The PostHog project key (`phc_...`) is a public ingestion key and is safe in a
browser. Use the same user ID on both sides so `posthog-js` events join the
server's `document.*` events:

```ts
posthog.identify(me.$id, { project: projectId })
```

Bunwrite uses the signed-in user's ID, or `project:<project-id>` for API-key
writes, as the analytics `distinct_id`.

## Enable it

Add the provider settings to `.env` and restart:

```bash
docker compose up -d --force-recreate
```

`OBSERVABILITY_ENABLED=false` disables every external exporter. It does not stop
the local console copy; use `OBSERVABILITY_CONSOLE=false` for that.

## Datadog

### Logs and metrics (no Agent)

```env
DD_API_KEY=...
DD_SITE=datadoghq.com
DD_LOGS_ENABLED=true
DD_METRICS_ENABLED=true
```

This posts to `https://http-intake.logs.<site>/api/v2/logs` and
`https://api.<site>/api/v1/series`. Logs carry `service`, `env`, `project`,
`route`, `status` and `request.id` as tags/attributes; metrics use the same
route labels.

### Traces (OTLP intake)

```env
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.datadoghq.com
OTEL_EXPORTER_OTLP_HEADERS=dd-api-key=...
OTEL_EXPORTER_OTLP_SIGNALS=traces
```

Use the regional endpoint that matches `DD_SITE` (`otlp.datadoghq.eu`,
`otlp.us3.datadoghq.com`, `otlp.us5.datadoghq.com`, `otlp.ap1.datadoghq.com`).
Keeping `OTEL_EXPORTER_OTLP_SIGNALS=traces` avoids sending logs and metrics
twice, once through the Datadog intake and once through OTLP.

### Local Datadog Agent

If the Agent runs beside Bunwrite, skip the Datadog key and point OTLP at it:

```env
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318
```

## PostHog

```env
POSTHOG_API_KEY=phc_...
POSTHOG_HOST=https://us.i.posthog.com
POSTHOG_ANALYTICS=true
POSTHOG_FLAGS=true
```

Product analytics events are named `document.created`, `document.updated` and
`document.deleted`. They carry `project`, `database`, `collection`,
`collection_name`, `document_id` and `action`; **the document body is never
sent**. The distinct ID is the signed-in user's ID, or `project:<id>` for
server-side/API-key writes.

Feature flags are evaluated server-side through `POST /flags?v=2` and cached for
`POSTHOG_FLAGS_TTL_MS`. Local overrides always win:

```env
FEATURE_FLAGS={"new-checkout":true,"theme":"dark"}
```

Read them from your frontend or function through the API:

```bash
curl -s https://your-host/v1/flags \
  -H "X-Appwrite-Project: booking-app" \
  -H "X-Appwrite-Key: $API_KEY"
```

```json
{ "flags": { "new-checkout": true, "theme": "dark" } }
```

A user session works too, so the same call returns that user's PostHog
evaluation. A PostHog outage falls back to the local values; it never fails the
request.

## Generic OTLP

Any OTLP/HTTP collector works (Grafana Alloy, Honeycomb, Tempo, Jaeger, a
Collector in a sidecar):

```env
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com
OTEL_EXPORTER_OTLP_HEADERS=api-key=...
OTEL_EXPORTER_OTLP_SIGNALS=traces,metrics,logs
OTEL_SERVICE_NAME=booking-api
DEPLOYMENT_ENVIRONMENT=production
```

Per-signal endpoints are available when a collector expects different hosts:

```env
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://tempo.example.com/v1/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://mimir.example.com/otlp/v1/metrics
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://loki.example.com/otlp/v1/logs
```

## Metrics reference

| Metric | Type | Labels |
| --- | --- | --- |
| `bunwrite.http.requests` | counter | `method`, `route`, `status`, `status_class` |
| `bunwrite.http.request.duration` | histogram (ms) | `method`, `route`, `status_class` |
| `bunwrite.http.response.bytes` | counter | `method`, `route`, `status_class` |
| `bunwrite.http.in_flight` | gauge | — |
| `bunwrite.process.memory.rss` | gauge (bytes) | — |
| `bunwrite.process.memory.heap_used` | gauge (bytes) | — |
| `bunwrite.process.memory.heap_total` | gauge (bytes) | — |
| `bunwrite.process.memory.external` | gauge (bytes) | — |
| `bunwrite.process.uptime` | gauge (seconds) | — |

Routes are normalised before they become labels
(`/v1/databases/db/collections/c/documents/<id>` becomes
`/databases/:id/collections/:id/documents/:id`), so IDs cannot explode
cardinality.

## Traces

Each request gets a server span named `<METHOD> <route>`, with the standard
`http.request.method`, `http.route`, `url.path`, `http.response.status_code`,
`http.request.body.size`, `http.response.body.size`, `client.address` and
`user_agent.original` attributes, plus `bunwrite.project`, `bunwrite.auth` and
`request.id`.

An incoming W3C `traceparent` header is honoured, so a trace started by your
gateway continues through Bunwrite. Every response carries `X-Request-Id` and,
when observability is on, `X-Trace-Id`.

Sampling is head-based:

```env
OBSERVABILITY_SAMPLE_RATE=0.1
```

Metrics and shipped logs are not sampled by this setting. To reduce log volume,
lower `LOG_SAMPLE_RATE` (which also reduces SQLite request-log rows) or turn off
`DD_LOGS_ENABLED`.

## Behaviour under failure

- Every exporter has a bounded queue (`OBSERVABILITY_QUEUE_LIMIT`) and drops the
  oldest events when a provider is slow.
- Sends run off the request path; a request never waits for a provider.
- A failed batch is retried on the next flush, up to the queue limit.
- Failures are logged once a minute, or on every failure with
  `OBSERVABILITY_DEBUG=true`.
- `SIGTERM` flushes all queues before exit (bounded by
  `OBSERVABILITY_TIMEOUT_MS`).

## Multi-process deployments

Every worker exports independently and identifies itself with
`service.instance.id` (`<host>:<worker>`). Metrics are deltas per process, so sum
them across instances rather than taking an average. `bunwrite.http.in_flight`
is a per-process gauge, not a cluster total.

## Privacy

- Request and response bodies are never exported.
- Client IP is included only when `LOG_IP=true`, matching the request log.
- The auth label is a category or user ID (`user:<id>`, `key`, `guest`,
  `console:<email>`), not a token.
- Product analytics sends document metadata, never document data.
- Provider keys are read from the environment and never written to the
  database or logs.

## Not included yet

- Database query spans and SQL metrics.
- A Prometheus scrape endpoint (export to an OTLP collector or use Datadog).
- Built-in alerting, readiness checks and audit trails.
