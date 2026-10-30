/**
 * The console API the Bunwrite CLI and the Appwrite CLI use, served for
 * requests whose project header (X-Bunwrite-Project or X-Appwrite-Project) is
 * `console`:
 *
 * - `login`: POST /account/sessions/email signs a console admin in and sets the
 *   console session cookie (`bw_session_console`, or `a_session_console` for a
 *   request made with Appwrite's headers); GET /account and DELETE /account/sessions/:id back
 *   `whoami` and `logout`.
 * - `init project`, `pull/push settings`: the organizations an admin belongs
 *   to (GET /teams) and their projects (/organization/projects,
 *   GET /projects/:id).
 *
 * With that cookie and the mode header (X-Bunwrite-Mode or X-Appwrite-Mode)
 * set to `admin`, a project request is made as the admin and acts with an API
 * key's rights (see `adminOf`). Admins are the console's own accounts
 * (`bun run console:admin`), not project users.
 */
import { parseCookies } from '~/auth/caller'
import { requestInfo } from '~/auth/service'
import { ConsoleAuth, type Admin } from '~/console/auth'
import { apiHeader, cliName, configFileName, sessionCookieName, sessionFromCookies } from '~/lib/compat'
import { addSeconds } from '~/lib/datetime'
import { BunwriteError, err } from '~/lib/errors'
import { json, list, noContent, readParams, str, type Params } from '~/lib/http'
import { RateLimiter } from '~/lib/limits'
import { page } from '~/lib/paging'
import { Router } from '~/lib/router'
import { OrganizationService } from '~/organizations/service'
import type { ProjectResolver, ProjectRuntime } from '~/projects/types'
import { projectModel } from './project'

export const CONSOLE_PROJECT = 'console'
/** Same lifetime as a console sign-in in the browser. */
const SESSION_TTL = 7 * 24 * 3600

interface ConsoleApiContext {
  request: Request
  params: Params
  path: Record<string, string>
  projects: ProjectResolver
  auth: ConsoleAuth
  organizations: OrganizationService
  session: ReturnType<ConsoleAuth['session']>
  secret: string | null
}

function sessionSecret(request: Request): string | null {
  return sessionFromCookies(parseCookies(request.headers.get('cookie') ?? ''), request.headers.get('x-fallback-cookies'), CONSOLE_PROJECT)
}

function signedIn(ctx: ConsoleApiContext): NonNullable<ConsoleApiContext['session']> {
  // The CLI tells "not signed in" apart from other errors by `role: guests`.
  if (!ctx.session) throw err('general_unauthorized_scope', 'User (role: guests) missing scopes (["account"])')
  return ctx.session
}

const adminId = (admin: Admin) => `console-${admin.seq}`

function accountOf(admin: Admin & { created_at: string }, orgName: string) {
  return {
    $id: adminId(admin),
    $createdAt: admin.created_at,
    $updatedAt: admin.created_at,
    name: admin.email.split('@')[0],
    registration: admin.created_at,
    status: true,
    labels: [],
    passwordUpdate: admin.created_at,
    email: admin.email,
    phone: '',
    emailVerification: true,
    phoneVerification: false,
    mfa: false,
    prefs: { organization: orgName },
    targets: [],
    accessedAt: admin.created_at,
  }
}

function sessionOf(session: NonNullable<ConsoleApiContext['session']>, request: Request) {
  return {
    $id: String(session.seq),
    $createdAt: session.createdAt,
    $updatedAt: session.createdAt,
    userId: adminId(session.admin),
    expire: session.expire,
    provider: 'email',
    providerUid: session.admin.email,
    providerAccessToken: '',
    providerAccessTokenExpiry: '',
    providerRefreshToken: '',
    ip: requestInfo(request).ip,
    osCode: '',
    osName: '',
    osVersion: '',
    clientType: '',
    clientCode: '',
    clientName: '',
    clientVersion: '',
    clientEngine: '',
    clientEngineVersion: '',
    deviceName: '',
    deviceBrand: '',
    deviceModel: '',
    countryCode: '--',
    countryName: 'Unknown',
    current: true,
    factors: ['password'],
    secret: '',
    mfaUpdatedAt: '',
  }
}

/** The organization a request names (X-Bunwrite-Organization or X-Appwrite-Organization), else the instance's own. */
function orgOf(ctx: ConsoleApiContext): string {
  const own = ctx.projects.control.config.orgId
  const named = apiHeader(ctx.request, 'organization')
  if (named && named !== own) throw err('general_argument_invalid', `Organization "${named}" does not exist on this server. Use "${own}".`)
  return own
}

function project(ctx: ConsoleApiContext, id: string): ProjectRuntime {
  const found = ctx.projects.get(id)
  if (!found) throw err('project_not_found')
  return found
}

/**
 * A project of the organization the request names. The CLI sends the
 * `organizationId` from appwrite.config.json, which is often still the one
 * from Appwrite Cloud after a migration, so say which ID to use instead.
 */
function orgProject(ctx: ConsoleApiContext, id: string): ProjectRuntime {
  const found = project(ctx, id)
  const c = ctx.projects.control.config
  const named = apiHeader(ctx.request, 'organization')
  if (named && named !== found.info.orgId) {
    throw err(
      'general_argument_invalid',
      `Project "${found.info.id}" belongs to organization "${found.info.orgId}", not "${named}". ` +
        `Set "organizationId" in ${configFileName(c)} to "${found.info.orgId}", or run: ${cliName(c)} init project --organization-id ${found.info.orgId} --project-id ${found.info.id}`,
    )
  }
  return found
}

const modelOf = (p: ProjectRuntime) => projectModel(p.info, p.services)

function routes(): Router<ConsoleApiContext> {
  const router = new Router<ConsoleApiContext>()

  router.post('/account/sessions/email', async ({ ctx }) => {
    const email = str(ctx.params.email) ?? ''
    new RateLimiter(ctx.projects.control.db).hit(`console-api-login:${requestInfo(ctx.request).ip}:${email.toLowerCase()}`, 10, 900)
    const secret = await ctx.auth.login(email, str(ctx.params.password) ?? '')
    if (!secret) throw err('user_invalid_credentials')
    const session = ctx.auth.session(secret)!
    ctx.organizations.ensureAdmin(ctx.projects.control.config.orgId, session.admin.email)
    const secure = ctx.projects.control.config.publicEndpoint.startsWith('https') ? '; Secure' : ''
    const expires = new Date(addSeconds(SESSION_TTL)).toUTCString()
    return json(sessionOf(session, ctx.request), 201, {
      'set-cookie': `${sessionCookieName(ctx.projects.control.config, ctx.request, CONSOLE_PROJECT)}=${secret}; Expires=${expires}; Path=/; HttpOnly; SameSite=Strict${secure}`,
    })
  })

  router.get('/account', ({ ctx }) => {
    const session = signedIn(ctx)
    const org = ctx.organizations.get(ctx.projects.control.config.orgId)
    return json(accountOf(session.admin, org?.name ?? ''))
  })

  router.get('/account/sessions/:sessionId', ({ ctx, path }) => {
    const session = signedIn(ctx)
    if (path.sessionId !== 'current' && path.sessionId !== String(session.seq)) throw err('user_session_not_found')
    return json(sessionOf(session, ctx.request))
  })

  // `appwrite logout` names the session by the CLI's own local ID, which the
  // server never saw, so any ID ends the session whose cookie came with it.
  router.delete('/account/sessions/:sessionId', ({ ctx }) => {
    signedIn(ctx)
    ctx.auth.endSession(ctx.secret!)
    return new Response(null, { status: 204, headers: { 'set-cookie': `${sessionCookieName(ctx.projects.control.config, ctx.request, CONSOLE_PROJECT)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` } })
  })

  // Organizations are Appwrite "teams" in the console project.
  router.get('/teams', ({ ctx }) => {
    signedIn(ctx)
    const org = ctx.organizations.get(ctx.projects.control.config.orgId)
    const teams = org ? [{ $id: org.id, $createdAt: org.createdAt, $updatedAt: org.updatedAt, name: org.name, total: ctx.organizations.members(org.id).length, prefs: {} }] : []
    return json({ total: teams.length, teams })
  })

  router.get('/projects/:projectId', ({ ctx, path }) => {
    signedIn(ctx)
    return json(modelOf(project(ctx, path.projectId!)))
  })

  router.get('/organization/projects', ({ ctx }) => {
    signedIn(ctx)
    const orgId = orgOf(ctx)
    const all = ctx.projects.list().filter((p) => p.info.orgId === orgId).map(modelOf)
    const { total, items } = page(all, list(ctx.params.queries), { search: str(ctx.params.search), searchFields: ['$id', 'name'] })
    return json({ total, projects: items })
  })

  router.post('/organization/projects', ({ ctx }) => {
    signedIn(ctx)
    const orgId = orgOf(ctx)
    try {
      const created = ctx.projects.create({ id: ctx.params.projectId, name: ctx.params.name, orgId })
      return json(modelOf(created.project), 201)
    } catch (error) {
      if (error instanceof BunwriteError) throw error
      throw err('general_not_implemented', error instanceof Error ? error.message : String(error))
    }
  })

  router.get('/organization/projects/:projectId', ({ ctx, path }) => {
    signedIn(ctx)
    return json(modelOf(orgProject(ctx, path.projectId!)))
  })

  router.patch('/organization/projects/:projectId', ({ ctx, path }) => {
    signedIn(ctx)
    const target = orgProject(ctx, path.projectId!)
    const name = str(ctx.params.name)?.trim()
    if (!name || name.length > 128) throw err('general_argument_invalid', 'Invalid `name` param: Value must be a valid string and at least 1 chars and no longer than 128 chars')
    // Same as renaming in the console: the project's own setting and the registry.
    const c = target.services.config
    target.services.settings.set('project', { projectName: name, allowedOrigins: c.allowedOrigins, sessionDuration: c.sessionDuration, sessionsLimit: c.sessionsLimit })
    ctx.projects.update(target.info.id, { name })
    return json(modelOf(project(ctx, target.info.id)))
  })

  router.delete('/organization/projects/:projectId', async ({ ctx, path }) => {
    signedIn(ctx)
    const target = orgProject(ctx, path.projectId!)
    if (target.info.id === ctx.projects.defaultProject().info.id) throw err('general_argument_invalid', 'The default project cannot be deleted.')
    await ctx.projects.delete(target.info.id)
    return noContent()
  })

  return router
}

export function createConsoleApi(projects: ProjectResolver) {
  const control = projects.control
  const auth = new ConsoleAuth(control.db)
  const organizations = new OrganizationService(control.db)
  organizations.ensure(control.config.orgId, control.config.projectName)
  const router = routes()

  return {
    /** Serve a console-project API call; undefined when no route here matches. */
    async handle(request: Request, pathname: string): Promise<Response | undefined> {
      const match = router.match(request.method, pathname)
      if (!match) return undefined
      const url = new URL(request.url)
      const params = await readParams(request, url)
      const secret = sessionSecret(request)
      const session = secret ? auth.session(secret) : null
      return match.handler({ request, url, params, path: match.path, ctx: { request, params, path: match.path, projects, auth, organizations, session, secret } })
    },

    /** A console admin acting on a project: their session cookie plus `X-Bunwrite-Mode: admin` (or X-Appwrite-Mode). */
    adminOf(request: Request): Admin | null {
      if (apiHeader(request, 'mode') !== 'admin') return null
      const secret = sessionSecret(request)
      return secret ? (auth.session(secret)?.admin ?? null) : null
    },
  }
}
