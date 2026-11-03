/**
 * The admin console at /console: server-rendered pages, htmx for navigation
 * (hx-boost) and the few live bits. Every page is a plain HTML form, so it
 * also works without JavaScript.
 */
import type { Server } from 'bun'

import { parseCookies } from '~/auth/caller'
import { clearInstanceApiKey, clearInstanceApiKeyAsync } from '~/instance/bootstrap'
import { clientIpOf } from '~/lib/client-ip'
import { BunwriteError } from '~/lib/errors'
import { sendMailLater } from '~/mail/mailer'
import { RateLimiter } from '~/lib/limits'
import { Router } from '~/lib/router'
import { OrganizationService } from '~/organizations/service'
import { singleProjectResolver, type ProjectResolver } from '~/projects/types'
import { SchemaAdmin } from '~/schema/admin'
import type { Services } from '~/services'
import { VcsHub } from '~/vcs/hub'
import { htmxPath } from './assets'
import { ConsoleAuth } from './auth'
import type { ConsoleContext } from './context'
import { readForm } from './forms'
import { back, go } from './htmx'
import { html, page } from './html'
import { bare, projectShell, shell, type Flash } from './layout'
import { registerConsolePages } from './pages'
import { signInPage } from './pages/sign-in'
import { alert, emptyState, header } from './ui'
import { inviteAcceptContent, inviteUnavailableContent } from './views/organization'

function loopback(request: Request, _server?: Server<unknown>): boolean {
  // Use the same trusted-proxy resolution as rate limits. Reading the raw
  // socket here made every visitor behind a local reverse proxy look like
  // loopback, exposing the unauthenticated first-admin setup page. The Host
  // must also be a loopback name: a proxy forwarding the public domain is not
  // a local operator even when it does not add X-Forwarded-For.
  let host: string
  try {
    host = new URL(request.url).hostname.toLowerCase()
  } catch {
    return false
  }
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  if (!localHost) return false
  const ip = clientIpOf(request)
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

/**
 * Refuse a POST from another site. Browsers control Origin, but an opaque
 * origin is sent as the literal "null" (a sandboxed iframe, a file URL), which
 * is not itself a URL. Compare parseable origins only and fall back to Fetch
 * Metadata instead of letting a malformed value throw.
 */
function crossSitePost(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin')?.trim()
  if (origin && origin !== 'null') {
    try {
      return new URL(origin).host !== url.host
    } catch {
      // Fall through to the Fetch Metadata hint.
    }
  }
  return request.headers.get('sec-fetch-site') === 'cross-site'
}

function flashFrom(url: URL): Flash {
  const error = url.searchParams.get('err')
  if (error) return { tone: 'critical', text: error }
  const ok = url.searchParams.get('ok')
  return ok ? { tone: 'success', text: ok } : null
}

export function createConsole(source: Services | ProjectResolver, vcsHub?: VcsHub) {
  const projects: ProjectResolver = 'defaultProject' in source ? source : singleProjectResolver(source)
  const hub = vcsHub ?? new VcsHub(projects)
  const control = projects.control
  const auth = new ConsoleAuth(control.db)
  const organizations = new OrganizationService(control.db)
  // Start the organization row once; every request awaits it before touching members.
  const organizationsReady = organizations.ensure(control.config.orgId, control.config.projectName)
  const limiter = new RateLimiter(control.db)
  const router = new Router<ConsoleContext>()
  registerConsolePages(router)

  const secure = () => control.config.publicEndpoint.startsWith('https')
  const sendMfa = (email: string, code: string) =>
    sendMailLater(control.consoleMailer, control.templates.render('mfaChallenge', email, { user: email, otp: code }), 'console sign-in code')

  return {
    async handle(request: Request, server?: Server<unknown>): Promise<Response | null> {
      await organizationsReady
      const url = new URL(request.url)
      if (url.pathname !== '/console' && !url.pathname.startsWith('/console/')) return null
      if (!control.config.consoleEnabled) return new Response('Not found', { status: 404 })
      if (url.pathname === '/console/assets/htmx.min.js') {
        const file = Bun.file(htmxPath)
        return new Response(file, {
          headers: { 'content-type': 'text/javascript', 'content-length': String(file.size), 'cache-control': 'public, max-age=86400' },
        })
      }

      // Forms must come from this console (SameSite=Lax withholds cookies from cross-site POSTs; this covers the rest).
      if (request.method === 'POST' && crossSitePost(request, url)) {
        return new Response('Cross-site request refused', { status: 403 })
      }

      const ip = clientIpOf(request)
      const inviteMatch = /^\/console\/invite\/([^/]+)$/.exec(url.pathname)
      if (inviteMatch) {
        const token = decodeURIComponent(inviteMatch[1]!)
        const member = await organizations.inviteByToken(token)
        if (!member) {
          return page(
            bare('Invitation unavailable', inviteUnavailableContent('This invitation is invalid or has already been accepted.'), control.config.projectName),
          )
        }
        const org = await organizations.get(member.organizationId)
        if (!org) {
          return page(
            bare('Invitation unavailable', inviteUnavailableContent('The organization for this invitation no longer exists.'), control.config.projectName),
          )
        }
        const existing = await auth.find(member.email)
        if (request.method === 'POST') {
          const form = await readForm(request)
          const name = String(form.name ?? '')
          try {
            await limiter.hit(`console-invite:${ip}`, 10, 900)
          } catch {
            return page(
              bare(
                `Join ${org.name}`,
                inviteAcceptContent({
                  orgName: org.name,
                  email: member.email,
                  token,
                  existing: Boolean(existing),
                  name,
                  error: 'Too many attempts. Try again in 15 minutes.',
                }),
                control.config.projectName,
              ),
            )
          }
          const password = String(form.password ?? '')
          try {
            if (!existing) {
              await auth.upsert(member.email, password)
              await organizations.accept(member.id, String(form.name ?? ''))
            }
            const result = await auth.authenticate(member.email, password)
            if (result.status === 'invalid') throw new Error('Incorrect email or password.')
            if (existing) await organizations.accept(member.id)
            if (result.status === 'mfa') {
              if (!control.consoleMailer.enabled) throw new Error('Email is not configured, so the sign-in code could not be sent.')
              sendMfa(result.email, result.code)
              return await signInPage(auth, {
                projectName: control.config.projectName,
                mfaChallenge: result.challenge,
                notice: 'Enter the code we emailed you to finish signing in.',
              })
            }
            return new Response(null, {
              status: 303,
              headers: { location: '/console', 'set-cookie': auth.cookie(result.secret, secure()) },
            })
          } catch (error) {
            return page(
              bare(
                `Join ${org.name}`,
                inviteAcceptContent({
                  orgName: org.name,
                  email: member.email,
                  token,
                  existing: Boolean(existing),
                  name,
                  error: error instanceof Error ? error.message : String(error),
                }),
                control.config.projectName,
              ),
            )
          }
        }
        return page(
          bare(
            `Join ${org.name}`,
            inviteAcceptContent({ orgName: org.name, email: member.email, token, existing: Boolean(existing) }),
            control.config.projectName,
          ),
        )
      }

      const noAdmins = (await auth.count()) === 0

      if (url.pathname === '/console/setup') {
        if (!noAdmins || !loopback(request, server)) return go(request, '/console/login')
        if (request.method === 'POST') {
          const form = await readForm(request)
          const email = String(form.email ?? '')
          try {
            await auth.upsert(email, String(form.password ?? ''))
          } catch (error) {
            return await signInPage(auth, {
              setup: true,
              email,
              error: error instanceof Error ? error.message : String(error),
              projectName: control.config.projectName,
              instance: control.config.bootstrap,
            })
          }
          if (control.db.dialect === 'sqlite') clearInstanceApiKey(control.db)
          else await clearInstanceApiKeyAsync(control.db)
          if (control.config.bootstrap) control.config.bootstrap.apiKey = undefined
          const secret = (await auth.login(String(form.email), String(form.password)))!
          return new Response(null, { status: 303, headers: { location: '/console', 'set-cookie': auth.cookie(secret, secure()) } })
        }
        return await signInPage(auth, { setup: true, projectName: control.config.projectName, instance: control.config.bootstrap })
      }

      if (url.pathname === '/console/login') {
        if (noAdmins && loopback(request, server)) return go(request, '/console/setup')
        if (request.method === 'POST') {
          const form = await readForm(request)
          const email = String(form.email ?? '')
          try {
            await limiter.hit(`console-login:${ip}`, 10, 900)
          } catch {
            return await signInPage(auth, { email, error: 'Too many attempts. Try again in 15 minutes.', projectName: control.config.projectName })
          }
          const result = await auth.authenticate(email, String(form.password ?? ''))
          if (result.status === 'invalid') {
            return await signInPage(auth, { email, error: 'That email and password do not match an admin.', projectName: control.config.projectName })
          }
          if (result.status === 'mfa') {
            if (!control.consoleMailer.enabled) {
              return await signInPage(auth, {
                email,
                error: 'Email is not configured, so the sign-in code could not be sent.',
                projectName: control.config.projectName,
              })
            }
            sendMfa(result.email, result.code)
            return await signInPage(auth, {
              projectName: control.config.projectName,
              mfaChallenge: result.challenge,
              notice: 'Enter the code we emailed you to finish signing in.',
            })
          }
          return new Response(null, { status: 303, headers: { location: '/console', 'set-cookie': auth.cookie(result.secret, secure()) } })
        }
        return await signInPage(auth, { projectName: control.config.projectName })
      }

      if (url.pathname === '/console/login/mfa' && request.method === 'POST') {
        const form = await readForm(request)
        const challenge = String(form.challenge ?? '')
        try {
          await limiter.hit(`console-mfa:${ip}`, 10, 900)
        } catch {
          return await signInPage(auth, {
            mfaChallenge: challenge,
            error: 'Too many attempts. Try again in 15 minutes.',
            projectName: control.config.projectName,
          })
        }
        const secret = await auth.verifyMfa(challenge, String(form.code ?? ''))
        if (!secret) {
          return await signInPage(auth, {
            mfaChallenge: challenge,
            error: 'That code is not valid or has expired. Sign in again to get a new one.',
            projectName: control.config.projectName,
          })
        }
        return new Response(null, { status: 303, headers: { location: '/console', 'set-cookie': auth.cookie(secret, secure()) } })
      }

      const admin = await auth.admin(request)
      if (!admin) return go(request, noAdmins && loopback(request, server) ? '/console/setup' : '/console/login')
      await organizations.ensureAdmin(control.config.orgId, admin.email)
      const canManageProjects = (await organizations.roleOf(control.config.orgId, admin.email)) === 'owner'

      if (url.pathname === '/console/logout' && request.method === 'POST') {
        await auth.logout(request)
        return new Response(null, { status: 303, headers: { location: '/console/login', 'set-cookie': auth.clearCookie() } })
      }

      const match = router.match(request.method, url.pathname.replace(/\/$/, '') || '/console')
      const flash = flashFrom(url)
      const cookieProject = parseCookies(request.headers.get('cookie') ?? '')['console_project']
      const selected = cookieProject ? projects.get(cookieProject) : null
      const pathname = url.pathname.replace(/\/$/, '') || '/console'
      const projectRoute =
        pathname !== '/console' &&
        !pathname.startsWith('/console/projects') &&
        !pathname.startsWith('/console/organization') &&
        !pathname.startsWith('/console/security')
      if (projectRoute && !selected) return go(request, '/console')

      const organization = await organizations.get(control.config.orgId)
      const current = selected ?? projects.defaultProject()
      const services = current.services
      const schema = new SchemaAdmin(services.db, services.registry)
      const ctx: ConsoleContext = {
        services,
        schema,
        auth,
        admin,
        form: await readForm(request),
        request,
        url,
        limiter,
        ip,
        projects,
        organizations,
        hub,
        observability: services.observability,
        currentProject: current.info,
        selectedProjectId: selected?.info.id ?? null,
        render: (title, section, body) =>
          page(
            section === 'projects' || section === 'organization' || section === 'security'
              ? projectShell(title, { admin: admin.email }, body, flash)
              : shell(
                  title,
                  {
                    section,
                    admin: admin.email,
                    projectName: services.config.projectName,
                    orgName: organization?.name ?? control.config.projectName,
                    projects: projects.list().map((project) => project.info),
                    currentProject: selected?.info.id ?? current.info.id,
                    canManageProjects,
                  },
                  body,
                  flash,
                ),
          ),
        go: (location, message) => go(request, location, message),
        back: (message) => back(request, message),
      }
      if (!match) {
        return ctx.render(
          'Not found',
          '',
          html`${header('Page not found')}
            <div class="card">${emptyState('Nothing here', 'The page may have moved.', html`<a class="btn" href="/console">Go home</a>`)}</div>`,
        )
      }
      try {
        return await match.handler({ request, url, params: {}, path: match.path, ctx })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!(error instanceof BunwriteError)) console.error('[console]', error)
        if (request.method === 'POST') return back(request, { tone: 'critical', text: message })
        return ctx.render('Error', '', html`${header('Something went wrong')}${alert('critical', html`${message}`)}`)
      }
    },
  }
}
