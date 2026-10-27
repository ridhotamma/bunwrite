import type { Server } from 'bun'

import { resolveCaller, type Caller } from './auth/caller'
import { BRAND_FILES } from './console/assets'
import { accountRoutes, userRoutes } from './auth/routes'
import { createConsole } from './console/app'
import { apiHomePage, notFoundPage, wantsHtml } from './console/public'
import { documentRoutes, transactionRoutes } from './documents/routes'
import { addVary, compressResponse } from './lib/compress'
import { AppwriteError, err } from './lib/errors'
import { errorResponse, json, readParams } from './lib/http'
import { clientIp, logRequest, requestId, truncate } from './lib/log'
import { originAllowed } from './lib/origins'
import { Router } from './lib/router'
import type { Socket, SocketData } from './realtime/hub'
import { schemaRoutes } from './schema/routes'
import type { Services } from './services'
import { functionRoutes } from './functions/routes'
import { singleProjectResolver, type ProjectResolver, type ProjectRuntime } from './projects/types'
import { renderRoutes } from './render/routes'
import { storageRoutes } from './storage/routes'
import { teamRoutes } from './teams/routes'

export { createServices, type Services } from './services'

export interface AppContext extends Services {
  caller: Caller
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

const ALLOW_HEADERS = `Accept, Origin, Cookie, Set-Cookie, Content-Type, Content-Range, X-Appwrite-Project, X-Appwrite-Key, X-Appwrite-Locale, X-Appwrite-Mode, X-Appwrite-JWT, X-Appwrite-Response-Format, X-Appwrite-Timeout, X-Appwrite-ID, X-Appwrite-Timestamp, X-Appwrite-Session, X-SDK-Version, X-SDK-Name, X-SDK-Language, X-SDK-Platform, X-SDK-GraphQL, Range, Cache-Control, Expires, Pragma, X-Fallback-Cookies, X-Requested-With, X-Forwarded-For, X-Forwarded-User-Agent, ${HTMX_REQUEST_HEADERS}`

const EXPOSE_HEADERS = `X-Appwrite-Session, X-Fallback-Cookies, X-Request-Id, ${HTMX_RESPONSE_HEADERS}`

export { originAllowed }

export function createApp(source: Services | ProjectResolver) {
  const projects: ProjectResolver = 'defaultProject' in source ? source : singleProjectResolver(source)
  const control = projects.control
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
  renderRoutes(router)
  for (const extend of extraRoutes) extend(router)

  const cors = (request: Request, allowedOrigins: string[]): Record<string, string> => {
    const origin = request.headers.get('origin')
    if (!origin || !originAllowed(origin, allowedOrigins)) return {}
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

  const consoleApp = createConsole(projects)

  const projectOf = (request: Request, url: URL) => request.headers.get('x-appwrite-project') ?? url.searchParams.get('project')

  /** Which project's services handle this request. */
  function runtimeFor(request: Request, url: URL): ProjectRuntime {
    const pathname = url.pathname.replace(/^\/v1(?=\/|$)/, '') || '/'
    // Browser preflights carry no custom project header.
    if (request.method === 'OPTIONS') return projects.defaultProject()
    if (pathname === '/health' || pathname.startsWith('/health/')) return projects.defaultProject()
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

    if (pathname === '/realtime') {
      const caller = await resolveCaller(services.db, services.config, request)
      meta.auth = authLabel(caller)
      if (server?.upgrade(request, { data: { caller, subscriptions: new Map(), projectId: runtime.info.id } })) return undefined
      throw err('general_argument_invalid', 'Realtime needs a WebSocket upgrade.')
    }

    const match = router.match(request.method, pathname)
    if (request.method === 'OPTIONS' && !match?.raw) return new Response(null, { status: 204 })
    if (!match) throw err('general_route_not_found')

    const params = match.raw ? {} : await readParams(request, url)
    const caller = await resolveCaller(services.db, services.config, request)
    meta.auth = authLabel(caller)
    services.store.drainEvents()
    const response = await match.handler({ request, url, params, path: match.path, ctx: { ...services, caller } })
    services.realtime.publish(services.store.drainEvents())
    return response
  }

  async function respond(request: Request, server: Server<SocketData> | undefined, meta: RequestMeta): Promise<Response | undefined> {
    const url = new URL(request.url)
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
      runtime = runtimeFor(request, url)
      response = await handle(request, server, meta, runtime)
      if (!response) return undefined
    } catch (error) {
      meta.error = truncate(error instanceof Error ? error.message : String(error), 2000)
      // A browser typing a wrong address gets a page; SDKs and /v1 keep Appwrite's JSON error.
      if (error instanceof AppwriteError && error.type === 'general_route_not_found' && wantsHtml(request, pathname)) {
        return notFoundPage(runtime.services.config.consoleEnabled, runtime.services.config.projectName)
      }
      runtime.services.store.drainEvents()
      response = errorResponse(error)
      if (!(error instanceof AppwriteError)) console.error(error)
    }
    for (const [k, v] of Object.entries(cors(request, runtime.services.config.allowedOrigins))) {
      // Keep a handler's Vary (for example Accept-Encoding) and add Origin beside it.
      if (k === 'vary') addVary(response.headers, v)
      else response.headers.set(k, v)
    }
    return response
  }

  return {
    async fetch(request: Request, server?: Server<SocketData>): Promise<Response | undefined> {
      const started = performance.now()
      const url = new URL(request.url)
      const id = requestId(request)
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
        if (logConfig.logRequests && !skip) {
          const entry = {
            id,
            method: request.method,
            path: truncate(url.pathname, 3000),
            status,
            durationMs: performance.now() - started,
            requestBytes: Number(request.headers.get('content-length') ?? 0) || 0,
            responseBytes,
            ip: logConfig.logIp ? clientIp(request, server) : undefined,
            project: truncate(meta.project ?? request.headers.get('x-appwrite-project') ?? url.searchParams.get('project') ?? '', 200) || undefined,
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
