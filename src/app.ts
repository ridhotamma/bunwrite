import type { Server } from 'bun'

import { keyCaller, parseCookies, resolveCaller, type Caller } from './auth/caller'
import { PUBLIC_FILES } from './console/assets'
import { accountRoutes, userRoutes } from './auth/routes'
import { forwardSticky, publicWorkerIndex, stickyHostOf, stickyTargetFor, withStickyCookie } from './cluster/sticky'
import { forwardWrite, shouldForwardConsoleWrite, shouldForwardWrite } from './cluster/writer'
import { createConsole } from './console/app'
import { apiHomePage, notFoundPage, wantsHtml } from './console/public'
import { documentRoutes, transactionRoutes } from './documents/routes'
import type { DocEvent } from './documents/store'
import { apiHeader, assertCompatHeaders, corsHeaderNames, sessionFromCookies } from './lib/compat'
import { addVary, compressResponse } from './lib/compress'
import { isStreaming } from './lib/streaming'
import { BunwriteError, err } from './lib/errors'
import { errorResponse, json, readParams } from './lib/http'
import { forwardedHeadersTrusted, parseTrustedProxies, rememberClientIp } from './lib/client-ip'
import { logRequest, requestId, truncate } from './lib/log'
import { originAllowed } from './lib/origins'
import { Router } from './lib/router'
import { requestLocale } from './locale/service'
import { localeRoutes } from './locale/routes'
import { normalizePath, type RequestObservation } from './observability'
import type { Socket, SocketData } from './realtime/hub'
import { schemaRoutes } from './schema/routes'
import type { Services } from './services'
import { functionHttpResponse } from './functions/http'
import { functionRoutes } from './functions/routes'
import { realtimeRoutes } from './realtime/routes'
import { proxyRoutes } from './proxy/routes'
import { singleProjectResolver, type ProjectResolver, type ProjectRuntime } from './projects/types'
import { renderRoutes } from './render/routes'
import { serveSite } from './sites/serve'
import { siteRoutes } from './sites/routes'
import { storageRoutes } from './storage/routes'
import { teamRoutes } from './teams/routes'
import { topicRoutes } from './messaging/topics'
import { queueRoutes } from './queue/routes'
import { vectorRoutes } from './vectors/routes'
import { CONSOLE_PROJECT, createConsoleApi } from './platform/console'
import { projectRoutes } from './platform/project'
import { webhookRoutes } from './webhooks/routes'
import { VcsHub } from './vcs/hub'
import { vcsRoutes } from './vcs/routes'

export { createServices, type Services } from './services'

export interface AppContext extends Services {
  caller: Caller
  /** Locale selected by `X-Appwrite-Locale` or `Accept-Language`, used for localized email templates. */
  locale: string
  /** Git deployments for the whole server (GitHub App, webhooks, repository links). */
  hub: VcsHub
  /** Events of this request's batched writes; published once the handler returns. */
  events: DocEvent[]
}

interface RequestMeta {
  auth?: string
  error?: string
  project?: string
  /** Normalised route template, for metric and trace labels. */
  route?: string
  /** Handed to the writer worker; that listener logs the real request. */
  forwarded?: boolean
  /** Set once the request's project is known; ended in `fetch`'s finally block. */
  observation?: RequestObservation
}

const authLabel = (caller: Caller) => (caller.kind === 'user' ? `user:${caller.user?.id ?? ''}` : caller.kind)

const refererOrigin = (value: string | null): string | null => {
  if (!value) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

// htmx sends its own headers on every request; a browser preflight rejects them
// unless they are listed here, so cross-origin htmx clients need these too.
const HTMX_REQUEST_HEADERS = 'HX-Request, HX-Current-URL, HX-Trigger, HX-Trigger-Name, HX-Target, HX-Prompt, HX-Boosted, HX-History-Restore-Request'

const HTMX_RESPONSE_HEADERS =
  'HX-Location, HX-Push-Url, HX-Redirect, HX-Refresh, HX-Replace-Url, HX-Reswap, HX-Retarget, HX-Reselect, HX-Trigger, HX-Trigger-After-Swap, HX-Trigger-After-Settle'

/** Bunwrite's and Appwrite's request headers, by short name (see lib/compat). */
const API_HEADERS = corsHeaderNames(['Project', 'Key', 'Locale', 'Mode', 'JWT', 'Response-Format', 'Timeout', 'ID', 'Timestamp', 'Session', 'Organization'])

const ALLOW_HEADERS = `Accept, Authorization, Origin, Cookie, Set-Cookie, Content-Type, Content-Range, If-Match, If-None-Match, ${API_HEADERS}, X-SDK-Version, X-SDK-Name, X-SDK-Language, X-SDK-Platform, X-SDK-GraphQL, Range, Cache-Control, Expires, Pragma, X-Fallback-Cookies, X-Requested-With, X-Forwarded-For, X-Forwarded-User-Agent, ${HTMX_REQUEST_HEADERS}`

const EXPOSE_HEADERS = `X-Bunwrite-Session, X-Appwrite-Session, X-Fallback-Cookies, X-Request-Id, X-Trace-Id, ${HTMX_RESPONSE_HEADERS}`

export { originAllowed }

/**
 * Reload what another process changed. Comparing the counters is one tiny
 * prepared SELECT; CACHE_CHECK_MS can throttle it at the cost of a short stale
 * window after an external schema or settings change.
 */
async function syncServices(services: Services): Promise<void> {
  // Poll in single-process mode too: session and API-key caches use the same
  // counters, and a local write must invalidate them on the next request.
  const changed = await services.versions.pollAsync()
  if (changed.schema) await services.registry.load()
  if (changed.settings) {
    await services.settings.load()
    await services.access.load()
    await services.observabilitySettings.load()
    // Template edits made in another worker must be sent by this one too.
    await services.templates.load()
  }
  if (changed.catalog) {
    await services.proxy.reload()
    services.sites.reload()
  }
}

export function createApp(source: Services | ProjectResolver) {
  const projects: ProjectResolver = 'defaultProject' in source ? source : singleProjectResolver(source)
  const control = projects.control
  const trustedProxies = parseTrustedProxies(control.config.trustedProxies)
  /**
   * Requests still arrive with no project at all, for example when the last
   * project has been deleted. Those requests (health checks, unknown paths)
   * run against the control services instead of failing with project_not_found.
   */
  const noProjectRuntime = (): ProjectRuntime => ({
    info: { id: '', name: control.config.projectName, orgId: control.config.orgId, createdAt: '', updatedAt: '' },
    services: control,
  })
  const defaultRuntime = (): ProjectRuntime => (projects.list().length ? projects.defaultProject() : noProjectRuntime())
  const hub = new VcsHub(projects)
  // Observability is per project: each runtime owns its exporters, sampling,
  // feature flags and local telemetry limits. Console pages and requests use
  // the runtime resolved for the selected project.
  const shouldObserve = (url: URL): boolean =>
    !(url.pathname in PUBLIC_FILES || url.pathname.startsWith('/console/assets/') || url.pathname.startsWith('/console/observability'))
  const router = new Router<AppContext>()
  router.get('/health', () => json({ name: 'http', ping: 0, status: 'pass' }))
  router.get('/health/version', () => json({ version: '1.8.0' }))
  // Server-side feature flags: local overrides plus PostHog.
  router.get('/flags', async ({ ctx }) => {
    const distinctId = ctx.caller.user?.id ?? `project:${ctx.config.projectId}`
    return json({ flags: await ctx.observability.flags.evaluate(distinctId, { project: ctx.config.projectId }) })
  })
  documentRoutes(router)
  transactionRoutes(router)
  schemaRoutes(router)
  localeRoutes(router)
  accountRoutes(router)
  userRoutes(router)
  teamRoutes(router)
  storageRoutes(router)
  functionRoutes(router)
  realtimeRoutes(router)
  siteRoutes(router)
  vcsRoutes(router)
  proxyRoutes(router)
  renderRoutes(router)
  projectRoutes(router)
  webhookRoutes(router)
  topicRoutes(router)
  queueRoutes(router)
  vectorRoutes(router)
  for (const extend of extraRoutes) extend(router)

  /**
   * Is this browser origin allowed to act for `projectId`? A hosted site or
   * function counts only for its own project: otherwise any tenant could make
   * credentialed requests against every other tenant's API.
   */
  const trustedOrigin = async (origin: string, projectId: string, allowedOrigins: string[], request?: Request): Promise<boolean> => {
    // A same-host browser request is not cross-site, whatever the allowlist.
    if (request) {
      try {
        if (new URL(origin).host === new URL(request.url).host) return true
      } catch {
        // fall through to the configured origins
      }
    }
    // `*` is never accepted for credentialed or state-changing requests.
    if (originAllowed(origin, allowedOrigins.filter((pattern) => pattern !== '*'))) return true
    const hosted = await siteOfOrigin(origin)
    return hosted?.project.info.id === projectId
  }

  const cors = async (request: Request, projectId: string, allowedOrigins: string[]): Promise<Record<string, string>> => {
    const origin = request.headers.get('origin')
    if (!origin) return {}
    // Same-project sites may call the API from the browser without being listed.
    const siteOrigin = await siteOfOrigin(origin)
    const ownSite = siteOrigin?.project.info.id === projectId
    const listed = originAllowed(origin, allowedOrigins.filter((pattern) => pattern !== '*'))
    if (!ownSite && !listed && !allowedOrigins.includes('*')) return {}
    // A literal `*` cannot be combined with credentials. Reflect it without
    // them so the operator's opt-in still permits reads, but not cookies.
    const wildcardOnly = !ownSite && !listed
    if (wildcardOnly) {
      return {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
        'access-control-allow-headers': ALLOW_HEADERS,
        'access-control-expose-headers': EXPOSE_HEADERS,
        'access-control-max-age': '86400',
        vary: 'Origin',
      }
    }
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
      'access-control-allow-headers': ALLOW_HEADERS,
      'access-control-expose-headers': EXPOSE_HEADERS,
      'access-control-max-age': '86400',
      vary: 'Origin',
    }
  }

  /** Apply CORS to a response; keep a handler's Vary (for example Accept-Encoding) and add Origin beside it. */
  const corsResponse = async (request: Request, response: Response, projectId: string, allowedOrigins: string[]): Promise<Response> => {
    for (const [k, v] of Object.entries(await cors(request, projectId, allowedOrigins))) {
      if (k === 'vary') addVary(response.headers, v)
      else response.headers.set(k, v)
    }
    return response
  }

  const siteOfOrigin = async (origin: string) => {
    try {
      const host = new URL(origin).host
      return (await projects.findSite(host)) ?? (await projects.findFunctionByHost(host))
    } catch {
      return null
    }
  }

  /** A site's own domain: `<siteId>.<SITES_DOMAIN>` or one of its custom domains. */
  async function siteFor(request: Request) {
    const host = request.headers.get('host')
    // Only a trusted proxy controls X-Forwarded-Host; otherwise a client
    // could make a request resolve to a host it was not sent to.
    const forwarded = forwardedHeadersTrusted(request) ? request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() : undefined
    return (host ? await projects.findSite(host) : null) ?? (forwarded ? await projects.findSite(forwarded) : null)
  }

  /** A function's own domain: `<functionId>.<FUNCTIONS_DOMAIN>` or one of its custom domains. */
  async function functionFor(request: Request) {
    const host = request.headers.get('host')
    const forwarded = forwardedHeadersTrusted(request) ? request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() : undefined
    return (host ? await projects.findFunctionByHost(host) : null) ?? (forwarded ? await projects.findFunctionByHost(forwarded) : null)
  }

  const consoleApp = createConsole(projects, hub)
  const consoleApi = createConsoleApi(projects)

  /** API keys first; then a console admin's CLI session in admin mode; then the request's own session or JWT. */
  async function callerOf(services: Services, request: Request, meta: RequestMeta): Promise<Caller> {
    if (!apiHeader(request, 'key')) {
      const admin = await consoleApi.adminOf(request)
      if (admin) {
        meta.auth = `console:${admin.email}`
        return keyCaller()
      }
    }
    const caller = await resolveCaller(services.db, services.config, request, services.versions)
    meta.auth = authLabel(caller)
    return caller
  }

  const projectOf = (request: Request, url: URL) => apiHeader(request, 'project') ?? url.searchParams.get('project')

  /**
   * Which project a console form writes to. Project-wide pages (projects,
   * organization, the index) use the control database and go to the control
   * writer; the rest follow the selected-project cookie.
   */
  function consoleWriteProject(request: Request, url: URL): string {
    const pathname = url.pathname.replace(/\/$/, '') || '/'
    if (
      pathname === '/console' ||
      pathname.startsWith('/console/projects') ||
      pathname.startsWith('/console/organization') ||
      pathname.startsWith('/console/security')
    ) {
      return control.config.projectId
    }
    const cookie = parseCookies(request.headers.get('cookie') ?? '')['console_project']
    return cookie && projects.get(cookie) ? cookie : control.config.projectId
  }

  /** Which project's services handle this request. */
  async function runtimeFor(request: Request, url: URL): Promise<ProjectRuntime> {
    const pathname = url.pathname.replace(/^\/v1(?=\/|$)/, '') || '/'
    // Function HTTP endpoints are called without a project header by the
    // function's own integrations; resolve the owner by function ID.
    const fn = /^\/functions\/([^/]+)\/http(?:\/|$)/.exec(pathname)
    if (fn) {
      const headerProject = projectOf(request, url)
      if (headerProject) {
        const byHeader = projects.get(headerProject)
        if (!byHeader) throw err('project_not_found')
        return byHeader
      }
      const owner = await projects.findFunction(decodeURIComponent(fn[1]!))
      if (owner) return owner
      throw err('project_not_found')
    }
    // Browser preflights carry no custom project header. Use the origin to
    // find the project whose site or allowlist the browser is calling from;
    // otherwise the default project's CORS settings would answer for every
    // project, and a site allowed by its own project would fail preflight.
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('origin')
      if (origin) {
        const hosted = await siteOfOrigin(origin)
        if (hosted) return hosted.project
        // Prefer a project that lists the origin over one that only has `*`:
        // a wildcard response is not usable with credentials.
        for (const runtime of projects.list()) {
          if (originAllowed(origin, runtime.services.config.allowedOrigins.filter((pattern) => pattern !== '*'))) return runtime
        }
        for (const runtime of projects.list()) {
          if (runtime.services.config.allowedOrigins.includes('*')) return runtime
        }
      }
      return defaultRuntime()
    }
    if (pathname === '/health' || pathname.startsWith('/health/')) {
      // Health answers without a project; when one is named, its key is the one
      // to validate, so `GET /health` can prove a second project's credentials.
      // The Appwrite CLI sends its pseudo-project `console` while probing.
      const projectId = projectOf(request, url)
      if (!projectId || projectId === CONSOLE_PROJECT) return defaultRuntime()
      const project = projects.get(projectId)
      if (!project) throw err('project_not_found')
      return project
    }
    // `appwrite push functions` reads this as the "console" project.
    if (pathname === '/console/variables') return defaultRuntime()

    // OAuth callbacks carry the project ID in the path.
    const oauth = /^\/account\/sessions\/oauth2\/callback\/[^/]+\/([^/]+)$/.exec(pathname)
    if (oauth) {
      const project = projects.get(decodeURIComponent(oauth[1]!))
      if (project) return project
      throw err('project_not_found')
    }

    const projectId = projectOf(request, url)
    if (!projectId) {
      // Let unknown paths fall through to the HTML 404 page; known API routes
      // still need a project header.
      if (!router.match(request.method, pathname)) return defaultRuntime()
      throw err('project_not_found')
    }
    const project = projects.get(projectId)
    if (!project) throw err('project_not_found')
    return project
  }

  async function handle(request: Request, server: Server<SocketData> | undefined, meta: RequestMeta, runtime: ProjectRuntime): Promise<Response | undefined> {
    const url = new URL(request.url)
    const pathname = url.pathname.replace(/^\/v1(?=\/|$)/, '') || '/'
    const services = runtime.services
    meta.project = runtime.info.id
    meta.route = normalizePath(pathname)

    if (pathname === '/realtime') {
      // A browser WebSocket carries cookies and is not covered by CORS.
      const origin = request.headers.get('origin')
      if (origin && !(await trustedOrigin(origin, runtime.info.id, services.config.allowedOrigins, request))) {
        throw err('general_unauthorized_scope', 'This origin may not open a realtime connection.')
      }
      const caller = await callerOf(services, request, meta)
      if (!caller.privileged) services.access.assertProtocol('websocket')
      if (server?.upgrade(request, { data: { caller, subscriptions: new Map(), projectId: runtime.info.id } })) return undefined
      throw err('general_argument_invalid', 'Realtime needs a WebSocket upgrade.')
    }

    const match = router.match(request.method, pathname)
    // Cluster mode: one process owns the write connection, so hand short
    // mutations there. Uploads, function runs and deployments stay local.
    // If the writer is unreachable, `forwardWrite` returns null and this
    // worker handles the request itself so writes never fail open.
    if (match && shouldForwardWrite(services.config, request.method, pathname, runtime.info.id)) {
      const forwarded = await forwardWrite(services.config, request, runtime.info.id)
      if (forwarded) {
        meta.forwarded = true
        return forwarded
      }
    }

    if (request.method === 'OPTIONS' && !match?.raw) return new Response(null, { status: 204 })
    if (!match) throw err('general_route_not_found')

    const params = match.raw ? {} : await readParams(request, url)
    const caller = await callerOf(services, request, meta)
    // A browser origin on a state-changing request must be one this project
    // trusts. Sessions are SameSite=None for cross-origin apps, so a hostile
    // page could otherwise submit a form with the victim's cookie (or perform
    // login CSRF on the unauthenticated session routes).
    // Apple posts its OAuth callback from appleid.apple.com; the signed state
    // is the CSRF protection for that route, not a project Origin.
    const oauthCallback = pathname.startsWith('/account/sessions/oauth2/callback/')
    if (!oauthCallback && request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
      const origin = request.headers.get('origin') ?? refererOrigin(request.headers.get('referer'))
      if (origin) {
        if (!(await trustedOrigin(origin, runtime.info.id, services.config.allowedOrigins, request))) {
          throw err('general_unauthorized_scope', 'Cross-site request refused.')
        }
      } else if (request.headers.get('sec-fetch-site') === 'cross-site') {
        throw err('general_unauthorized_scope', 'Cross-site request refused.')
      }
    }
    // Like Appwrite, switched-off services and protocols stop clients but not API keys or console admins.
    // A function's own HTTP endpoint stands in for its public domain, so it is not part of the Functions API.
    if (!caller.privileged && !/^\/functions\/[^/]+\/http(?:\/|$)/.test(pathname)) {
      services.access.assertProtocol('rest')
      services.access.assertService(pathname)
    }
    services.store.drainEvents()
    const events: DocEvent[] = []
    const locale = requestLocale(request)
    const response = await match.handler({ request, url, params, path: match.path, ctx: { ...services, caller, locale, hub, events } })
    const published = [...events, ...services.store.drainEvents()]
    services.realtime.publish(published)
    await services.webhooks.dispatch(published, caller)
    runtime.services.observability.captureEvents(published, caller, runtime.info.id, runtime.services.telemetry)
    return response
  }

  async function respond(
    request: Request,
    server: Server<SocketData> | undefined,
    meta: RequestMeta,
    sticky: boolean,
  ): Promise<Response | undefined> {
    const url = new URL(request.url)
    // Start with the project that will handle the request, not the default:
    // sampling and exporters are per project.
    const startObservation = (services: Services) => {
      if (meta.observation || !shouldObserve(url)) return
      const observation = services.observability.begin(request)
      if (observation) meta.observation = observation
    }
    try {
      assertCompatHeaders(request)
    } catch (error) {
      meta.error = truncate(error instanceof Error ? error.message : String(error), 2000)
      startObservation(control)
      return await corsResponse(request, errorResponse(error), control.config.projectId, control.config.allowedOrigins)
    }
    const hosted = await siteFor(request)
    if (hosted) {
      meta.project = hosted.project.info.id
      meta.auth = `site:${hosted.site.id}`
      meta.route = 'site'
      if (hosted.project.services !== control) await syncServices(hosted.project.services)

      const hostedConfig = hosted.project.services.config
      const host = stickyHostOf(request)
      // Static files are stateless. SSR sites send every request to their app;
      // a static site only needs affinity on its API function paths.
      const apiPath = url.pathname === '/api' || url.pathname.startsWith('/api/')
      const stateful = hosted.site.adapter === 'ssr' || (apiPath && Boolean(hosted.site.api_function_id))
      const target = sticky && stateful ? stickyTargetFor(request, hostedConfig, host) : undefined
      const self = publicWorkerIndex(hostedConfig)
      let response: Response | undefined

      if (target !== undefined && target !== self) {
        const forwarded = await forwardSticky(hostedConfig, request, host, target)
        if (forwarded) {
          meta.forwarded = true
          response = forwarded
        }
      }

      if (!response) {
        startObservation(hosted.project.services)
        response = await serveSite(hosted.project.services, hosted.site, request, hosted.deploymentId)
      }

      // Pin browsers to the worker that handled this request (or whose sticky
      // listener accepted the forward). If the target was unreachable and we
      // served locally, leave the next request free to try again.
      if (sticky && target !== undefined && (meta.forwarded || target === self)) {
        response = withStickyCookie(response, hostedConfig, target)
      }
      return response
    }
    const hostedFunction = await functionFor(request)
    if (hostedFunction) {
      meta.project = hostedFunction.project.info.id
      meta.auth = `function:${hostedFunction.fn.id}`
      meta.route = 'function'
      try {
        if (hostedFunction.project.services !== control) await syncServices(hostedFunction.project.services)
        startObservation(hostedFunction.project.services)
        const caller = await resolveCaller(
          hostedFunction.project.services.db,
          hostedFunction.project.services.config,
          request,
          hostedFunction.project.services.versions,
        )
        return await functionHttpResponse(hostedFunction.project.services, hostedFunction.fn, caller, request, `${url.pathname}${url.search}`)
      } catch (error) {
        meta.error = truncate(error instanceof Error ? error.message : String(error), 2000)
        return errorResponse(error)
      }
    }
    // Caddy's on-demand TLS asks here before getting a certificate for a host.
    // GitHub calls these without a project: the hub finds the project itself.
    if (url.pathname === '/v1/vcs/github/events' && request.method === 'POST') {
      meta.auth = 'github'
      startObservation(control)
      return hub.webhook(request)
    }
    if (url.pathname === '/v1/vcs/github/callback' && request.method === 'GET') {
      startObservation(control)
      return hub.completeInstall(url)
    }
    if (url.pathname === '/v1/vcs/github/manifest' && request.method === 'GET') {
      startObservation(control)
      return hub.completeManifest(url)
    }
    if ((url.pathname === '/.well-known/bunwrite/site-domain' || url.pathname === '/.well-known/bunwrite/host') && request.method === 'GET') {
      startObservation(control)
      const domain = url.searchParams.get('domain') ?? ''
      return new Response(null, { status: domain && ((await projects.findSite(domain)) || (await projects.findFunctionByHost(domain))) ? 200 : 404 })
    }
    const asset = PUBLIC_FILES[url.pathname]
    if (asset && (request.method === 'GET' || request.method === 'HEAD')) {
      const file = Bun.file(asset.path)
      return new Response(file, { headers: { 'content-type': asset.type, 'content-length': String(file.size), 'cache-control': 'public, max-age=604800' } })
    }
    // Console forms are short database writes too. Uploads, builds, backups
    // and outbound tests stay on this worker; the writer that owns the selected
    // project handles the rest.
    const consoleProjectId = consoleWriteProject(request, url)
    if (shouldForwardConsoleWrite(control.config, request.method, url.pathname, consoleProjectId)) {
      const forwarded = await forwardWrite(control.config, request, consoleProjectId)
      if (forwarded) {
        meta.forwarded = true
        return forwarded
      }
    }
    const consoleResponse = await consoleApp.handle(request, server)
    if (consoleResponse) {
      meta.route = 'console'
      startObservation(control)
      return consoleResponse
    }
    const pathname = url.pathname
    // The bare host is for people: send them to the console (or say the API is up).
    if (pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      meta.route = '/'
      startObservation(control)
      return control.config.consoleEnabled ? new Response(null, { status: 302, headers: { location: '/console' } }) : apiHomePage(control.config.projectName)
    }
    let runtime: ProjectRuntime = defaultRuntime()
    let response: Response | undefined
    try {
      // The Appwrite CLI's console calls (login, organizations, projects).
      // Newer CLI versions call /account/sessions/current without a project
      // header; its console session cookie is enough to identify the scope.
      const requestedProject = projectOf(request, url)
      const consoleCookie =
        !requestedProject &&
        /^\/v1\/account(?:\/|$)/.test(pathname) &&
        Boolean(
          sessionFromCookies(parseCookies(request.headers.get('cookie') ?? ''), request.headers.get('x-fallback-cookies'), CONSOLE_PROJECT),
        )
      if ((requestedProject === CONSOLE_PROJECT || consoleCookie) && request.method !== 'OPTIONS') {
        response = await consoleApi.handle(request, pathname.replace(/^\/v1(?=\/|$)/, '') || '/')
        if (response) meta.auth ??= 'console'
      }
      if (!response) runtime = await runtimeFor(request, url)
      if (runtime.services !== control) await syncServices(runtime.services)
      startObservation(runtime.services)
      response ??= await handle(request, server, meta, runtime)
      if (!response) return undefined
    } catch (error) {
      meta.error = truncate(error instanceof Error ? error.message : String(error), 2000)
      // A browser typing a wrong address gets a page; SDKs and /v1 keep Appwrite's JSON error.
      if (error instanceof BunwriteError && error.type === 'general_route_not_found' && wantsHtml(request, pathname)) {
        return notFoundPage(runtime.services.config.consoleEnabled, runtime.services.config.projectName)
      }
      runtime.services.store.drainEvents()
      response = errorResponse(error)
      if (!(error instanceof BunwriteError)) console.error(error)
    }
    return await corsResponse(request, response, runtime.info.id, runtime.services.config.allowedOrigins)
  }

  const fetch = async (
    request: Request,
    server?: Server<SocketData>,
    sticky = true,
  ): Promise<Response | undefined> => {
      // Another worker may have changed projects, schema or settings.
      if (projects.sync) await projects.sync()
      else await syncServices(control)
      const started = performance.now()
      const url = new URL(request.url)
      // The console resolves its own project, so refresh every runtime it may show.
      if (url.pathname.startsWith('/console')) {
        for (const runtime of projects.list()) if (runtime.services !== control) await syncServices(runtime.services)
      }
      const id = requestId(request)
      const ip = rememberClientIp(request, server?.requestIP(request)?.address, trustedProxies)
      const meta: RequestMeta = { auth: url.pathname.startsWith('/console') ? 'console' : undefined }
      const logsUi = url.pathname === '/console/logs' || url.pathname.startsWith('/console/logs/')
      let status = 500
      let responseBytes = 0
      try {
        const raw = await respond(request, server, meta, sticky)
        if (!raw) {
          status = 101
          return undefined
        }
        // A stream may go quiet for longer than the idle timeout (an LLM thinking); keep it open.
        if (server && isStreaming(raw)) server.timeout(request, 0)
        const response = control.config.compression ? await compressResponse(request, raw) : raw
        status = response.status
        responseBytes = Number(response.headers.get('content-length') ?? 0) || 0
        response.headers.set('x-request-id', id)
        response.headers.set('x-content-type-options', 'nosniff')
        // Only claim HSTS when this instance is actually served over HTTPS;
        // setting it on a plain-HTTP development server would lock the host.
        if (control.config.publicEndpoint.startsWith('https')) {
          response.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains')
        }
        if (meta.observation) response.headers.set('x-trace-id', meta.observation.traceId)
        // HEAD runs the GET handler so headers and cache validation match, then drops the body.
        return request.method === 'HEAD'
          ? new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers })
          : response
      } finally {
        const skip = url.pathname in PUBLIC_FILES || url.pathname.startsWith('/console/assets/') || (logsUi && status < 400)
        const runtime = meta.project ? projects.get(meta.project) : undefined
        const logConfig = runtime?.services.config ?? control.config
        // Sampling keeps the hot path cheap while errors are always recorded.
        const sampling = logConfig.logSampleRate < 1 && status < 400
        if (logConfig.logRequests && !meta.forwarded && !skip && (!sampling || Math.random() < logConfig.logSampleRate)) {
          const entry = {
            id,
            method: request.method,
            path: truncate(url.pathname, 3000),
            status,
            durationMs: performance.now() - started,
            requestBytes: Number(request.headers.get('content-length') ?? 0) || 0,
            responseBytes,
            ip: logConfig.logIp ? ip || undefined : undefined,
            project: truncate(meta.project ?? apiHeader(request, 'project') ?? url.searchParams.get('project') ?? '', 200) || undefined,
            auth: truncate(meta.auth ?? '', 200) || undefined,
            referer: truncate(request.headers.get('referer') ?? '', 2000) || undefined,
            userAgent: truncate(request.headers.get('user-agent') ?? '', 2000) || undefined,
            error: meta.error,
          }
          logRequest(entry, logConfig.logFormat)
          const logs = runtime?.services.requestLogs ?? control.requestLogs
          logs.record(entry)
        }
        // Observability is independent of request logging. Forwarded writes are
        // recorded by the writer that actually handled them.
        if (meta.observation) {
          meta.observation.end({
            method: request.method,
            path: url.pathname,
            route: meta.route,
            status,
            project: truncate(meta.project ?? apiHeader(request, 'project') ?? url.searchParams.get('project') ?? '', 200) || undefined,
            auth: truncate(meta.auth ?? '', 200) || undefined,
            ip: logConfig.logIp ? ip || undefined : undefined,
            userAgent: truncate(request.headers.get('user-agent') ?? '', 2000) || undefined,
            requestBytes: Number(request.headers.get('content-length') ?? 0) || 0,
            responseBytes,
            error: meta.error,
            id,
            forwarded: meta.forwarded,
            telemetry: runtime?.services.telemetry ?? control.telemetry,
          })
        }
      }
    }

  return {
    hub,
    /** The control store's facade; per-project requests use their own runtime. */
    observability: control.observability,
    fetch,
    fetchLocal: (request: Request, server?: Server<SocketData>) => fetch(request, server, false),
    websocket: {
      // Realtime messages are JSON; compressing them saves bandwidth for clients that support it.
      perMessageDeflate: control.config.websocketCompression,
      // A subscribe message with many channels is still one JSON frame. Keep it
      // bounded so a client cannot force a huge allocation per message.
      maxPayloadLength: 1024 * 1024,
      // Slow consumers are disconnected instead of buffering without limit.
      // send() returns -1 when it queues and 0 when it drops.
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      open: (ws: Socket) => projects.get(ws.data.projectId)?.services.realtime.open(ws),
      message: (ws: Socket, message: string | Buffer) => projects.get(ws.data.projectId)?.services.realtime.message(ws, message),
      close: (ws: Socket) => projects.get(ws.data.projectId)?.services.realtime.close(ws),
    },
  }
}

/** Route groups added by later modules (storage, functions). */
export const extraRoutes: ((router: Router<AppContext>) => void)[] = []
