/**
 * The console routes shared by every variable scope (project, a site and a
 * function), so the save/remove/clear/import rules live in one place.
 *
 * A POST to the base path adds a variable or replaces one by name and deploy
 * context (all, live or preview); a blank value on a secret keeps what is
 * stored, so an edit need not reveal it.
 */
import type { ConsoleContext, ConsoleRoute, ConsoleRouter } from '~/console/context'
import { importEnvVariables } from '~/console/env-vars'
import { checked, value } from '~/console/forms'
import type { EnvVariable } from '~/functions/env'
import { variableContext, type VariableContext } from '~/variables/context'

/**
 * The subset of the function and variable services this page writes to.
 *
 * Returns may be synchronous or promises: services move to the async driver
 * port one at a time, and the handler awaits either.
 */
export interface VariableStore {
  variables(
    scope: string,
  ): { key: string; value: string; secret: number; context: string }[] | Promise<{ key: string; value: string; secret: number; context: string }[]>
  setVariable(scope: string, key: string, value: string, secret: boolean, context?: VariableContext): void | Promise<void>
  setVariables(scope: string, entries: EnvVariable[], secret: boolean, context?: VariableContext): void | Promise<void>
  deleteVariable(scope: string, key: string, context?: VariableContext): void | Promise<void>
  clearVariables(scope: string): number | Promise<number>
}

export interface VariableRouteOptions {
  /** Where variables are saved, e.g. `/console/functions/:id/variables`. */
  base: string
  /** The scope a request acts on: `project`, `site:<id>`, or a function ID. */
  scope: (route: ConsoleRoute) => string | Promise<string>
  /** The service that owns the scope; functions and project/site variables share the same shape. */
  store: (ctx: ConsoleContext) => VariableStore
  /** Restart anything that cached the old environment (SSR apps). */
  changed?: (ctx: ConsoleContext, scope: string) => void
  /** Where the browser lands after a write. */
  then: (route: ConsoleRoute, scope: string) => string
}

export function registerVariableRoutes(router: ConsoleRouter, options: VariableRouteOptions): void {
  const { base } = options

  router.post(base, async (route) => {
    const { ctx } = route
    const scope = await options.scope(route)
    const store = options.store(ctx)
    const key = value(ctx.form, 'key')
    const context = variableContext(ctx.form.context)
    const existing = (await store.variables(scope)).find((v) => v.key === key && v.context === context)
    // An edit that leaves a secret's value blank keeps its stored value and flag.
    const keep = Boolean(existing?.secret) && String(ctx.form.value ?? '') === ''
    const next = keep ? (existing?.value ?? '') : String(ctx.form.value ?? '')
    await store.setVariable(scope, key, next, keep || checked(ctx.form.secret), context)
    options.changed?.(ctx, scope)
    return ctx.go(options.then(route, scope), { tone: 'success', text: 'Variable saved' })
  })

  router.post(`${base}/delete`, async (route) => {
    const scope = await options.scope(route)
    await options.store(route.ctx).deleteVariable(scope, value(route.ctx.form, 'key'), variableContext(route.ctx.form.context))
    options.changed?.(route.ctx, scope)
    return route.ctx.go(options.then(route, scope), { tone: 'success', text: 'Variable removed' })
  })

  router.post(`${base}/clear`, async (route) => {
    const scope = await options.scope(route)
    const count = await options.store(route.ctx).clearVariables(scope)
    options.changed?.(route.ctx, scope)
    const text = count ? `Removed ${count} variable${count === 1 ? '' : 's'}` : 'No variables to remove'
    return route.ctx.go(options.then(route, scope), { tone: 'success', text })
  })

  router.post(`${base}/bulk`, async (route) => {
    const scope = await options.scope(route)
    return importEnvVariables(
      route.ctx,
      async (vars, secret) => {
        await options.store(route.ctx).setVariables(scope, vars, secret)
        options.changed?.(route.ctx, scope)
      },
      options.then(route, scope),
    )
  })
}
