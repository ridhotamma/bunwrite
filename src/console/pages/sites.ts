import { gitSection } from '~/console/views/vcs'
import { detectFramework } from '~/vcs/detect'
import { rootDirectory } from '~/vcs/hub'
import { readFileSync } from 'node:fs'

import { htmxPath } from '~/console/assets'
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { checked, value } from '~/console/forms'
import { html, type Html } from '~/console/html'
import { alert, copyableId, destroy, emptyState, header, icon, listCard, menu, settingsSection, tabs, when } from '~/console/ui'
import { customDomainsSection } from '~/console/views/domains'
import {
  apiFunctionSelect,
  buildFields,
  createSiteDialog,
  deploySiteDialog,
  deploySiteForm,
  SITES,
  siteDeploymentsCard,
  siteDeploymentView,
  siteStatus,
  siteUrl,
} from '~/console/views/sites'
import { err } from '~/lib/errors'
import { sitesDomainOf } from '~/lib/hosts'
import { frameworkOf } from '~/sites/frameworks'
import type { SiteDeploymentRow, SiteFile, SiteRow, SiteSettings } from '~/sites/service'
import { registerDomainRoutes } from './domains'

/** What the deploy form asks for, checked before anything is created. */
type FilesSource = { kind: 'starter' } | { kind: 'upload'; file: File } | { kind: 'paste'; text: string }

function filesSource(ctx: ConsoleContext): FilesSource {
  const kind = value(ctx.form, 'source') || 'starter'
  if (kind === 'upload') {
    const file = ctx.form.code
    if (!(file instanceof Blob) || file.size === 0) throw err('general_argument_invalid', 'Choose a .zip or .tar.gz file to upload.')
    return { kind, file: file as File }
  }
  if (kind === 'paste') {
    const text = String(ctx.form.html ?? '')
    if (!text.trim()) throw err('general_argument_invalid', 'Add the HTML for index.html.')
    return { kind, text: text.replace(/\r\n/g, '\n') }
  }
  return { kind: 'starter' }
}

/** A plain page with htmx served from the site itself: edit and redeploy, nothing to build. */
function starterFiles(site: SiteRow): SiteFile[] {
  const prefix = site.output_directory ? `${site.output_directory}/` : ''
  const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${site.name.replace(/[<&>"]/g, '')}</title>
  <script src="/htmx.min.js" defer></script>
  <style>
    body { font: 16px/1.6 system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 16px; color: #222 }
    button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid #ccc; background: #fff; cursor: pointer }
    #greeting { margin-top: 16px }
  </style>
</head>
<body>
  <h1>It works</h1>
  <p>This page is plain HTML with <a href="https://htmx.org">htmx</a>. Edit it and deploy again; there is no build step.</p>
  <button hx-get="/hello.html" hx-target="#greeting">Say hello</button>
  <div id="greeting"></div>
  <!--
    Dynamic parts: choose an API function in the site's settings, then
    hx-get="/api/..." runs that function on this same domain.
  -->
</body>
</html>
`
  return [
    { path: `${prefix}index.html`, content: page },
    { path: `${prefix}hello.html`, content: '<p>Hello from a static fragment 👋</p>\n' },
    { path: `${prefix}htmx.min.js`, content: readFileSync(htmxPath) },
  ]
}

async function deploy(ctx: ConsoleContext, site: SiteRow, source: FilesSource, activate: boolean): Promise<SiteDeploymentRow> {
  if (site.adapter === 'ssr' && site.start_command.trim() && source.kind !== 'upload') {
    throw err('general_argument_invalid', 'An SSR app needs an uploaded source archive (.zip or .tar.gz), not the starter page or pasted HTML.')
  }
  const sites = ctx.services.sites
  if (source.kind === 'upload') return sites.upload(site, { code: source.file, activate, contentRange: null, uploadId: null })
  if (source.kind === 'paste') {
    const prefix = site.output_directory ? `${site.output_directory}/` : ''
    return sites.deployFiles(site, [{ path: `${prefix}index.html`, content: source.text }], activate)
  }
  return sites.deployFiles(site, starterFiles(site), activate)
}

/** A new site that builds from a GitHub repository: detect how to build it, connect, and deploy the branch. */
async function createFromGit(ctx: ConsoleContext): Promise<Response> {
  const installationId = value(ctx.form, 'installation_id')
  const repositoryId = value(ctx.form, 'provider_repository_id')
  if (!installationId || !repositoryId) throw err('general_argument_invalid', 'Pick an account and a repository.')
  const installation = ctx.services.vcs.get(installationId)
  const root = rootDirectory(value(ctx.form, 'provider_root_directory'))
  const branch = value(ctx.form, 'provider_branch')
  let preset = frameworkOf(value(ctx.form, 'framework'))
  let fields = {
    framework: preset.key,
    adapter: value(ctx.form, 'adapter') || preset.adapter,
    outputDirectory: value(ctx.form, 'output_directory') || preset.outputDirectory,
    fallbackFile: value(ctx.form, 'fallback_file') || preset.fallbackFile,
    installCommand: value(ctx.form, 'install_command') || preset.installCommand,
    buildCommand: value(ctx.form, 'build_command') || preset.buildCommand,
    startCommand: value(ctx.form, 'start_command') || preset.startCommand,
  }
  if (checked(ctx.form.detect)) {
    const gh = ctx.hub.github
    const names = (await gh.contents(installation.provider_installation_id, repositoryId, root, branch)).map((e) => e.name)
    const found = await detectFramework(names, (p) => gh.fileText(installation.provider_installation_id, repositoryId, root ? `${root}/${p}` : p, branch))
    preset = frameworkOf(found.framework)
    fields = { ...found }
  }
  const id = value(ctx.form, 'id')
  const site = ctx.services.sites.create(id, {
    name: value(ctx.form, 'name') || id,
    enabled: true,
    domains: [],
    apiFunctionId: '',
    buildRuntime: '',
    pruneMode: 'auto',
    ...fields,
  })
  const project = ctx.projects.get(ctx.currentProject.id)!
  try {
    await ctx.hub.link(project, 'site', site.id, {
      installationId: installation.id,
      providerRepositoryId: repositoryId,
      providerBranch: branch,
      providerRootDirectory: root,
      providerSilentMode: false,
    })
    const linked = ctx.services.sites.site(site.id)
    await ctx.hub.deployReference(project, 'site', site.id, 'branch', linked.provider_branch, true)
    return ctx.go(siteUrl(site.id), { tone: 'success', text: `Site created as ${preset.name}; deploying ${linked.provider_branch}` })
  } catch (error) {
    ctx.hub.forget(project.info.id, 'site', site.id)
    ctx.services.sites.remove(site.id)
    throw error
  }
}

const siteTabs = (id: string, on: 'deployments' | 'settings') =>
  tabs(
    [
      { key: 'deployments', label: 'Deployments', href: siteUrl(id) },
      { key: 'settings', label: 'Settings', href: `${siteUrl(id)}/settings` },
    ],
    on,
  )

function siteShell(ctx: ConsoleContext, site: SiteRow, active: 'deployments' | 'settings', body: Html): Html {
  const url = ctx.services.sites.url(site)
  const latest = ctx.services.sites.latest(site.id)
  const actions = html`<a class="btn" href="${url}" target="_blank" rel="noopener">Open site</a>
    ${active === 'deployments' ? html`<a class="btn primary" href="${siteUrl(site.id)}/deploy" data-dialog-open="#deploy-site">${icon('upload-simple')}<span>Deploy</span></a>` : ''}
    ${menu(destroy(`${siteUrl(site.id)}/delete`, 'Delete site', `Delete ${site.name}? Its deployments and files are removed too.`), { label: 'More actions' })}`
  const notice = !site.enabled
    ? alert('warning', html`This site is paused and answers with a "paused" page. Turn it on in <a href="${siteUrl(site.id)}/settings">Settings</a>.`)
    : !site.deployment_id && latest?.status === 'failed'
      ? alert('critical', html`The last deployment failed. <a href="${siteUrl(site.id)}/deployments/${latest.id}">See why</a>, then deploy again.`)
      : ''
  return html`${header(site.name, { back: SITES, actions })}${siteTabs(site.id, active)}
    ${notice}
    ${body}
    ${active === 'deployments' ? deploySiteDialog(site) : ''}`
}

/**
 * Merge one settings card into the site. Each card posts only its own fields,
 * so a field that is absent (or hidden/disabled for the current adapter) keeps
 * its stored value instead of being cleared.
 */
function settingsFromForm(ctx: ConsoleContext, base: SiteSettings, section: string): SiteSettings {
  const form = ctx.form
  const text = (key: string, current: string) => (key in form ? value(form, key) : current)
  if (section === 'general') {
    return { ...base, name: text('name', base.name) || base.name, enabled: checked(form.enabled) }
  }
  if (section === 'build') {
    return {
      ...base,
      framework: text('framework', base.framework) || base.framework,
      outputDirectory: text('output_directory', base.outputDirectory),
      fallbackFile: text('fallback_file', base.fallbackFile),
      adapter: text('adapter', base.adapter) || base.adapter,
      installCommand: text('install_command', base.installCommand),
      buildCommand: text('build_command', base.buildCommand),
      startCommand: text('start_command', base.startCommand),
      pruneMode: text('prune_mode', base.pruneMode) || base.pruneMode,
    }
  }
  if (section === 'api') {
    const apiFunctionId = text('api_function_id', base.apiFunctionId)
    if (apiFunctionId && apiFunctionId !== base.apiFunctionId) ctx.services.functions.fn(apiFunctionId)
    return { ...base, apiFunctionId }
  }
  const apiFunctionId = text('api_function_id', base.apiFunctionId)
  if (apiFunctionId && apiFunctionId !== base.apiFunctionId) ctx.services.functions.fn(apiFunctionId)
  return {
    ...base,
    name: text('name', base.name) || base.name,
    enabled: 'enabled' in form ? checked(form.enabled) : base.enabled,
    framework: text('framework', base.framework) || base.framework,
    outputDirectory: text('output_directory', base.outputDirectory),
    fallbackFile: text('fallback_file', base.fallbackFile),
    apiFunctionId,
    adapter: text('adapter', base.adapter) || base.adapter,
    installCommand: text('install_command', base.installCommand),
    buildCommand: text('build_command', base.buildCommand),
    startCommand: text('start_command', base.startCommand),
    pruneMode: text('prune_mode', base.pruneMode) || base.pruneMode,
  }
}

/** Where the site answers, with copy buttons. Shown on the Settings tab. */
function addressesSection(ctx: ConsoleContext, site: SiteRow): Html {
  const urls = ctx.services.sites.urls(site)
  return settingsSection(
    'Addresses',
    'Where the site answers. The browser SDK may call the API from these without adding them to allowed origins.',
    html`<ul class="list">
      ${urls[0] ? html`<li><span class="subdued">Site URL</span>${copyableId(urls[0], 'site-url-0', 'Copy URL')}</li>` : ''}
      <li><span class="subdued">Site ID</span>${copyableId(site.id, 'site-id-label')}</li>
      ${urls.slice(1).map((u, i) => html`<li><span class="subdued">Custom domain</span>${copyableId(u, `site-url-${i + 1}`, 'Copy URL')}</li>`)}
      ${site.api_function_id ? html`<li><span class="subdued">API</span><span class="mono">/api/* → ${site.api_function_id}</span></li>` : ''}
    </ul>`,
    { id: 'site-addresses' },
  )
}

export function sitePages(router: ConsoleRouter): void {
  router.get(SITES, ({ ctx, url }) => {
    const sites = ctx.services.sites.list()
    const create = html`<button type="button" class="primary" data-dialog-open="#create-site">${icon('plus')}<span>Create site</span></button>`
    return ctx.render(
      'Sites',
      'sites',
      html`${header('Sites', { actions: sites.length ? create : undefined })}
      ${listCard('sites', {
        body: sites.length
          ? html`<div class="scroll"><table><thead><tr><th>Site</th><th>Address</th><th>Status</th><th class="hide-sm">Updated</th></tr></thead><tbody>
            ${sites.map((s) => {
              const latest = ctx.services.sites.latest(s.id)
              const address = ctx.services.sites.url(s)
              const domain = ctx.services.proxy.domainsFor('site', s.id)[0]
              return html`<tr class="row-link" onclick="location='${siteUrl(s.id)}'"><td><a href="${siteUrl(s.id)}">${s.name}</a><div class="mono subdued cell-sub">${s.id}</div></td>
                <td class="mono clip"><a href="${address}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${domain || new URL(address).host}</a></td>
                <td>${siteStatus(s, latest)}</td>
                <td class="subdued hide-sm">${when(latest?.created_at ?? s.updated_at)}</td></tr>`
            })}
            </tbody></table></div>`
          : emptyState('No sites yet', 'Host plain HTML, htmx pages, a built single-page app, or an SSR app that this server builds and runs.', create),
      })}
      ${createSiteDialog(url.searchParams.get('create') === '1', sitesDomainOf(ctx.services.config), ctx.hub.apps.get() ? ctx.services.vcs.list() : [])}`,
    )
  })

  router.post(SITES, async ({ ctx }) => {
    if (value(ctx.form, 'source') === 'github') return createFromGit(ctx)
    const id = value(ctx.form, 'id')
    const source = filesSource(ctx)
    const preset = frameworkOf(value(ctx.form, 'framework'))
    const adapter = value(ctx.form, 'adapter') || preset.adapter
    const startCommand = value(ctx.form, 'start_command') || preset.startCommand
    if (adapter === 'ssr' && startCommand.trim() && source.kind !== 'upload') {
      throw err('general_argument_invalid', 'An SSR app needs an uploaded source archive (.zip or .tar.gz), not the starter page or pasted HTML.')
    }
    const site = ctx.services.sites.create(id, {
      name: value(ctx.form, 'name') || id,
      enabled: true,
      framework: preset.key,
      outputDirectory: value(ctx.form, 'output_directory'),
      fallbackFile: value(ctx.form, 'fallback_file'),
      domains: [],
      apiFunctionId: '',
      installCommand: value(ctx.form, 'install_command') || preset.installCommand,
      buildCommand: value(ctx.form, 'build_command') || preset.buildCommand,
      startCommand,
      buildRuntime: '',
      adapter,
      pruneMode: value(ctx.form, 'prune_mode') || 'auto',
    })
    const d = await deploy(ctx, site, source, true)
    if (d.status === 'failed') return ctx.go(`${siteUrl(site.id)}/deployments/${d.id}`, { tone: 'critical', text: 'Site created, but its files could not be deployed' })
    return ctx.go(siteUrl(site.id), { tone: 'success', text: 'Site created and live' })
  })

  router.get(`${SITES}/:id`, ({ ctx, path }) => {
    const site = ctx.services.sites.site(path.id!)
    return ctx.render(site.name, 'sites', siteShell(ctx, site, 'deployments', siteDeploymentsCard(site, ctx.services.sites.deployments(site.id))))
  })

  // Without JavaScript the "Deploy" link lands here instead of opening the dialog.
  router.get(`${SITES}/:id/deploy`, ({ ctx, path }) => {
    const site = ctx.services.sites.site(path.id!)
    return ctx.render(
      `Deploy to ${site.name}`,
      'sites',
      html`${header('Deploy', { back: siteUrl(site.id) })}
      <div class="card">${deploySiteForm(site, 'deploy-site-page-form')}
        <div class="foot" style="margin-top:12px"><a class="btn" href="${siteUrl(site.id)}">Cancel</a><button type="submit" form="deploy-site-page-form" class="primary">Deploy</button></div>
      </div>`,
    )
  })

  router.post(`${SITES}/:id/deployments`, async ({ ctx, path }) => {
    const site = ctx.services.sites.site(path.id!)
    const d = await deploy(ctx, site, filesSource(ctx), checked(ctx.form.activate))
    if (d.status === 'failed') return ctx.go(`${siteUrl(site.id)}/deployments/${d.id}`, { tone: 'critical', text: 'Deployment failed' })
    return ctx.go(siteUrl(site.id), { tone: 'success', text: d.activate ? 'Deployed and live' : 'Deployed' })
  })

  router.get(`${SITES}/:id/deployments/:did`, ({ ctx, path }) => {
    const site = ctx.services.sites.site(path.id!)
    const deployment = ctx.services.sites.deployment(site.id, path.did!)
    // A Git build that is not live can still be opened on its own preview address.
    const preview = deployment.type === 'vcs' && deployment.status === 'ready' && deployment.id !== site.deployment_id ? ctx.services.sites.deploymentUrl(site, deployment.id) : ''
    return ctx.render(`Deployment · ${site.name}`, 'sites', siteDeploymentView(site, deployment, ctx.services.sites.runtimeLogs(site.id), preview))
  })

  router.get(`${SITES}/:id/deployments/:did/download`, async ({ ctx, path }) => {
    const archive = await ctx.services.sites.download(path.id!, path.did!)
    return new Response(archive, {
      headers: { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${path.id}-${path.did}.tar.gz"` },
    })
  })

  router.post(`${SITES}/:id/deployments/:did/activate`, ({ ctx, path }) => {
    ctx.services.sites.activate(path.id!, path.did!)
    return ctx.go(siteUrl(path.id!), { tone: 'success', text: 'Deployment is live' })
  })

  router.post(`${SITES}/:id/deployments/:did/delete`, ({ ctx, path }) => {
    ctx.services.sites.removeDeployment(path.id!, path.did!)
    return ctx.go(siteUrl(path.id!), { tone: 'success', text: 'Deployment deleted' })
  })

  router.get(`${SITES}/:id/settings`, async ({ ctx, path }) => {
    const site = ctx.services.sites.site(path.id!)
    const apiHost = new URL(ctx.services.config.publicEndpoint).hostname
    const domainSettings = await customDomainsSection({
      ctx,
      type: 'site',
      id: site.id,
      action: `${siteUrl(site.id)}/domains`,
      sectionId: 'site-domain',
      note: html`Do not add <code>${apiHost}</code>; it is the API.`,
    })
    return ctx.render(
      site.name,
      'sites',
      siteShell(
        ctx,
        site,
        'settings',
        html`${addressesSection(ctx, site)}
        ${settingsSection(
          'General',
          'The name in the console, and whether the site is served.',
          html`<form method="post" action="${siteUrl(site.id)}">
            <input type="hidden" name="section" value="general">
            <label>Name<input name="name" required value="${site.name}"></label>
            <label class="check"><input type="checkbox" name="enabled" ${site.enabled ? 'checked' : ''}>Serve this site</label>
            <div class="foot"><button class="primary">Save</button></div>
          </form>`,
          { id: 'site-general' },
        )}
        ${settingsSection(
          'Build and run',
          html`Static sites serve the upload as it is. SSR sites are installed, built and started here; the start command is saved with each new deployment, so a rollback keeps its own runtime.`,
          html`<form method="post" action="${siteUrl(site.id)}">
            <input type="hidden" name="section" value="build">
            ${buildFields(site)}
            <div class="foot"><button class="primary">Save</button></div>
          </form>`,
          { id: 'site-runtime' },
        )}
        ${gitSection(ctx, { type: 'site', row: site, base: siteUrl(site.id) })}
        ${settingsSection(
          'API',
          html`Let pages call a function on the same origin, for example <code>hx-post="/api/todos"</code>. No CORS setup needed.`,
          html`<form method="post" action="${siteUrl(site.id)}">
            <input type="hidden" name="section" value="api">
            ${apiFunctionSelect(site, ctx.services.functions.list())}
            <div class="foot"><button class="primary">Save</button></div>
          </form>`,
          { id: 'site-api' },
        )}
        ${domainSettings}
        ${settingsSection('Delete site', 'Removes the site, its deployments and files. This cannot be undone.', destroy(`${siteUrl(site.id)}/delete`, 'Delete site', `Delete ${site.name}?`))}`,
      ),
    )
  })

  router.post(`${SITES}/:id`, ({ ctx, path }) => {
    const site = ctx.services.sites.site(path.id!)
    ctx.services.sites.update(site.id, settingsFromForm(ctx, ctx.services.sites.settingsOf(site), value(ctx.form, 'section')))
    return ctx.go(`${siteUrl(site.id)}/settings`, { tone: 'success', text: 'Saved' })
  })

  registerDomainRoutes(router, {
    base: `${SITES}/:id/domains`,
    target: ({ ctx, path }) => ({ type: 'site', id: ctx.services.sites.site(path.id!).id }),
    then: (_route, target) => `${siteUrl(target.id)}/settings`,
  })

  router.post(`${SITES}/:id/delete`, ({ ctx, path }) => {
    const site = ctx.services.sites.site(path.id!)
    ctx.services.sites.remove(site.id)
    ctx.hub.forget(ctx.currentProject.id, 'site', site.id)
    return ctx.go(SITES, { tone: 'success', text: `${site.name} deleted` })
  })
}
