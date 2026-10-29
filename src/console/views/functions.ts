/** Console views for creating functions and deploying their code. */
import { gitDeployFields, gitSourceFields, sourceCard, sourceCell, type GitDeploySource } from '~/console/views/vcs'
import { html, type Html } from '~/console/html'
import { badge, copyableId, destroy, emptyState, formatBytes, header, menu, pageFooter, poll, settingsSection, when } from '~/console/ui'
import type { DeploymentRow } from '~/functions/deployments'
import type { FunctionRow } from '~/functions/service'
import { defaultEntrypoint, isPython, RUNTIME_OPTIONS, starterCode } from '~/functions/templates'
import { DEFAULT_RUNTIME, FUNCTION_RUNTIMES } from '~/runtimes/catalog'
import { runtimeSelect } from '~/console/views/runtimes'

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
  /** GitHub installations, for a new function's "GitHub repository" choice. */
  installations?: { id: string; organization: string }[]
  /** The GitHub App exists, so offer the repository choice even before an install. */
  githubApp?: boolean
  /** Select this source on first paint, such as `github` after connecting. */
  preferredSource?: string
  /** The section title already says "Code". */
  hideLegend?: boolean
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
  const preferredGithub = !existing && Boolean(options.githubApp) && options.preferredSource === 'github'
  const template = choice('template', existing ? 'Start over from the template' : 'Starter template', existing ? 'Replace the code with a hello world.' : 'A small hello world to edit later.', !existing && !preferredGithub)
  const upload = choice('upload', 'Upload a folder', 'A .zip or .tar.gz of the function folder.', existing && !options.current)
  const paste = choice('paste', options.current ? 'Edit code' : 'Write code', options.current ? 'Change the entry file here.' : 'One file, typed or pasted here.', existing && Boolean(options.current))
  const installations = options.installations ?? []
  const github = options.githubApp ? [choice('github', 'GitHub repository', 'Build on every push to the production branch.', preferredGithub)] : []
  const choices = existing ? (options.current ? [paste, upload, template] : [upload, paste, template]) : [template, upload, paste, ...github]
  // Render the same visibility the script would apply, so the first paint is
  // the final layout and the selected block does not pop in after the swap.
  const selected = existing ? (options.current ? 'paste' : 'upload') : preferredGithub ? 'github' : 'template'
  const shown = (...keys: string[]) => (keys.includes(selected) ? '' : 'hidden')
  return html`<fieldset class="code-source">
      <legend class="${options.hideLegend ? 'visually-hidden' : ''}">Code</legend>
      <div class="choice">${choices}</div>
    </fieldset>
    <div data-show-for="upload" data-for-select="source" ${shown('upload')}>
      <label>Archive<input type="file" name="code" accept=".zip,.tar.gz,.tgz,application/zip,application/gzip" required>
        <small>The entry file must be inside, either at the top or in one folder. For very large folders use <code>bunwrite push functions</code>.</small></label>
    </div>
    <div data-show-for="paste" data-for-select="source" ${shown('paste')}>
      <label>Entry file code<textarea name="code_text" class="mono tall code-editor" spellcheck="false" required ${followCode}>${pasteDefault}</textarea></label>
    </div>
    ${github.length
      ? gitSourceFields(installations, 'create-function', {
          detectLabel: 'Detect the runtime, entry file and build command from the repository',
          connectTo: '/console/functions/new?source=github',
          open: selected === 'github',
        })
      : ''}
    <div data-show-for="upload paste github" data-for-select="source" ${shown('upload', 'paste', 'github')}>
      <label>Build command<input name="commands" class="mono" value="${options.commands}" placeholder="${options.runtime ? (python ? 'pip install -r requirements.txt' : 'npm install') : 'npm install'}">${buildHint(options.buildCommands)}</label>
    </div>`
}

/** The Create function page: general settings and code in sections, like the other create pages. */
export function functionCreateView(
  buildCommands: boolean,
  installations: { id: string; organization: string }[] = [],
  githubApp = false,
  preferredSource = '',
): Html {
  return html`${header('Create function', { back: FN })}
    <form method="post" action="${FN}" enctype="multipart/form-data" hx-boost="false">
      ${settingsSection(
        'General',
        'Functions run server code on demand, on a schedule or from the HTTP endpoint.',
        html`<div class="fields">
          <label>Name<input name="name" required data-slug-source placeholder="Send welcome email" autofocus></label>
          <label>Function ID<input name="id" class="mono" required data-slug-from="name" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}" placeholder="send-welcome-email"><small>Used in the API and the HTTP endpoint. It cannot change later.</small></label>
        </div>
        <div class="fields">
          ${runtimeSelect('runtime', DEFAULT_RUNTIME, FUNCTION_RUNTIMES, "Node.js and Bun are downloaded the first time a function uses that version; this server's Bun needs no download. Python runs on the server's python3.")}
          <label>Entry file<input name="entrypoint" class="mono" required value="${defaultEntrypoint(RUNTIME_OPTIONS[0]!.id)}" data-follow="runtime" data-follow-values="${JSON.stringify({ python: 'src/main.py', '*': 'src/main.js' })}"><small>The file that exports the function.</small></label>
        </div>
        <label>Schedule <span class="subdued">(optional)</span><input name="schedule" class="mono" placeholder="0 * * * *"><small>Cron, in UTC. Leave empty to run only on demand.</small></label>`,
      )}
      ${settingsSection(
        'Code',
        githubApp
          ? 'Start from the template, upload a folder, write the code, or build a GitHub repository on every push.'
          : 'Start from the template, upload a folder, or write the code. Set up the GitHub App once in Organization → GitHub App to deploy from a repository.',
        html`<div class="stack-fields">${codeFields({
          runtime: null,
          commands: '',
          buildCommands,
          installations,
          githubApp,
          preferredSource,
          hideLegend: true,
        })}</div>`,
      )}
      ${pageFooter(FN, 'Create function')}
    </form>`
}

/** The deploy form on its own page. */
export function deployForm(f: FunctionRow, current: string | undefined, buildCommands: boolean, git: GitDeploySource | null = null): Html {
  if (git) {
    return html`<form id="deploy-page-form" method="post" action="${FN}/${f.id}/git/deploy" hx-boost="false" class="stack-fields">
      <p class="dialog-message">The current code keeps running until the new one is built.</p>
      ${gitDeployFields('function', f.id, git)}
      <label class="check"><input type="checkbox" name="activate" checked>Make it live once built</label>
    </form>`
  }
  return html`<form id="deploy-page-form" method="post" action="${FN}/${f.id}/deployments" enctype="multipart/form-data" hx-boost="false" class="stack-fields">
    <p class="dialog-message">The current code keeps running until the new one is built.</p>
    <label>Entry file<input name="entrypoint" class="mono" required value="${f.entrypoint}"></label>
    ${codeFields({ runtime: f.runtime, commands: f.commands, current, buildCommands })}
    <label class="check"><input type="checkbox" name="activate" checked>Make it live once built</label>
  </form>`
}

export function deploymentsCard(f: FunctionRow, deployments: DeploymentRow[]): Html {
  const live = deployments.some((d) => IN_PROGRESS.includes(d.status))
  const base = `${FN}/${f.id}`
  // While a build runs, refresh this card so its status and actions stay current.
  return html`<div class="card flush" id="deployments" ${live ? poll(`${base}/deployments`, 'deployments', 2) : ''}>
    <div class="toolbar"><h2 style="margin:0">Deployments</h2></div>
    ${deployments.length
      ? html`<div class="scroll"><table><thead><tr><th>Created</th><th>Status</th><th class="hide-sm">Source</th><th class="num hide-sm">Size</th><th class="num hide-sm">Build</th><th class="actions-col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
        ${deployments.map((d) => {
          const href = `${base}/deployments/${d.id}`
          const active = d.id === f.deployment_id
          return html`<tr>
            <td><a href="${href}">${when(d.created_at)}</a></td>
            <td>${deploymentBadge(d, f.deployment_id)}</td>
            <td class="clip hide-sm">${sourceCell(d)}</td>
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
      : emptyState('No deployments', 'Deploy code from the console, or with bunwrite push functions.', html`<a class="btn primary" href="${base}/deploy">Deploy code</a>`)}
  </div>`
}

export function deploymentView(f: FunctionRow, d: DeploymentRow): Html {
  const base = `${FN}/${f.id}`
  const live = IN_PROGRESS.includes(d.status)
  return html`<div id="deployment" ${live ? poll(`${base}/deployments/${d.id}`, 'deployment', 2) : ''}>
    ${header('Deployment', {
      back: `${base}/deployments`,
      actions: html`${d.status === 'ready' && d.id !== f.deployment_id ? html`<form method="post" action="${base}/deployments/${d.id}/activate" class="inline"><button class="primary">Make live</button></form>` : ''}
        ${d.id === f.deployment_id ? '' : destroy(`${base}/deployments/${d.id}/delete`, 'Delete', 'Delete this deployment and its files?')}`,
    })}
    <div class="stats" style="margin-bottom:16px">
      <div class="stat"><span>Status</span><b style="font-size:14px">${deploymentBadge(d, f.deployment_id)}</b></div>
      <div class="stat"><span>Deployment ID</span><b style="font-size:13px">${copyableId(d.id, 'deployment-id-label')}</b></div>
      <div class="stat"><span>Created</span><b style="font-size:14px">${when(d.created_at)}</b></div>
      <div class="stat"><span>Size</span><b>${formatBytes(d.source_size)}</b></div>
      <div class="stat"><span>Build time</span><b>${live ? '…' : `${d.build_duration.toFixed(1)}s`}</b></div>
      <div class="stat"><span>Entry file</span><b class="mono" style="font-size:13px">${d.entrypoint}</b></div>
    </div>
    ${sourceCard(d)}
    ${d.commands ? html`<div class="card"><h2>Build command</h2><pre>${d.commands}</pre></div>` : ''}
    <div class="card"><h2>Build logs</h2>${d.build_logs ? html`<pre>${d.build_logs}</pre>` : html`<p class="subdued" style="margin:0">${live ? 'Building…' : 'Nothing logged.'}</p>`}</div>
  </div>`
}
