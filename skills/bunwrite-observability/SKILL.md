---
name: bunwrite-observability
description: "Use when adding observability to a Bunwrite app: request logs, traces, metrics, product analytics, feature flags, OTLP, Datadog, PostHog, and the console Observability pages. Explains what the server records automatically and which events the frontend must send. Triggers: Bunwrite observability, Datadog, PostHog, OTLP, OpenTelemetry, traces, metrics, feature flags, product analytics, request logging."
metadata:
  author: bunwrite
  version: "0.1.0"
---

# Bunwrite observability

Bunwrite records API-level observability on the server, keeps a bounded local
copy for the console, and can export it to OTLP, Datadog or PostHog. Product
events that only exist in the browser are **not** captured automatically; the
frontend sends those.

## What is automatic

| Signal | Captured by Bunwrite | Notes |
| --- | --- | --- |
| Request logs | Every API request | Stored in `_request_logs` and shown under **Console → Request logs** when `LOG_REQUESTS=true`. |
| Traces | One server span per API request | W3C `traceparent` is honoured. The console keeps a sample; exporters get the full stream. |
| Metrics | Every request | Per-minute requests/errors/latency rolled up for the console, plus counters, histograms and process gauges for exporters. |
| Product analytics | Document `create`, `update` and `delete` | Metadata only: project, database, collection, document ID and action. Never the document body. |
| Feature flags | Evaluation, when asked | `GET /v1/flags` returns local `FEATURE_FLAGS` overrides merged with PostHog. |

Every response carries `X-Request-Id`; when observability is on it also carries
`X-Trace-Id`.

## What the frontend must send

Bunwrite cannot see clicks, page views, client-side errors, session replay or
form steps. Those need a client call or a client SDK:

| Need | How to do it |
| --- | --- |
| Custom product events (`booking_started`, `checkout_clicked`, `search_performed`) | Use the PostHog browser SDK (`posthog-js`) with the same PostHog project key, or post the event to your own function which forwards it. Bunwrite has no generic analytics-ingest endpoint. |
| Page views, autocapture, session replay, heatmaps | PostHog browser SDK or Datadog RUM. These are browser features; the server cannot provide them. |
| Browser errors | PostHog error tracking, Datadog RUM or Sentry. Bunwrite captures server request errors, not client exceptions. |
| Frontend-to-backend trace correlation | Send a W3C `traceparent` header from the browser or gateway. Bunwrite continues the trace and returns `X-Trace-Id`. |
| Feature flags in the UI | Call `GET /v1/flags` (project header + user session or API key). Server-side `FEATURE_FLAGS` wins over PostHog. |

The PostHog project API key (`phc_...`) is a public ingestion key and is safe in
a browser. A Bunwrite API key (`X-Bunwrite-Key`) is not.

Join server and browser analytics on the same `distinct_id`: Bunwrite uses the
signed-in user's ID, or `project:<project-id>` for API-key writes. Pass the same
value to `posthog-js`:

```ts
posthog.identify(me.$id, { project: process.env.NEXT_PUBLIC_BUNWRITE_PROJECT_ID })
```

Do not invent a separate anonymous ID on the client for events that should join
server-side `document.*` events.

## Console

**Console → Observability** has four tabs:

- **Overview**: requests, error rate, p95, traces kept, analytics and flags;
  one-hour traffic chart; recent routes; exporter status.
- **Traces**: sampled spans with search/status filters and a detail page
  (trace, span, parent, request ID, attributes, error).
- **Analytics**: `document.*` events per hour, top events, distinct subjects and
  a filterable list.
- **Feature flags**: evaluate a user or project, see local overrides and the
  PostHog source.

The local copy is on when the console is on. It is independent of external
exporters:

```env
OBSERVABILITY_CONSOLE=true                 # defaults to CONSOLE_ENABLED
OBSERVABILITY_CONSOLE_SAMPLE_RATE=0.01     # detailed traces; metrics count every request
OBSERVABILITY_CONSOLE_SPANS=2000
OBSERVABILITY_CONSOLE_EVENTS=5000
OBSERVABILITY_CONSOLE_RETENTION_DAYS=7
```

## Export

With no provider configured, the console pages still work and nothing leaves
the server. Add one of these to `.env` and restart:

```env
# Any OTLP/HTTP collector, including Datadog's OTLP intake
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com
OTEL_EXPORTER_OTLP_HEADERS=api-key=...
OTEL_EXPORTER_OTLP_SIGNALS=traces,metrics,logs

# Datadog logs + metrics without an Agent
DD_API_KEY=...
DD_SITE=datadoghq.com

# PostHog analytics + server-side flags
POSTHOG_API_KEY=phc_...
POSTHOG_HOST=https://us.i.posthog.com
FEATURE_FLAGS={"new-checkout":true}
```

When Datadog handles logs and metrics, keep `OTEL_EXPORTER_OTLP_SIGNALS=traces`
so nothing is sent twice.

## Reading flags

```ts
const res = await fetch(`${endpoint}/flags`, {
  headers: {
    'X-Bunwrite-Project': projectId,
    // browser: send the session cookie instead of a key
    // server: 'X-Bunwrite-Key': apiKey,
  },
  credentials: 'include',
})
const { flags } = await res.json()
// e.g. { "new-checkout": true, "theme": "dark" }
```

The server caches PostHog evaluations for `POSTHOG_FLAGS_TTL_MS` (default 30s).
A PostHog outage falls back to `FEATURE_FLAGS`; it never fails the request.

## Privacy

- Request and response bodies are never exported.
- `LOG_IP=true` (default) includes the client IP in request telemetry; set it to
  `false` to omit it.
- Product analytics stores document metadata, not document data.
- Use `OBSERVABILITY_CONSOLE=false` to stop the local copy, and
  `OBSERVABILITY_ENABLED=false` to stop external export.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| Expecting page views or button clicks in **Analytics** | Bunwrite only records document writes. Send custom events from the client or your function. |
| Expecting PostHog autocapture or session replay from the server | Install `posthog-js` in the browser; the server key only enables server-side capture. |
| Sending `X-Bunwrite-Key` to a browser | Use an account session; keep API keys server-side. |
| Expecting database query spans or a Prometheus endpoint | Traces are request-level; export to OTLP/Datadog. No scrape endpoint or DB span exists yet. |
| Turning `LOG_REQUESTS=false` and expecting an empty Observability overview | Request logs and the Observability metrics are separate; metrics still count. The Request logs page is what goes empty. |
| Setting `CONSOLE_ENABLED=false` and looking for local traces | Local telemetry defaults to `CONSOLE_ENABLED`; set `OBSERVABILITY_CONSOLE=true` to keep it. |

## Verify

1. Send a few API requests and open **Console → Observability**.
2. Check `X-Request-Id` and `X-Trace-Id` on a response.
3. `curl -s <endpoint>/flags -H "X-Bunwrite-Project: <id>" -H "X-Bunwrite-Key: <key>"`.
4. For an exporter, check the provider for the service name (`OTEL_SERVICE_NAME`,
   default `bunwrite`) and `deployment.environment`.

## Reference

- [Observability guide](https://github.com/ridhotamma/bunwrite/blob/main/docs/OBSERVABILITY.md)
- [Configuration reference](https://github.com/ridhotamma/bunwrite/blob/main/docs/CONFIGURATION.md#observability)
- [Limitations](https://github.com/ridhotamma/bunwrite/blob/main/docs/LIMITATIONS.md#14-observability-is-opt-in-and-export-only)
