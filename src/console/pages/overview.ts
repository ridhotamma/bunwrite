import { statSync } from 'node:fs'

import { keyCaller } from '~/auth/caller'
import { addSeconds } from '~/lib/datetime'
import { lineChart } from '~/console/chart'
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { html, type Html } from '~/console/html'
import { alert, emptyState, formatBytes, header, stat, statusBadge, when } from '~/console/ui'

const started = Date.now()

export function overviewPages(router: ConsoleRouter): void {
  router.get('/console', ({ ctx }) => ctx.render('Home', 'overview', overview(ctx)))
}

function overview(ctx: ConsoleContext): Html {
  const { services } = ctx
  let documents = 0
  for (const c of services.registry.collections.values()) documents += services.store.countDocuments(keyCaller(), c)
  const files = services.storage.totals()
  let dbBytes = 0
  try {
    dbBytes = statSync(services.config.databasePath).size
  } catch {
    /* in-memory database */
  }
  const failed = services.functions.failedSince(addSeconds(-86400))
  const runs = services.functions.recent(6)
  const uptime = Math.round((Date.now() - started) / 60000)
  const smtpOff = !services.config.smtp
  const since = addSeconds(-86400)
  const now = new Date()
  now.setUTCMinutes(0, 0, 0)
  const hours = Array.from({ length: 24 }, (_, i) => new Date(now.getTime() - (23 - i) * 3600_000).toISOString().slice(0, 13))
  const hourly = new Map(services.requestLogs.bandwidthByHour(since).map((row) => [row.hour, row]))
  const inbound = hours.map((hour) => hourly.get(hour)?.inbound ?? 0)
  const outbound = hours.map((hour) => hourly.get(hour)?.outbound ?? 0)
  const totalBytes = [...inbound, ...outbound].reduce((sum, value) => sum + value, 0)
  const consumers = services.requestLogs.topConsumers(since, 6)
  const traffic = html`<div class="layout" style="margin-bottom:16px">
    <div class="card">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px"><h2 style="margin:0">Bandwidth over time</h2><a class="subdued" style="margin-left:auto" href="/console/logs">View request logs</a></div>
      ${totalBytes
        ? lineChart({
            labels: hours.map((hour) => `${hour.slice(11, 13)}:00`),
            series: [
              { label: 'Inbound', color: '#16a34a', values: inbound },
              { label: 'Outbound', color: '#db2777', values: outbound },
            ],
          })
        : emptyState('No bandwidth yet', 'The chart fills in after some API traffic.')}
    </div>
    <div class="card"><h2>Top bandwidth consumers</h2>
      ${consumers.length
        ? html`<ul class="list">${consumers.map((item) => html`<li><span class="mono clip" title="${item.path}">${item.path}</span><span class="subdued">${formatBytes(item.bytes)}</span></li>`)}</ul>`
        : emptyState('No consumers yet', 'Paths appear here after the first requests.')}
    </div>
  </div>`
  return html`
    ${header('Home')}
    ${smtpOff ? alert('warning', html`Email is not set up, so sign-in codes, password resets and invitations cannot be sent. <a href="/console/settings/email">Set up SMTP</a>`) : ''}
    <div class="stats" style="margin-bottom:16px">
      ${stat('Documents', documents.toLocaleString('en-US'), '/console/databases')}
      ${stat('Collections', services.registry.collections.size, '/console/databases')}
      ${stat('Users', services.auth.countUsers(), '/console/auth/users')}
      ${stat('Teams', services.teams.count(), '/console/auth/teams')}
      ${stat('Files', `${files.files} · ${formatBytes(files.bytes)}`, '/console/storage')}
      ${stat('Failed runs, 24h', failed, '/console/functions')}
    </div>
    ${traffic}
    <div class="layout">
      <div class="card flush">
        <div class="toolbar"><h2 style="margin:0">Recent function runs</h2></div>
        ${runs.length
          ? html`<div class="scroll"><table><thead><tr><th>Function</th><th>Status</th><th class="hide-sm">Trigger</th><th class="num">Time</th><th>Started</th></tr></thead><tbody>
            ${runs.map((r) => html`<tr class="row-link" onclick="location='/console/functions/${r.function_id}/executions/${r.id}'"><td>${r.function_id}</td><td>${statusBadge(r.status)}</td><td class="hide-sm">${r.trigger}</td><td class="num">${r.duration.toFixed(2)}s</td><td>${when(r.created_at)}</td></tr>`)}
            </tbody></table></div>`
          : emptyState('No runs yet', 'Scheduled functions show up here after their first run.')}
      </div>
      <div class="card">
        <h2>Server</h2>
        <ul class="list">
          <li><span class="subdued">Database file</span><span>${formatBytes(dbBytes)}</span></li>
          <li><span class="subdued">Memory</span><span>${formatBytes(process.memoryUsage().rss)}</span></li>
          <li><span class="subdued">Up for</span><span>${uptime < 120 ? `${uptime} min` : `${Math.round(uptime / 60)} h`}</span></li>
          <li><span class="subdued">Project ID</span><span class="mono">${services.config.projectId}</span></li>
          <li><span class="subdued">API endpoint</span><span class="mono">${services.config.publicEndpoint}</span></li>
        </ul>
      </div>
    </div>`
}
