# Observability

Bunwrite can export request logs, traces, metrics, product analytics and feature
flags to a third party, and keeps a local copy for the console's Observability
pages. Everything is optional and implemented as plain HTTPS calls: there is no
vendor SDK and no sidecar.

Providers and sampling are configured per project in **Console →
Observability → Settings**. The settings are stored in the project's database,
so each project has its own exporter credentials, sampling, limits and local
feature flags. There are no observability environment variables: a project
without saved settings uses the built-in defaults, and saving applies them
without a restart.

Projects that have never saved settings may inherit the control project's saved
configuration once after upgrading from the old instance-wide setting; after
that each project has its own copy and can be changed independently.

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

The console has an **Observability** section with five tabs:

| Page | What it shows |
| --- | --- |
| Overview | Requests, error rate, p95, traces kept, analytics and flags for this project; one-hour traffic chart; recent routes; exporter status. |
| Traces | Sampled request spans, with route/status/search filters and a detail page (trace ID, span ID, request ID, attributes, error). |
| Analytics | Document events per hour, top events, distinct subjects and a filterable event list. |
| Feature flags | Flags evaluated for a user or project, with local overrides and the PostHog source. |
| Settings | Per-project providers, sampling, limits and local flags, stored in the project database. |

This copy is local and works without a provider:

- **Metrics** are counted for every request and upserted once per minute per
  project (`_telemetry_minutes`), so the chart is accurate and costs one write
  per minute instead of one per request.
- **Traces** are sampled at the project's console sample rate (default `1%`)
  into `_telemetry_spans`, capped at the configured span limit (default
  `2000`).
- **Analytics** stores document metadata in `_telemetry_events`, capped at the
  configured event limit (default `5000`).
- Everything is pruned after the configured retention (default 7 days).

Turn **Keep local telemetry in the console** off in Settings to stop the local
copy. Metrics and traces still export to a configured provider.

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

## Console settings

Open **Observability → Settings**. Organization owners can edit:

- **Local console** — keep local traces/events, sampling, limits and retention.
- **External exporters** — the project's switch, service metadata, trace
  sampling, timeout and queue size.
- **OTLP/HTTP** — base and per-signal endpoints, headers and signals.
- **Datadog** — API key, site, logs and metrics.
- **PostHog** — project API key, host, analytics, flags and cache TTL.

Local feature flags are managed from **Observability → Feature flags**: add
boolean or text flags, edit them, remove one, or clear all. Changes save
immediately and win over PostHog.

Saving applies the new configuration immediately: the project's exporters are
rebuilt and its local telemetry limits are updated. Stored API keys and headers
are never rendered back into the page; leave a secret blank to keep it, or use
its **remove** checkbox. **Reset to defaults** deletes the project's saved
settings and restores the built-in defaults.

The page is visible to every console admin, but only an organization owner can
save or reset it.

## Enable it in the console

Open **Observability → Settings** for the project, turn on **Enable external
exporters**, fill in the provider you use and save. Changes take effect
immediately; no restart is needed.

Turning **Enable external exporters** off stops every outbound exporter. It does
not stop the local console copy; use **Keep local telemetry in the console** for
that.

## Datadog

### Logs and metrics (no Agent)

In **Observability → Settings → Datadog**, enter the API key, choose the site,
and enable **Send logs** and **Send metrics**.

This posts to `https://http-intake.logs.<site>/api/v2/logs` and
`https://api.<site>/api/v1/series`. Logs carry `service`, `env`, `project`,
`route`, `status` and `request.id` as tags/attributes; metrics use the same
route labels.

### Traces (OTLP intake)

In **Observability → Settings → OTLP/HTTP**, set the base endpoint to
`https://otlp.datadoghq.com`, add `dd-api-key=...` to the headers, and select
only **Traces**.

Use the regional endpoint that matches the Datadog site (`otlp.datadoghq.eu`,
`otlp.us3.datadoghq.com`, `otlp.us5.datadoghq.com`,
`otlp.ap1.datadoghq.com`). Selecting only **Traces** avoids sending logs and
metrics twice, once through the Datadog intake and once through OTLP.

### Local Datadog Agent

If the Agent runs beside Bunwrite, skip the Datadog key and point the OTLP/HTTP
base endpoint at it:

```text
http://host.docker.internal:4318
```

## PostHog

In **Observability → Settings → PostHog**, enter the project API key, choose the
host, and enable **Send document analytics** and/or **Evaluate feature flags**.

Product analytics events are named `document.created`, `document.updated` and
`document.deleted`. They carry `project`, `database`, `collection`,
`collection_name`, `document_id` and `action`; **the document body is never
sent**. The distinct ID is the signed-in user's ID, or `project:<id>` for
server-side/API-key writes.

Feature flags are evaluated server-side through `POST /flags?v=2` and cached for
the configured **Flag cache** duration. Local overrides always win and are
managed in **Observability → Feature flags**.

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
Collector in a sidecar). In **Observability → Settings → OTLP/HTTP**, set the
base endpoint, add any headers, and select the signals to export. Service
metadata and trace sampling live in **External exporters**.

Per-signal endpoints are available when a collector expects different hosts.
Enter them under **Traces endpoint**, **Metrics endpoint** and **Logs
endpoint**; they override the base.

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

Sampling is head-based. Set **Trace sampling** under **External exporters**;
the default is 100%. Metrics and shipped logs are not sampled by this setting.
To reduce log volume, lower `LOG_SAMPLE_RATE` (which also reduces SQLite
request-log rows) or turn off **Send logs** in the Datadog section.

## Behaviour under failure

- Every exporter has a bounded queue (default 5000 events per signal) and drops
  the oldest events when a provider is slow.
- Sends run off the request path; a request never waits for a provider.
- A failed batch is retried on the next flush, up to the queue limit.
- Failures are logged once a minute, or on every failure when **Log every
  exporter failure** is enabled.
- `SIGTERM` flushes all queues before exit (bounded by the configured timeout,
  default 5000 ms).

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
- Provider keys are stored in the project's database and never rendered back
  into the console pages or logged.

## Not included yet

- Database query spans and SQL metrics.
- A Prometheus scrape endpoint (export to an OTLP collector or use Datadog).
- Built-in alerting, readiness checks and audit trails.
