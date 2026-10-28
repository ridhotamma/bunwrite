/**
 * Appwrite's Sites API (`/v1/sites`), so `node-appwrite`, `@bunwrite/sdk` and
 * `appwrite push sites` work. `adapter: 'static'` (the default) serves the
 * uploaded files; `adapter: 'ssr'` builds and runs them on this server.
 *
 * Bunwrite extensions on create and update: `domain` (a custom domain),
 * `domains` (several), `apiFunctionId` (the function that answers `/api/*`, or
 * every path when an SSR site has no start command) and `startCommand`.
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { apiHeader } from '~/lib/compat'
import { err } from '~/lib/errors'
import { bool, json, list, noContent, str, type Params } from '~/lib/http'
import { uniqueId } from '~/lib/ids'
import { page } from '~/lib/paging'
import type { Router } from '~/lib/router'
import { applyProvider, projectOf } from '~/vcs/routes'
import { NO_PROVIDER, providerOf, sourceModel } from '~/vcs/source'
import { DEFAULT_RUNTIME, SITE_RUNTIMES } from '~/runtimes/catalog'
import { FRAMEWORKS, frameworkOf } from './frameworks'
import type { SiteDeploymentRow, SiteRow, SiteSettings } from './service'

export { FRAMEWORKS }

export function siteDeploymentModel(d: SiteDeploymentRow) {
  return {
    $id: d.id,
    $createdAt: d.created_at,
    $updatedAt: d.updated_at,
    resourceId: d.site_id,
    resourceType: 'sites',
    entrypoint: '',
    sourceSize: d.source_size,
    buildSize: d.total_size,
    totalSize: d.total_size || d.source_size,
    buildId: d.id,
    activate: Boolean(d.activate),
    screenshotLight: '',
    screenshotDark: '',
    status: d.status,
    buildLogs: d.build_logs,
    buildDuration: d.build_duration,
    ...sourceModel(d),
    // The SDKs read these to tell when a chunked upload is complete.
    chunksTotal: d.chunks_total,
    chunksUploaded: d.chunks_uploaded,
    // Bunwrite: how many files the deployment serves.
    fileCount: d.file_count,
  }
}

export function siteModel(ctx: AppContext, s: SiteRow) {
  const latest = ctx.sites.latest(s.id)
  const live = s.deployment_id ? ctx.sites.deployment(s.id, s.deployment_id) : null
  const domains = ctx.proxy.domainsFor('site', s.id)
  return {
    $id: s.id,
    $createdAt: s.created_at,
    $updatedAt: s.updated_at,
    name: s.name,
    enabled: Boolean(s.enabled),
    live: Boolean(s.deployment_id),
    logging: true,
    framework: s.framework,
    deploymentRetention: 0,
    deploymentId: s.deployment_id,
    deploymentCreatedAt: live?.created_at ?? '',
    deploymentScreenshotLight: '',
    deploymentScreenshotDark: '',
    latestDeploymentId: latest?.id ?? '',
    latestDeploymentCreatedAt: latest?.created_at ?? '',
    latestDeploymentStatus: latest?.status ?? '',
    scopes: [],
    vars: [],
    timeout: 30,
    installCommand: s.install_command,
    buildCommand: s.build_command,
    startCommand: s.start_command,
    outputDirectory: s.output_directory,
    ...providerOf(s),
    providerBranches: [],
    providerPaths: [],
    buildSpecification: 's-1vcpu-512mb',
    runtimeSpecification: 's-1vcpu-512mb',
    buildRuntime: s.build_runtime,
    adapter: s.adapter,
    fallbackFile: s.fallback_file,
    // Bunwrite extensions.
    url: ctx.sites.url(s),
    domains,
    domain: domains[0] ?? '',
    apiFunctionId: s.api_function_id,
    pruneMode: s.prune_mode,
  }
}

function settingsFrom(ctx: AppContext, p: Params, base: SiteSettings): SiteSettings {
  const apiFunctionId = str(p.apiFunctionId) ?? base.apiFunctionId
  if (apiFunctionId && apiFunctionId !== base.apiFunctionId) ctx.functions.fn(apiFunctionId)
  const domains = p.domains !== undefined ? list(p.domains).map(String) : p.domain !== undefined ? (str(p.domain) ? [str(p.domain)!] : []) : base.domains
  return {
    name: str(p.name) ?? base.name,
    enabled: bool(p.enabled, base.enabled),
    framework: str(p.framework) || base.framework,
    outputDirectory: str(p.outputDirectory) ?? base.outputDirectory,
    fallbackFile: str(p.fallbackFile) ?? base.fallbackFile,
    domains,
    apiFunctionId,
    installCommand: str(p.installCommand) ?? base.installCommand,
    buildCommand: str(p.buildCommand) ?? base.buildCommand,
    startCommand: str(p.startCommand) ?? base.startCommand,
    buildRuntime: str(p.buildRuntime) ?? base.buildRuntime,
    adapter: str(p.adapter) || base.adapter,
    pruneMode: str(p.pruneMode) || base.pruneMode,
  }
}

export function siteRoutes(router: Router<AppContext>): void {
  router.get('/sites', ({ ctx, params }) => {
    requireKey(ctx, 'sites.read')
    const { total, items } = page(ctx.sites.list().map((s) => siteModel(ctx, s)), list(params.queries), { search: str(params.search), searchFields: ['$id', 'name', 'framework'] })
    return json({ total, sites: items })
  })

  router.post('/sites', async ({ ctx, params }) => {
    requireKey(ctx, 'sites.write')
    const raw = str(params.siteId)
    if (!raw) throw err('general_argument_invalid', 'Param "siteId" is not optional.')
    const id = raw === 'unique()' ? uniqueId() : raw
    const framework = frameworkOf(str(params.framework))
    const settings = settingsFrom(ctx, params, {
      name: id,
      enabled: true,
      framework: framework.key,
      outputDirectory: framework.outputDirectory,
      fallbackFile: framework.fallbackFile,
      domains: [],
      apiFunctionId: '',
      installCommand: framework.installCommand,
      buildCommand: framework.buildCommand,
      startCommand: framework.startCommand,
      buildRuntime: '',
      adapter: framework.adapter,
      pruneMode: 'auto',
    })
    const created = ctx.sites.create(id, settings)
    try {
      await applyProvider(ctx, 'site', created.id, params, NO_PROVIDER)
    } catch (error) {
      ctx.hub.forget(ctx.config.projectId, 'site', created.id)
      ctx.sites.remove(created.id)
      throw error
    }
    return json(siteModel(ctx, ctx.sites.site(created.id)), 201)
  })

  router.get('/sites/frameworks', () =>
    json({
      total: FRAMEWORKS.length,
      frameworks: FRAMEWORKS.map((f) => ({
        key: f.key,
        name: f.name,
        buildRuntime: f.buildCommand || f.adapter === 'ssr' ? DEFAULT_RUNTIME : 'static-1',
        runtimes: f.buildCommand || f.adapter === 'ssr' ? SITE_RUNTIMES.map((r) => r.id) : ['static-1'],
        // Bunwrite: static or server, for grouping in a picker.
        group: f.group,
        adapters: [
          {
            key: f.adapter,
            installCommand: f.installCommand,
            buildCommand: f.buildCommand,
            startCommand: f.startCommand,
            outputDirectory: f.outputDirectory,
            fallbackFile: f.fallbackFile,
          },
        ],
      })),
    }),
  )

  router.get('/sites/specifications', () =>
    json({ total: 1, specifications: [{ memory: 512, cpus: 1, enabled: true, slug: 's-1vcpu-512mb' }] }),
  )

  router.get('/sites/:siteId', ({ ctx, path }) => {
    requireKey(ctx, 'sites.read')
    return json(siteModel(ctx, ctx.sites.site(path.siteId!)))
  })

  router.put('/sites/:siteId', async ({ ctx, path, params }) => {
    requireKey(ctx, 'sites.write')
    const s = ctx.sites.site(path.siteId!)
    const updated = ctx.sites.update(s.id, settingsFrom(ctx, params, ctx.sites.settingsOf(s)))
    await applyProvider(ctx, 'site', updated.id, params, providerOf(s))
    return json(siteModel(ctx, ctx.sites.site(updated.id)))
  })

  router.delete('/sites/:siteId', ({ ctx, path }) => {
    requireKey(ctx, 'sites.write')
    ctx.sites.remove(path.siteId!)
    ctx.hub.forget(ctx.config.projectId, 'site', path.siteId!)
    return noContent()
  })

  // Appwrite's createVcsDeployment: build a branch, tag or commit of the connected repository.
  router.post('/sites/:siteId/deployments/vcs', async ({ ctx, path, params }) => {
    requireKey(ctx, 'sites.write')
    const s = ctx.sites.site(path.siteId!)
    const d = await ctx.hub.deployReference(projectOf(ctx), 'site', s.id, str(params.type) ?? 'branch', str(params.reference) ?? '', bool(params.activate, false))
    return json(siteDeploymentModel(ctx.sites.deployment(s.id, d.id)), 202)
  })

  // ---- Deployments ----

  router.get('/sites/:siteId/deployments', ({ ctx, path, params }) => {
    requireKey(ctx, 'sites.read')
    ctx.sites.site(path.siteId!)
    const { total, items } = page(ctx.sites.deployments(path.siteId!).map(siteDeploymentModel), list(params.queries), { search: str(params.search), searchFields: ['$id', 'status'] })
    return json({ total, deployments: items })
  })

  router.post('/sites/:siteId/deployments', async ({ ctx, path, params, request }) => {
    requireKey(ctx, 'sites.write')
    const s = ctx.sites.site(path.siteId!)
    const code = params.code
    if (!(code instanceof Blob)) throw err('general_argument_invalid', 'Param "code" must be a .tar.gz or .zip file.')
    // Build settings sent with a deployment update the site, as on Appwrite.
    const changes = ['installCommand', 'buildCommand', 'startCommand', 'outputDirectory', 'pruneMode'].filter((k) => str(params[k]) !== undefined)
    if (changes.length) ctx.sites.update(s.id, settingsFrom(ctx, params, ctx.sites.settingsOf(s)))
    const deployment = await ctx.sites.upload(ctx.sites.site(s.id), {
      code,
      activate: bool(params.activate, false),
      contentRange: request.headers.get('content-range'),
      uploadId: apiHeader(request, 'id'),
    })
    return json(siteDeploymentModel(deployment), 202)
  })

  router.get('/sites/:siteId/deployments/:deploymentId', ({ ctx, path }) => {
    requireKey(ctx, 'sites.read')
    return json(siteDeploymentModel(ctx.sites.deployment(path.siteId!, path.deploymentId!)))
  })

  router.delete('/sites/:siteId/deployments/:deploymentId', ({ ctx, path }) => {
    requireKey(ctx, 'sites.write')
    ctx.sites.removeDeployment(path.siteId!, path.deploymentId!)
    return noContent()
  })

  router.get('/sites/:siteId/deployments/:deploymentId/download', async ({ ctx, path }) => {
    requireKey(ctx, 'sites.read')
    const archive = await ctx.sites.download(path.siteId!, path.deploymentId!)
    return new Response(archive, {
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(archive.size),
        'content-disposition': `attachment; filename="${path.deploymentId}.tar.gz"`,
      },
    })
  })

  router.patch('/sites/:siteId/deployment', ({ ctx, path, params }) => {
    requireKey(ctx, 'sites.write')
    const deploymentId = str(params.deploymentId)
    if (!deploymentId) throw err('general_argument_invalid', 'Param "deploymentId" is not optional.')
    return json(siteModel(ctx, ctx.sites.activate(path.siteId!, deploymentId)))
  })

  /** Sites have no variables; an empty list keeps `appwrite pull sites` going. */
  router.get('/sites/:siteId/variables', ({ ctx, path }) => {
    requireKey(ctx, 'sites.read')
    ctx.sites.site(path.siteId!)
    return json({ total: 0, variables: [] })
  })
}
