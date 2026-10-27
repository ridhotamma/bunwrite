import { join } from 'node:path'
import type { Server } from 'bun'

import { resolveCaller, type Caller } from './auth/caller'
import { accountRoutes, userRoutes } from './auth/routes'
import { createConsole } from './console/app'
import { apiHomePage, notFoundPage, wantsHtml } from './console/public'
import { documentRoutes, transactionRoutes } from './documents/routes'
import { AppwriteError, err } from './lib/errors'
import { errorResponse, json, readParams } from './lib/http'
import { clientIp, logRequest, requestId, truncate } from './lib/log'
import { originAllowed } from './lib/origins'
import { Router } from './lib/router'
import type { Socket, SocketData } from './realtime/hub'
import { schemaRoutes } from './schema/routes'
import type { Services } from './services'
import { functionRoutes } from './functions/routes'
import { storageRoutes } from './storage/routes'
import { teamRoutes } from './teams/routes'

export { createServices, type Services } from './services'

export interface AppContext extends Services {
  caller: Caller
}

interface RequestMeta {
  auth?: string
  error?: string
}

const authLabel = (caller: Caller) => (caller.kind === 'user' ? `user:${caller.user?.id ?? ''}` : caller.kind)

const FAVICON = join(import.meta.dir, '..', 'public', 'favicon.ico')

const ALLOW_HEADERS =
  'Accept, Origin, Cookie, Set-Cookie, Content-Type, Content-Range, X-Appwrite-Project, X-Appwrite-Key, X-Appwrite-Locale, X-Appwrite-Mode, X-Appwrite-JWT, X-Appwrite-Response-Format, X-Appwrite-Timeout, X-Appwrite-ID, X-Appwrite-Timestamp, X-Appwrite-Session, X-SDK-Version, X-SDK-Name, X-SDK-Language, X-SDK-Platform, X-SDK-GraphQL, Range, Cache-Control, Expires, Pragma, X-Fallback-Cookies, X-Requested-With, X-Forwarded-For, X-Forwarded-User-Agent'

/** Routes reachable without an X-Appwrite-Project header. */
const PROJECTLESS = [/^\/health/, /^\/version$/, /^\/account\/sessions\/oauth2\/callback\//, /^\/functions\/[^/]+\/http(\/|$)/]

export { originAllowed }

export function createApp(services: Services) {
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
  for (const extend of extraRoutes) extend(router)

  const cors = (request: Request): Record<string, string> => {
    const origin = request.headers.get('origin')
    if (!origin || !originAllowed(origin, services.config.allowedOrigins)) return {}
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
      'access-control-allow-headers': ALLOW_HEADERS,
      'access-control-expose-headers': 'X-Appwrite-Session, X-Fallback-Cookies, X-Request-Id',
      'access-control-max-age': '86400',
      vary: 'Origin',
    }
  }

  const consoleApp = createConsole(services)

  const projectOf = (request: Request, url: URL) => request.headers.get('x-appwrite-project') ?? url.searchParams.get('project')

  async function handle(request: Request, server: Server<SocketData> | undefined, meta: RequestMeta): Promise<Response | undefined> {
    const url = new URL(request.url)
    const pathname = url.pathname.replace(/^\/v1(?=\/|$)/, '') || '/'

    if (pathname === '/realtime') {
      if (projectOf(request, url) !== services.config.projectId) throw err('project_not_found')
      const caller = await resolveCaller(services.db, services.config, request)
      meta.auth = authLabel(caller)
      if (server?.upgrade(request, { data: { caller, subscriptions: new Map() } })) return undefined
      throw err('general_argument_invalid', 'Realtime needs a WebSocket upgrade.')
    }

    const match = router.match(request.method, pathname)
    if (request.method === 'OPTIONS' && !match?.raw) return new Response(null, { status: 204 })
    if (!match) throw err('general_route_not_found')

    if (!PROJECTLESS.some((p) => p.test(pathname)) && projectOf(request, url) !== services.config.projectId) {
      throw err('project_not_found')
    }

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
    if (url.pathname === '/favicon.ico' && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(Bun.file(FAVICON), { headers: { 'content-type': 'image/x-icon', 'cache-control': 'public, max-age=604800' } })
    }
    const consoleResponse = await consoleApp.handle(request, server)
    if (consoleResponse) return consoleResponse
    const pathname = url.pathname
    // The bare host is for people: send them to the console (or say the API is up).
    if (pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      return services.config.consoleEnabled ? new Response(null, { status: 302, headers: { location: '/console' } }) : apiHomePage()
    }
    let response: Response | undefined
    try {
      response = await handle(request, server, meta)
      if (!response) return undefined
    } catch (error) {
      meta.error = truncate(error instanceof Error ? error.message : String(error), 2000)
      // A browser typing a wrong address gets a page; SDKs and /v1 keep Appwrite's JSON error.
      if (error instanceof AppwriteError && error.type === 'general_route_not_found' && wantsHtml(request, pathname)) {
        return notFoundPage(services.config.consoleEnabled)
      }
      services.store.drainEvents()
      response = errorResponse(error)
      if (!(error instanceof AppwriteError)) console.error(error)
    }
    for (const [k, v] of Object.entries(cors(request))) response.headers.set(k, v)
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
        const response = await respond(request, server, meta)
        if (!response) {
          status = 101
          return undefined
        }
        status = response.status
        responseBytes = Number(response.headers.get('content-length') ?? 0) || 0
        response.headers.set('x-request-id', id)
        return response
      } finally {
        const skip = url.pathname === '/favicon.ico' || url.pathname.startsWith('/console/assets/') || (logsUi && status < 400)
        if (services.config.logRequests && !skip) {
          const entry = {
            id,
            method: request.method,
            path: truncate(url.pathname, 3000),
            status,
            durationMs: performance.now() - started,
            requestBytes: Number(request.headers.get('content-length') ?? 0) || 0,
            responseBytes,
            ip: services.config.logIp ? clientIp(request, server) : undefined,
            project: truncate(request.headers.get('x-appwrite-project') ?? url.searchParams.get('project') ?? '', 200) || undefined,
            auth: truncate(meta.auth ?? '', 200) || undefined,
            referer: truncate(request.headers.get('referer') ?? '', 2000) || undefined,
            userAgent: truncate(request.headers.get('user-agent') ?? '', 2000) || undefined,
            error: meta.error,
          }
          logRequest(entry, services.config.logFormat)
          services.requestLogs.record(entry)
        }
      }
    },
    websocket: {
      open: (ws: Socket) => services.realtime.open(ws),
      message: (ws: Socket, message: string | Buffer) => services.realtime.message(ws, message),
      close: (ws: Socket) => services.realtime.close(ws),
    },
  }
}

/** Route groups added by later modules (storage, functions). */
export const extraRoutes: ((router: Router<AppContext>) => void)[] = []
