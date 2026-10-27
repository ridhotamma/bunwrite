import { statSync } from 'node:fs'

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
  const sql = services.db.sqlite
  const n = (q: string) => (sql.query(q).get() as { n: number }).n
  let documents = 0
  for (const c of services.registry.collections.values()) {
    documents += (sql.query(`SELECT count(*) AS n FROM "${c.table.replace(/"/g, '""')}"`).get() as { n: number }).n
  }
  const files = sql.query('SELECT count(*) AS n, coalesce(sum(size_original), 0) AS bytes FROM _files').get() as { n: number; bytes: number }
  let dbBytes = 0
  try {
    dbBytes = statSync(services.config.databasePath).size
  } catch {
    /* in-memory database */
  }
  const failed = (sql.query("SELECT count(*) AS n FROM _executions WHERE status = 'failed' AND created_at > ?").get(addSeconds(-86400)) as { n: number }).n
  const runs = sql
    .query<any, []>('SELECT e.id, e.function_id, e.status, e.trigger, e.duration, e.created_at FROM _executions e ORDER BY e.seq DESC LIMIT 6')
    .all()
  const uptime = Math.round((Date.now() - started) / 60000)
  const smtpOff = !services.config.smtp
  services.requestLogs.flush()
  const since = addSeconds(-86400)
  const now = new Date()
  now.setUTCMinutes(0, 0, 0)
  const hours = Array.from({ length: 24 }, (_, i) => new Date(now.getTime() - (23 - i) * 3600_000).toISOString().slice(0, 13))
  const hourly = new Map(
    sql
      .query<{ hour: string; inbound: number; outbound: number }, [string]>(
        `SELECT substr(created_at, 1, 13) AS hour, coalesce(sum(request_bytes), 0) AS inbound, coalesce(sum(response_bytes), 0) AS outbound
         FROM _request_logs WHERE created_at >= ? GROUP BY hour`,
      )
      .all(since)
      .map((row) => [row.hour, row]),
  )
  const inbound = hours.map((hour) => hourly.get(hour)?.inbound ?? 0)
  const outbound = hours.map((hour) => hourly.get(hour)?.outbound ?? 0)
  const totalBytes = [...inbound, ...outbound].reduce((sum, value) => sum + value, 0)
  const consumers = sql
    .query<{ path: string; bytes: number }, [string]>(
      `SELECT path, coalesce(sum(request_bytes + response_bytes), 0) AS bytes
       FROM _request_logs WHERE created_at >= ? GROUP BY path ORDER BY bytes DESC LIMIT 6`,
    )
    .all(since)
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
      ${stat('Users', n('SELECT count(*) AS n FROM _users'), '/console/auth/users')}
      ${stat('Teams', n('SELECT count(*) AS n FROM _teams'), '/console/auth/teams')}
      ${stat('Files', `${files.n} · ${formatBytes(files.bytes)}`, '/console/storage')}
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
