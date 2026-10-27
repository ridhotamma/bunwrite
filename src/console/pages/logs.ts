import type { ConsoleRouter } from '~/console/context'
import { html, type Html } from '~/console/html'
import { pageCount, pageParams } from '~/console/query'
import { alert, badge, destroy, emptyState, formatBytes, header, listCard, menu, pager, searchForm, when } from '~/console/ui'

const LOGS = '/console/logs'
const LIMIT = 50

const STATUS_FILTERS: [string, string][] = [
  ['', 'Any status'],
  ['2xx', '2xx success'],
  ['3xx', '3xx redirect'],
  ['4xx', '4xx client error'],
  ['5xx', '5xx server error'],
]

const tone = (status: number) => (status >= 500 ? 'critical' : status >= 400 ? 'attention' : status >= 300 ? 'info' : 'success')
const duration = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`)

export function logPages(router: ConsoleRouter): void {
  router.get(LOGS, ({ ctx, url }) => {
    const search = url.searchParams.get('q') ?? ''
    const status = url.searchParams.get('status') ?? ''
    const { page, limit } = pageParams(url, LIMIT)
    const project = ctx.services.config.projectId
    const { total, logs } = ctx.services.requestLogs.list({ page, limit, search, status, project })
    const pages = pageCount(total, limit)
    const statusSelect = html`<select name="status" aria-label="Filter by status">
      ${STATUS_FILTERS.map(([value, label]) => html`<option value="${value}" ${value === status ? 'selected' : ''}>${label}</option>`)}
    </select>`
    const body = logs.length
      ? html`<div class="scroll"><table><thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th class="num">Duration</th><th class="hide-sm">Auth</th><th class="hide-sm">IP</th><th class="hide-sm">Request ID</th></tr></thead><tbody>
        ${logs.map((l) => html`<tr class="row-link" onclick="location='${LOGS}/${l.seq}'"><td>${when(l.created_at)}</td><td class="mono">${l.method}</td>
          <td class="clip mono"><a href="${LOGS}/${l.seq}" title="${l.path}">${l.path}</a></td>
          <td><span title="${l.error || ''}">${badge(String(l.status), tone(l.status))}</span></td><td class="num">${duration(l.duration_ms)}</td>
          <td class="clip hide-sm">${l.auth || '—'}</td><td class="mono hide-sm">${l.ip || '—'}</td><td class="mono clip hide-sm" title="${l.id}">${l.id}</td></tr>`)}
        </tbody></table></div>`
      : emptyState(
          ctx.services.config.logRequests ? 'No matching requests' : 'Request logging is off',
          ctx.services.config.logRequests
            ? search || status
              ? 'Try a different filter.'
              : 'Requests appear here after the next call.'
            : 'Set LOG_REQUESTS=true and restart to record requests.',
          search || status ? html`<a class="btn" href="${LOGS}">Clear filters</a>` : undefined,
        )
    const retention = ctx.services.requestLogs.retentionDays > 0 ? `Stored for ${ctx.services.requestLogs.retentionDays} day${ctx.services.requestLogs.retentionDays === 1 ? '' : 's'}.` : 'Stored until you clear them.'
    return ctx.render(
      'Request logs',
      'logs',
      html`${header('Request logs', {
        subtitle: `${retention} Requests to this page itself are not recorded.`,
        actions: menu(destroy(`${LOGS}/delete`, 'Clear logs', 'Delete every request log for this project?'), { label: 'More actions' }),
      })}
      ${ctx.services.config.logRequests ? '' : alert('warning', html`Request logging is off. Set <code>LOG_REQUESTS=true</code> and restart to record new requests.`)}
      ${listCard('logs', {
        toolbar: searchForm({
          action: LOGS,
          target: 'logs',
          name: 'q',
          value: search,
          placeholder: 'Search path, request ID, IP or project',
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
          label: `Page ${page} of ${pages} · ${total.toLocaleString('en-US')} request${total === 1 ? '' : 's'}`,
        }),
      })}`,
    )
  })

  router.get(`${LOGS}/:seq`, ({ ctx, path }) => {
    const seq = Number(path.seq)
    const log = Number.isSafeInteger(seq) ? ctx.services.requestLogs.get(seq, ctx.services.config.projectId) : null
    if (!log) {
      return ctx.render(
        'Log entry not found',
        'logs',
        html`${header('Log entry not found', { back: LOGS })}
        <div class="card">${emptyState('Not found', 'It may have been cleared or pruned.', html`<a class="btn" href="${LOGS}">Back to logs</a>`)}</div>`,
      )
    }
    const row = (label: string, value: Html | string) => html`<li><span class="subdued">${label}</span><span>${value}</span></li>`
    return ctx.render(
      `${log.method} ${log.path}`,
      'logs',
      html`${header(`${log.method} ${log.path}`, {
        back: LOGS,
        subtitle: when(log.created_at),
        badges: [badge(String(log.status), tone(log.status))],
      })}
      <div class="layout">
        <div class="card"><h2>Request</h2><ul class="list">
          ${row('Method', log.method)}
          ${row('Path', html`<span class="mono">${log.path}</span>`)}
          ${row('Status', String(log.status))}
          ${row('Duration', duration(log.duration_ms))}
          ${row('Inbound', formatBytes(log.request_bytes))}
          ${row('Outbound', formatBytes(log.response_bytes))}
          ${row('Request ID', html`<span class="mono">${log.id}</span>`)}
          ${row('Project', log.project || '—')}
        </ul></div>
        <div class="card"><h2>Client</h2><ul class="list">
          ${row('Auth', log.auth || '—')}
          ${row('IP', log.ip || '—')}
          ${row('Referer', log.referer || '—')}
          ${row('User agent', log.user_agent || '—')}
        </ul></div>
      </div>
      ${log.error ? html`<div class="card"><h2>Error</h2><pre>${log.error}</pre></div>` : ''}`,
    )
  })

  router.post(`${LOGS}/delete`, ({ ctx }) => {
    ctx.services.requestLogs.clear(ctx.services.config.projectId)
    return ctx.go(LOGS, { tone: 'success', text: 'Request logs cleared' })
  })
}
