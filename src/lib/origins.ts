import { err } from './errors'

/** Does `origin` (or any URL) match the allowed list? `*.example.com` matches subdomains. */
export function originAllowed(origin: string, allowed: string[]): boolean {
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    return false
  }
  return allowed.some((pattern) => {
    if (pattern === '*') return true
    if (pattern.includes('://')) {
      try {
        return new URL(pattern).origin === new URL(origin).origin
      } catch {
        return false
      }
    }
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) || host === pattern.slice(2)
    return host === pattern
  })
}

/** Appwrite only redirects to hosts on the project's platform list. */
export function assertRedirect(url: unknown, allowed: string[], param: string): string {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url) || !originAllowed(url, allowed)) {
    throw err('general_argument_invalid', `Invalid \`${param}\` param: URL host must be one of: ${allowed.join(', ')}`)
  }
  return url
}

/** Append query parameters to a URL, keeping any it already has. */
export function withQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?$/i
const HOST = /^[a-z0-9.-]+(:\d+)?$|^\[[0-9a-f:.]+\](:\d+)?$/i

/**
 * The API endpoint (with /v1) at the address the browser used to reach this
 * server: `http://localhost:8080/v1` while developing, `https://your-domain/v1`
 * behind a reverse proxy or Cloudflare. Falls back to `fallback`
 * (PUBLIC_ENDPOINT) when a proxy hides the public host.
 */
export function requestEndpoint(request: Request, fallback: string): string {
  const configured = fallback.replace(/\/$/, '')
  const first = (name: string) => request.headers.get(name)?.split(',')[0]?.trim() ?? ''
  const url = new URL(request.url)
  const forwardedHost = first('x-forwarded-host')
  const host = forwardedHost || request.headers.get('host') || url.host
  const proxied = Boolean(forwardedHost || first('x-forwarded-for') || request.headers.get('cf-connecting-ip'))
  // A proxy that forwards to 127.0.0.1 without passing the Host header on.
  if (!HOST.test(host) || (proxied && LOOPBACK_HOST.test(host))) return configured

  const visitor = request.headers.get('cf-visitor') ?? ''
  const proto = (first('x-forwarded-proto') || (visitor.includes('"https"') ? 'https' : '') || url.protocol.slice(0, -1)).toLowerCase()
  if (proto !== 'http' && proto !== 'https') return configured

  // Same host as PUBLIC_ENDPOINT: keep its exact form (path, scheme).
  try {
    if (new URL(configured).host.toLowerCase() === host.toLowerCase()) return configured
  } catch {}
  return `${proto}://${host}/v1`
}
