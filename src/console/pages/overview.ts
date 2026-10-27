import { statSync } from 'node:fs'

import { addSeconds } from '../../lib/datetime'
import type { ConsoleContext, ConsoleRouter } from '../context'
import { html, type Html } from '../html'
import { emptyState, formatBytes, header, stat, statusBadge, when } from '../ui'

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
  return html`
    ${header('Home')}
    ${smtpOff ? html`<div class="banner warning">Email is not set up, so sign-in codes, password resets and invitations cannot be sent. <a href="/console/settings#email">Set up SMTP</a></div>` : ''}
    <div class="stats" style="margin-bottom:16px">
      ${stat('Documents', documents.toLocaleString('en-US'), '/console/databases')}
      ${stat('Collections', services.registry.collections.size, '/console/databases')}
      ${stat('Users', n('SELECT count(*) AS n FROM _users'), '/console/auth/users')}
      ${stat('Teams', n('SELECT count(*) AS n FROM _teams'), '/console/auth/teams')}
      ${stat('Files', `${files.n} · ${formatBytes(files.bytes)}`, '/console/storage')}
      ${stat('Failed runs, 24h', failed, '/console/functions')}
    </div>
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
