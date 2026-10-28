/**
 * Appwrite's Sites API (`/v1/sites`), so `node-appwrite`, `@bunwrite/sdk` and
 * `appwrite push sites` work. Everything is served as static files; build
 * settings are stored and returned but nothing is built.
 *
 * Bunwrite extensions on create and update: `domain` (a custom domain) and
 * `apiFunctionId` (the function that answers `/api/*` on the site's domain).
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { apiHeader } from '~/lib/compat'
import { err } from '~/lib/errors'
import { bool, json, list, noContent, str, type Params } from '~/lib/http'
import { uniqueId } from '~/lib/ids'
import { page } from '~/lib/paging'
import type { Router } from '~/lib/router'
import type { SiteDeploymentRow, SiteRow, SiteSettings } from './service'

/** Frameworks the console and `appwrite init sites` offer; all are served as static output. */
export const FRAMEWORKS = [
  { key: 'other', name: 'Plain HTML / htmx', outputDirectory: '', fallbackFile: '' },
  { key: 'vite', name: 'Vite', outputDirectory: 'dist', fallbackFile: 'index.html' },
  { key: 'react', name: 'React', outputDirectory: 'dist', fallbackFile: 'index.html' },
  { key: 'vue', name: 'Vue', outputDirectory: 'dist', fallbackFile: 'index.html' },
  { key: 'svelte', name: 'Svelte', outputDirectory: 'dist', fallbackFile: 'index.html' },
  { key: 'astro', name: 'Astro (static)', outputDirectory: 'dist', fallbackFile: '' },
  { key: 'angular', name: 'Angular', outputDirectory: 'dist/browser', fallbackFile: 'index.html' },
]

export function siteDeploymentModel(d: SiteDeploymentRow) {
  return {
    $id: d.id,
    $createdAt: d.created_at,
    $updatedAt: d.updated_at,
    type: 'manual',
    resourceId: d.site_id,
    resourceType: 'sites',
    entrypoint: '',
    sourceSize: d.source_size,
    buildSize: 0,
    totalSize: d.total_size || d.source_size,
    buildId: d.id,
    activate: Boolean(d.activate),
    screenshotLight: '',
    screenshotDark: '',
    status: d.status,
    buildLogs: d.build_logs,
    buildDuration: d.build_duration,
    providerRepositoryName: '',
    providerRepositoryOwner: '',
    providerRepositoryUrl: '',
    providerCommitHash: '',
    providerCommitAuthorUrl: '',
    providerCommitAuthor: '',
    providerCommitMessage: '',
    providerCommitUrl: '',
    providerBranch: '',
    providerBranchUrl: '',
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
    startCommand: '',
    outputDirectory: s.output_directory,
    installationId: '',
    providerRepositoryId: '',
    providerBranch: '',
    providerRootDirectory: '',
    providerSilentMode: false,
    providerBranches: [],
    providerPaths: [],
    buildSpecification: 's-1vcpu-512mb',
    runtimeSpecification: 's-1vcpu-512mb',
    buildRuntime: s.build_runtime,
    adapter: s.adapter,
    fallbackFile: s.fallback_file,
    // Bunwrite extensions.
    url: ctx.sites.url(s),
    domain: s.domain,
    apiFunctionId: s.api_function_id,
  }
}

/** A site's custom domain as an Appwrite proxy rule; `domain` overrides it for the built-in subdomain. */
export function siteRule(ctx: AppContext, s: SiteRow, domain = s.domain) {
  return {
    $id: domain === s.domain ? `site-${s.id}` : `default-${s.id}`,
    $createdAt: s.created_at,
    $updatedAt: s.updated_at,
    domain,
    type: 'deployment',
    trigger: 'manual',
    redirectUrl: '',
    redirectStatusCode: 301,
    deploymentId: s.deployment_id,
    deploymentResourceType: 'site',
    deploymentResourceId: s.id,
    deploymentVcsProviderBranch: '',
    status: 'verified',
    logs: '',
    renewAt: '',
  }
}

/** Every address a site answers on: its subdomain here, and its custom domain if set. */
export const siteRules = (ctx: AppContext, s: SiteRow) => [
  siteRule(ctx, s, new URL(ctx.sites.url(s)).host),
  ...(s.domain ? [siteRule(ctx, s)] : []),
]

function settingsFrom(ctx: AppContext, p: Params, base: SiteSettings): SiteSettings {
  const apiFunctionId = str(p.apiFunctionId) ?? base.apiFunctionId
  if (apiFunctionId && apiFunctionId !== base.apiFunctionId) ctx.functions.fn(apiFunctionId)
  return {
    name: str(p.name) ?? base.name,
    enabled: bool(p.enabled, base.enabled),
    framework: str(p.framework) || base.framework,
    outputDirectory: str(p.outputDirectory) ?? base.outputDirectory,
    fallbackFile: str(p.fallbackFile) ?? base.fallbackFile,
    domain: str(p.domain) ?? base.domain,
    apiFunctionId,
    installCommand: str(p.installCommand) ?? base.installCommand,
    buildCommand: str(p.buildCommand) ?? base.buildCommand,
    buildRuntime: str(p.buildRuntime) ?? base.buildRuntime,
    adapter: str(p.adapter) || base.adapter,
  }
}

export function siteRoutes(router: Router<AppContext>): void {
  router.get('/sites', ({ ctx, params }) => {
    requireKey(ctx, 'sites.read')
    const { total, items } = page(ctx.sites.list().map((s) => siteModel(ctx, s)), list(params.queries), { search: str(params.search), searchFields: ['$id', 'name', 'framework'] })
    return json({ total, sites: items })
  })

  router.post('/sites', ({ ctx, params }) => {
    requireKey(ctx, 'sites.write')
    const raw = str(params.siteId)
    if (!raw) throw err('general_argument_invalid', 'Param "siteId" is not optional.')
    const id = raw === 'unique()' ? uniqueId() : raw
    const framework = FRAMEWORKS.find((f) => f.key === str(params.framework))
    const settings = settingsFrom(ctx, params, {
      name: id,
      enabled: true,
      framework: str(params.framework) || 'other',
      outputDirectory: framework?.outputDirectory ?? '',
      fallbackFile: framework?.fallbackFile ?? '',
      domain: '',
      apiFunctionId: '',
      installCommand: '',
      buildCommand: '',
      buildRuntime: '',
      adapter: 'static',
    })
    return json(siteModel(ctx, ctx.sites.create(id, settings)), 201)
  })

  router.get('/sites/frameworks', () =>
    json({
      total: FRAMEWORKS.length,
      frameworks: FRAMEWORKS.map((f) => ({
        key: f.key,
        name: f.name,
        buildRuntime: 'static-1',
        runtimes: ['static-1'],
        adapters: [{ key: 'static', installCommand: '', buildCommand: '', outputDirectory: f.outputDirectory, fallbackFile: f.fallbackFile }],
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

  router.put('/sites/:siteId', ({ ctx, path, params }) => {
    requireKey(ctx, 'sites.write')
    const s = ctx.sites.site(path.siteId!)
    return json(siteModel(ctx, ctx.sites.update(s.id, settingsFrom(ctx, params, ctx.sites.settingsOf(s)))))
  })

  router.delete('/sites/:siteId', ({ ctx, path }) => {
    requireKey(ctx, 'sites.write')
    ctx.sites.remove(path.siteId!)
    return noContent()
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
    const changes = ['installCommand', 'buildCommand', 'outputDirectory'].filter((k) => str(params[k]) !== undefined)
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

  /** Sites run no code on this server, so they have no variables; an empty list keeps `appwrite pull sites` going. */
  router.get('/sites/:siteId/variables', ({ ctx, path }) => {
    requireKey(ctx, 'sites.read')
    ctx.sites.site(path.siteId!)
    return json({ total: 0, variables: [] })
  })

  // ---- Custom domains, as Appwrite proxy rules ----

  router.post('/proxy/rules/site', ({ ctx, params }) => {
    requireKey(ctx, 'rules.write')
    const s = ctx.sites.site(str(params.siteId) ?? '')
    const domain = str(params.domain)
    if (!domain) throw err('general_argument_invalid', 'Param "domain" is not optional.')
    return json(siteRule(ctx, ctx.sites.update(s.id, { ...ctx.sites.settingsOf(s), domain })), 201)
  })

  router.delete('/proxy/rules/:ruleId', ({ ctx, path }) => {
    requireKey(ctx, 'rules.write')
    const m = /^site-(.+)$/.exec(path.ruleId!)
    if (!m) throw err('rule_not_found')
    const s = ctx.sites.site(m[1]!)
    if (!s.domain) throw err('rule_not_found')
    ctx.sites.update(s.id, { ...ctx.sites.settingsOf(s), domain: '' })
    return noContent()
  })
}
