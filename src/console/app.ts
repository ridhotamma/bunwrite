/**
 * The admin console at /console: server-rendered pages, htmx for navigation
 * (hx-boost) and the few live bits. Every page is a plain HTML form, so it
 * also works without JavaScript.
 */
import type { Server } from 'bun'

import { clearInstanceApiKey } from '~/instance/bootstrap'
import { AppwriteError } from '~/lib/errors'
import { RateLimiter } from '~/lib/limits'
import { Router } from '~/lib/router'
import { SchemaAdmin } from '~/schema/admin'
import type { Services } from '~/services'
import { htmxPath } from './assets'
import { ConsoleAuth } from './auth'
import type { ConsoleContext } from './context'
import { readForm } from './forms'
import { back, go } from './htmx'
import { html, page } from './html'
import { shell, type Flash } from './layout'
import { registerConsolePages } from './pages'
import { signInPage } from './pages/sign-in'
import { alert, emptyState, header } from './ui'

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

export function createConsole(services: Services) {
  const auth = new ConsoleAuth(services.db)
  const schema = new SchemaAdmin(services.db, services.registry)
  const limiter = new RateLimiter()
  const router = new Router<ConsoleContext>()
  registerConsolePages(router)

  const secure = () => services.config.publicEndpoint.startsWith('https')

  return {
    async handle(request: Request, server?: Server<any>): Promise<Response | null> {
      const url = new URL(request.url)
      if (url.pathname !== '/console' && !url.pathname.startsWith('/console/')) return null
      if (!services.config.consoleEnabled) return new Response('Not found', { status: 404 })
      if (url.pathname === '/console/assets/htmx.min.js') {
        return new Response(Bun.file(htmxPath), { headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=86400' } })
      }

      // Forms must come from this console (SameSite=Strict covers modern browsers; this covers the rest).
      if (request.method === 'POST') {
        const origin = request.headers.get('origin')
        if (origin && new URL(origin).host !== url.host) return new Response('Cross-site request refused', { status: 403 })
      }

      const ip = (server?.requestIP(request)?.address ?? '') + (request.headers.get('cf-connecting-ip') ?? '')
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
              projectName: services.config.projectName,
              instance: services.config.bootstrap,
            })
          }
          const bootstrapKey = services.config.bootstrap?.apiKey
          clearInstanceApiKey(services.db)
          if (bootstrapKey) services.config.apiKeys = services.config.apiKeys.filter((key) => key !== bootstrapKey)
          if (services.config.bootstrap) services.config.bootstrap.apiKey = undefined
          const secret = (await auth.login(String(form.email), String(form.password)))!
          return new Response(null, { status: 303, headers: { location: '/console', 'set-cookie': auth.cookie(secret, secure()) } })
        }
        return signInPage(auth, { setup: true, projectName: services.config.projectName, instance: services.config.bootstrap })
      }

      if (url.pathname === '/console/login') {
        if (noAdmins && loopback(request, server)) return go(request, '/console/setup')
        if (request.method === 'POST') {
          const form = await readForm(request)
          const email = String(form.email ?? '')
          try {
            limiter.hit(`console-login:${ip}`, 10, 900)
          } catch {
            return signInPage(auth, { email, error: 'Too many attempts. Try again in 15 minutes.', projectName: services.config.projectName })
          }
          const secret = await auth.login(email, String(form.password ?? ''))
          if (!secret) return signInPage(auth, { email, error: 'That email and password do not match an admin.', projectName: services.config.projectName })
          return new Response(null, { status: 303, headers: { location: '/console', 'set-cookie': auth.cookie(secret, secure()) } })
        }
        return signInPage(auth, { projectName: services.config.projectName })
      }

      const admin = auth.admin(request)
      if (!admin) return go(request, noAdmins && loopback(request, server) ? '/console/setup' : '/console/login')

      if (url.pathname === '/console/logout' && request.method === 'POST') {
        auth.logout(request)
        return new Response(null, { status: 303, headers: { location: '/console/login', 'set-cookie': auth.clearCookie() } })
      }

      const match = router.match(request.method, url.pathname.replace(/\/$/, '') || '/console')
      const flash = flashFrom(url)
      const ctx: ConsoleContext = {
        services,
        schema,
        auth,
        admin,
        form: await readForm(request),
        request,
        url,
        render: (title, section, body) => page(shell(title, { section, admin: admin.email, projectName: services.config.projectName }, body, flash)),
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
