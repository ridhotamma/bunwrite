import type { ConsoleRouter } from '~/console/context'
import { html } from '~/console/html'
import { pageCount, pageParams } from '~/console/query'
import { alert, badge, cardHead, destroy, emptyState, header, listCard, menu, pager, searchForm, stat, tabs, when } from '~/console/ui'
import { lineChart } from '~/console/chart'
import { addSeconds } from '~/lib/datetime'
import type { MinutePoint } from '~/observability/store'
import {
  OBS,
  OBS_TABS,
  attributesCard,
  duration,
  providerCard,
  recentTracesCard,
  routesCard,
  statusTone,
  traceFacts,
  trafficCard,
} from '~/console/views/observability'

const TRACES = `${OBS}/traces`
const ANALYTICS = `${OBS}/analytics`
const FLAGS = `${OBS}/flags`

const STATUS_FILTERS: [string, string][] = [
  ['', 'Any status'],
  ['2xx', '2xx success'],
  ['4xx', '4xx client error'],
  ['5xx', '5xx server error'],
]

const percent = (value: number): string => `${value.toFixed(value >= 10 ? 0 : 1)}%`

function fillMinutes(minutes: MinutePoint[]) {
  const now = new Date()
  now.setUTCSeconds(0, 0)
  const labels = Array.from({ length: 60 }, (_, index) => new Date(now.getTime() - (59 - index) * 60_000).toISOString().slice(0, 16))
  const byMinute = new Map(minutes.map((minute) => [minute.minute, minute]))
  return labels.map((minute) => byMinute.get(minute) ?? { minute, requests: 0, errors: 0, avg: 0 })
}

export function observabilityPages(router: ConsoleRouter): void {
  router.get(OBS, async ({ ctx }) => {
    const project = ctx.services.config.projectId
    const sinceMinute = new Date(Date.now() - 3_600_000).toISOString().slice(0, 16)
    const day = addSeconds(-86400)
    await ctx.services.telemetry.flush()
    const [summary, minutes, routes, recent, counts, events, distinct, flags] = await Promise.all([
      ctx.services.telemetry.summary(project, sinceMinute),
      ctx.services.telemetry.minutePoints(project, sinceMinute),
      ctx.services.telemetry.topRoutes(project, day, 6),
      ctx.services.telemetry.listSpans({ page: 1, limit: 8, project }),
      ctx.services.telemetry.counts(project),
      ctx.services.telemetry.eventSummary(project, day),
      ctx.services.telemetry.distinctIds(project, day),
      ctx.observability.flags.evaluate(`project:${project}`, { project }),
    ])
    const eventCount = events.reduce((sum, event) => sum + event.n, 0)
    const errorRate = summary.requests > 0 ? (summary.errors / summary.requests) * 100 : 0
    const body = html`${header('Observability')} ${tabs(OBS_TABS, 'overview')}
      ${!ctx.services.config.logRequests ? alert('warning', html`Request logging is off, so the traffic cards stay empty. Set <code>LOG_REQUESTS=true</code> and restart, or rely on the exported metrics.`) : ''}
      ${!ctx.observability.config.console ? alert('info', html`The local console trace store is off (<code>OBSERVABILITY_CONSOLE=false</code>). External exporters are unaffected.`) : ''}
      <div class="stats" style="margin:16px 0">
        ${stat('Requests, 1h', summary.requests.toLocaleString('en-US'), '/console/logs')} ${stat('Error rate', percent(errorRate), '/console/logs?status=5xx')}
        ${stat('p95 latency', duration(summary.p95), '/console/logs')} ${stat('Traces kept', counts.spans.toLocaleString('en-US'), TRACES)}
        ${stat('Analytics, 24h', eventCount.toLocaleString('en-US'), ANALYTICS)} ${stat('Distinct subjects', distinct.toLocaleString('en-US'), ANALYTICS)}
        ${stat('Flags returned', Object.keys(flags).length.toLocaleString('en-US'), FLAGS)}
      </div>
      <div class="layout" style="margin-bottom:16px">${trafficCard(fillMinutes(minutes), summary)}${routesCard(routes)}</div>
      <div class="layout">${recentTracesCard(recent.spans, TRACES)}${providerCard(ctx.observability)}</div>`
    return ctx.render('Observability', 'observability', body)
  })

  router.get(TRACES, async ({ ctx, url }) => {
    const project = ctx.services.config.projectId
    const search = url.searchParams.get('q') ?? ''
    const status = url.searchParams.get('status') ?? ''
    const { page, limit } = pageParams(url, 50)
    const { total, spans } = await ctx.services.telemetry.listSpans({ page, limit, project, search, status })
    const pages = pageCount(total, limit)
    const statusSelect = html`<select name="status" aria-label="Filter by status">
      ${STATUS_FILTERS.map(([value, label]) => html`<option value="${value}" ${value === status ? 'selected' : ''}>${label}</option>`)}
    </select>`
    const body = spans.length
      ? html`<div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Method</th>
                <th>Route</th>
                <th>Status</th>
                <th class="num">Duration</th>
                <th class="hide-sm">Request ID</th>
                <th class="hide-sm">Trace ID</th>
              </tr>
            </thead>
            <tbody>
              ${spans.map(
                (span) =>
                  html`<tr class="row-link" onclick="location='${TRACES}/${span.seq}'">
                    <td class="nowrap">${when(span.created_at)}</td>
                    <td class="mono">${span.method}</td>
                    <td class="clip mono"><a href="${TRACES}/${span.seq}" title="${span.route}">${span.route}</a></td>
                    <td>${badge(String(span.status), statusTone(span.status))}</td>
                    <td class="num">${duration(span.duration_ms)}</td>
                    <td class="mono clip hide-sm">${span.request_id || '—'}</td>
                    <td class="mono clip hide-sm" title="${span.trace_id}">${span.trace_id}</td>
                  </tr>`,
              )}
            </tbody>
          </table>
        </div>`
      : emptyState(
          'No traces yet',
          search || status ? 'Try a different filter.' : 'Traces are sampled; send some API traffic and refresh this page.',
          search || status ? html`<a class="btn" href="${TRACES}">Clear filters</a>` : undefined,
        )
    const bodyCard = listCard('traces', {
      toolbar: searchForm({
        action: TRACES,
        target: 'traces',
        name: 'q',
        value: search,
        placeholder: 'Search route, trace ID, span ID or request ID',
        extra: statusSelect,
        mono: true,
        submit: 'Filter',
      }),
      body,
      footer: pager({
        page,
        pages,
        params: { q: search, status },
        always: total > 0,
        label: `Page ${page} of ${pages} · ${total.toLocaleString('en-US')} trace${total === 1 ? '' : 's'}`,
      }),
    })
    return ctx.render(
      'Traces',
      'observability',
      html`${header('Traces', {
          actions: menu(destroy(`${TRACES}/delete`, 'Clear traces', 'Delete every console trace for this project?'), { label: 'More actions' }),
        })}
        ${tabs(OBS_TABS, 'traces')}
        ${!ctx.observability.config.console ? alert('info', html`The local trace store is off (<code>OBSERVABILITY_CONSOLE=false</code>).`) : ''} ${bodyCard}
        <p class="help">
          Console traces are sampled at ${(ctx.observability.config.consoleSampleRate * 100).toFixed(1)}% and capped at
          ${ctx.observability.config.spanLimit.toLocaleString('en-US')} spans. Configure an OTLP or Datadog exporter for the complete stream.
        </p>`,
    )
  })

  router.get(`${TRACES}/:seq`, async ({ ctx, path }) => {
    const seq = Number(path.seq)
    const span = Number.isSafeInteger(seq) ? await ctx.services.telemetry.getSpan(seq, ctx.services.config.projectId) : null
    if (!span) {
      return ctx.render(
        'Trace not found',
        'observability',
        html`${header('Trace not found', { back: TRACES })} ${tabs(OBS_TABS, 'traces')}
          <div class="card">${emptyState('Not found', 'It may have been pruned or cleared.', html`<a class="btn" href="${TRACES}">Back to traces</a>`)}</div>`,
      )
    }
    return ctx.render(
      span.name,
      'observability',
      html`${header(span.name, { back: TRACES })} ${tabs(OBS_TABS, 'traces')}
        <div class="layout">${traceFacts(span)} ${attributesCard(span.attributes)}</div>
        ${
          span.error
            ? html`<div class="card">
                <h2>Error</h2>
                <pre>${span.error}</pre>
              </div>`
            : ''
        }`,
    )
  })

  router.post(`${TRACES}/delete`, async ({ ctx }) => {
    await ctx.services.telemetry.clearSpans(ctx.services.config.projectId)
    return ctx.go(TRACES, { tone: 'success', text: 'Traces cleared' })
  })

  router.get(ANALYTICS, async ({ ctx, url }) => {
    const project = ctx.services.config.projectId
    const since = addSeconds(-86400)
    const search = url.searchParams.get('q') ?? ''
    const eventFilter = url.searchParams.get('event') ?? ''
    const { page, limit } = pageParams(url, 50)
    await ctx.services.telemetry.flush()
    const [summary, hours, distinct, names, list] = await Promise.all([
      ctx.services.telemetry.eventSummary(project, since),
      ctx.services.telemetry.eventsByHour(project, since),
      ctx.services.telemetry.distinctIds(project, since),
      ctx.services.telemetry.eventNames(project),
      ctx.services.telemetry.listEvents({ page, limit, project, search, event: eventFilter }),
    ])
    const total = summary.reduce((sum, event) => sum + event.n, 0)
    const now = new Date()
    now.setUTCMinutes(0, 0, 0)
    const labels = Array.from({ length: 24 }, (_, index) => new Date(now.getTime() - (23 - index) * 3_600_000).toISOString().slice(0, 13))
    const byHour = new Map(hours.map((hour) => [hour.hour, hour.n]))
    const values = labels.map((hour) => byHour.get(hour) ?? 0)
    const pages = pageCount(list.total, limit)
    const eventSelect = html`<select name="event" aria-label="Filter by event">
      <option value="">Any event</option>
      ${names.map((name) => html`<option value="${name}" ${name === eventFilter ? 'selected' : ''}>${name}</option>`)}
    </select>`
    const table = list.events.length
      ? html`<div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Subject</th>
                <th>Collection</th>
                <th class="hide-sm">Document</th>
              </tr>
            </thead>
            <tbody>
              ${list.events.map(
                (event) =>
                  html`<tr>
                    <td class="nowrap">${when(event.created_at)}</td>
                    <td>${badge(event.event.replace('document.', ''), 'info')}</td>
                    <td class="mono clip">${event.distinct_id || '—'}</td>
                    <td class="mono">${event.collection || '—'}</td>
                    <td class="mono clip hide-sm" title="${event.document_id}">${event.document_id || '—'}</td>
                  </tr>`,
              )}
            </tbody>
          </table>
        </div>`
      : emptyState(
          'No analytics events yet',
          search || eventFilter ? 'Try a different filter.' : 'Document writes are captured as document.created, document.updated and document.deleted.',
          search || eventFilter ? html`<a class="btn" href="${ANALYTICS}">Clear filters</a>` : undefined,
        )
    const body = html`${header('Product analytics', {
        actions: menu(destroy(`${ANALYTICS}/delete`, 'Clear analytics', 'Delete every product analytics event for this project?'), { label: 'More actions' }),
      })}
      ${tabs(OBS_TABS, 'analytics')}
      ${!ctx.observability.config.console ? alert('info', html`Local analytics is off (<code>OBSERVABILITY_CONSOLE=false</code>).`) : ''}
      <div class="stats" style="margin:16px 0">
        ${stat('Events, 24h', total.toLocaleString('en-US'))} ${stat('Distinct subjects', distinct.toLocaleString('en-US'))}
        ${stat('Event types', summary.length.toLocaleString('en-US'))}
      </div>
      <div class="layout" style="margin-bottom:16px">
        <div class="card">
          ${cardHead('Events per hour', html`<span class="subdued">last 24 hours</span>`)}
          ${
            total
              ? lineChart({ labels: labels.map((hour) => `${hour.slice(11, 13)}:00`), series: [{ label: 'Events', color: '#2563eb', values }] })
              : emptyState('No events yet', 'Write a document through the API and it appears here.')
          }
        </div>
        <div class="card">
          ${cardHead('Top events')}
          ${
            summary.length
              ? html`<ul class="list">
                  ${summary.map((event) => html`<li><span class="mono">${event.event}</span><span class="subdued">${event.n.toLocaleString('en-US')}</span></li>`)}
                </ul>`
              : emptyState('No events yet', 'Document events appear after the first write.')
          }
        </div>
      </div>
      ${listCard('analytics', {
        toolbar: searchForm({
          action: ANALYTICS,
          target: 'analytics',
          name: 'q',
          value: search,
          placeholder: 'Search event, subject, collection or document',
          extra: eventSelect,
          mono: true,
          submit: 'Filter',
        }),
        body: table,
        footer: pager({
          page,
          pages,
          params: { q: search, event: eventFilter },
          always: list.total > 0,
          label: `Page ${page} of ${pages} · ${list.total.toLocaleString('en-US')} event${list.total === 1 ? '' : 's'}`,
        }),
      })}
      <p class="help">Only document metadata is stored: project, database, collection, document ID and action. The document body is never kept or sent.</p>`
    return ctx.render('Product analytics', 'observability', body)
  })

  router.post(`${ANALYTICS}/delete`, async ({ ctx }) => {
    await ctx.services.telemetry.clearEvents(ctx.services.config.projectId)
    return ctx.go(ANALYTICS, { tone: 'success', text: 'Analytics cleared' })
  })

  router.get(FLAGS, async ({ ctx, url }) => {
    const project = ctx.services.config.projectId
    const subject = url.searchParams.get('subject')?.trim() || `project:${project}`
    const flags = await ctx.observability.flags.evaluate(subject, { project })
    const local = ctx.observability.config.localFlags
    const names = Object.keys(flags).sort()
    const source = (name: string) => (Object.hasOwn(local, name) ? 'Local override' : ctx.observability.config.posthog?.flags ? 'PostHog' : 'Local')
    const value = (name: string) => {
      const flag = flags[name]
      return typeof flag === 'boolean' ? badge(flag ? 'On' : 'Off', flag ? 'success' : 'info') : badge(String(flag), 'info')
    }
    const table = names.length
      ? html`<div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Flag</th>
                <th>Value</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              ${names.map(
                (name) =>
                  html`<tr>
                    <td class="mono">${name}</td>
                    <td>${value(name)}</td>
                    <td class="subdued">${source(name)}</td>
                  </tr>`,
              )}
            </tbody>
          </table>
        </div>`
      : emptyState('No flags configured', 'Add FEATURE_FLAGS to the environment or configure PostHog, then evaluate a subject.')
    const body = html`${header('Feature flags')} ${tabs(OBS_TABS, 'flags')}
      <div class="stats" style="margin:16px 0">
        ${stat('Flags returned', names.length.toLocaleString('en-US'))} ${stat('Local overrides', Object.keys(local).length.toLocaleString('en-US'))}
        ${stat('Provider', ctx.observability.config.posthog?.flags ? 'PostHog' : 'Local only')}
      </div>
      <div class="card">
        ${cardHead('Evaluate for a subject')}
        <form method="get" action="${FLAGS}" class="toolbar" style="margin:0">
          <input type="text" name="subject" value="${subject}" placeholder="user ID or project:<id>" autocomplete="off" />
          <button class="btn primary">Evaluate</button>
        </form>
        <p class="help">
          User sessions use the user ID; API-key calls use <code>project:${project}</code>. The value is cached for
          ${Math.round((ctx.observability.config.posthog?.flagsTtlMs ?? 30_000) / 1000)}s.
        </p>
      </div>
      <div class="card flush" style="margin-top:16px">${table}</div>
      <p class="help">
        Edit <code>FEATURE_FLAGS</code> for local overrides, or set <code>POSTHOG_API_KEY</code>. Clients read the same evaluation from
        <code>GET /v1/flags</code>.
      </p>`
    return ctx.render('Feature flags', 'observability', body)
  })
}
