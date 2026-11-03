/**
 * Sticky sessions for site requests.
 *
 * Bunwrite runs several public HTTP workers. With `SO_REUSEPORT` the kernel
 * spreads *connections* across them, so an SSE stream and the POSTs that follow
 * it can land on different processes. An SSR app keeps state per process, so
 * that used to break session-based sites.
 *
 * When `STICKY_SESSIONS` is on, each public worker also listens on a private
 * loopback port. A site request that hashes to another worker is streamed over
 * loopback to that worker's listener. The affinity key is the `bw_sticky`
 * cookie when present, otherwise the client IP plus the site host. The first
 * response sets the cookie, so browsers stay pinned even if their IP changes;
 * clients that do not keep cookies (SSE/EventSource) still stick by IP.
 *
 * Only site requests use this path. API, console, function and WebSocket
 * traffic keep their existing routing.
 */
import { createHash } from 'node:crypto'

import { clientIpOf } from '~/lib/client-ip'

export type StickyMode = 'off' | 'ip' | 'cookie'

export const STICKY_COOKIE = 'bw_sticky'

/** The slice of `Config` the sticky helpers need. */
export interface StickyConfig {
  stickySessions: StickyMode
  stickyPort: number
  stickyHost: string
  publicWorkers: number
  workers: number
  workerIndex: number
  publicEndpoint?: string
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

/** `off`, `ip` (no cookie) or `cookie` (cookie with IP fallback). */
export function parseStickyMode(value: string | undefined): StickyMode {
  const setting = (value ?? '').trim().toLowerCase()
  if (!setting || setting === '0' || setting === 'off' || setting === 'false' || setting === 'none') return 'off'
  if (setting === 'ip' || setting === 'ip_hash' || setting === 'ip-hash') return 'ip'
  if (setting === '1' || setting === 'true' || setting === 'on' || setting === 'cookie' || setting === 'cookies' || setting === 'auto') return 'cookie'
  return 'off'
}

export function stickyEnabled(config: StickyConfig): boolean {
  return config.stickySessions !== 'off' && config.publicWorkers > 1 && config.stickyPort > 0
}

/** Public worker index, ignoring the writer processes that precede them. */
export function publicWorkerIndex(config: StickyConfig): number {
  const writerCount = Math.max(0, config.workers - config.publicWorkers)
  return Math.max(0, Math.min(config.publicWorkers - 1, config.workerIndex - writerCount))
}

/** The loopback port this worker's sticky listener uses. */
export function stickyPortFor(config: StickyConfig, index = publicWorkerIndex(config)): number {
  return config.stickyPort + index
}

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i

/** The site host a request is for, with the same precedence as `siteFor()`. */
export function stickyHostOf(request: Request): string {
  const host = request.headers.get('host')?.trim() ?? ''
  const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  // A public Host is the original site host. When a proxy rewrote it to a
  // loopback address, the original is in X-Forwarded-Host.
  if (host && !LOOPBACK_HOST.test(host)) return host
  if (forwarded) return forwarded
  if (host) return host
  try {
    return new URL(request.url).host
  } catch {
    return ''
  }
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!name) continue
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      out[name] = value
    }
  }
  return out
}

function hashKey(value: string): number {
  return createHash('sha256').update(value).digest().readUInt32BE(0)
}

function cookieIndex(value: string | undefined, publicWorkers: number): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const index = Number(value)
  return Number.isInteger(index) && index >= 0 && index < publicWorkers ? index : undefined
}

/**
 * The worker for a site request. A valid `bw_sticky` cookie wins; otherwise the
 * client IP and host are hashed. `ip` mode ignores cookies entirely.
 */
export function stickyWorkerFor(host: string, ip: string, cookie: string | undefined, publicWorkers: number, mode: StickyMode): number | undefined {
  if (mode === 'off' || publicWorkers <= 1) return undefined
  if (mode === 'cookie') {
    const fromCookie = cookieIndex(cookie, publicWorkers)
    if (fromCookie !== undefined) return fromCookie
  }
  return hashKey(`${host}|${ip || 'unknown'}`) % publicWorkers
}

/** The current request's sticky worker, or undefined when sticky is off. */
export function stickyTargetFor(request: Request, config: StickyConfig, host = stickyHostOf(request)): number | undefined {
  if (!stickyEnabled(config)) return undefined
  // We cannot forward an upgrade through fetch; leave WebSockets on the
  // accepting worker. HTTP/SSE requests remain sticky.
  if ((request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') return undefined
  const cookie = parseCookies(request.headers.get('cookie') ?? '')[STICKY_COOKIE]
  return stickyWorkerFor(host, clientIpOf(request), cookie, config.publicWorkers, config.stickySessions)
}

export function stickyCookieHeader(config: StickyConfig, target: number): string {
  const secure = (config.publicEndpoint ?? '').startsWith('https') ? '; Secure' : ''
  return `${STICKY_COOKIE}=${target}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`
}

/** Add/refresh the affinity cookie without folding existing Set-Cookie headers. */
export function withStickyCookie(response: Response, config: StickyConfig, target: number): Response {
  if (config.stickySessions !== 'cookie' || target === undefined) return response
  const headers = new Headers(response.headers)
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  if (cookies.length) {
    headers.delete('set-cookie')
    for (const cookie of cookies) headers.append('set-cookie', cookie)
  }
  headers.append('set-cookie', stickyCookieHeader(config, target))
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Stream a site request to another worker's sticky listener. Returns null when
 * the upstream is unavailable or the request cannot be proxied, so the caller
 * can serve it locally instead of failing the request.
 */
export async function forwardSticky(config: StickyConfig, request: Request, host: string, target: number): Promise<Response | null> {
  if ((request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') return null

  let url: URL
  try {
    const incoming = new URL(request.url)
    url = new URL(`http://${config.stickyHost}:${stickyPortFor(config, target)}${incoming.pathname}${incoming.search}`)
  } catch {
    return null
  }

  const headers = new Headers(request.headers)
  for (const name of HOP_BY_HOP) headers.delete(name)
  // Keep the original site host available to the target so `siteFor()`
  // resolves the same site after the loopback hop. Bun's fetch permits an
  // explicit Host; X-Forwarded-Host is kept for the SSR app proxy.
  if (host) {
    headers.set('host', host)
    headers.set('x-forwarded-host', host)
  } else {
    headers.delete('host')
  }
  if (!headers.get('x-forwarded-proto')) headers.set('x-forwarded-proto', new URL(request.url).protocol.slice(0, -1))
  if (!headers.get('x-forwarded-for') && clientIpOf(request)) headers.set('x-forwarded-for', clientIpOf(request))

  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body
  let upstream: Response
  try {
    upstream = await fetch(url, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      decompress: false,
      duplex: 'half',
      signal: request.signal,
    } as RequestInit)
  } catch {
    return null
  }

  const out = new Headers()
  for (const [name, value] of upstream.headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) out.set(name, value)
  }
  const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : []
  if (cookies.length) {
    out.delete('set-cookie')
    for (const cookie of cookies) out.append('set-cookie', cookie)
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  })
}
