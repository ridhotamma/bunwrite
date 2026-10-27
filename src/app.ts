import type { Server } from 'bun'

import { resolveCaller, type Caller } from './auth/caller'
import { OAuthService } from './auth/oauth'
import { accountRoutes, userRoutes } from './auth/routes'
import { AuthService } from './auth/service'
import type { Config } from './config'
import type { Db } from './db/connection'
import { documentRoutes, transactionRoutes } from './documents/routes'
import { DocumentStore } from './documents/store'
import { AppwriteError, err } from './lib/errors'
import { errorResponse, json, readParams } from './lib/http'
import { originAllowed } from './lib/origins'
import { Router } from './lib/router'
import { DisabledMailer, SmtpMailer, type Mailer } from './mail/mailer'
import { RealtimeHub, type Socket, type SocketData } from './realtime/hub'
import { Registry } from './schema/registry'
import { teamRoutes } from './teams/routes'
import { TeamService } from './teams/service'
import { TransactionService } from './transactions/service'
import { FunctionService, readEnvFile } from './functions/service'
import { functionRoutes } from './functions/routes'
import { schemaRoutes } from './schema/routes'
import { StorageService } from './storage/service'
import { storageRoutes } from './storage/routes'
import { SettingsService } from './settings/service'
import { randomSecret } from './lib/ids'
import { createConsole } from './console/app'

export interface Services {
  config: Config
  db: Db
  registry: Registry
  store: DocumentStore
  transactions: TransactionService
  auth: AuthService
  teams: TeamService
  oauth: OAuthService
  mailer: Mailer
  realtime: RealtimeHub
  storage: StorageService
  functions: FunctionService
  settings: SettingsService
}

export interface AppContext extends Services {
  caller: Caller
}

const ALLOW_HEADERS =
  'Accept, Origin, Cookie, Set-Cookie, Content-Type, Content-Range, X-Appwrite-Project, X-Appwrite-Key, X-Appwrite-Locale, X-Appwrite-Mode, X-Appwrite-JWT, X-Appwrite-Response-Format, X-Appwrite-Timeout, X-Appwrite-ID, X-Appwrite-Timestamp, X-Appwrite-Session, X-SDK-Version, X-SDK-Name, X-SDK-Language, X-SDK-Platform, X-SDK-GraphQL, Range, Cache-Control, Expires, Pragma, X-Fallback-Cookies, X-Requested-With, X-Forwarded-For, X-Forwarded-User-Agent'

/** Routes reachable without an X-Appwrite-Project header. */
const PROJECTLESS = [/^\/health/, /^\/version$/, /^\/account\/sessions\/oauth2\/callback\//, /^\/functions\/[^/]+\/http(\/|$)/]

export { originAllowed }

export function createServices(config: Config, db: Db, overrides: Partial<Services> = {}): Services {
  config.internalKey ??= `internal_${randomSecret(32)}`
  const registry = new Registry(db)
  const store = new DocumentStore(db)
  const transactions = new TransactionService(db, registry, store)
  const auth = new AuthService(db, config, store)
  const teams = new TeamService(db, store, auth)
  const oauth = new OAuthService(db, config, auth)
  const makeMailer = () => (config.smtp ? new SmtpMailer(config.smtp) : new DisabledMailer())
  const realtime = new RealtimeHub(db)
  const storage = new StorageService(db, config, store)
  const functions = new FunctionService(db, config, store, {
    functionEnv: readEnvFile(config.functionsEnvFile),
    skipSchedules: config.skipSchedules,
  })
  const services = { config, db, registry, store, transactions, auth, teams, oauth, mailer: overrides.mailer ?? new DisabledMailer(), realtime, storage, functions } as Services
  // Settings saved in the console apply over env; a new SMTP setting rebuilds the mailer.
  services.settings = new SettingsService(db, config, (key) => {
    if (key === 'smtp' && !overrides.mailer) services.mailer = makeMailer()
  })
  if (!overrides.mailer) services.mailer = makeMailer()
  return Object.assign(services, overrides)
}

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
      'access-control-expose-headers': 'X-Appwrite-Session, X-Fallback-Cookies',
      'access-control-max-age': '86400',
      vary: 'Origin',
    }
  }

  const consoleApp = createConsole(services)

  const projectOf = (request: Request, url: URL) => request.headers.get('x-appwrite-project') ?? url.searchParams.get('project')

  async function handle(request: Request, server?: Server<SocketData>): Promise<Response | undefined> {
    const url = new URL(request.url)
    const pathname = url.pathname.replace(/^\/v1(?=\/|$)/, '') || '/'

    if (pathname === '/realtime') {
      if (projectOf(request, url) !== services.config.projectId) throw err('project_not_found')
      const caller = await resolveCaller(services.db, services.config, request)
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
    services.store.drainEvents()
    const response = await match.handler({ request, url, params, path: match.path, ctx: { ...services, caller } })
    services.realtime.publish(services.store.drainEvents())
    return response
  }

  return {
    async fetch(request: Request, server?: Server<SocketData>): Promise<Response | undefined> {
      const consoleResponse = await consoleApp.handle(request, server)
      if (consoleResponse) return consoleResponse
      let response: Response | undefined
      try {
        response = await handle(request, server)
        if (!response) return undefined
      } catch (error) {
        services.store.drainEvents()
        response = errorResponse(error)
        if (!(error instanceof AppwriteError)) console.error(error)
      }
      for (const [k, v] of Object.entries(cors(request))) response.headers.set(k, v)
      return response
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
