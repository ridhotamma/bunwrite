/** Shared pieces for the Observability console pages. */
import { lineChart } from '~/console/chart'
import { html, type Html } from '~/console/html'
import { badge, cardHead, emptyState, when } from '~/console/ui'
import type { Observability } from '~/observability'
import type { MetricSummary, MinutePoint, RouteCount, SpanRow } from '~/observability/store'

export const OBS = '/console/observability'

export const OBS_TABS = [
  { key: 'overview', label: 'Overview', href: OBS },
  { key: 'traces', label: 'Traces', href: `${OBS}/traces` },
  { key: 'analytics', label: 'Analytics', href: `${OBS}/analytics` },
  { key: 'flags', label: 'Feature flags', href: `${OBS}/flags` },
  { key: 'settings', label: 'Settings', href: `${OBS}/settings` },
] as const

export const duration = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`)
export const statusTone = (status: number): 'success' | 'info' | 'attention' | 'critical' =>
  status >= 500 ? 'critical' : status >= 400 ? 'attention' : status >= 300 ? 'info' : 'success'

const method = (value: string) => html`<span class="mono">${value}</span>`

export function providerCard(observability: Observability): Html {
  const c = observability.config
  const row = (label: string, on: boolean, detail?: string) =>
    html`<li>
      <span>${label}</span><span>${badge(on ? 'On' : 'Off', on ? 'success' : 'info')}${detail ? html` <span class="subdued">${detail}</span>` : ''}</span>
    </li>`
  const signals = c.otlp ? [...c.otlp.signals].join(', ') : ''
  const otlpOn = c.enabled && Boolean(c.otlp && c.otlp.signals.size)
  const datadogOn = c.enabled && Boolean(c.datadog && (c.datadog.logs || c.datadog.metrics))
  const posthogOn = c.enabled && Boolean(c.posthog && (c.posthog.analytics || c.posthog.flags))
  return html`<div class="card">
    ${cardHead('Exporters', html`<a class="subdued" href="${OBS}/settings">Settings</a>`)}
    <ul class="list">
      ${row('Console traces', c.console, `${(c.consoleSampleRate * 100).toFixed(1)}% sampled`)}
      ${row('OTLP/HTTP', otlpOn, c.enabled ? signals : 'external export is off')}
      ${row('Datadog', datadogOn, c.datadog ? [c.datadog.logs ? 'logs' : '', c.datadog.metrics ? 'metrics' : ''].filter(Boolean).join(' + ') : undefined)}
      ${row('PostHog', posthogOn, c.posthog ? [c.posthog.analytics ? 'analytics' : '', c.posthog.flags ? 'flags' : ''].filter(Boolean).join(' + ') : undefined)}
    </ul>
    <p class="help">
      Local traces keep the last ${c.spanLimit.toLocaleString('en-US')} spans in total for ${c.consoleRetentionDays}
      day${c.consoleRetentionDays === 1 ? '' : 's'}. Exporters are the system of record. Providers are managed on the
      <a href="${OBS}/settings">Settings</a> tab.
    </p>
  </div>`
}

export function trafficCard(minutes: MinutePoint[], summary: MetricSummary): Html {
  if (summary.requests === 0) {
    return html`<div class="card">
      ${cardHead('Traffic, last hour')} ${emptyState('No requests yet', 'The chart fills in after some API traffic.')}
    </div>`
  }
  return html`<div class="card">
    ${cardHead('Traffic, last hour', html`<span class="subdued">${summary.requests.toLocaleString('en-US')} requests · p95 ${duration(summary.p95)}</span>`)}
    ${lineChart({
      labels: minutes.map((minute) => minute.minute.slice(11, 16)),
      series: [
        { label: 'Requests', color: '#16a34a', values: minutes.map((minute) => minute.requests) },
        { label: 'Errors', color: '#db2777', values: minutes.map((minute) => minute.errors) },
      ],
    })}
  </div>`
}

export function routesCard(routes: RouteCount[]): Html {
  return html`<div class="card">
    ${cardHead('Recent routes', html`<span class="subdued">sampled traces</span>`)}
    ${
      routes.length
        ? html`<ul class="list">
            ${routes.map(
              (route) =>
                html`<li>
                  <span class="mono clip" title="${route.route}">${route.route}</span>
                  <span class="subdued">${route.requests.toLocaleString('en-US')} · ${duration(route.avg)}${route.errors ? ` · ${route.errors} err` : ''}</span>
                </li>`,
            )}
          </ul>`
        : emptyState('No routes yet', 'Routes appear here after the first requests.')
    }
  </div>`
}

export function recentTracesCard(spans: SpanRow[], moreHref: string): Html {
  return html`<div class="card flush">
    <div class="toolbar">
      <h2 style="margin:0">Recent traces</h2>
      <a class="subdued" style="margin-left:auto" href="${moreHref}">View all</a>
    </div>
    ${
      spans.length
        ? html`<div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Method</th>
                  <th>Route</th>
                  <th>Status</th>
                  <th class="num">Duration</th>
                </tr>
              </thead>
              <tbody>
                ${spans.map(
                  (span) =>
                    html`<tr class="row-link" onclick="location='${moreHref}/${span.seq}'">
                      <td class="nowrap">${when(span.created_at)}</td>
                      <td>${method(span.method)}</td>
                      <td class="clip mono"><a href="${moreHref}/${span.seq}" title="${span.route}">${span.route}</a></td>
                      <td>${badge(String(span.status), statusTone(span.status))}</td>
                      <td class="num">${duration(span.duration_ms)}</td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`
        : emptyState('No traces yet', 'Traces are sampled; send some traffic and they appear here.')
    }
  </div>`
}

export function traceFacts(span: SpanRow): Html {
  const row = (label: string, value: Html | string) => html`<li><span class="subdued">${label}</span><span>${value}</span></li>`
  return html`<div class="card">
    <h2>Span</h2>
    <ul class="list">
      ${row('Time', when(span.created_at))} ${row('Method', method(span.method))} ${row('Route', html`<span class="mono">${span.route}</span>`)}
      ${row('Status', badge(String(span.status), statusTone(span.status)))} ${row('Duration', duration(span.duration_ms))}
      ${row('Project', span.project || '—')} ${row('Auth', span.auth || '—')} ${row('Trace ID', html`<span class="mono">${span.trace_id}</span>`)}
      ${row('Span ID', html`<span class="mono">${span.span_id}</span>`)}
      ${row('Parent span', span.parent_span_id ? html`<span class="mono">${span.parent_span_id}</span>` : '—')}
      ${row('Request ID', span.request_id ? html`<a class="mono" href="/console/logs?q=${encodeURIComponent(span.request_id)}">${span.request_id}</a>` : '—')}
    </ul>
  </div>`
}

export function attributesCard(attributes: string): Html {
  let pretty = attributes
  try {
    pretty = JSON.stringify(JSON.parse(attributes), null, 2)
  } catch {
    // Keep the raw value when it is not JSON.
  }
  return html`<div class="card">
    <h2>Attributes</h2>
    <pre>${pretty}</pre>
  </div>`
}
