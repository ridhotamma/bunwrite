/**
 * The admin console at /console: server-rendered pages, htmx for navigation
 * (hx-boost) and the few live bits. Every page is a plain HTML form, so it
 * also works without JavaScript.
 */
import type { Server } from 'bun'

import { parseCookies } from '~/auth/caller'
import { clearInstanceApiKey } from '~/instance/bootstrap'
import { clientIpOf } from '~/lib/client-ip'
import { AppwriteError } from '~/lib/errors'
import { RateLimiter } from '~/lib/limits'
import { Router } from '~/lib/router'
import { OrganizationService } from '~/organizations/service'
import { singleProjectResolver, type ProjectResolver } from '~/projects/types'
import { SchemaAdmin } from '~/schema/admin'
import type { Services } from '~/services'
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

function loopback(request: Request, server?: Server<any>): boolean {
  const ip = server?.requestIP(request)?.address ?? ''
  const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip')
  return !forwarded && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')
}

function flashFrom(url: URL): Flash {
  const error = url.searchParams.get('err')
  if (error) return { tone: 'critical', text: error }
  const ok = url.searchParams.get('ok')
  return ok ? { tone: 'success', text: ok } : null
}

export function createConsole(source: Services | ProjectResolver) {
  const projects: ProjectResolver = 'defaultProject' in source ? source : singleProjectResolver(source)
  const control = projects.control
  const auth = new ConsoleAuth(control.db)
  const organizations = new OrganizationService(control.db)
  organizations.ensure(control.config.orgId, control.config.projectName)
  const limiter = new RateLimiter()
  const router = new Router<ConsoleContext>()
  registerConsolePages(router)

  const secure = () => control.config.publicEndpoint.startsWith('https')

  return {
    async handle(request: Request, server?: Server<any>): Promise<Response | null> {
      const url = new URL(request.url)
      if (url.pathname !== '/console' && !url.pathname.startsWith('/console/')) return null
      if (!control.config.consoleEnabled) return new Response('Not found', { status: 404 })
      if (url.pathname === '/console/assets/htmx.min.js') {
        const file = Bun.file(htmxPath)
        return new Response(file, { headers: { 'content-type': 'text/javascript', 'content-length': String(file.size), 'cache-control': 'public, max-age=86400' } })
      }

      // Forms must come from this console (SameSite=Strict covers modern browsers; this covers the rest).
      if (request.method === 'POST') {
        const origin = request.headers.get('origin')
        if (origin && new URL(origin).host !== url.host) return new Response('Cross-site request refused', { status: 403 })
      }

      const ip = clientIpOf(request)
      const inviteMatch = /^\/console\/invite\/([^/]+)$/.exec(url.pathname)
      if (inviteMatch) {
        const token = decodeURIComponent(inviteMatch[1]!)
        const member = organizations.inviteByToken(token)
        if (!member) {
          return page(bare('Invitation unavailable', inviteUnavailableContent('This invitation is invalid or has already been accepted.'), control.config.projectName))
        }
        const org = organizations.get(member.organizationId)
        if (!org) {
          return page(bare('Invitation unavailable', inviteUnavailableContent('The organization for this invitation no longer exists.'), control.config.projectName))
        }
        const existing = auth.find(member.email)
        if (request.method === 'POST') {
          try {
            limiter.hit(`console-invite:${ip}`, 10, 900)
          } catch {
            return page(
              bare(
                `Join ${org.name}`,
                inviteAcceptContent({
                  orgName: org.name,
                  email: member.email,
                  token,
                  existing: Boolean(existing),
                  error: 'Too many attempts. Try again in 15 minutes.',
                }),
                control.config.projectName,
              ),
            )
          }
          const form = await readForm(request)
          const password = String(form.password ?? '')
          try {
            let secret: string | null
            if (existing) {
              secret = await auth.login(member.email, password)
              if (!secret) throw new Error('Incorrect email or password.')
              organizations.accept(member.id)
            } else {
              await auth.upsert(member.email, password)
              organizations.accept(member.id, String(form.name ?? ''))
              secret = await auth.login(member.email, password)
            }
            return new Response(null, {
              status: 303,
              headers: { location: '/console', 'set-cookie': auth.cookie(secret!, secure()) },
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

      const noAdmins = auth.count() === 0

      if (url.pathname === '/console/setup') {
        if (!noAdmins || !loopback(request, server)) return go(request, '/console/login')
        if (request.method === 'POST') {
          const form = await readForm(request)
          const email = String(form.email ?? '')
          try {
            await auth.upsert(email, String(form.password ?? ''))
          } catch (error) {
            return signInPage(auth, {
              setup: true,
              email,
              error: error instanceof Error ? error.message : String(error),
              projectName: control.config.projectName,
              instance: control.config.bootstrap,
            })
          }
          clearInstanceApiKey(control.db)
          if (control.config.bootstrap) control.config.bootstrap.apiKey = undefined
          const secret = (await auth.login(String(form.email), String(form.password)))!
          return new Response(null, { status: 303, headers: { location: '/console', 'set-cookie': auth.cookie(secret, secure()) } })
        }
        return signInPage(auth, { setup: true, projectName: control.config.projectName, instance: control.config.bootstrap })
      }

      if (url.pathname === '/console/login') {
        if (noAdmins && loopback(request, server)) return go(request, '/console/setup')
        if (request.method === 'POST') {
          const form = await readForm(request)
          const email = String(form.email ?? '')
          try {
            limiter.hit(`console-login:${ip}`, 10, 900)
          } catch {
            return signInPage(auth, { email, error: 'Too many attempts. Try again in 15 minutes.', projectName: control.config.projectName })
          }
          const secret = await auth.login(email, String(form.password ?? ''))
          if (!secret) return signInPage(auth, { email, error: 'That email and password do not match an admin.', projectName: control.config.projectName })
          return new Response(null, { status: 303, headers: { location: '/console', 'set-cookie': auth.cookie(secret, secure()) } })
        }
        return signInPage(auth, { projectName: control.config.projectName })
      }

      const admin = auth.admin(request)
      if (!admin) return go(request, noAdmins && loopback(request, server) ? '/console/setup' : '/console/login')
      organizations.ensureAdmin(control.config.orgId, admin.email)

      if (url.pathname === '/console/logout' && request.method === 'POST') {
        auth.logout(request)
        return new Response(null, { status: 303, headers: { location: '/console/login', 'set-cookie': auth.clearCookie() } })
      }

      const match = router.match(request.method, url.pathname.replace(/\/$/, '') || '/console')
      const flash = flashFrom(url)
      const cookieProject = parseCookies(request.headers.get('cookie') ?? '')['console_project']
      const selected = cookieProject ? projects.get(cookieProject) : null
      const pathname = url.pathname.replace(/\/$/, '') || '/console'
      const projectRoute = pathname !== '/console' && !pathname.startsWith('/console/projects') && !pathname.startsWith('/console/organization')
      if (projectRoute && !selected) return go(request, '/console')

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
        projects,
        organizations,
        currentProject: current.info,
        selectedProjectId: selected?.info.id ?? null,
        render: (title, section, body) =>
          page(
            section === 'projects' || section === 'organization'
              ? projectShell(title, { admin: admin.email }, body, flash)
              : shell(
                  title,
                  {
                    section,
                    admin: admin.email,
                    projectName: services.config.projectName,
                    orgName: organizations.get(control.config.orgId)?.name ?? control.config.projectName,
                    projects: projects.list().map((project) => project.info),
                    currentProject: selected?.info.id ?? current.info.id,
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
          html`${header('Page not found')}<div class="card">${emptyState('Nothing here', 'The page may have moved.', html`<a class="btn" href="/console">Go home</a>`)}</div>`,
        )
      }
      try {
        return await match.handler({ request, url, params: {}, path: match.path, ctx })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!(error instanceof AppwriteError)) console.error('[console]', error)
        if (request.method === 'POST') return back(request, { tone: 'critical', text: message })
        return ctx.render('Error', '', html`${header('Something went wrong')}${alert('critical', html`${message}`)}`)
      }
    },
  }
}
