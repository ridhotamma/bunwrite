# Observability

Bunwrite can export request logs, traces, metrics, product analytics and feature
flags to a third party. Everything is optional, configured from the environment,
and implemented as plain HTTPS calls: there is no vendor SDK and no sidecar.

With no provider configured the subsystem is off. The request path only checks a
boolean, so it costs nothing on an instance that does not use it.

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

## Enable it

Add the provider settings to `.env` and restart:

```bash
docker compose up -d --force-recreate
```

`OBSERVABILITY_ENABLED=false` is the kill switch. Without it, any configured
provider turns the subsystem on.

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
