/** Console views for creating functions and deploying their code. */
import { dialog } from '~/console/dialog'
import { html, type Html } from '~/console/html'
import { badge, copyableId, destroy, emptyState, formatBytes, header, menu, poll, when } from '~/console/ui'
import type { DeploymentRow } from '~/functions/deployments'
import type { FunctionRow } from '~/functions/service'
import { defaultEntrypoint, isPython, RUNTIME_OPTIONS, starterCode } from '~/functions/templates'

const FN = '/console/functions'

/** Deployment states that are still on their way to ready or failed. */
export const IN_PROGRESS = ['waiting', 'processing', 'building']

export function deploymentBadge(d: DeploymentRow, activeId: string): Html {
  if (d.id === activeId) return badge('Active', 'success')
  if (d.status === 'ready') return badge('Ready')
  if (d.status === 'failed') return badge('Failed', 'critical')
  return badge('Building', 'info')
}

const buildHint = (enabled: boolean) =>
  enabled
    ? html`<small>Runs in the function folder on this server, for example <code>npm install</code>. Leave empty if there is nothing to install.</small>`
    : html`<small>Build commands are turned off on this server (<code>FUNCTIONS_BUILD_COMMANDS=false</code>), so this is skipped.</small>`

interface CodeFieldsOptions {
  /** Fixed runtime for an existing function; null lets the code follow the runtime select. */
  runtime: string | null
  commands: string
  /** Current code of the entry file, to edit in place. */
  current?: string
  buildCommands: boolean
}

/** Where the code comes from: a starter template, an uploaded archive, or one file of code. */
function codeFields(options: CodeFieldsOptions): Html {
  const runtime = options.runtime ?? RUNTIME_OPTIONS[0]!.id
  const python = isPython(runtime)
  const followCode = options.runtime
    ? ''
    : html`data-follow="runtime" data-follow-values="${JSON.stringify({ python: starterCode('python'), '*': starterCode('node') })}"`
  const pasteDefault = options.current ?? starterCode(runtime)
  // A new function starts from the template; an existing one from its own code.
  const existing = options.runtime !== null
  const choice = (key: string, title: string, text: string, on: boolean) =>
    html`<label><input type="radio" name="source" value="${key}" data-show-by ${on ? 'checked' : ''}><div><b>${title}</b><span>${text}</span></div></label>`
  const template = choice('template', existing ? 'Start over from the template' : 'Starter template', existing ? 'Replace the code with a hello world.' : 'A small hello world to edit later.', !existing)
  const upload = choice('upload', 'Upload a folder', 'A .zip or .tar.gz of the function folder.', existing && !options.current)
  const paste = choice('paste', options.current ? 'Edit code' : 'Write code', options.current ? 'Change the entry file here.' : 'One file, typed or pasted here.', existing && Boolean(options.current))
  const choices = existing ? (options.current ? [paste, upload, template] : [upload, paste, template]) : [template, upload, paste]
  return html`<fieldset class="code-source">
      <legend>Code</legend>
      <div class="choice">${choices}</div>
    </fieldset>
    <div data-show-for="upload" data-for-select="source" hidden>
      <label>Archive<input type="file" name="code" accept=".zip,.tar.gz,.tgz,application/zip,application/gzip" required>
        <small>The entry file must be inside, either at the top or in one folder. For very large folders use <code>appwrite push functions</code>.</small></label>
    </div>
    <div data-show-for="paste" data-for-select="source" hidden>
      <label>Entry file code<textarea name="code_text" class="mono tall code-editor" spellcheck="false" required ${followCode}>${pasteDefault}</textarea></label>
    </div>
    <div data-show-for="upload paste" data-for-select="source" hidden>
      <label>Build command<input name="commands" class="mono" value="${options.commands}" placeholder="${options.runtime ? (python ? 'pip install -r requirements.txt' : 'npm install') : 'npm install'}">${buildHint(options.buildCommands)}</label>
    </div>`
}

export function createFunctionDialog(open: boolean, buildCommands: boolean): Html {
  return dialog({
    id: 'create-function',
    title: 'Create function',
    open,
    body: html`<form id="create-function-form" method="post" action="${FN}" enctype="multipart/form-data" hx-boost="false" class="stack-fields">
      <p class="dialog-message">Functions run server code on demand, on a schedule or from the HTTP endpoint.</p>
      <div class="fields">
        <label>Name<input name="name" required data-slug-source placeholder="Send welcome email" autofocus></label>
        <label>Function ID<input name="id" class="mono" required data-slug-from="name" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}" placeholder="send-welcome-email"><small>Used in the API and the HTTP endpoint. It cannot change later.</small></label>
      </div>
      <div class="fields">
        <label>Runtime<select name="runtime">${RUNTIME_OPTIONS.map((r) => html`<option value="${r.id}">${r.label}</option>`)}</select><small>Node.js and Bun code runs under this server's Bun; Python under python3.</small></label>
        <label>Entry file<input name="entrypoint" class="mono" required value="${defaultEntrypoint(RUNTIME_OPTIONS[0]!.id)}" data-follow="runtime" data-follow-values="${JSON.stringify({ python: 'src/main.py', '*': 'src/main.js' })}"><small>The file that exports the function.</small></label>
      </div>
      <label>Schedule <span class="subdued">(optional)</span><input name="schedule" class="mono" placeholder="0 * * * *"><small>Cron, in UTC. Leave empty to run only on demand.</small></label>
      ${codeFields({ runtime: null, commands: '', buildCommands })}
    </form>`,
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="create-function-form" class="primary">Create function</button>`,
  })
}

/** The deploy form, shared by the dialog and its no-JavaScript page. */
export function deployForm(f: FunctionRow, current: string | undefined, buildCommands: boolean, id = 'deploy-code-form'): Html {
  return html`<form id="${id}" method="post" action="${FN}/${f.id}/deployments" enctype="multipart/form-data" hx-boost="false" class="stack-fields">
    <p class="dialog-message">The current code keeps running until the new one is built.</p>
    <label>Entry file<input name="entrypoint" class="mono" required value="${f.entrypoint}"></label>
    ${codeFields({ runtime: f.runtime, commands: f.commands, current, buildCommands })}
    <label class="check"><input type="checkbox" name="activate" checked>Make it live once built</label>
  </form>`
}

export function deployDialog(f: FunctionRow, current: string | undefined, buildCommands: boolean): Html {
  return dialog({
    id: 'deploy-code',
    title: 'Deploy new code',
    body: deployForm(f, current, buildCommands),
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="deploy-code-form" class="primary">Deploy</button>`,
  })
}

export function deploymentsCard(f: FunctionRow, deployments: DeploymentRow[]): Html {
  const live = deployments.some((d) => IN_PROGRESS.includes(d.status))
  const base = `${FN}/${f.id}`
  // While a build runs, refresh this card so its status and actions stay current.
  return html`<div class="card flush" id="deployments" ${live ? poll(`${base}/deployments`, 'deployments', 2) : ''}>
    <div class="toolbar"><h2 style="margin:0">Deployments</h2></div>
    ${deployments.length
      ? html`<div class="scroll"><table><thead><tr><th>Created</th><th>Status</th><th class="num hide-sm">Size</th><th class="num hide-sm">Build</th><th class="actions-col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
        ${deployments.map((d) => {
          const href = `${base}/deployments/${d.id}`
          const active = d.id === f.deployment_id
          return html`<tr>
            <td><a href="${href}">${when(d.created_at)}</a></td>
            <td>${deploymentBadge(d, f.deployment_id)}</td>
            <td class="num subdued hide-sm">${formatBytes(d.source_size)}</td>
            <td class="num subdued hide-sm">${IN_PROGRESS.includes(d.status) ? '…' : `${d.build_duration.toFixed(1)}s`}</td>
            <td class="num">${menu(
              html`<a class="menu-item" href="${href}">Build logs</a>
                ${d.status === 'ready' && !active ? html`<form method="post" action="${href}/activate"><button type="submit">Make live</button></form>` : ''}
                ${active ? '' : html`<hr>${destroy(`${href}/delete`, 'Delete deployment', 'Delete this deployment and its files?')}`}`,
              { label: `Actions for the deployment from ${when(d.created_at)}` },
            )}</td>
          </tr>`
        })}
      </tbody></table></div>`
      : emptyState('No deployments', 'Deploy code from the console, or with appwrite push functions.', html`<button type="button" class="primary" data-dialog-open="#deploy-code">Deploy code</button>`)}
  </div>`
}

export function deploymentView(f: FunctionRow, d: DeploymentRow): Html {
  const base = `${FN}/${f.id}`
  const live = IN_PROGRESS.includes(d.status)
  return html`<div id="deployment" ${live ? poll(`${base}/deployments/${d.id}`, 'deployment', 2) : ''}>
    ${header('Deployment', {
      back: `${base}/deployments`,
      subtitle: html`${copyableId(d.id, 'deployment-id-label')}<span class="dot" aria-hidden="true">·</span><span>${f.name}</span>`,
      badges: [deploymentBadge(d, f.deployment_id)],
      actions: html`${d.status === 'ready' && d.id !== f.deployment_id ? html`<form method="post" action="${base}/deployments/${d.id}/activate" class="inline"><button class="primary">Make live</button></form>` : ''}
        ${d.id === f.deployment_id ? '' : destroy(`${base}/deployments/${d.id}/delete`, 'Delete', 'Delete this deployment and its files?')}`,
    })}
    <div class="stats" style="margin-bottom:16px">
      <div class="stat"><span>Created</span><b style="font-size:14px">${when(d.created_at)}</b></div>
      <div class="stat"><span>Size</span><b>${formatBytes(d.source_size)}</b></div>
      <div class="stat"><span>Build time</span><b>${live ? '…' : `${d.build_duration.toFixed(1)}s`}</b></div>
      <div class="stat"><span>Entry file</span><b class="mono" style="font-size:13px">${d.entrypoint}</b></div>
    </div>
    ${d.commands ? html`<div class="card"><h2>Build command</h2><pre>${d.commands}</pre></div>` : ''}
    <div class="card"><h2>Build logs</h2>${d.build_logs ? html`<pre>${d.build_logs}</pre>` : html`<p class="subdued" style="margin:0">${live ? 'Building…' : 'Nothing logged.'}</p>`}</div>
  </div>`
}
