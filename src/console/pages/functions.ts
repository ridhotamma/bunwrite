import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { deploymentDir, Deployments, type DeploymentRow } from '~/functions/deployments'
import type { ExecutionRow, FunctionRow } from '~/functions/service'
import { starterFiles, SUPPORTED_RUNTIME_IDS } from '~/functions/templates'
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { envBulkDialog, importEnvVariables } from '~/console/env-vars'
import { checked, lines, value } from '~/console/forms'
import { html, type Html } from '~/console/html'
import { alert, badge, destroy, emptyState, header, icon, menu, poll, statusBadge, when } from '~/console/ui'
import { createFunctionDialog, deployDialog, deploymentsCard, deploymentView, IN_PROGRESS } from '~/console/views/functions'
import { err } from '~/lib/errors'

const FN = '/console/functions'
const FUNCTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/
/** Larger entry files are not offered for editing in the browser. */
const MAX_EDIT_BYTES = 256 * 1024

const deploymentsOf = (ctx: ConsoleContext) => new Deployments(ctx.services.db, ctx.services.config, ctx.services.functions)

/** The entry file's text, when it is small enough to edit in the console. */
function currentCode(ctx: ConsoleContext, f: FunctionRow): string | undefined {
  const { dir, entrypoint } = ctx.services.functions.codeDir(f)
  if (!dir) return undefined
  const path = join(dir, entrypoint)
  if (!existsSync(path) || statSync(path).size > MAX_EDIT_BYTES) return undefined
  return readFileSync(path, 'utf8')
}

/** What the code form asks for, checked before anything is created. */
type CodeSource = { kind: 'template' } | { kind: 'upload'; file: File } | { kind: 'paste'; text: string }

function codeSource(ctx: ConsoleContext): CodeSource {
  const kind = value(ctx.form, 'source') || 'template'
  if (kind === 'upload') {
    const file = ctx.form.code
    if (!(file instanceof Blob) || file.size === 0) throw err('general_argument_invalid', 'Choose a .zip or .tar.gz file to upload.')
    return { kind, file: file as File }
  }
  if (kind === 'paste') {
    const text = String(ctx.form.code_text ?? '')
    if (!text.trim()) throw err('general_argument_invalid', 'Add the code for the entry file.')
    return { kind, text: text.replace(/\r\n/g, '\n') }
  }
  return { kind: 'template' }
}

function entrypointFrom(ctx: ConsoleContext): string {
  const entrypoint = value(ctx.form, 'entrypoint').replace(/^\.?\/+/, '')
  if (!entrypoint || entrypoint.split('/').includes('..')) throw err('general_argument_invalid', 'Enter the entry file, such as src/main.js.')
  return entrypoint
}

async function deploy(ctx: ConsoleContext, f: FunctionRow, source: CodeSource, entrypoint: string, commands: string, activate: boolean): Promise<DeploymentRow> {
  const deployments = deploymentsOf(ctx)
  if (source.kind === 'upload') {
    return deployments.upload(f, { code: source.file, entrypoint, commands, activate, contentRange: null, uploadId: null })
  }
  if (source.kind === 'paste') return deployments.deployFiles(f, { files: [{ path: entrypoint, content: source.text }], entrypoint, commands, activate })
  return deployments.deployFiles(f, { files: starterFiles(f.runtime, entrypoint), entrypoint, commands: '', activate })
}

/** A short status for the functions list when no code is live yet. */
function codeBadge(ctx: ConsoleContext, f: FunctionRow, latest: DeploymentRow | null): Html {
  if (ctx.services.functions.codeDir(f).dir) return html``
  if (latest && IN_PROGRESS.includes(latest.status)) return html` ${badge('Building', 'info')}`
  if (latest?.status === 'failed') return html` ${badge('Build failed', 'critical')}`
  return html` ${badge('Code missing', 'critical')}`
}

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
  router.get(FN, ({ ctx, url }) => {
    const fns = ctx.services.functions.list()
    const last = ctx.services.functions.latestByFunction()
    const skipped = ctx.services.config.skipSchedules
    const deployments = deploymentsOf(ctx)
    const latest = new Map(fns.map((f) => [f.id, deployments.latest(f.id)]))
    // Functions with no code folder and nothing deployed: the code folder setting is likely wrong.
    const missing = fns.filter((f) => !ctx.services.functions.codeDir(f).dir && !latest.get(f.id)).length
    return ctx.render(
      'Functions',
      'functions',
      html`${header('Functions', {
        actions: html`<a class="btn" href="/console/settings/functions">Global variables</a><button type="button" class="primary" data-dialog-open="#create-function">${icon('plus')}<span>Create function</span></button>`,
      })}
      ${missing ? alert('critical', html`Code not found for ${missing} function${missing === 1 ? '' : 's'}. Check the code folder in <a href="/console/settings/functions">Settings</a>; it should be the folder with appwrite.config.json.`) : ''}
      <div class="card flush">
        ${fns.length
          ? html`<div class="scroll"><table><thead><tr><th>Function</th><th class="hide-sm">Runtime</th><th>Schedule</th><th>Last run</th></tr></thead><tbody>
            ${fns.map((f) => {
              const run = last.get(f.id)
              return html`<tr class="row-link" onclick="location='${FN}/${f.id}'"><td><a href="${FN}/${f.id}">${f.name}</a>${f.enabled ? '' : html` ${badge('Disabled')}`}${codeBadge(ctx, f, latest.get(f.id) ?? null)}</td>
                <td class="hide-sm subdued">${f.runtime}</td>
                <td class="mono">${f.schedule ? html`${f.schedule}${skipped.includes(f.id) ? html` ${badge('Paused')}` : ''}` : html`<span class="subdued">—</span>`}</td>
                <td>${run ? html`${statusBadge(run.status)} <span class="subdued hide-sm">${when(run.created_at)}</span>` : html`<span class="subdued">Never</span>`}</td></tr>`
            })}
            </tbody></table></div>`
          : emptyState(
              'No functions yet',
              'Create one here, or import appwrite.config.json from Schema.',
              html`<button type="button" class="primary" data-dialog-open="#create-function">Create function</button>`,
            )}
      </div>
      ${createFunctionDialog(url.searchParams.get('create') === '1', ctx.services.config.functionsBuildCommands)}`,
    )
  })

  router.post(FN, async ({ ctx }) => {
    const id = value(ctx.form, 'id')
    if (!FUNCTION_ID.test(id)) throw err('general_argument_invalid', 'Function ID: up to 36 characters of a-z, A-Z, 0-9, period, hyphen and underscore, starting with a letter or digit.')
    const name = value(ctx.form, 'name') || id
    const runtime = value(ctx.form, 'runtime')
    if (!SUPPORTED_RUNTIME_IDS.includes(runtime)) throw err('general_argument_invalid', 'Choose a runtime.')
    const entrypoint = entrypointFrom(ctx)
    const commands = value(ctx.form, 'commands')
    const source = codeSource(ctx)
    const f = ctx.services.functions.create(id, {
      name,
      runtime,
      execute: [],
      events: [],
      schedule: value(ctx.form, 'schedule'),
      timeout: 15,
      enabled: true,
      logging: true,
      entrypoint,
      commands: source.kind === 'template' ? '' : commands,
      scopes: [],
      buildSpecification: 's-1vcpu-512mb',
      runtimeSpecification: 's-1vcpu-512mb',
      deploymentRetention: 0,
    })
    try {
      await deploy(ctx, f, source, entrypoint, source.kind === 'template' ? '' : commands, true)
    } catch (error) {
      // Keep the function; its page explains the failed deployment and lets you try again.
      const message = error instanceof Error ? error.message : String(error)
      return ctx.go(`${FN}/${f.id}`, { tone: 'critical', text: `Function created, but its code could not be deployed: ${message}` })
    }
    return ctx.go(`${FN}/${f.id}`, { tone: 'success', text: 'Function created' })
  })

  router.get(`${FN}/:id`, ({ ctx, path }) => {
    const f: FunctionRow = ctx.services.functions.fn(path.id!)
    const runs = ctx.services.functions.runsFor(f.id)
    const vars = ctx.services.functions.variables(f.id)
    const live = runs.some((r) => r.status === 'waiting' || r.status === 'processing')
    const base = `${FN}/${f.id}`
    const paused = ctx.services.config.skipSchedules.includes(f.id)
    const code = ctx.services.functions.codeDir(f)
    const deployments = deploymentsOf(ctx).list(f.id)
    const building = deployments.find((d) => IN_PROGRESS.includes(d.status))
    const latest = deployments[0]
    const fromDeployment = Boolean(f.deployment_id) && code.dir === deploymentDir(ctx.services.config, f.id, f.deployment_id)
    const codeAlert = code.dir
      ? ''
      : building
        ? alert('info', html`The code is being built. This page updates when it is ready.`)
        : latest?.status === 'failed'
          ? alert('critical', html`The last deployment failed. <a href="${base}/deployments/${latest.id}">See the build logs</a>, then deploy again.`)
          : deployments.length
            ? alert('warning', html`No deployment is live. Make one live from Deployments.`)
            : alert('critical', html`Code not found. Looked for ${code.tried.map((t, i) => html`${i ? ' and ' : ''}<code>${t}</code>`)}. Deploy code below, or set the code folder in <a href="/console/settings/functions">Settings</a>.`)
    return ctx.render(
      f.name,
      'functions',
      html`${header(f.name, {
        back: FN,
        badges: [f.enabled ? badge('Enabled', 'success') : badge('Disabled'), badge(f.runtime)],
        actions: html`<button type="button" data-dialog-open="#deploy-code">${icon('upload-simple')}<span>Deploy</span></button>
          <form method="post" action="${base}/run" class="inline"><button class="primary">Run now</button></form>
          ${menu(destroy(`${base}/delete`, 'Delete function', `Delete ${f.name}? Its deployments, runs and variables are removed too.`), { label: 'More actions' })}`,
      })}
      ${paused && f.schedule ? alert('warning', html`The schedule is paused in Settings.`) : ''}
      <div id="code-status">${codeAlert}</div>
      <div class="layout">
        <div>${runsTable(f.id, runs, live)}${deploymentsCard(f, deployments)}</div>
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
          <div class="card" id="code-card"><h2>Code</h2><ul class="list"><li><span class="subdued">Source</span><span>${fromDeployment ? 'Live deployment' : code.dir ? 'Code folder' : html`<span style="color:var(--critical)">None</span>`}</span></li>
            ${code.dir && !fromDeployment ? html`<li><span class="subdued">Folder</span><span class="mono clip">${code.dir}</span></li>` : ''}
            <li><span class="subdued">Entry file</span><span class="mono">${code.entrypoint}</span></li>
            <li><span class="subdued">HTTP endpoint</span><span class="mono clip">/v1/functions/${f.id}/http</span></li></ul></div>
        </div>
      </div>
      ${deployDialog(f, currentCode(ctx, f), ctx.services.config.functionsBuildCommands)}`,
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

  router.post(`${FN}/:id/delete`, ({ ctx, path }) => {
    const f = ctx.services.functions.fn(path.id!)
    ctx.services.functions.remove(f.id)
    return ctx.go(FN, { tone: 'success', text: `${f.name} deleted` })
  })

  router.post(`${FN}/:id/deployments`, async ({ ctx, path }) => {
    const f = ctx.services.functions.fn(path.id!)
    const entrypoint = entrypointFrom(ctx)
    const source = codeSource(ctx)
    const d = await deploy(ctx, f, source, entrypoint, value(ctx.form, 'commands'), checked(ctx.form.activate))
    return ctx.go(`${FN}/${f.id}/deployments/${d.id}`, { tone: 'success', text: 'Deploying' })
  })

  router.get(`${FN}/:id/deployments/:did`, ({ ctx, path }) => {
    const f = ctx.services.functions.fn(path.id!)
    const d = deploymentsOf(ctx).get(f.id, path.did!)
    return ctx.render(`Deployment · ${f.name}`, 'functions', deploymentView(f, d))
  })

  router.post(`${FN}/:id/deployments/:did/activate`, ({ ctx, path }) => {
    deploymentsOf(ctx).activate(path.id!, path.did!)
    return ctx.go(`${FN}/${path.id}`, { tone: 'success', text: 'Deployment is live' })
  })

  router.post(`${FN}/:id/deployments/:did/delete`, ({ ctx, path }) => {
    deploymentsOf(ctx).remove(path.id!, path.did!)
    return ctx.go(`${FN}/${path.id}`, { tone: 'success', text: 'Deployment deleted' })
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
