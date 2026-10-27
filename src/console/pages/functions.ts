import { go, statusBadge, type ConsoleRouter } from '../app'
import { html, type Html } from '../html'
import { badge, destroy, emptyState, header, when } from '../layout'
import type { ExecutionRow, FunctionRow } from '../../functions/service'

const FN = '/console/functions'
const checked = (v: unknown) => v === 'on' || v === 'true'
const lines = (v: unknown) => String(v ?? '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean)

function runsTable(fnId: string, runs: ExecutionRow[], live: boolean): Html {
  return html`<div class="card flush" id="runs" ${live ? html`hx-get="${FN}/${fnId}" hx-select="#runs" hx-target="#runs" hx-swap="outerHTML" hx-trigger="every 5s"` : ''}>
    <div class="toolbar"><h2 style="margin:0">Runs</h2></div>
    ${runs.length
      ? html`<div class="scroll"><table><thead><tr><th>Started</th><th>Status</th><th class="hide-sm">Trigger</th><th class="num hide-sm">Code</th><th class="num">Time</th></tr></thead><tbody>
        ${runs.map((r) => html`<tr class="row-link" onclick="location='${FN}/${fnId}/executions/${r.id}'"><td><a href="${FN}/${fnId}/executions/${r.id}">${when(r.created_at)}</a></td>
          <td>${statusBadge(r.status)}</td><td class="hide-sm">${r.trigger}</td><td class="num hide-sm">${r.response_status_code || '—'}</td><td class="num">${r.duration.toFixed(2)}s</td></tr>`)}
        </tbody></table></div>`
      : emptyState('No runs yet', 'Run it now, or wait for its schedule.')}
  </div>`
}

export function functionPages(router: ConsoleRouter): void {
  router.get(FN, ({ ctx }) => {
    const fns = ctx.services.functions.list()
    const last = new Map(
      ctx.services.db.sqlite
        .query<{ function_id: string; status: string; created_at: string }, []>(
          'SELECT function_id, status, created_at FROM _executions WHERE seq IN (SELECT max(seq) FROM _executions GROUP BY function_id)',
        )
        .all()
        .map((r) => [r.function_id, r]),
    )
    const skipped = ctx.services.config.skipSchedules
    return ctx.render(
      'Functions',
      'functions',
      html`${header('Functions')}
      <div class="card flush">
        ${fns.length
          ? html`<div class="scroll"><table><thead><tr><th>Function</th><th class="hide-sm">Runtime</th><th>Schedule</th><th>Last run</th></tr></thead><tbody>
            ${fns.map((f) => {
              const run = last.get(f.id)
              return html`<tr class="row-link" onclick="location='${FN}/${f.id}'"><td><a href="${FN}/${f.id}">${f.name}</a>${f.enabled ? '' : html` ${badge('Disabled')}`}</td>
                <td class="hide-sm subdued">${f.runtime}</td>
                <td class="mono">${f.schedule ? html`${f.schedule}${skipped.includes(f.id) ? html` ${badge('Paused')}` : ''}` : html`<span class="subdued">—</span>`}</td>
                <td>${run ? html`${statusBadge(run.status)} <span class="subdued hide-sm">${when(run.created_at)}</span>` : html`<span class="subdued">Never</span>`}</td></tr>`
            })}
            </tbody></table></div>`
          : emptyState('No functions', 'Functions come from appwrite.config.json. Import it from Schema.', html`<a class="btn" href="/console/schema">Go to Schema</a>`)}
      </div>`,
    )
  })

  router.get(`${FN}/:id`, ({ ctx, path }) => {
    const f: FunctionRow = ctx.services.functions.fn(path.id!)
    const runs = ctx.services.db.sqlite.query<ExecutionRow, [string]>('SELECT * FROM _executions WHERE function_id = ? ORDER BY seq DESC LIMIT 20').all(f.id)
    const vars = ctx.services.functions.variables(f.id)
    const live = runs.some((r) => r.status === 'waiting' || r.status === 'processing')
    const base = `${FN}/${f.id}`
    const paused = ctx.services.config.skipSchedules.includes(f.id)
    return ctx.render(
      f.name,
      'functions',
      html`${header(f.name, {
        back: FN,
        badges: [f.enabled ? badge('Enabled', 'success') : badge('Disabled'), badge(f.runtime)],
        actions: html`<form method="post" action="${base}/run" class="inline"><button class="primary">Run now</button></form>`,
      })}
      ${paused && f.schedule ? html`<div class="banner warning">The schedule is paused by the skip list in Settings.</div>` : ''}
      <div class="layout">
        <div>${runsTable(f.id, runs, live)}</div>
        <div>
          <form method="post" action="${base}" class="card"><h2>Settings</h2>
            <label>Schedule<input name="schedule" class="mono" value="${f.schedule}" placeholder="0 * * * *"><small>Cron, in UTC. Empty for none.</small></label>
            <label>Timeout (seconds)<input name="timeout" type="number" min="1" max="900" value="${f.timeout}"></label>
            <label>Who may run it<input name="execute" value="${JSON.parse(f.execute).join(', ')}" placeholder="any"><small>Roles, comma-separated. API keys always may.</small></label>
            <label class="check"><input type="checkbox" name="enabled" ${f.enabled ? 'checked' : ''}>Enabled</label>
            <div class="foot"><button>Save</button></div>
          </form>
          <div class="card"><h2>Variables</h2>
            ${vars.length
              ? html`<ul class="list">${vars.map((v) => html`<li><span class="mono">${v.key}</span><span>${v.secret ? html`<span class="subdued">••••••</span>` : html`<span class="mono clip">${v.value}</span>`} ${destroy(`${base}/variables/delete`, 'Remove', `Remove ${v.key}?`, { key: v.key })}</span></li>`)}</ul>`
              : html`<p class="hint" style="margin:0 0 12px">None set here. Values from the functions env file still apply.</p>`}
            <form method="post" action="${base}/variables" style="margin-top:12px">
              <div class="fields"><label>Name<input name="key" class="mono" required pattern="[A-Za-z_][A-Za-z0-9_]*"></label><label>Value<input name="value"></label></div>
              <label class="check"><input type="checkbox" name="secret" checked>Hide the value</label>
              <div class="foot"><button>Add variable</button></div>
            </form>
          </div>
          <div class="card"><h2>Code</h2><ul class="list"><li><span class="subdued">Folder</span><span class="mono clip">${f.path}</span></li><li><span class="subdued">Entry point</span><span class="mono">${f.entrypoint}</span></li>
            <li><span class="subdued">HTTP endpoint</span><span class="mono clip">/v1/functions/${f.id}/http</span></li></ul></div>
        </div>
      </div>`,
    )
  })

  router.post(`${FN}/:id`, ({ ctx, path, request }) => {
    ctx.services.functions.update(path.id!, {
      enabled: checked(ctx.form.enabled),
      schedule: String(ctx.form.schedule ?? '').trim(),
      timeout: Number(ctx.form.timeout),
      execute: lines(ctx.form.execute),
    })
    return go(request, `${FN}/${path.id}`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${FN}/:id/run`, async ({ ctx, path, request }) => {
    const f = ctx.services.functions.fn(path.id!)
    const { execution } = await ctx.services.functions.execute(f, { trigger: 'http', method: 'POST', path: '/' }, 'async')
    return go(request, `${FN}/${f.id}/executions/${execution.id}`, { tone: 'success', text: 'Started' })
  })

  router.post(`${FN}/:id/variables`, ({ ctx, path, request }) => {
    ctx.services.functions.fn(path.id!)
    ctx.services.functions.setVariable(path.id!, String(ctx.form.key ?? '').trim(), String(ctx.form.value ?? ''), checked(ctx.form.secret))
    return go(request, `${FN}/${path.id}`, { tone: 'success', text: 'Variable saved' })
  })

  router.post(`${FN}/:id/variables/delete`, ({ ctx, path, request }) => {
    ctx.services.functions.deleteVariable(path.id!, String(ctx.form.key ?? ''))
    return go(request, `${FN}/${path.id}`, { tone: 'success', text: 'Variable removed' })
  })

  router.get(`${FN}/:id/executions/:eid`, ({ ctx, path }) => {
    const e = ctx.services.functions.execution(path.id!, path.eid!)
    const live = e.status === 'waiting' || e.status === 'processing'
    const pretty = (text: string) => {
      try {
        return JSON.stringify(JSON.parse(text), null, 2)
      } catch {
        return text
      }
    }
    return ctx.render(
      `Run ${e.id}`,
      'functions',
      html`<div id="run" ${live ? html`hx-get="${FN}/${path.id}/executions/${e.id}" hx-select="#run" hx-target="#run" hx-swap="outerHTML" hx-trigger="every 2s"` : ''}>
        ${header(when(e.created_at), { back: `${FN}/${path.id}`, badges: [statusBadge(e.status), badge(e.trigger)] })}
        <div class="stats" style="margin-bottom:16px">
          <div class="stat"><span>Response</span><b>${e.response_status_code || '—'}</b></div>
          <div class="stat"><span>Time</span><b>${e.duration.toFixed(2)}s</b></div>
          <div class="stat"><span>Request</span><b class="mono" style="font-size:14px">${e.request_method} ${e.request_path}</b></div>
        </div>
        ${e.errors ? html`<div class="card"><h2>Errors</h2><pre>${e.errors}</pre></div>` : ''}
        <div class="card"><h2>Logs</h2>${e.logs ? html`<pre>${e.logs}</pre>` : html`<p class="subdued" style="margin:0">${live ? 'Running…' : 'Nothing logged.'}</p>`}</div>
        <div class="card"><h2>Response body</h2>${e.response_body ? html`<pre>${pretty(e.response_body)}</pre>` : html`<p class="subdued" style="margin:0">Empty.</p>`}</div>
      </div>`,
    )
  })
}
