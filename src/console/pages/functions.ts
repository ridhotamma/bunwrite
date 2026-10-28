
import { deploymentDir, Deployments, type DeploymentRow } from '~/functions/deployments'
import type { ExecutionRow, FunctionRow } from '~/functions/service'
import { starterFiles, SUPPORTED_RUNTIME_IDS } from '~/functions/templates'
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { envBulkDialog } from '~/console/env-vars'
import { checked, lines, value } from '~/console/forms'
import { html, type Html } from '~/console/html'
import { alert, badge, copyableId, destroy, emptyState, header, icon, listCard, menu, plural, poll, settingsSection, stat, statusBadge, tabs, when } from '~/console/ui'
import { customDomainsSection } from '~/console/views/domains'
import { createFunctionDialog, deployDialog, deployForm, deploymentsCard, deploymentView, IN_PROGRESS } from '~/console/views/functions'
import { variableList } from '~/console/views/variables'
import { err } from '~/lib/errors'
import { requestEndpoint } from '~/lib/origins'
import { registerDomainRoutes } from './domains'
import { registerVariableRoutes } from './variables'

const FN = '/console/functions'
const FUNCTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/
/** Larger entry files are not offered for editing in the browser. */
const MAX_EDIT_BYTES = 256 * 1024

const functionUrl = (id: string) => `${FN}/${encodeURIComponent(id)}`
const functionHttpUrl = (ctx: ConsoleContext, f: FunctionRow) =>
  `${requestEndpoint(ctx.request, ctx.services.config.publicEndpoint)}/functions/${encodeURIComponent(f.id)}/http`

const deploymentsOf = (ctx: ConsoleContext) => new Deployments(ctx.services.db, ctx.services.config, ctx.services.functions)

/** The entry file's text, when it is small enough to edit in the console. */
function currentCode(ctx: ConsoleContext, f: FunctionRow): string | undefined {
  return ctx.services.functions.readEntry(f, MAX_EDIT_BYTES)
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

function runsList(fnId: string, runs: ExecutionRow[], live: boolean): Html {
  return html`<div class="card flush" id="runs" ${live ? poll(functionUrl(fnId), 'runs', 5) : ''}>
    <div class="toolbar"><h2 style="margin:0">Runs</h2>${live ? html`<span class="subdued" style="margin-left:auto">Running now…</span>` : ''}</div>
    ${runs.length
      ? html`<div class="scroll"><table><thead><tr><th>Started</th><th>Status</th><th class="hide-sm">Trigger</th><th class="num hide-sm">Code</th><th class="num">Time</th></tr></thead><tbody>
        ${runs.map((r) => html`<tr class="row-link" onclick="location='${functionUrl(fnId)}/executions/${r.id}'"><td><a href="${functionUrl(fnId)}/executions/${r.id}">${when(r.created_at)}</a></td>
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

const functionTabs = (id: string, on: 'runs' | 'deployments' | 'variables' | 'settings') =>
  tabs(
    [
      { key: 'runs', label: 'Runs', href: functionUrl(id) },
      { key: 'deployments', label: 'Deployments', href: `${functionUrl(id)}/deployments` },
      { key: 'variables', label: 'Variables', href: `${functionUrl(id)}/variables` },
      { key: 'settings', label: 'Settings', href: `${functionUrl(id)}/settings` },
    ],
    on,
  )

function functionActions(f: FunctionRow, active: 'runs' | 'deployments' | 'variables' | 'settings'): Html | undefined {
  const base = functionUrl(f.id)
  if (active === 'variables' || active === 'settings') return undefined
  const deploy = html`<a class="btn" href="${base}/deploy" data-dialog-open="#deploy-code">${icon('upload-simple')}<span>Deploy</span></a>`
  const more = menu(destroy(`${base}/delete`, 'Delete function', `Delete ${f.name}? Its deployments, runs and variables are removed too.`), { label: 'More actions' })
  return active === 'runs'
    ? html`${deploy}<form method="post" action="${base}/run" class="inline"><button class="primary">Run now</button></form>${more}`
    : html`${deploy}${more}`
}

/** Header, tabs, code notice and dialogs shared by every function tab. */
function functionShell(ctx: ConsoleContext, f: FunctionRow, active: 'runs' | 'deployments' | 'variables' | 'settings', body: Html): Html {
  const base = functionUrl(f.id)
  const deployments = deploymentsOf(ctx).list(f.id)
  const latest = deployments[0]
  const building = deployments.find((d) => IN_PROGRESS.includes(d.status))
  const code = ctx.services.functions.codeDir(f)
  const paused = ctx.services.config.skipSchedules.includes(f.id)
  const notice = code.dir
    ? ''
    : building
      ? alert('info', html`The code is being built. This page updates when it is ready.`)
      : latest?.status === 'failed'
        ? alert('critical', html`The last deployment failed. <a href="${base}/deployments/${latest.id}">See the build logs</a>, then deploy again.`)
        : deployments.length
          ? alert('warning', html`No deployment is live. Make one live from Deployments.`)
          : alert('critical', html`Code not found. Looked for ${code.tried.map((t, i) => html`${i ? ' and ' : ''}<code>${t}</code>`)}. Deploy code below, or set the code folder in <a href="/console/settings/functions">Settings</a>.`)
  return html`${header(f.name, { back: FN, actions: functionActions(f, active) })}${functionTabs(f.id, active)}
  ${paused && f.schedule ? alert('warning', html`The schedule is paused in Settings.`) : ''}
  <div id="code-status">${notice}</div>
  ${body}
  ${active === 'runs' || active === 'deployments' ? deployDialog(f, currentCode(ctx, f), ctx.services.config.functionsBuildCommands) : ''}`
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
    const create = html`<button type="button" class="primary" data-dialog-open="#create-function">${icon('plus')}<span>Create function</span></button>`
    return ctx.render(
      'Functions',
      'functions',
      html`${header('Functions', {
        actions: html`<a class="btn" href="/console/settings/functions">Global variables</a>${fns.length ? create : ''}`,
      })}
      ${missing ? alert('critical', html`Code not found for ${plural(missing, 'function')}. Check the code folder in <a href="/console/settings/functions">Settings</a>; it should be the folder with the project config file (bunwrite.config.json or appwrite.config.json).`) : ''}
      ${listCard('functions', {
        body: fns.length
          ? html`<div class="scroll"><table><thead><tr><th>Function</th><th class="hide-sm">Runtime</th><th>Schedule</th><th>Last run</th></tr></thead><tbody>
            ${fns.map((f) => {
              const run = last.get(f.id)
              return html`<tr class="row-link" onclick="location='${functionUrl(f.id)}'"><td><a href="${functionUrl(f.id)}">${f.name}</a><div class="mono subdued cell-sub">${f.id}</div>${f.enabled ? '' : html`${badge('Disabled')}`}${codeBadge(ctx, f, latest.get(f.id) ?? null)}</td>
                <td class="hide-sm subdued">${f.runtime}</td>
                <td class="mono">${f.schedule ? html`${f.schedule}${skipped.includes(f.id) ? html` ${badge('Paused')}` : ''}` : html`<span class="subdued">—</span>`}</td>
                <td>${run ? html`${statusBadge(run.status)} <span class="subdued hide-sm">${when(run.created_at)}</span>` : html`<span class="subdued">Never</span>`}</td></tr>`
            })}
            </tbody></table></div>`
          : emptyState('No functions yet', 'Create one here, or import a project config file from Schema.', create),
      })}
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
      // Appwrite's default: client SDKs and guests may call it until the admin narrows this.
      execute: ['any'],
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
      domains: [],
    })
    try {
      await deploy(ctx, f, source, entrypoint, source.kind === 'template' ? '' : commands, true)
    } catch (error) {
      // Keep the function; its page explains the failed deployment and lets you try again.
      const message = error instanceof Error ? error.message : String(error)
      return ctx.go(functionUrl(f.id), { tone: 'critical', text: `Function created, but its code could not be deployed: ${message}` })
    }
    return ctx.go(functionUrl(f.id), { tone: 'success', text: 'Function created' })
  })

  router.get(`${FN}/:id`, ({ ctx, path }) => {
    const f = ctx.services.functions.fn(path.id!)
    const runs = ctx.services.functions.runsFor(f.id)
    const live = runs.some((r) => r.status === 'waiting' || r.status === 'processing')
    return ctx.render(f.name, 'functions', functionShell(ctx, f, 'runs', runsList(f.id, runs, live)))
  })

  // Without JavaScript the "Deploy" link lands here instead of opening the dialog.
  router.get(`${FN}/:id/deploy`, ({ ctx, path }) => {
    const f = ctx.services.functions.fn(path.id!)
    return ctx.render(
      `Deploy to ${f.name}`,
      'functions',
      html`${header('Deploy new code', { back: functionUrl(f.id) })}
      <div class="card narrow">${deployForm(f, currentCode(ctx, f), ctx.services.config.functionsBuildCommands, 'deploy-page-form')}
        <div class="foot" style="margin-top:12px"><a class="btn" href="${functionUrl(f.id)}">Cancel</a><button type="submit" form="deploy-page-form" class="primary">Deploy</button></div>
      </div>`,
    )
  })

  router.get(`${FN}/:id/deployments`, ({ ctx, path }) => {
    const f = ctx.services.functions.fn(path.id!)
    return ctx.render(f.name, 'functions', functionShell(ctx, f, 'deployments', deploymentsCard(f, deploymentsOf(ctx).list(f.id))))
  })

  router.get(`${FN}/:id/variables`, ({ ctx, path }) => {
    const f = ctx.services.functions.fn(path.id!)
    const vars = ctx.services.functions.variables(f.id)
    return ctx.render(
      f.name,
      'functions',
      functionShell(
        ctx,
        f,
        'variables',
        settingsSection(
          'Function variables',
          'Available only to this function. A variable here wins over a global variable with the same name.',
          html`${vars.length
            ? variableList(vars, {
                save: `${functionUrl(f.id)}/variables`,
                remove: `${functionUrl(f.id)}/variables/delete`,
                clear: { action: `${functionUrl(f.id)}/variables/clear`, confirm: `Delete all ${vars.length} variables for ${f.name}? This cannot be undone.` },
              })
            : html`<p class="hint" style="margin:0 0 12px">None set here. Values from the functions env file still apply.</p>`}
          <p class="help">Global variables from <a href="/console/settings/functions">Settings</a> also apply; a variable here with the same name wins.</p>
          <form method="post" action="${functionUrl(f.id)}/variables" style="margin-top:12px">
            <div class="fields"><label>Name<input name="key" class="mono" required pattern="[A-Za-z_][A-Za-z0-9_]*"></label><label>Value<input name="value"></label></div>
            <label class="check"><input type="checkbox" name="secret" checked>Hide the value</label>
            <div class="foot"><button type="button" data-dialog-open="#bulk-fn-vars">${icon('upload-simple')}<span>Bulk upload</span></button><button class="primary">Add variable</button></div>
          </form>
          ${envBulkDialog({ id: 'bulk-fn-vars', title: `Import variables for ${f.name}`, action: `${functionUrl(f.id)}/variables/bulk` })}`,
          { id: 'function-variables' },
        ),
      ),
    )
  })

  router.get(`${FN}/:id/settings`, async ({ ctx, path }) => {
    const f = ctx.services.functions.fn(path.id!)
    const code = ctx.services.functions.codeDir(f)
    const deployments = deploymentsOf(ctx).list(f.id)
    const fromDeployment = Boolean(f.deployment_id) && code.dir === deploymentDir(ctx.services.config, f.id, f.deployment_id)
    const domainSettings = await customDomainsSection({
      ctx,
      type: 'function',
      id: f.id,
      action: `${functionUrl(f.id)}/domains`,
      sectionId: 'function-domains',
    })
    return ctx.render(
      f.name,
      'functions',
      functionShell(
        ctx,
        f,
        'settings',
        html`${settingsSection(
          'Schedule and limits',
          'When the function runs, how long it may take, and who can call it.',
          html`<form method="post" action="${functionUrl(f.id)}">
            <label>Schedule<input name="schedule" class="mono" value="${f.schedule}" placeholder="0 * * * *"><small>Cron, in UTC. Empty for none.</small></label>
            <div class="fields"><label>Timeout (seconds)<input name="timeout" type="number" min="1" max="900" value="${f.timeout}"></label>
              <label>Who may run it<input name="execute" value="${JSON.parse(f.execute).join(', ')}" placeholder="any, users, team:ID"><small>Roles, comma-separated. <code>any</code> lets everyone call it, <code>users</code> only signed-in users. Empty means API keys only; API keys always may.</small></label></div>
            <label class="check"><input type="checkbox" name="enabled" ${f.enabled ? 'checked' : ''}>Enabled</label>
            <div class="foot"><button class="primary">Save</button></div>
          </form>`,
          { id: 'function-settings' },
        )}
        ${settingsSection(
          'Code',
          'Where the live code comes from and how to reach it over HTTP.',
          html`<ul class="list" id="code-card">
            <li><span class="subdued">Function ID</span>${copyableId(f.id, 'function-id-label')}</li>
            <li><span class="subdued">Runtime</span><span class="mono">${f.runtime}</span></li>
            <li><span class="subdued">Source</span><span>${fromDeployment ? 'Live deployment' : code.dir ? 'Code folder' : html`<span style="color:var(--critical)">None</span>`}</span></li>
            ${code.dir && !fromDeployment ? html`<li><span class="subdued">Folder</span><span class="mono clip">${code.dir}</span></li>` : ''}
            <li><span class="subdued">Entry file</span><span class="mono">${code.entrypoint}</span></li>
            <li><span class="subdued">Function URL</span>${copyableId(ctx.services.functions.url(f), 'function-domain-url', 'Copy function URL')}</li>
            ${ctx.services.functions.urls(f).slice(1).map((url, i) => html`<li><span class="subdued">Custom domain</span>${copyableId(url, `function-domain-${i}`, 'Copy domain URL')}</li>`)}
            <li><span class="subdued">HTTP endpoint</span>${copyableId(functionHttpUrl(ctx, f), 'function-http-url', 'Copy function URL')}</li>
          </ul>
          <p class="help">${deployments.length ? `${plural(deployments.length, 'deployment')} saved.` : 'No deployments yet.'} <a href="${functionUrl(f.id)}/deployments">View deployments</a></p>`,
        )}
        ${domainSettings}
        ${settingsSection(
          'Delete function',
          'Permanently removes the function, its deployments, runs and variables. This cannot be undone.',
          destroy(`${functionUrl(f.id)}/delete`, 'Delete function', `Delete ${f.name}?`),
        )}`,
      ),
    )
  })

  router.post(`${FN}/:id`, ({ ctx, path }) => {
    ctx.services.functions.update(path.id!, {
      enabled: checked(ctx.form.enabled),
      schedule: value(ctx.form, 'schedule'),
      timeout: Number(ctx.form.timeout),
      execute: lines(ctx.form.execute),
    })
    return ctx.go(`${functionUrl(path.id!)}/settings`, { tone: 'success', text: 'Saved' })
  })

  registerDomainRoutes(router, {
    base: `${FN}/:id/domains`,
    target: ({ ctx, path }) => ({ type: 'function', id: ctx.services.functions.fn(path.id!).id }),
    then: (_route, target) => `${functionUrl(target.id)}/settings`,
  })

  router.post(`${FN}/:id/run`, async ({ ctx, path }) => {
    const f = ctx.services.functions.fn(path.id!)
    const { execution } = await ctx.services.functions.execute(f, { trigger: 'http', method: 'POST', path: '/' }, 'async')
    return ctx.go(`${functionUrl(f.id)}/executions/${execution.id}`, { tone: 'success', text: 'Started' })
  })

  registerVariableRoutes(router, {
    base: `${FN}/:id/variables`,
    // Looking the function up here also answers 404 for an ID that is not there.
    scope: ({ ctx, path }) => ctx.services.functions.fn(path.id!).id,
    then: (_route, scope) => `${functionUrl(scope)}/variables`,
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
    return ctx.go(`${functionUrl(f.id)}/deployments/${d.id}`, { tone: 'success', text: 'Deploying' })
  })

  router.get(`${FN}/:id/deployments/:did`, ({ ctx, path }) => {
    const f = ctx.services.functions.fn(path.id!)
    const d = deploymentsOf(ctx).get(f.id, path.did!)
    return ctx.render(`Deployment · ${f.name}`, 'functions', deploymentView(f, d))
  })

  router.post(`${FN}/:id/deployments/:did/activate`, ({ ctx, path }) => {
    deploymentsOf(ctx).activate(path.id!, path.did!)
    return ctx.go(`${functionUrl(path.id!)}/deployments`, { tone: 'success', text: 'Deployment is live' })
  })

  router.post(`${FN}/:id/deployments/:did/delete`, ({ ctx, path }) => {
    deploymentsOf(ctx).remove(path.id!, path.did!)
    return ctx.go(`${functionUrl(path.id!)}/deployments`, { tone: 'success', text: 'Deployment deleted' })
  })

  router.get(`${FN}/:id/executions/:eid`, ({ ctx, path }) => {
    const e = ctx.services.functions.execution(path.id!, path.eid!)
    const f = ctx.services.functions.fn(path.id!)
    const live = e.status === 'waiting' || e.status === 'processing'
    return ctx.render(
      `Run ${e.id}`,
      'functions',
      html`<div id="run" ${live ? poll(`${functionUrl(path.id!)}/executions/${e.id}`, 'run', 2) : ''}>
        ${header('Run', { back: functionUrl(f.id) })}
        <div class="stats" style="margin-bottom:16px">
          <div class="stat"><span>Status</span><b style="font-size:14px">${statusBadge(e.status)}</b></div>
          ${stat('Trigger', e.trigger)}
          <div class="stat"><span>Started</span><b style="font-size:14px">${when(e.created_at)}</b></div>
          <div class="stat"><span>Run ID</span><b style="font-size:13px">${copyableId(e.id, 'execution-id-label')}</b></div>
          ${stat('Response', e.response_status_code || '—')}
          ${stat('Time', `${e.duration.toFixed(2)}s`)}
          ${stat('Request', `${e.request_method} ${e.request_path}`)}
        </div>
        ${e.errors ? html`<div class="card"><h2>Errors</h2><pre>${e.errors}</pre></div>` : ''}
        <div class="card"><h2>Logs</h2>${e.logs ? html`<pre>${e.logs}</pre>` : html`<p class="subdued" style="margin:0">${live ? 'Running…' : 'Nothing logged.'}</p>`}</div>
        <div class="card"><h2>Response body</h2>${e.response_body ? html`<pre>${pretty(e.response_body)}</pre>` : html`<p class="subdued" style="margin:0">Empty.</p>`}</div>
      </div>`,
    )
  })
}
