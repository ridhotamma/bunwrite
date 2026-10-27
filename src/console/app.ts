/**
 * The admin console at /console: server-rendered pages, htmx for navigation
 * (hx-boost) and the few live bits. Every page is a plain HTML form, so it
 * also works without JavaScript.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { Server } from 'bun'

import type { Services } from '../app'
import { keyCaller } from '../auth/caller'
import { AppwriteError } from '../lib/errors'
import { RateLimiter } from '../lib/limits'
import { addSeconds } from '../lib/datetime'
import { Router, type RouteContext } from '../lib/router'
import { ConsoleAuth, type Admin } from './auth'
import { html, page, type Html } from './html'
import { bare, emptyState, formatBytes, header, shell, when, type Flash } from './layout'
import { databasePages } from './pages/databases'
import { authPages } from './pages/auth'
import { storagePages } from './pages/storage'
import { functionPages } from './pages/functions'
import { settingsPages } from './pages/settings'
import { schemaPages } from './pages/schema'
import { SchemaAdmin } from '../schema/admin'

export interface ConsoleContext {
  services: Services
  schema: SchemaAdmin
  auth: ConsoleAuth
  admin: Admin
  form: Record<string, any>
  /** Render a full console page. */
  render(title: string, section: string, body: Html): Response
}

export type ConsoleRoute = RouteContext<ConsoleContext>
export type ConsoleRouter = Router<ConsoleContext>

const HTMX = join(import.meta.dir, '..', '..', 'node_modules', 'htmx.org', 'dist', 'htmx.min.js')
const started = Date.now()

/** Go to `location`: an htmx swap for boosted requests, a 303 otherwise. */
export function go(request: Request, location: string, flash?: Flash): Response {
  const url = new URL(location, 'http://x')
  if (flash) url.searchParams.set(flash.tone === 'critical' ? 'err' : 'ok', flash.text)
  const target = url.pathname + url.search
  if (request.headers.get('hx-request')) return new Response(null, { status: 204, headers: { 'HX-Location': JSON.stringify({ path: target, target: 'body' }) } })
  return new Response(null, { status: 303, headers: { location: target } })
}

/** Back to the page the form was on, with a message. */
export function back(request: Request, flash: Flash): Response {
  const from = request.headers.get('hx-current-url') ?? request.headers.get('referer') ?? '/console'
  const url = new URL(from, 'http://x')
  url.searchParams.delete('ok')
  url.searchParams.delete('err')
  return go(request, url.pathname + url.search, flash)
}

async function readForm(request: Request): Promise<Record<string, any>> {
  if (request.method !== 'POST') return {}
  const type = request.headers.get('content-type') ?? ''
  if (!type.includes('form')) return {}
  const out: Record<string, any> = {}
  for (const [key, value] of await request.formData()) {
    if (key in out) out[key] = ([] as unknown[]).concat(out[key], value)
    else out[key] = value
  }
  return out
}

function loopback(request: Request, server?: Server<any>): boolean {
  const ip = server?.requestIP(request)?.address ?? ''
  const forwarded = request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip')
  return !forwarded && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')
}

export function createConsole(services: Services) {
  const auth = new ConsoleAuth(services.db)
  const schema = new SchemaAdmin(services.db, services.registry)
  const limiter = new RateLimiter()
  const router: ConsoleRouter = new Router()

  databasePages(router)
  authPages(router)
  storagePages(router)
  functionPages(router)
  settingsPages(router)
  schemaPages(router)
  router.get('/console', ({ ctx }) => ctx.render('Home', 'overview', overview(ctx)))

  const secure = () => services.config.publicEndpoint.startsWith('https')

  function signIn(error?: string, setup = false): Response {
    return page(
      bare(
        setup ? 'Create admin' : 'Sign in',
        html`<div class="auth">
          <div class="brand"><i></i>Pesanle console</div>
          <div class="card">
            <h2>${setup ? 'Create the first admin' : 'Sign in'}</h2>
            ${setup ? html`<p class="hint">Only shown on this machine while no admin exists.</p>` : ''}
            ${error ? html`<div class="banner critical">${error}</div>` : ''}
            <form method="post" action="${setup ? '/console/setup' : '/console/login'}">
              <label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>
              <label>Password<input type="password" name="password" autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="8" required></label>
              <button class="primary" style="width:100%;justify-content:center">${setup ? 'Create admin' : 'Sign in'}</button>
            </form>
          </div>
          ${!setup && auth.count() === 0 ? html`<p class="subdued" style="text-align:center">No admin yet. Run <code>bun run console:admin you@example.com</code> on the server.</p>` : ''}
        </div>`,
      ),
      error ? 401 : 200,
    )
  }

  return {
    async handle(request: Request, server?: Server<any>): Promise<Response | null> {
      const url = new URL(request.url)
      if (url.pathname !== '/console' && !url.pathname.startsWith('/console/')) return null
      if (!services.config.consoleEnabled) return new Response('Not found', { status: 404 })
      if (url.pathname === '/console/assets/htmx.min.js') {
        return new Response(Bun.file(HTMX), { headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=86400' } })
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
          try {
            await auth.upsert(String(form.email ?? ''), String(form.password ?? ''))
          } catch (error) {
            return signIn(error instanceof Error ? error.message : String(error), true)
          }
          const secret = (await auth.login(String(form.email), String(form.password)))!
          return new Response(null, { status: 303, headers: { location: '/console', 'set-cookie': auth.cookie(secret, secure()) } })
        }
        return signIn(undefined, true)
      }

      if (url.pathname === '/console/login') {
        if (noAdmins && loopback(request, server)) return go(request, '/console/setup')
        if (request.method === 'POST') {
          const form = await readForm(request)
          try {
            limiter.hit(`console-login:${ip}`, 10, 900)
          } catch {
            return signIn('Too many attempts. Try again in 15 minutes.')
          }
          const secret = await auth.login(String(form.email ?? ''), String(form.password ?? ''))
          if (!secret) return signIn('That email and password do not match an admin.')
          return new Response(null, { status: 303, headers: { location: '/console', 'set-cookie': auth.cookie(secret, secure()) } })
        }
        return signIn()
      }

      const admin = auth.admin(request)
      if (!admin) return go(request, noAdmins && loopback(request, server) ? '/console/setup' : '/console/login')

      if (url.pathname === '/console/logout' && request.method === 'POST') {
        auth.logout(request)
        return new Response(null, { status: 303, headers: { location: '/console/login', 'set-cookie': auth.clearCookie() } })
      }

      const match = router.match(request.method, url.pathname.replace(/\/$/, '') || '/console')
      const flash: Flash = url.searchParams.get('err')
        ? { tone: 'critical', text: url.searchParams.get('err')! }
        : url.searchParams.get('ok')
          ? { tone: 'success', text: url.searchParams.get('ok')! }
          : null
      const ctx: ConsoleContext = {
        services,
        schema,
        auth,
        admin,
        form: await readForm(request),
        render: (title, section, body) => page(shell(title, { section, admin: admin.email }, body, flash)),
      }
      if (!match) return ctx.render('Not found', '', html`${header('Page not found')}<div class="card">${emptyState('Nothing here', 'The page may have moved.', html`<a class="btn" href="/console">Go home</a>`)}</div>`)
      try {
        return await match.handler({ request, url, params: {}, path: match.path, ctx })
      } catch (error) {
        const message = error instanceof AppwriteError || error instanceof SyntaxError || error instanceof Error ? error.message : String(error)
        if (!(error instanceof AppwriteError)) console.error('[console]', error)
        if (request.method === 'POST') return back(request, { tone: 'critical', text: message })
        return ctx.render('Error', '', html`${header('Something went wrong')}<div class="banner critical">${message}</div>`)
      }
    },
  }
}

function overview(ctx: ConsoleContext): Html {
  const { services } = ctx
  const sql = services.db.sqlite
  const n = (q: string) => (sql.query(q).get() as { n: number }).n
  let documents = 0
  for (const c of services.registry.collections.values()) documents += (sql.query(`SELECT count(*) AS n FROM "${c.table.replace(/"/g, '""')}"`).get() as { n: number }).n
  const files = sql.query('SELECT count(*) AS n, coalesce(sum(size_original), 0) AS bytes FROM _files').get() as { n: number; bytes: number }
  let dbBytes = 0
  try {
    dbBytes = statSync(services.config.databasePath).size
  } catch {
    /* in-memory database */
  }
  const failed = (sql.query("SELECT count(*) AS n FROM _executions WHERE status = 'failed' AND created_at > ?").get(addSeconds(-86400)) as { n: number }).n
  const runs = sql
    .query<any, []>('SELECT e.id, e.function_id, e.status, e.trigger, e.duration, e.created_at FROM _executions e ORDER BY e.seq DESC LIMIT 6')
    .all()
  const stat = (label: string, value: string | number, href?: string) =>
    html`<div class="stat"><span>${label}</span><b>${href ? html`<a href="${href}" style="color:inherit">${value}</a>` : value}</b></div>`
  const uptime = Math.round((Date.now() - started) / 60000)
  const smtpOff = !services.config.smtp
  return html`
    ${header('Home')}
    ${smtpOff ? html`<div class="banner warning">Email is not set up, so sign-in codes, password resets and invitations cannot be sent. <a href="/console/settings#email">Set up SMTP</a></div>` : ''}
    <div class="stats" style="margin-bottom:16px">
      ${stat('Documents', documents.toLocaleString('en-US'), '/console/databases')}
      ${stat('Collections', services.registry.collections.size, '/console/databases')}
      ${stat('Users', n('SELECT count(*) AS n FROM _users'), '/console/auth/users')}
      ${stat('Teams', n('SELECT count(*) AS n FROM _teams'), '/console/auth/teams')}
      ${stat('Files', `${files.n} · ${formatBytes(files.bytes)}`, '/console/storage')}
      ${stat('Failed runs, 24h', failed, '/console/functions')}
    </div>
    <div class="layout">
      <div class="card flush">
        <div class="toolbar"><h2 style="margin:0">Recent function runs</h2></div>
        ${runs.length
          ? html`<div class="scroll"><table><thead><tr><th>Function</th><th>Status</th><th class="hide-sm">Trigger</th><th class="num">Time</th><th>Started</th></tr></thead><tbody>
            ${runs.map((r) => html`<tr class="row-link" onclick="location='/console/functions/${r.function_id}/executions/${r.id}'"><td>${r.function_id}</td><td>${statusBadge(r.status)}</td><td class="hide-sm">${r.trigger}</td><td class="num">${r.duration.toFixed(2)}s</td><td>${when(r.created_at)}</td></tr>`)}
            </tbody></table></div>`
          : emptyState('No runs yet', 'Scheduled functions show up here after their first run.')}
      </div>
      <div class="card">
        <h2>Server</h2>
        <ul class="list">
          <li><span class="subdued">Database file</span><span>${formatBytes(dbBytes)}</span></li>
          <li><span class="subdued">Memory</span><span>${formatBytes(process.memoryUsage().rss)}</span></li>
          <li><span class="subdued">Up for</span><span>${uptime < 120 ? `${uptime} min` : `${Math.round(uptime / 60)} h`}</span></li>
          <li><span class="subdued">Project ID</span><span class="mono">${services.config.projectId}</span></li>
          <li><span class="subdued">API endpoint</span><span class="mono">${services.config.publicEndpoint}</span></li>
        </ul>
      </div>
    </div>`
}

export function statusBadge(status: string): Html {
  const tone = status === 'completed' ? 'success' : status === 'failed' ? 'critical' : status === 'processing' ? 'info' : 'attention'
  return html`<span class="badge ${tone}">${status[0]!.toUpperCase() + status.slice(1)}</span>`
}

export { keyCaller }
