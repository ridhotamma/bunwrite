import type { Params } from './http'

export interface RouteContext<C> {
  request: Request
  url: URL
  params: Params
  path: Record<string, string>
  ctx: C
}

export type Handler<C> = (route: RouteContext<C>) => Response | Promise<Response>

interface Route<C> {
  method: string
  /** Registration order across all routes; keeps overlapping patterns deterministic. */
  order: number
  /** First static path segment, or null when the route starts with a parameter or wildcard. */
  segment: string | null
  pattern: RegExp
  keys: string[]
  handler: Handler<C>
  /** Leave the body unread: the handler streams it itself. */
  raw: boolean
}

interface MethodIndex<C> {
  /** Routes whose first segment is static, keyed by that segment. */
  bySegment: Map<string, Route<C>[]>
  /** Routes that can match any first segment (`/:id`, `/*`, `/`). */
  generic: Route<C>[]
}

/** Shared empty list; a lookup miss must not allocate on the request path. */
const NO_ROUTES: Route<any>[] = []

/** First path segment when it is static (`/databases/...` → `databases`), else null. */
function staticSegment(path: string): string | null {
  if (!path.startsWith('/')) return null
  const end = path.indexOf('/', 1)
  const segment = path.slice(1, end === -1 ? undefined : end)
  return segment && !segment.startsWith(':') ? segment : null
}

/** Minimal method + path router. Patterns use `:name` segments. */
export class Router<C> {
  private readonly methods = new Map<string, MethodIndex<C>>()
  private nextOrder = 0

  /** `:name` matches one segment; a trailing `/*` matches the rest as `path.rest`. */
  on(method: string, path: string, handler: Handler<C>, options: { raw?: boolean } = {}): this {
    const keys: string[] = []
    const wildcard = path.endsWith('/*')
    const base = wildcard ? path.slice(0, -2) : path
    const pattern = new RegExp(
      '^' +
        base.replace(/\/:([a-zA-Z]+)/g, (_, key) => {
          keys.push(key)
          return '/([^/]+)'
        }) +
        (wildcard ? '(?:/(.*))?$' : '/?$'),
    )
    if (wildcard) keys.push('rest')
    const segment = staticSegment(base)
    const methods = method === 'ANY' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] : [method]
    for (const m of methods) {
      const route: Route<C> = {
        method: m,
        order: this.nextOrder++,
        segment,
        pattern,
        keys,
        handler,
        raw: Boolean(options.raw),
      }
      let index = this.methods.get(m)
      if (!index) {
        index = { bySegment: new Map(), generic: [] }
        this.methods.set(m, index)
      }
      if (segment === null) index.generic.push(route)
      else {
        const list = index.bySegment.get(segment)
        if (list) list.push(route)
        else index.bySegment.set(segment, [route])
      }
    }
    return this
  }

  get = (p: string, h: Handler<C>) => this.on('GET', p, h)
  post = (p: string, h: Handler<C>) => this.on('POST', p, h)
  put = (p: string, h: Handler<C>) => this.on('PUT', p, h)
  patch = (p: string, h: Handler<C>) => this.on('PATCH', p, h)
  delete = (p: string, h: Handler<C>) => this.on('DELETE', p, h)

  match(method: string, pathname: string): { handler: Handler<C>; path: Record<string, string>; raw: boolean } | null {
    // HEAD is GET without the body; app.fetch strips it after the handler runs.
    return this.find(method, pathname) ?? (method === 'HEAD' ? this.find('GET', pathname) : null)
  }

  private find(method: string, pathname: string): { handler: Handler<C>; path: Record<string, string>; raw: boolean } | null {
    const index = this.methods.get(method)
    if (!index) return null

    const end = pathname.indexOf('/', 1)
    const segment = pathname.slice(1, end === -1 ? undefined : end)
    const specific = index.bySegment.get(segment) ?? (NO_ROUTES as Route<C>[])
    const generic = index.generic

    // Merge the two ordered lists so a wildcard registered before a static
    // route still wins, exactly like the previous linear scan.
    let si = 0
    let gi = 0
    while (si < specific.length || gi < generic.length) {
      const exact = specific[si]
      const fallback = generic[gi]
      const route = fallback === undefined || (exact !== undefined && exact.order < fallback.order) ? exact! : fallback!
      if (route === exact) si++
      else gi++

      const m = route.pattern.exec(pathname)
      if (!m) continue
      const path: Record<string, string> = {}
      route.keys.forEach((k, i) => (path[k] = m[i + 1] === undefined ? '' : k === 'rest' ? m[i + 1]! : decodeURIComponent(m[i + 1]!)))
      return { handler: route.handler, path, raw: route.raw }
    }
    return null
  }
}
