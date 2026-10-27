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
  pattern: RegExp
  keys: string[]
  handler: Handler<C>
  /** Leave the body unread: the handler streams it itself. */
  raw: boolean
}

/** Minimal method + path router. Patterns use `:name` segments. */
export class Router<C> {
  private routes: Route<C>[] = []

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
    const methods = method === 'ANY' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] : [method]
    for (const m of methods) this.routes.push({ method: m, pattern, keys, handler, raw: Boolean(options.raw) })
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
    for (const route of this.routes) {
      if (route.method !== method) continue
      const m = route.pattern.exec(pathname)
      if (!m) continue
      const path: Record<string, string> = {}
      route.keys.forEach((k, i) => (path[k] = m[i + 1] === undefined ? '' : k === 'rest' ? m[i + 1]! : decodeURIComponent(m[i + 1]!)))
      return { handler: route.handler, path, raw: route.raw }
    }
    return null
  }
}
