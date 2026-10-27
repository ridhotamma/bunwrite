/** Navigation responses that work for both htmx and plain browser requests. */
import type { Flash } from './layout'

export const isHtmx = (request: Request): boolean => Boolean(request.headers.get('hx-request'))

/**
 * Go to `location`: an htmx body swap for boosted requests, a 303 otherwise.
 * Flash messages travel in the URL so they survive the redirect.
 */
export function go(request: Request, location: string, flash?: Flash): Response {
  const url = new URL(location, 'http://x')
  if (flash) url.searchParams.set(flash.tone === 'critical' ? 'err' : 'ok', flash.text)
  const target = url.pathname + url.search
  if (isHtmx(request)) {
    return new Response(null, { status: 204, headers: { 'HX-Location': JSON.stringify({ path: target, target: 'body' }) } })
  }
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
