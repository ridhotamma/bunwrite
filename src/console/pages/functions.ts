import type { ExecutionRow, FunctionRow } from '~/functions/service'
import type { ConsoleRouter } from '~/console/context'
import { envBulkDialog, importEnvVariables } from '~/console/env-vars'
import { checked, lines, value } from '~/console/forms'
import { html, type Html } from '~/console/html'
import { alert, badge, destroy, emptyState, header, icon, poll, statusBadge, when } from '~/console/ui'

const FN = '/console/functions'

function runsTable(fnId: string, runs: ExecutionRow[], live: boolean): Html {
  return html`<div class="card flush" id="runs" ${live ? poll(`${FN}/${fnId}`, 'runs', 5) : ''}>
    <div class="toolbar"><h2 style="margin:0">Runs</h2></div>
    ${runs.length
      ? html`<div class="scroll"><table><thead><tr><th>Started</th><th>Status</th><th class="hide-sm">Trigger</th><th class="num hide-sm">Code</th><th class="num">Time</th></tr></thead><tbody>
        ${runs.map((r) => html`<tr class="row-link" onclick="location='${FN}/${fnId}/executions/${r.id}'"><td><a href="${FN}/${fnId}/executions/${r.id}">${when(r.created_at)}</a></td>
          <td>${statusBadge(r.status)}</td><td class="hide-sm">${r.trigger}</td><td class="num hide-sm">${r.response_status_code || '—'}</td><td class="num">${r.duration.toFixed(2)}s</td></tr>`)}
        </tbody></table></div>`
      : emptyState('No runs yet', 'Run it now, or wait for its schedule.')}
  </div>`
}

const pretty = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

export function functionPages(router: ConsoleRouter): void {
  router.get(FN, ({ ctx }) => {
    const fns = ctx.services.functions.list()
    const last = ctx.services.functions.latestByFunction()
    const skipped = ctx.services.config.skipSchedules
    const missing = fns.filter((f) => !ctx.services.functions.codeDir(f).dir).length
    return ctx.render(
      'Functions',
      'functions',
      html`${header('Functions', { actions: html`<a class="btn" href="/console/settings/functions">Global variables</a>` })}
      ${missing ? alert('critical', html`Code not found for ${missing} function${missing === 1 ? '' : 's'}. Check the code folder in <a href="/console/settings/functions">Settings</a>; it should be the folder with appwrite.config.json.`) : ''}
      <div class="card flush">
        ${fns.length
          ? html`<div class="scroll"><table><thead><tr><th>Function</th><th class="hide-sm">Runtime</th><th>Schedule</th><th>Last run</th></tr></thead><tbody>
            ${fns.map((f) => {
              const run = last.get(f.id)
              const missing = !ctx.services.functions.codeDir(f).dir
              return html`<tr class="row-link" onclick="location='${FN}/${f.id}'"><td><a href="${FN}/${f.id}">${f.name}</a>${f.enabled ? '' : html` ${badge('Disabled')}`}${missing ? html` ${badge('Code missing', 'critical')}` : ''}</td>
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
    const runs = ctx.services.functions.runsFor(f.id)
    const vars = ctx.services.functions.variables(f.id)
    const live = runs.some((r) => r.status === 'waiting' || r.status === 'processing')
    const base = `${FN}/${f.id}`
    const paused = ctx.services.config.skipSchedules.includes(f.id)
    const code = ctx.services.functions.codeDir(f)
    return ctx.render(
      f.name,
      'functions',
      html`${header(f.name, {
        back: FN,
        badges: [f.enabled ? badge('Enabled', 'success') : badge('Disabled'), badge(f.runtime)],
        actions: html`<form method="post" action="${base}/run" class="inline"><button class="primary">Run now</button></form>`,
      })}
      ${paused && f.schedule ? alert('warning', html`The schedule is paused in Settings.`) : ''}
      ${code.dir ? '' : alert('critical', html`Code not found. Looked for ${code.tried.map((t, i) => html`${i ? ' and ' : ''}<code>${t}</code>`)}. Set the code folder in <a href="/console/settings/functions">Settings</a>.`)}
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
            <p class="help">Global variables from <a href="/console/settings/functions">Settings</a> also apply; a variable here with the same name wins.</p>
            <form method="post" action="${base}/variables" style="margin-top:12px">
              <div class="fields"><label>Name<input name="key" class="mono" required pattern="[A-Za-z_][A-Za-z0-9_]*"></label><label>Value<input name="value"></label></div>
              <label class="check"><input type="checkbox" name="secret" checked>Hide the value</label>
              <div class="foot"><button type="button" data-dialog-open="#bulk-fn-vars">${icon('upload-simple')}<span>Bulk upload</span></button><button>Add variable</button></div>
            </form>
          </div>
          ${envBulkDialog({ id: 'bulk-fn-vars', title: `Import variables for ${f.name}`, action: `${base}/variables/bulk` })}
          <div class="card"><h2>Code</h2><ul class="list"><li><span class="subdued">Folder</span><span class="mono">${code.dir ?? html`<span style="color:var(--critical)">Not found</span>`}</span></li><li><span class="subdued">Entry point</span><span class="mono">${f.entrypoint}</span></li>
            <li><span class="subdued">HTTP endpoint</span><span class="mono clip">/v1/functions/${f.id}/http</span></li></ul></div>
        </div>
      </div>`,
    )
  })

  router.post(`${FN}/:id`, ({ ctx, path }) => {
    ctx.services.functions.update(path.id!, {
      enabled: checked(ctx.form.enabled),
      schedule: value(ctx.form, 'schedule'),
      timeout: Number(ctx.form.timeout),
      execute: lines(ctx.form.execute),
    })
    return ctx.go(`${FN}/${path.id}`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${FN}/:id/run`, async ({ ctx, path }) => {
    const f = ctx.services.functions.fn(path.id!)
    const { execution } = await ctx.services.functions.execute(f, { trigger: 'http', method: 'POST', path: '/' }, 'async')
    return ctx.go(`${FN}/${f.id}/executions/${execution.id}`, { tone: 'success', text: 'Started' })
  })

  router.post(`${FN}/:id/variables`, ({ ctx, path }) => {
    ctx.services.functions.fn(path.id!)
    ctx.services.functions.setVariable(path.id!, value(ctx.form, 'key'), String(ctx.form.value ?? ''), checked(ctx.form.secret))
    return ctx.go(`${FN}/${path.id}`, { tone: 'success', text: 'Variable saved' })
  })

  router.post(`${FN}/:id/variables/delete`, ({ ctx, path }) => {
    ctx.services.functions.deleteVariable(path.id!, value(ctx.form, 'key'))
    return ctx.go(`${FN}/${path.id}`, { tone: 'success', text: 'Variable removed' })
  })

  router.post(`${FN}/:id/variables/bulk`, ({ ctx, path }) => {
    const f = ctx.services.functions.fn(path.id!)
    return importEnvVariables(ctx, (vars, secret) => ctx.services.functions.setVariables(f.id, vars, secret), `${FN}/${f.id}`)
  })

  router.get(`${FN}/:id/executions/:eid`, ({ ctx, path }) => {
    const e = ctx.services.functions.execution(path.id!, path.eid!)
    const live = e.status === 'waiting' || e.status === 'processing'
    return ctx.render(
      `Run ${e.id}`,
      'functions',
      html`<div id="run" ${live ? poll(`${FN}/${path.id}/executions/${e.id}`, 'run', 2) : ''}>
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
