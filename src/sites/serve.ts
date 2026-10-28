/**
 * Serving a site's files. Requests reach here by Host header (see app.ts):
 * `<siteId>.<SITES_DOMAIN>` or the site's custom domain.
 *
 * - `/about` tries `about`, `about.html` and `about/index.html`.
 * - Missing paths get the site's fallback file (single-page apps) with 200,
 *   else `404.html` with 404, else a small 404 page.
 * - Pages revalidate on every visit; files with a content hash in their name
 *   (`app.3f9a1c2b.js`) are cached for a year.
 * - `file.br` / `file.gz` next to a file are sent when the browser accepts them.
 * - With an API function set, `/api` and `/api/*` run that function.
 * - `adapter: 'ssr'` sites run an app instead (see ssr.ts).
 */
import { statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

import { resolveCaller } from '~/auth/caller'
import { functionHttpResponse } from '~/functions/http'
import { pickEncoding } from '~/lib/compress'
import { errorResponse } from '~/lib/http'
import type { Services } from '~/services'
import { sitePage, SECURITY_HEADERS } from './pages'
import type { SiteRow } from './service'
import { ssrResponse } from './ssr'

const API_PREFIX = '/api'
const HASHED = /[.-][a-zA-Z0-9_-]{8,}\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|svg|ico|wasm|map)$/

const page = (status: number, title: string, text: string) => sitePage(status, title, text)

const isFile = (path: string) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The file for a URL path inside `root`, or null. Never leaves `root`.
 * `folder` is set when `/docs` matched `docs/index.html`: the caller
 * redirects to `/docs/` so the page's relative links resolve.
 */
export function findFile(root: string, pathname: string): { path: string; folder: boolean } | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const base = resolve(root)
  const target = resolve(base, `.${decoded}`)
  if (target !== base && !target.startsWith(base + sep)) return null
  if (decoded.endsWith('/')) {
    const index = join(target, 'index.html')
    return isFile(index) ? { path: index, folder: false } : null
  }
  for (const path of [target, `${target}.html`]) if (isFile(path)) return { path, folder: false }
  const index = join(target, 'index.html')
  return isFile(index) ? { path: index, folder: true } : null
}

function fileResponse(request: Request, path: string, deploymentId: string, status = 200): Response {
  const stats = statSync(path)
  const etag = `"${deploymentId}-${stats.size.toString(36)}-${Math.floor(stats.mtimeMs).toString(36)}"`
  const type = Bun.file(path).type
  const html = type.startsWith('text/html')
  const headers: Record<string, string> = {
    'content-type': type,
    etag,
    'cache-control': html || !HASHED.test(path) ? 'public, max-age=0, must-revalidate' : 'public, max-age=31536000, immutable',
    vary: 'Accept-Encoding',
    ...SECURITY_HEADERS,
  }
  if (status === 200 && request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
  // Pre-compressed copies made at build time beat compressing on every request.
  const accept = request.headers.get('accept-encoding')
  for (const [encoding, ext] of [['br', '.br'], ['gzip', '.gz']] as const) {
    if (pickEncoding(accept, [encoding]) && isFile(path + ext)) {
      const file = Bun.file(path + ext)
      return new Response(file, { status, headers: { ...headers, 'content-encoding': encoding, 'content-length': String(file.size) } })
    }
  }
  const file = Bun.file(path)
  return new Response(file, { status, headers: { ...headers, 'content-length': String(file.size) } })
}

async function apiResponse(services: Services, site: SiteRow, request: Request, url: URL): Promise<Response> {
  let f
  try {
    f = services.functions.fn(site.api_function_id)
  } catch {
    return Response.json({ message: `The site's API function "${site.api_function_id}" does not exist.`, code: 502 }, { status: 502 })
  }
  try {
    const caller = await resolveCaller(services.db, services.config, request)
    const rest = url.pathname.slice(API_PREFIX.length) || '/'
    return await functionHttpResponse(services, f, caller, request, `${rest}${url.search}`)
  } catch (error) {
    return errorResponse(error)
  }
}

export async function serveSite(services: Services, site: SiteRow, request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (!site.enabled) return page(503, 'Site paused', 'This site is turned off for now.')
  // An SSR app answers every path, including /api, and handles methods itself.
  if (site.adapter === 'ssr') return ssrResponse(services, site, request)
  if (site.api_function_id && (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`))) {
    return apiResponse(services, site, request, url)
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD', ...SECURITY_HEADERS } })
  }
  const root = services.sites.root(site)
  if (!root) return page(404, 'Nothing here yet', 'This site has no live deployment.')

  const found = findFile(root, url.pathname)
  if (found?.folder) return new Response(null, { status: 308, headers: { location: `${url.pathname}/${url.search}` } })
  if (found) return fileResponse(request, found.path, site.deployment_id)
  // Single-page apps route in the browser: unknown paths get the app shell,
  // but a missing asset (it has an extension) stays a 404.
  if (site.fallback_file && !extname(url.pathname)) {
    const fallback = findFile(root, `/${site.fallback_file}`)
    if (fallback && !fallback.folder) return fileResponse(request, fallback.path, site.deployment_id)
  }
  const notFound = findFile(root, '/404.html')
  if (notFound) return fileResponse(request, notFound.path, site.deployment_id, 404)
  return page(404, 'Page not found', 'There is nothing at this address.')
}
