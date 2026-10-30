/**
 * Bounded in-flight requests.
 *
 * A black-holed request is worse than a fast rejection: the client waits for
 * its own timeout while the server keeps the connection and the queue. When a
 * worker is at its limit we answer 503 with `Retry-After` immediately, so the
 * proxy and the client can retry or shed load. Health checks always pass so a
 * busy worker is not mistaken for a dead one.
 */
// `any` keeps this boundary compatible with Bun's handler types and the app's
// `Response | undefined` return without casts at every call site.
export type FetchHandler = (request: Request, server?: any) => any

export function isHealthPath(pathname: string): boolean {
  return pathname === '/health' || pathname === '/v1/health' || pathname.startsWith('/v1/health/')
}

/**
 * WebSocket upgrades are long-lived but the handler returns as soon as the
 * socket is upgraded, so counting them as in-flight REST requests only turns a
 * reconnect storm into 503s. The connection itself is still bounded by the
 * file-descriptor limit and `backpressureLimit`.
 */
export function isRealtimePath(pathname: string): boolean {
  return pathname === '/realtime' || pathname === '/v1/realtime'
}

export function busyResponse(): Response {
  return new Response(JSON.stringify({ message: 'Server is busy', code: 503, type: 'service_unavailable' }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'retry-after': '1' },
  })
}

/** Wrap a fetch handler with a per-process in-flight cap. `limit <= 0` disables it. */
export function withInflightLimit(handler: FetchHandler, limit: number): FetchHandler {
  if (!Number.isFinite(limit) || limit <= 0) return handler
  let inflight = 0
  return (request, server) => {
    let pathname = ''
    try {
      pathname = new URL(request.url).pathname
    } catch {
      // A malformed URL is rejected by the app; do not let it bypass the cap.
    }
    if (isHealthPath(pathname) || isRealtimePath(pathname)) return handler(request, server)
    if (inflight >= limit) return busyResponse()
    inflight++
    let result: Response | Promise<Response>
    try {
      result = handler(request, server)
    } catch (error) {
      inflight--
      throw error
    }
    if (result instanceof Promise) {
      return result.finally(() => {
        inflight--
      })
    }
    inflight--
    return result
  }
}
