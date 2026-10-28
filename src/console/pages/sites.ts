import { readFileSync } from 'node:fs'

import { htmxPath } from '~/console/assets'
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { checked, lines, value } from '~/console/forms'
import { html, type Html } from '~/console/html'
import { alert, copyableId, destroy, emptyState, header, icon, listCard, menu, settingsSection, tabs, when } from '~/console/ui'
import {
  apiFunctionSelect,
  createSiteDialog,
  deploySiteDialog,
  deploySiteForm,
  folderFields,
  frameworkSelect,
  SITES,
  siteDeploymentsCard,
  siteDeploymentView,
  siteStatus,
  siteUrl,
} from '~/console/views/sites'
import { err } from '~/lib/errors'
import { sitesDomainOf } from '~/lib/hosts'
import type { SiteDeploymentRow, SiteFile, SiteRow, SiteSettings } from '~/sites/service'

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
  const sites = ctx.services.sites
  if (source.kind === 'upload') return sites.upload(site, { code: source.file, activate, contentRange: null, uploadId: null })
  if (source.kind === 'paste') {
    const prefix = site.output_directory ? `${site.output_directory}/` : ''
    return sites.deployFiles(site, [{ path: `${prefix}index.html`, content: source.text }], activate)
  }
  return sites.deployFiles(site, starterFiles(site), activate)
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

function settingsFromForm(ctx: ConsoleContext, base: SiteSettings): SiteSettings {
  const apiFunctionId = value(ctx.form, 'api_function_id')
  if (apiFunctionId) ctx.services.functions.fn(apiFunctionId)
  return {
    ...base,
    name: value(ctx.form, 'name') || base.name,
    enabled: checked(ctx.form.enabled),
    framework: value(ctx.form, 'framework') || base.framework,
    outputDirectory: value(ctx.form, 'output_directory'),
    fallbackFile: value(ctx.form, 'fallback_file'),
    domains: lines(ctx.form.domains),
    apiFunctionId,
  }
}

/** Where the site answers, with copy buttons. Shown on the Settings tab. */
function addressesSection(ctx: ConsoleContext, site: SiteRow): Html {
  const urls = ctx.services.sites.urls(site)
  return settingsSection(
    'Addresses',
    'Where the site answers. The browser SDK may call the API from these without adding them to allowed origins.',
    html`<ul class="list">${urls.map((u, i) => html`<li><span class="subdued">${i === 0 ? 'Site URL' : 'Custom domain'}</span>${copyableId(u, `site-url-${i}`, 'Copy URL')}</li>`)}
      ${site.api_function_id ? html`<li><span class="subdued">API</span><span class="mono">/api/* → ${site.api_function_id}</span></li>` : ''}</ul>`,
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
          : emptyState('No sites yet', 'Host plain HTML, htmx pages or a built single-page app on this server. Nothing is built here: upload the files as they should be served.', create),
      })}
      ${createSiteDialog(url.searchParams.get('create') === '1', sitesDomainOf(ctx.services.config))}`,
    )
  })

  router.post(SITES, async ({ ctx }) => {
    const id = value(ctx.form, 'id')
    const source = filesSource(ctx)
    const site = ctx.services.sites.create(id, {
      name: value(ctx.form, 'name') || id,
      enabled: true,
      framework: value(ctx.form, 'framework') || 'other',
      outputDirectory: value(ctx.form, 'output_directory'),
      fallbackFile: value(ctx.form, 'fallback_file'),
      domains: [],
      apiFunctionId: '',
      installCommand: '',
      buildCommand: '',
      buildRuntime: '',
      adapter: 'static',
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
    return ctx.render(`Deployment · ${site.name}`, 'sites', siteDeploymentView(site, ctx.services.sites.deployment(site.id, path.did!)))
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

  router.get(`${SITES}/:id/settings`, ({ ctx, path }) => {
    const site = ctx.services.sites.site(path.id!)
    const sitesDomain = sitesDomainOf(ctx.services.config)
    const apiHost = new URL(ctx.services.config.publicEndpoint).hostname
    return ctx.render(
      site.name,
      'sites',
      siteShell(
        ctx,
        site,
        'settings',
        html`${addressesSection(ctx, site)}
        <form method="post" action="${siteUrl(site.id)}">
        ${settingsSection(
          'General',
          'The name in the console, and whether the site is served.',
          html`<label>Name<input name="name" required value="${site.name}"></label>
            <label class="check"><input type="checkbox" name="enabled" ${site.enabled ? 'checked' : ''}>Serve this site</label>
            <ul class="list" style="margin-top:12px"><li><span class="subdued">Site ID</span>${copyableId(site.id, 'site-id-label')}</li></ul>`,
        )}
        ${settingsSection(
          'Files',
          'Which uploaded folder is served. Takes effect right away.',
          html`${frameworkSelect(site.framework)}${folderFields(site)}`,
        )}
        ${settingsSection(
          'API',
          html`Let pages call a function on the same origin, for example <code>hx-post="/api/todos"</code>. No CORS setup needed.`,
          apiFunctionSelect(site, ctx.services.functions.list()),
          { id: 'site-api' },
        )}
        ${settingsSection(
          'Custom domains',
          html`Point a CNAME record for each domain at <code>${site.id}.${sitesDomain}</code> (or an A record at this server). Caddy gets certificates on the first visit. The default site URL above always keeps working.`,
          html`<label>Domains<textarea name="domains" class="mono" rows="3" placeholder="www.example.com&#10;shop.example.com">${ctx.services.sites.settingsOf(site).domains.join('\n')}</textarea><small>One per line. Empty for none. Not <code>${apiHost}</code>, which is the API.</small></label>`,
          { id: 'site-domain' },
        )}
        <div class="page-foot"><button class="primary">Save</button></div>
        </form>
        ${settingsSection('Delete site', 'Removes the site, its deployments and files. This cannot be undone.', destroy(`${siteUrl(site.id)}/delete`, 'Delete site', `Delete ${site.name}?`))}`,
      ),
    )
  })

  router.post(`${SITES}/:id`, ({ ctx, path }) => {
    const site = ctx.services.sites.site(path.id!)
    ctx.services.sites.update(site.id, settingsFromForm(ctx, ctx.services.sites.settingsOf(site)))
    return ctx.go(`${siteUrl(site.id)}/settings`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${SITES}/:id/delete`, ({ ctx, path }) => {
    const site = ctx.services.sites.site(path.id!)
    ctx.services.sites.remove(site.id)
    return ctx.go(SITES, { tone: 'success', text: `${site.name} deleted` })
  })
}
