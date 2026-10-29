/** Console views for static sites: create, deploy, deployments and settings. */
import { gitDeployFields, gitSourceFields, sourceCard, sourceCell, type GitDeploySource } from '~/console/views/vcs'
import { html, type Html } from '~/console/html'
import { badge, copyableId, destroy, emptyState, formatBytes, header, menu, pageFooter, poll, settingsSection, when } from '~/console/ui'
import type { FunctionRow } from '~/functions/service'
import { DEFAULT_RUNTIME, SERVER_BUN, SITE_RUNTIMES } from '~/runtimes/catalog'
import { FRAMEWORKS, frameworkForSite, frameworkOf } from '~/sites/frameworks'
import { runtimeSelect } from '~/console/views/runtimes'
import { SITE_IN_PROGRESS, type SiteDeploymentRow, type SiteRow } from '~/sites/service'

export const SITES = '/console/sites'
export const siteUrl = (id: string) => `${SITES}/${encodeURIComponent(id)}`

export function siteDeploymentBadge(d: SiteDeploymentRow, liveId: string): Html {
  if (d.id === liveId) return badge('Live', 'success')
  if (d.status === 'ready') return badge('Ready')
  if (d.status === 'failed') return badge('Failed', 'critical')
  if (d.status === 'building') return badge('Building', 'info')
  return badge('Uploading', 'info')
}

/** A site's state for lists: live, waiting for code, or the last deployment failed. */
export function siteStatus(site: SiteRow, latest: SiteDeploymentRow | null): Html {
  if (!site.enabled) return badge('Paused', 'attention')
  if (latest?.status === 'building') return badge('Building', 'info')
  if (latest && SITE_IN_PROGRESS.includes(latest.status)) return badge('Uploading', 'info')
  if (site.deployment_id) return latest?.status === 'failed' ? html`${badge('Live', 'success')} ${badge('Last deploy failed', 'critical')}` : badge('Live', 'success')
  return latest?.status === 'failed' ? badge('Deploy failed', 'critical') : badge('No deployment')
}

/**
 * Where the files come from: a GitHub repository (new sites), an uploaded
 * folder, a starter page, or one HTML file. `githubApp` keeps the repository
 * choice visible while no account is installed yet, with a Connect button.
 */
function sourceFields(
  existing: boolean,
  installations: { id: string; organization: string }[] = [],
  hideLegend = false,
  githubApp = false,
  preferredSource = '',
): Html {
  const github = githubApp
  // Coming back from Connect GitHub: select the repository flow instead of
  // making the user pick it again.
  const preferredGithub = !existing && github && preferredSource === 'github'
  const choice = (key: string, title: string, text: string, on: boolean) =>
    html`<label><input type="radio" name="source" value="${key}" data-show-by ${on ? 'checked' : ''}><div><b>${title}</b><span>${text}</span></div></label>`
  // Like Create function: start from the starter, and a repository is the last
  // choice, so a new site is never connected to GitHub by accident.
  const choices = existing
    ? [
        choice('upload', 'Upload a folder', 'A .zip or .tar.gz of the site, or of its build output.', true),
        choice('starter', 'htmx starter', 'A page with htmx, ready to edit. No build step.', false),
        choice('paste', 'Write HTML', 'One index.html, typed or pasted here.', false),
      ]
    : [
        choice('starter', 'htmx starter', 'A ready-made page. Plain files, nothing to build.', !preferredGithub),
        choice('upload', 'Upload a folder', 'A .zip or .tar.gz: built output, or source for a server app.', false),
        choice('paste', 'Write HTML', 'One index.html, typed or pasted here.', false),
        ...(github ? [choice('github', 'GitHub repository', 'Builds here on every push; other branches get previews.', preferredGithub)] : []),
      ]
  // Render the same visibility the script would apply, so the first paint is
  // the final layout and the selected block does not pop in after a swap.
  const selected = existing ? 'upload' : preferredGithub ? 'github' : 'starter'
  const shown = (...keys: string[]) => (keys.includes(selected) ? '' : 'hidden')
  return html`<fieldset class="code-source">
      <legend class="${hideLegend ? 'visually-hidden' : ''}">Source</legend>
      <div class="choice">${choices}</div>
    </fieldset>
    ${github
      ? gitSourceFields(installations, 'create-site', {
          detectInto: 'git-build-fields',
          connectTo: '/console/sites/new?source=github',
          open: selected === 'github',
        })
      : ''}
    <div data-show-for="upload" data-for-select="source" ${shown('upload')}>
      <label>Archive<input type="file" name="code" accept=".zip,.tar.gz,.tgz,application/zip,application/gzip" required>
        <small>For a static site, upload what the build made. For a server app, upload the source: it is installed, built and started here. For large sites use <code>bunwrite push sites</code>.</small></label>
    </div>
    <div data-show-for="paste" data-for-select="source" ${shown('paste')}>
      <label>index.html<textarea name="html" class="mono tall code-editor" spellcheck="false" required><!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>My site</title></head>
<body>
  <h1>Hello</h1>
</body>
</html></textarea></label>
    </div>
    ${existing ? '' : html`<p class="help" data-show-for="starter paste" data-for-select="source" ${shown('starter', 'paste')} style="margin:0">Served as plain files from this server. There is nothing to build, so no framework or runtime to pick.</p>`}`
}

const keysOf = (group: 'static' | 'server') => FRAMEWORKS.filter((f) => f.group === group).map((f) => f.key).join(' ')
const STATIC_KEYS = keysOf('static')
const SERVER_KEYS = keysOf('server')

/** The value each framework puts in a field, for data-follow. */
const follow = (select: string, field: 'outputDirectory' | 'fallbackFile' | 'startCommand' | 'installCommand' | 'buildCommand') =>
  html`data-follow="${select}" data-follow-values="${JSON.stringify(Object.fromEntries(FRAMEWORKS.map((f) => [f.key, f[field]])))}"`

function frameworkSelect(name: string, current: string): Html {
  const option = (f: (typeof FRAMEWORKS)[number]) => html`<option value="${f.key}" ${f.key === current ? 'selected' : ''}>${f.name}</option>`
  return html`<label>Framework<select name="${name}" data-show-by>
      <optgroup label="Static site: files to serve">${FRAMEWORKS.filter((f) => f.group === 'static').map(option)}</optgroup>
      <optgroup label="Server app: rendered on each request (SSR)">${FRAMEWORKS.filter((f) => f.group === 'server').map(option)}</optgroup>
    </select><small>Pick "Other static build" or "Other server" when yours is not listed; the commands below can be anything.</small></label>`
}

/** What the build fields show: a site's settings, a framework's defaults, or what detection found. */
export interface BuildValues {
  framework: string
  outputDirectory: string
  fallbackFile: string
  installCommand: string
  buildCommand: string
  startCommand: string
  buildRuntime: string
  pruneMode: string
}

export function buildValuesOf(site: SiteRow): BuildValues {
  return {
    framework: frameworkForSite(site.framework, site.adapter).key,
    outputDirectory: site.output_directory,
    fallbackFile: site.fallback_file,
    installCommand: site.install_command,
    buildCommand: site.build_command,
    startCommand: site.start_command,
    buildRuntime: site.build_runtime,
    pruneMode: site.prune_mode,
  }
}

export function presetValues(key: string, buildRuntime = DEFAULT_RUNTIME): BuildValues {
  const f = frameworkOf(key)
  return {
    framework: f.key,
    outputDirectory: f.outputDirectory,
    fallbackFile: f.fallbackFile,
    installCommand: f.installCommand,
    buildCommand: f.buildCommand,
    startCommand: f.startCommand,
    buildRuntime,
    pruneMode: 'auto',
  }
}

/**
 * Framework, then only the fields it uses. `upload`: a static framework is
 * served as uploaded, so it only needs the output folder; a server app is
 * installed, built and started here. `git`: everything is built here, so the
 * runtime and commands always show. `select` names the framework select (the
 * Create site page has one per source).
 */
export function buildFields(mode: 'upload' | 'git', v: BuildValues, select = 'framework'): Html {
  const server = frameworkOf(v.framework).group === 'server'
  const forStatic = html`data-show-for="${STATIC_KEYS}" data-for-select="${select}"`
  const forServer = html`data-show-for="${SERVER_KEYS}" data-for-select="${select}"`
  const runtime = v.buildRuntime || SERVER_BUN
  return html`${frameworkSelect(select, v.framework)}
    <div class="stack-fields" ${mode === 'upload' ? forServer : ''} ${mode === 'upload' && !server ? 'hidden' : ''}>
      ${runtimeSelect('build_runtime', runtime, SITE_RUNTIMES, "Install, build and start run on this. Node.js and Bun are downloaded the first time a site uses that version; this server's Bun needs no download.")}
      <div class="fields">
        <label>Install command<input name="install_command" class="mono" value="${v.installCommand}" placeholder="npm install" ${follow(select, 'installCommand')}><small>Runs first, in the app folder.</small></label>
        <label>Build command<input name="build_command" class="mono" value="${v.buildCommand}" placeholder="npm run build" ${follow(select, 'buildCommand')}><small>Runs after the install command.</small></label>
      </div>
    </div>
    <div class="fields" ${forStatic} ${server ? 'hidden' : ''}>
      <label>Output folder<input name="output_directory" class="mono" value="${v.outputDirectory}" placeholder="dist" ${follow(select, 'outputDirectory')}><small>${mode === 'upload' ? 'The folder inside the upload to serve. Empty serves the top.' : 'The folder the build writes, which is served. Empty serves the top.'}</small></label>
      <label>Fallback file<input name="fallback_file" class="mono" value="${v.fallbackFile}" placeholder="index.html" ${follow(select, 'fallbackFile')}><small>For single-page apps: served for paths with no file.</small></label>
    </div>
    <div class="stack-fields" ${forServer} ${server ? '' : 'hidden'}>
      <div class="fields">
        <label>Start command<input name="start_command" class="mono" value="${v.startCommand}" placeholder="node .output/server/index.mjs" ${follow(select, 'startCommand')}><small>Starts the app with <code>PORT</code> and <code>HOST=127.0.0.1</code> set.</small></label>
        <label>App folder<input name="output_directory" class="mono" value="${server ? v.outputDirectory : ''}" placeholder="./" ${follow(select, 'outputDirectory')}><small>Where the start command runs, for monorepos. Empty is the top.</small></label>
      </div>
      ${pruneField(v.pruneMode)}
    </div>`
}

const PRUNE_OPTIONS: [string, string][] = [
  ['auto', 'Automatic (recommended)'],
  ['standalone', 'Remove node_modules (self-contained output)'],
  ['production', 'Remove dev dependencies only'],
  ['none', 'Keep everything'],
]

function pruneField(current: string): Html {
  return html`<label>After the build<select name="prune_mode">${PRUNE_OPTIONS.map(([key, label]) => html`<option value="${key}" ${key === (current || 'auto') ? 'selected' : ''}>${label}</option>`)}</select>
    <small>Frees disk space on every kept deployment. Automatic removes node_modules when the start command runs a Next.js standalone or Nuxt <code>.output</code> build, and otherwise removes dev dependencies only. Pick "Keep everything" if the app needs a package listed under <code>devDependencies</code>.</small></label>`
}

/**
 * The Create site page. The source comes first and decides what follows:
 * GitHub and uploads get build settings, the starter and Write HTML none.
 */
export function siteCreateView(
  sitesDomain: string,
  installations: { id: string; organization: string }[] = [],
  githubApp = false,
  preferredSource = '',
): Html {
  const github = githubApp
  return html`${header('Create site', { back: SITES })}
    <form method="post" action="${SITES}" enctype="multipart/form-data" hx-boost="false">
      ${settingsSection(
        'General',
        "The name shown in the console, and the ID that becomes the site's address.",
        html`<div class="fields">
          <label>Name<input name="name" required data-slug-source placeholder="Company website" autofocus></label>
          <label>Site ID<input name="id" class="mono" required data-slug-from="name" pattern="[a-z0-9]([a-z0-9\\-]{0,34}[a-z0-9])?" placeholder="company-website"><small>Becomes the address <span class="mono">&lt;id&gt;.${sitesDomain}</span>. Lowercase letters, digits and hyphens.</small></label>
        </div>`,
      )}
      ${settingsSection(
        'Source',
        github
          ? 'Where the code comes from. A repository builds on every push; the starter and Write HTML are plain files.'
          : 'Where the code comes from. Set up the GitHub App once in Organization → GitHub App to deploy from a repository.',
        html`<div class="stack-fields">${sourceFields(false, installations, true, githubApp, preferredSource)}</div>`,
      )}
      ${github && installations.length
        ? settingsSection(
            'Build and run',
            'Filled in from the repository when you pick it. Change anything that is not right.',
            html`<div id="git-build-fields" class="stack-fields">${buildFields('git', presetValues('other'), 'git_framework')}</div>`,
            { attrs: html`data-show-for="github" data-for-select="source"` },
          )
        : ''}
      ${settingsSection(
        'Build and run',
        'A static site is served as you upload it. A server app is uploaded as source, then installed, built and started here.',
        html`<div class="stack-fields">${buildFields('upload', presetValues('vite'))}</div>`,
        { attrs: html`data-show-for="upload" data-for-select="source" hidden` },
      )}
      ${pageFooter(SITES, 'Create site')}
    </form>`
}

export function deploySiteForm(site: SiteRow, git: GitDeploySource | null = null): Html {
  if (git) {
    return html`<form id="deploy-site-page-form" method="post" action="${siteUrl(site.id)}/git/deploy" hx-boost="false" class="stack-fields">
      <p class="dialog-message">The live version keeps serving until the new one is ready.</p>
      ${gitDeployFields('site', site.id, git)}
      <label class="check"><input type="checkbox" name="activate" checked>Make it live once ready</label>
    </form>`
  }
  return html`<form id="deploy-site-page-form" method="post" action="${siteUrl(site.id)}/deployments" enctype="multipart/form-data" hx-boost="false" class="stack-fields">
    <p class="dialog-message">The live version keeps serving until the new one is ready.</p>
    ${sourceFields(true)}
    <label class="check"><input type="checkbox" name="activate" checked>Make it live once ready</label>
  </form>`
}

export function siteDeploymentsCard(site: SiteRow, deployments: SiteDeploymentRow[]): Html {
  const busy = deployments.some((d) => SITE_IN_PROGRESS.includes(d.status))
  const base = siteUrl(site.id)
  return html`<div class="card flush" id="deployments" ${busy ? poll(`${base}`, 'deployments', 2) : ''}>
    <div class="toolbar"><h2 style="margin:0">Deployments</h2></div>
    ${deployments.length
      ? html`<div class="scroll"><table><thead><tr><th>Created</th><th>Status</th><th class="hide-sm">Source</th><th class="num hide-sm">Files</th><th class="num hide-sm">Size</th><th class="actions-col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
        ${deployments.map((d) => {
          const href = `${base}/deployments/${d.id}`
          const live = d.id === site.deployment_id
          return html`<tr>
            <td><a href="${href}">${when(d.created_at)}</a></td>
            <td>${siteDeploymentBadge(d, site.deployment_id)}</td>
            <td class="clip hide-sm">${sourceCell(d)}</td>
            <td class="num subdued hide-sm">${d.file_count || '—'}</td>
            <td class="num subdued hide-sm">${formatBytes(d.total_size || d.source_size)}</td>
            <td class="num">${menu(
              html`<a class="menu-item" href="${href}">Details</a>
                ${d.status === 'ready' && !live ? html`<form method="post" action="${href}/activate"><button type="submit">Make live</button></form>` : ''}
                ${d.status === 'ready' ? html`<a class="menu-item" href="${href}/download">Download</a>` : ''}
                ${live ? '' : html`<hr>${destroy(`${href}/delete`, 'Delete deployment', 'Delete this deployment and its files?')}`}`,
              { label: `Actions for the deployment from ${when(d.created_at)}` },
            )}</td>
          </tr>`
        })}
      </tbody></table></div>`
      : emptyState('No deployments', 'Upload files from here, or with bunwrite push sites.', html`<a class="btn primary" href="${base}/deploy">Deploy</a>`)}
  </div>`
}

export function siteDeploymentView(site: SiteRow, d: SiteDeploymentRow, runtimeLog = '', previewUrl = ''): Html {
  const base = siteUrl(site.id)
  const busy = SITE_IN_PROGRESS.includes(d.status)
  const live = d.id === site.deployment_id
  return html`<div id="deployment" ${busy ? poll(`${base}/deployments/${d.id}`, 'deployment', 2) : ''}>
    ${header('Deployment', {
      back: base,
      actions: html`${d.status === 'ready' && d.id !== site.deployment_id ? html`<form method="post" action="${base}/deployments/${d.id}/activate" class="inline"><button class="primary">Make live</button></form>` : ''}
        ${d.id === site.deployment_id ? '' : destroy(`${base}/deployments/${d.id}/delete`, 'Delete', 'Delete this deployment and its files?')}`,
    })}
    <div class="stats" style="margin-bottom:16px">
      <div class="stat"><span>Status</span><b style="font-size:14px">${siteDeploymentBadge(d, site.deployment_id)}</b></div>
      <div class="stat"><span>Deployment ID</span><b style="font-size:13px">${copyableId(d.id, 'deployment-id-label')}</b></div>
      <div class="stat"><span>Created</span><b style="font-size:14px">${when(d.created_at)}</b></div>
      <div class="stat"><span>Files</span><b>${d.file_count || '—'}</b></div>
      <div class="stat"><span>Size</span><b>${formatBytes(d.total_size || d.source_size)}</b></div>
    </div>
    ${sourceCard(d, previewUrl)}
    <div class="card"><h2>Log</h2>${d.build_logs ? html`<pre>${d.build_logs}</pre>` : html`<p class="subdued" style="margin:0">${busy ? 'Uploading…' : 'Nothing logged.'}</p>`}</div>
    ${live && site.adapter === 'ssr'
      ? html`<div class="card" style="margin-top:16px"><h2>Runtime</h2>
          <p class="subdued" style="margin:0 0 8px">Output of the app process. It starts on the first request and stops when idle.</p>
          ${runtimeLog ? html`<pre>${runtimeLog}</pre>` : html`<p class="subdued" style="margin:0">Not running.</p>`}</div>`
      : ''}
  </div>`
}

export function apiFunctionSelect(site: SiteRow, functions: FunctionRow[]): Html {
  return html`<label>API function<select name="api_function_id">
      <option value="">None</option>
      ${functions.map((f) => html`<option value="${f.id}" ${f.id === site.api_function_id ? 'selected' : ''}>${f.name} (${f.id})</option>`)}
    </select><small>Requests to <code>/api/…</code> on the site run this function, on the site's own domain. <code>/api/todos</code> reaches it as <code>/todos</code>. Its "Who may run it" setting still applies.</small></label>`
}

export { frameworkSelect }
