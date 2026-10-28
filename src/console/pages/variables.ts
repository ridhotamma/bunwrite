/**
 * The console routes shared by every variable scope (global variables and each
 * function's own), so the save/remove/clear/import rules live in one place.
 *
 * A POST to the base path adds a variable or replaces one by name; a blank
 * value on a secret keeps what is stored, so an edit need not reveal it.
 */
import type { ConsoleRoute, ConsoleRouter } from '~/console/context'
import { importEnvVariables } from '~/console/env-vars'
import { checked, value } from '~/console/forms'

export interface VariableRouteOptions {
  /** Where variables are saved, e.g. `/console/functions/:id/variables`. */
  base: string
  /** The scope a request acts on: `*` for global variables, otherwise a function ID. */
  scope: (route: ConsoleRoute) => string
  /** Where the browser lands after a write. */
  then: (route: ConsoleRoute, scope: string) => string
}

export function registerVariableRoutes(router: ConsoleRouter, options: VariableRouteOptions): void {
  const { base } = options

  router.post(base, (route) => {
    const { ctx } = route
    const scope = options.scope(route)
    const key = value(ctx.form, 'key')
    const existing = ctx.services.functions.variables(scope).find((v) => v.key === key)
    // An edit that leaves a secret's value blank keeps its stored value and flag.
    const keep = Boolean(existing?.secret) && String(ctx.form.value ?? '') === ''
    const next = keep ? (existing?.value ?? '') : String(ctx.form.value ?? '')
    ctx.services.functions.setVariable(scope, key, next, keep || checked(ctx.form.secret))
    return ctx.go(options.then(route, scope), { tone: 'success', text: 'Variable saved' })
  })

  router.post(`${base}/delete`, (route) => {
    const scope = options.scope(route)
    route.ctx.services.functions.deleteVariable(scope, value(route.ctx.form, 'key'))
    return route.ctx.go(options.then(route, scope), { tone: 'success', text: 'Variable removed' })
  })

  router.post(`${base}/clear`, (route) => {
    const scope = options.scope(route)
    const count = route.ctx.services.functions.clearVariables(scope)
    const text = count ? `Removed ${count} variable${count === 1 ? '' : 's'}` : 'No variables to remove'
    return route.ctx.go(options.then(route, scope), { tone: 'success', text })
  })

  router.post(`${base}/bulk`, (route) => {
    const scope = options.scope(route)
    return importEnvVariables(route.ctx, (vars, secret) => route.ctx.services.functions.setVariables(scope, vars, secret), options.then(route, scope))
  })
}
