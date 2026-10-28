/** Console views for static sites: create, deploy, deployments and settings. */
import { dialog } from '~/console/dialog'
import { html, type Html } from '~/console/html'
import { badge, copyableId, destroy, emptyState, formatBytes, header, menu, poll, when } from '~/console/ui'
import type { FunctionRow } from '~/functions/service'
import { FRAMEWORKS } from '~/sites/frameworks'
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

/** Where the files come from: a starter page, an uploaded folder, or one HTML file. */
function sourceFields(existing: boolean): Html {
  const choice = (key: string, title: string, text: string, on: boolean) =>
    html`<label><input type="radio" name="source" value="${key}" data-show-by ${on ? 'checked' : ''}><div><b>${title}</b><span>${text}</span></div></label>`
  const choices = [
    choice('upload', 'Upload a folder', 'A .zip or .tar.gz of the site, or of its build output.', existing),
    choice('starter', 'htmx starter', 'A page with htmx, ready to edit. No build step.', !existing),
    choice('paste', 'Write HTML', 'One index.html, typed or pasted here.', false),
  ]
  return html`<fieldset class="code-source">
      <legend>Files</legend>
      <div class="choice">${existing ? choices : [choices[1], choices[0], choices[2]]}</div>
    </fieldset>
    <div data-show-for="upload" data-for-select="source" hidden>
      <label>Archive<input type="file" name="code" accept=".zip,.tar.gz,.tgz,application/zip,application/gzip" required>
        <small>Static: served exactly as uploaded, so build before uploading. SSR: the source is installed and built here. For large sites use <code>bunwrite push sites</code>.</small></label>
    </div>
    <div data-show-for="paste" data-for-select="source" hidden>
      <label>index.html<textarea name="html" class="mono tall code-editor" spellcheck="false" required><!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>My site</title></head>
<body>
  <h1>Hello</h1>
</body>
</html></textarea></label>
    </div>`
}

function frameworkSelect(current = 'other'): Html {
  return html`<label>Framework<select name="framework">${FRAMEWORKS.map((f) => html`<option value="${f.key}" ${f.key === current ? 'selected' : ''}>${f.name}</option>`)}</select>
    <small>Static frameworks are uploaded after your own build. SSR frameworks are built and run here.</small></label>`
}

const follow = (field: 'outputDirectory' | 'fallbackFile' | 'adapter' | 'startCommand') =>
  JSON.stringify(Object.fromEntries(FRAMEWORKS.map((f) => [f.key, f[field]])))

function adapterField(site?: SiteRow): Html {
  return html`<label>Adapter<select name="adapter" data-show-by data-follow="framework" data-follow-values="${follow('adapter')}">
      <option value="static" ${!site || site.adapter === 'static' ? 'selected' : ''}>Static files (uploaded as they are)</option>
      <option value="ssr" ${site?.adapter === 'ssr' ? 'selected' : ''}>SSR app (built and run here)</option>
    </select><small>Static serves the upload as it is. SSR installs, builds and starts it.</small></label>`
}

function outputDirectoryField(site?: SiteRow): Html {
  return html`<label>Output directory<input name="output_directory" class="mono" value="${site?.output_directory ?? ''}" placeholder="dist" data-follow="framework" data-follow-values="${follow('outputDirectory')}"><small>Static: the folder inside the upload to serve. SSR: the app folder the start command runs in.</small></label>`
}

function fallbackField(site?: SiteRow): Html {
  return html`<label>Fallback file<input name="fallback_file" class="mono" value="${site?.fallback_file ?? ''}" placeholder="index.html" data-follow="framework" data-follow-values="${follow('fallbackFile')}"><small>For static single-page apps: served for paths with no file.</small></label>`
}

function ssrFields(site: SiteRow | undefined, ssr: boolean): Html {
  return html`<div class="stack-fields" data-show-for="ssr" data-for-select="adapter" ${ssr ? '' : 'hidden'}>
      <label>Start command<input name="start_command" class="mono" value="${site?.start_command ?? ''}" placeholder="node .output/server/index.mjs" data-follow="framework" data-follow-values="${follow('startCommand')}"><small>Runs in the deployment folder with <code>PORT</code> and <code>HOST=127.0.0.1</code>. Empty runs the API function for every path instead.</small></label>
      <div class="fields">
        <label>Install command<input name="install_command" class="mono" value="${site?.install_command ?? ''}" placeholder="npm install"><small>Runs in the deployment folder before the build.</small></label>
        <label>Build command<input name="build_command" class="mono" value="${site?.build_command ?? ''}" placeholder="npm run build"><small>Runs after the install command.</small></label>
      </div>
    </div>`
}

/** Framework and adapter, plus only the fields that adapter uses. */
export function buildFields(site?: SiteRow): Html {
  const ssr = site?.adapter === 'ssr'
  return html`${frameworkSelect(site?.framework)}
    <div class="fields">${adapterField(site)}${outputDirectoryField(site)}</div>
    <div class="fields" data-show-for="static" data-for-select="adapter" ${ssr ? 'hidden' : ''}>${fallbackField(site)}</div>
    ${ssrFields(site, ssr)}`
}

export function createSiteDialog(open: boolean, sitesDomain: string): Html {
  return dialog({
    id: 'create-site',
    title: 'Create site',
    open,
    wide: true,
    body: html`<form id="create-site-form" method="post" action="${SITES}" enctype="multipart/form-data" hx-boost="false" class="stack-fields">
      <p class="dialog-message">Static files are served from this server. An SSR framework is built here and run behind the site's address.</p>
      <div class="fields">
        <label>Name<input name="name" required data-slug-source placeholder="Company website" autofocus></label>
        <label>Site ID<input name="id" class="mono" required data-slug-from="name" pattern="[a-z0-9]([a-z0-9\\-]{0,34}[a-z0-9])?" placeholder="company-website"><small>Becomes the address <span class="mono">&lt;id&gt;.${sitesDomain}</span>. Lowercase letters, digits and hyphens.</small></label>
      </div>
      ${buildFields()}
      ${sourceFields(false)}
    </form>`,
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="create-site-form" class="primary">Create site</button>`,
  })
}

export function deploySiteForm(site: SiteRow, id = 'deploy-site-form'): Html {
  return html`<form id="${id}" method="post" action="${siteUrl(site.id)}/deployments" enctype="multipart/form-data" hx-boost="false" class="stack-fields">
    <p class="dialog-message">The live version keeps serving until the new one is ready.</p>
    ${sourceFields(true)}
    <label class="check"><input type="checkbox" name="activate" checked>Make it live once ready</label>
  </form>`
}

export function deploySiteDialog(site: SiteRow): Html {
  return dialog({
    id: 'deploy-site',
    title: `Deploy to ${site.name}`,
    body: deploySiteForm(site),
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="deploy-site-form" class="primary">Deploy</button>`,
  })
}

export function siteDeploymentsCard(site: SiteRow, deployments: SiteDeploymentRow[]): Html {
  const busy = deployments.some((d) => SITE_IN_PROGRESS.includes(d.status))
  const base = siteUrl(site.id)
  return html`<div class="card flush" id="deployments" ${busy ? poll(`${base}`, 'deployments', 2) : ''}>
    <div class="toolbar"><h2 style="margin:0">Deployments</h2></div>
    ${deployments.length
      ? html`<div class="scroll"><table><thead><tr><th>Created</th><th>Status</th><th class="num hide-sm">Files</th><th class="num hide-sm">Size</th><th class="actions-col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
        ${deployments.map((d) => {
          const href = `${base}/deployments/${d.id}`
          const live = d.id === site.deployment_id
          return html`<tr>
            <td><a href="${href}">${when(d.created_at)}</a></td>
            <td>${siteDeploymentBadge(d, site.deployment_id)}</td>
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
      : emptyState('No deployments', 'Upload files from here, or with bunwrite push sites.', html`<button type="button" class="primary" data-dialog-open="#deploy-site">Deploy</button>`)}
  </div>`
}

export function siteDeploymentView(site: SiteRow, d: SiteDeploymentRow, runtimeLog = ''): Html {
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
