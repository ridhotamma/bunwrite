/**
 * Custom-domain routes shared by sites and functions. The save route replaces
 * the full list; the remove route deletes one domain without touching the rest.
 */
import type { ConsoleRoute, ConsoleRouter } from '~/console/context'
import { arrayLines, value } from '~/console/forms'
import type { ProxyResourceType } from '~/proxy/service'

export interface DomainRouteOptions {
  /** e.g. `/console/sites/:id/domains`. */
  base: string
  /** Resolve the site/function a request is for; also answers 404 for bad IDs. */
  target: (route: ConsoleRoute) => { type: ProxyResourceType; id: string }
  /** Where the browser lands after a write. */
  then: (route: ConsoleRoute, target: { type: ProxyResourceType; id: string }) => string
}

export function registerDomainRoutes(router: ConsoleRouter, options: DomainRouteOptions): void {
  const save = (route: ConsoleRoute, domains: string[], text: string) => {
    const target = options.target(route)
    route.ctx.services.proxy.set(target.type, target.id, domains)
    return route.ctx.go(options.then(route, target), { tone: 'success', text })
  }

  router.post(options.base, (route) => {
    return save(route, arrayLines(route.ctx.form.domains), 'Domains saved')
  })

  router.post(`${options.base}/remove`, (route) => {
    const target = options.target(route)
    const domain = value(route.ctx.form, 'remove')
    const remaining = route.ctx.services.proxy.domainsFor(target.type, target.id).filter((one) => one !== domain)
    return save(route, remaining, 'Domain removed')
  })
}
