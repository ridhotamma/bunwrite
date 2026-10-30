import type { Server } from 'bun'

import { keyCaller, resolveCaller, type Caller } from './auth/caller'
import { BRAND_FILES } from './console/assets'
import { accountRoutes, userRoutes } from './auth/routes'
import { createConsole } from './console/app'
import { apiHomePage, notFoundPage, wantsHtml } from './console/public'
import { documentRoutes, transactionRoutes } from './documents/routes'
import { apiHeader, assertCompatHeaders, corsHeaderNames } from './lib/compat'
import { addVary, compressResponse } from './lib/compress'
import { isStreaming } from './lib/streaming'
import { BunwriteError, err } from './lib/errors'
import { errorResponse, json, readParams } from './lib/http'
import { parseTrustedProxies, rememberClientIp } from './lib/client-ip'
import { logRequest, requestId, truncate } from './lib/log'
import { originAllowed } from './lib/origins'
import { Router } from './lib/router'
import type { Socket, SocketData } from './realtime/hub'
import { schemaRoutes } from './schema/routes'
import type { Services } from './services'
import { functionHttpResponse } from './functions/http'
import { functionRoutes } from './functions/routes'
import { proxyRoutes } from './proxy/routes'
import { singleProjectResolver, type ProjectResolver, type ProjectRuntime } from './projects/types'
import { renderRoutes } from './render/routes'
import { serveSite } from './sites/serve'
import { siteRoutes } from './sites/routes'
import { storageRoutes } from './storage/routes'
import { teamRoutes } from './teams/routes'
import { topicRoutes } from './messaging/topics'
import { queueRoutes } from './queue/routes'
import { CONSOLE_PROJECT, createConsoleApi } from './platform/console'
import { projectRoutes } from './platform/project'
import { webhookRoutes } from './webhooks/routes'
import { VcsHub } from './vcs/hub'
import { vcsRoutes } from './vcs/routes'

export { createServices, type Services } from './services'

export interface AppContext extends Services {
  caller: Caller
  /** Git deployments for the whole server (GitHub App, webhooks, repository links). */
  hub: VcsHub
}

interface RequestMeta {
  auth?: string
  error?: string
  project?: string
}

const authLabel = (caller: Caller) => (caller.kind === 'user' ? `user:${caller.user?.id ?? ''}` : caller.kind)

// htmx sends its own headers on every request; a browser preflight rejects them
// unless they are listed here, so cross-origin htmx clients need these too.
const HTMX_REQUEST_HEADERS =
  'HX-Request, HX-Current-URL, HX-Trigger, HX-Trigger-Name, HX-Target, HX-Prompt, HX-Boosted, HX-History-Restore-Request'

const HTMX_RESPONSE_HEADERS =
  'HX-Location, HX-Push-Url, HX-Redirect, HX-Refresh, HX-Replace-Url, HX-Reswap, HX-Retarget, HX-Reselect, HX-Trigger, HX-Trigger-After-Swap, HX-Trigger-After-Settle'

/** Bunwrite's and Appwrite's request headers, by short name (see lib/compat). */
const API_HEADERS = corsHeaderNames(['Project', 'Key', 'Locale', 'Mode', 'JWT', 'Response-Format', 'Timeout', 'ID', 'Timestamp', 'Session', 'Organization'])

const ALLOW_HEADERS = `Accept, Origin, Cookie, Set-Cookie, Content-Type, Content-Range, ${API_HEADERS}, X-SDK-Version, X-SDK-Name, X-SDK-Language, X-SDK-Platform, X-SDK-GraphQL, Range, Cache-Control, Expires, Pragma, X-Fallback-Cookies, X-Requested-With, X-Forwarded-For, X-Forwarded-User-Agent, ${HTMX_REQUEST_HEADERS}`

const EXPOSE_HEADERS = `X-Bunwrite-Session, X-Appwrite-Session, X-Fallback-Cookies, X-Request-Id, ${HTMX_RESPONSE_HEADERS}`

export { originAllowed }

/**
 * Reload what another process changed. The version read is throttled by
 * CACHE_CHECK_MS, so most requests only compare a timestamp.
 */
function syncServices(services: Services): void {
  if (services.config.workers <= 1) return
  const changed = services.versions.poll()
  if (changed.schema) services.registry.reload()
  if (changed.settings) {
    services.settings.refreshAll()
    services.access.reload()
  }
  if (changed.catalog) {
    services.proxy.reload()
    services.sites.reload()
  }
}

export function createApp(source: Services | ProjectResolver) {
  const projects: ProjectResolver = 'defaultProject' in source ? source : singleProjectResolver(source)
  const control = projects.control
  const trustedProxies = parseTrustedProxies(control.config.trustedProxies)
  const hub = new VcsHub(projects)
  const router = new Router<AppContext>()
  router.get('/health', () => json({ name: 'http', ping: 0, status: 'pass' }))
  router.get('/health/version', () => json({ version: '1.8.0' }))
  documentRoutes(router)
  transactionRoutes(router)
  schemaRoutes(router)
  accountRoutes(router)
  userRoutes(router)
  teamRoutes(router)
  storageRoutes(router)
  functionRoutes(router)
  siteRoutes(router)
  vcsRoutes(router)
  proxyRoutes(router)
  renderRoutes(router)
  projectRoutes(router)
  webhookRoutes(router)
  topicRoutes(router)
  queueRoutes(router)
  for (const extend of extraRoutes) extend(router)

  const cors = (request: Request, allowedOrigins: string[]): Record<string, string> => {
    const origin = request.headers.get('origin')
    // Sites hosted here may call the API from the browser without being listed.
    if (!origin || !(originAllowed(origin, allowedOrigins) || siteOfOrigin(origin))) return {}
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
  const corsResponse = (request: Request, response: Response, allowedOrigins: string[]): Response => {
    for (const [k, v] of Object.entries(cors(request, allowedOrigins))) {
      if (k === 'vary') addVary(response.headers, v)
      else response.headers.set(k, v)
    }
    return response
  }

  const siteOfOrigin = (origin: string) => {
    try {
      const host = new URL(origin).host
      return projects.findSite(host) ?? projects.findFunctionByHost(host)
    } catch {
      return null
    }
  }

  /** A site's own domain: `<siteId>.<SITES_DOMAIN>` or one of its custom domains. */
  function siteFor(request: Request) {
    const host = request.headers.get('host')
    const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    return (host ? projects.findSite(host) : null) ?? (forwarded ? projects.findSite(forwarded) : null)
  }

  /** A function's own domain: `<functionId>.<FUNCTIONS_DOMAIN>` or one of its custom domains. */
  function functionFor(request: Request) {
    const host = request.headers.get('host')
    const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    return (host ? projects.findFunctionByHost(host) : null) ?? (forwarded ? projects.findFunctionByHost(forwarded) : null)
  }

  const consoleApp = createConsole(projects, hub)
  const consoleApi = createConsoleApi(projects)

  /** API keys first; then a console admin's CLI session in admin mode; then the request's own session or JWT. */
  async function callerOf(services: Services, request: Request, meta: RequestMeta): Promise<Caller> {
    if (!apiHeader(request, 'key')) {
      const admin = consoleApi.adminOf(request)
      if (admin) {
        meta.auth = `console:${admin.email}`
        return keyCaller()
      }
    }
    const caller = await resolveCaller(services.db, services.config, request)
    meta.auth = authLabel(caller)
    return caller
  }

  const projectOf = (request: Request, url: URL) => apiHeader(request, 'project') ?? url.searchParams.get('project')

  /** Which project's services handle this request. */
  function runtimeFor(request: Request, url: URL): ProjectRuntime {
    const pathname = url.pathname.replace(/^\/v1(?=\/|$)/, '') || '/'
    // Browser preflights carry no custom project header.
    if (request.method === 'OPTIONS') return projects.defaultProject()
    if (pathname === '/health' || pathname.startsWith('/health/')) {
      // Health answers without a project; when one is named, its key is the one
      // to validate, so `GET /health` can prove a second project's credentials.
      // The Appwrite CLI sends its pseudo-project `console` while probing.
      const projectId = projectOf(request, url)
      if (!projectId || projectId === CONSOLE_PROJECT) return projects.defaultProject()
      const project = projects.get(projectId)
      if (!project) throw err('project_not_found')
      return project
    }
    // `appwrite push functions` reads this as the "console" project.
    if (pathname === '/console/variables') return projects.defaultProject()

    // OAuth callbacks carry the project ID in the path.
    const oauth = /^\/account\/sessions\/oauth2\/callback\/[^/]+\/([^/]+)$/.exec(pathname)
    if (oauth) {
      const project = projects.get(decodeURIComponent(oauth[1]!))
      if (project) return project
      throw err('project_not_found')
    }

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
      const owner = projects.findFunction(decodeURIComponent(fn[1]!))
      if (owner) return owner
      throw err('project_not_found')
    }

    const projectId = projectOf(request, url)
    if (!projectId) {
      // Let unknown paths fall through to the HTML 404 page; known API routes
      // still need a project header.
      if (!router.match(request.method, pathname)) return projects.defaultProject()
      throw err('project_not_found')
    }
    const project = projects.get(projectId)
    if (!project) throw err('project_not_found')
    return project
  }

  async function handle(
    request: Request,
    server: Server<SocketData> | undefined,
    meta: RequestMeta,
    runtime: ProjectRuntime,
  ): Promise<Response | undefined> {
    const url = new URL(request.url)
    const pathname = url.pathname.replace(/^\/v1(?=\/|$)/, '') || '/'
    const services = runtime.services
    meta.project = runtime.info.id
    syncServices(services)

    if (pathname === '/realtime') {
      const caller = await callerOf(services, request, meta)
      if (!caller.privileged) services.access.assertProtocol('websocket')
      if (server?.upgrade(request, { data: { caller, subscriptions: new Map(), projectId: runtime.info.id } })) return undefined
      throw err('general_argument_invalid', 'Realtime needs a WebSocket upgrade.')
    }

    const match = router.match(request.method, pathname)
    if (request.method === 'OPTIONS' && !match?.raw) return new Response(null, { status: 204 })
    if (!match) throw err('general_route_not_found')

    const params = match.raw ? {} : await readParams(request, url)
    const caller = await callerOf(services, request, meta)
    // Like Appwrite, switched-off services and protocols stop clients but not API keys or console admins.
    // A function's own HTTP endpoint stands in for its public domain, so it is not part of the Functions API.
    if (!caller.privileged && !/^\/functions\/[^/]+\/http(?:\/|$)/.test(pathname)) {
      services.access.assertProtocol('rest')
      services.access.assertService(pathname)
    }
    services.store.drainEvents()
    const response = await match.handler({ request, url, params, path: match.path, ctx: { ...services, caller, hub } })
    const events = services.store.drainEvents()
    services.realtime.publish(events)
    services.webhooks.dispatch(events, caller)
    return response
  }

  async function respond(request: Request, server: Server<SocketData> | undefined, meta: RequestMeta): Promise<Response | undefined> {
    const url = new URL(request.url)
    try {
      assertCompatHeaders(request)
    } catch (error) {
      meta.error = truncate(error instanceof Error ? error.message : String(error), 2000)
      return corsResponse(request, errorResponse(error), control.config.allowedOrigins)
    }
    const hosted = siteFor(request)
    if (hosted) {
      meta.project = hosted.project.info.id
      meta.auth = `site:${hosted.site.id}`
      syncServices(hosted.project.services)
      return serveSite(hosted.project.services, hosted.site, request, hosted.deploymentId)
    }
    const hostedFunction = functionFor(request)
    if (hostedFunction) {
      meta.project = hostedFunction.project.info.id
      meta.auth = `function:${hostedFunction.fn.id}`
      try {
        syncServices(hostedFunction.project.services)
        const caller = await resolveCaller(hostedFunction.project.services.db, hostedFunction.project.services.config, request)
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
      return hub.webhook(request)
    }
    if (url.pathname === '/v1/vcs/github/callback' && request.method === 'GET') return hub.completeInstall(url)
    if (url.pathname === '/v1/vcs/github/manifest' && request.method === 'GET') return hub.completeManifest(url)
    if ((url.pathname === '/.well-known/bunwrite/site-domain' || url.pathname === '/.well-known/bunwrite/host') && request.method === 'GET') {
      const domain = url.searchParams.get('domain') ?? ''
      return new Response(null, { status: domain && (projects.findSite(domain) || projects.findFunctionByHost(domain)) ? 200 : 404 })
    }
    const brand = BRAND_FILES[url.pathname]
    if (brand && (request.method === 'GET' || request.method === 'HEAD')) {
      const file = Bun.file(brand.path)
      return new Response(file, { headers: { 'content-type': brand.type, 'content-length': String(file.size), 'cache-control': 'public, max-age=604800' } })
    }
    const consoleResponse = await consoleApp.handle(request, server)
    if (consoleResponse) return consoleResponse
    const pathname = url.pathname
    // The bare host is for people: send them to the console (or say the API is up).
    if (pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      return control.config.consoleEnabled ? new Response(null, { status: 302, headers: { location: '/console' } }) : apiHomePage(control.config.projectName)
    }
    let runtime = projects.defaultProject()
    let response: Response | undefined
    try {
      // The Appwrite CLI's console calls (login, organizations, projects).
      if (projectOf(request, url) === CONSOLE_PROJECT && request.method !== 'OPTIONS') {
        response = await consoleApi.handle(request, pathname.replace(/^\/v1(?=\/|$)/, '') || '/')
        if (response) meta.auth ??= 'console'
      }
      if (!response) runtime = runtimeFor(request, url)
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
    return corsResponse(request, response, runtime.services.config.allowedOrigins)
  }

  return {
    hub,
    async fetch(request: Request, server?: Server<SocketData>): Promise<Response | undefined> {
      // Another worker may have changed projects, schema or settings.
      projects.sync?.()
      syncServices(control)
      const started = performance.now()
      const url = new URL(request.url)
      // The console resolves its own project, so refresh every runtime it may show.
      if (url.pathname.startsWith('/console')) for (const runtime of projects.list()) syncServices(runtime.services)
      const id = requestId(request)
      const ip = rememberClientIp(request, server?.requestIP(request)?.address, trustedProxies)
      const meta: RequestMeta = { auth: url.pathname.startsWith('/console') ? 'console' : undefined }
      const logsUi = url.pathname === '/console/logs' || url.pathname.startsWith('/console/logs/')
      let status = 500
      let responseBytes = 0
      try {
        const raw = await respond(request, server, meta)
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
        // HEAD runs the GET handler so headers and cache validation match, then drops the body.
        return request.method === 'HEAD' ? new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers }) : response
      } finally {
        const skip = url.pathname in BRAND_FILES || url.pathname.startsWith('/console/assets/') || (logsUi && status < 400)
        const runtime = meta.project ? projects.get(meta.project) : undefined
        const logConfig = runtime?.services.config ?? control.config
        // Sampling keeps the hot path cheap while errors are always recorded.
        const sampling = logConfig.logSampleRate < 1 && status < 400
        if (logConfig.logRequests && !skip && (!sampling || Math.random() < logConfig.logSampleRate)) {
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
      }
    },
    websocket: {
      // Realtime messages are JSON; compressing them saves bandwidth for clients that support it.
      perMessageDeflate: control.config.compression,
      open: (ws: Socket) => projects.get(ws.data.projectId)?.services.realtime.open(ws),
      message: (ws: Socket, message: string | Buffer) => projects.get(ws.data.projectId)?.services.realtime.message(ws, message),
      close: (ws: Socket) => projects.get(ws.data.projectId)?.services.realtime.close(ws),
    },
  }
}

/** Route groups added by later modules (storage, functions). */
export const extraRoutes: ((router: Router<AppContext>) => void)[] = []
