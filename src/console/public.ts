/**
 * Pages for people who open the server in a browser outside the API: the
 * root and a 404. API paths (/v1/...) keep Appwrite's JSON errors, which the
 * SDKs read.
 */
import { html, page } from './html'
import { bare } from './layout'

/** A browser navigation (not an SDK call) to a non-API path. */
export function wantsHtml(request: Request, pathname: string): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  if (pathname === '/v1' || pathname.startsWith('/v1/')) return false
  return (request.headers.get('accept') ?? '').includes('text/html')
}

export function notFoundPage(consoleEnabled: boolean, projectName: string): Response {
  return page(
    bare(
      'Page not found',
      html`<div class="auth">
        <div class="brand">${projectName}</div>
        <div class="card" style="text-align:center;padding:32px 24px">
          <div style="font-size:40px;font-weight:650;line-height:1;margin-bottom:8px">404</div>
          <h2 style="margin:0 0 4px">Page not found</h2>
          <p class="subdued" style="margin:0 0 16px">Check the address, or go back to where you came from.</p>
          ${consoleEnabled ? html`<a class="btn primary" href="/console">Go to console</a>` : ''}
        </div>
        <p class="subdued" style="text-align:center">Looking for the API? It lives under <code>/v1</code>.</p>
      </div>`,
      projectName,
    ),
    404,
  )
}

/** Shown at / when the console is turned off. */
export function apiHomePage(projectName: string): Response {
  return page(
    bare(
      'API',
      html`<div class="auth">
        <div class="brand">${projectName}</div>
        <div class="card" style="text-align:center;padding:32px 24px">
          <h2 style="margin:0 0 4px">API is running</h2>
          <p class="subdued" style="margin:0">Apps connect at <code>/v1</code>. Health check: <a href="/v1/health">/v1/health</a></p>
        </div>
      </div>`,
      projectName,
    ),
  )
}
