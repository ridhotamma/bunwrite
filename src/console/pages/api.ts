/** API page handlers. Markup lives in console/views/api. */
import type { ConsoleRouter } from '~/console/context'
import { arrayOf, checked, value } from '~/console/forms'
import { apiKeyScopes } from '~/settings/scopes'
import { API, apiView } from '~/console/views/api'

export function apiPages(router: ConsoleRouter): void {
  router.get(API, async ({ ctx }) => ctx.render('API', 'api', await apiView(ctx)))

  router.post(`${API}/keys`, async ({ ctx }) => {
    const expire = value(ctx.form, 'expire')
    // A key is scoped unless the operator explicitly asks for full access.
    const scopes = checked(ctx.form.full) ? null : apiKeyScopes(arrayOf(ctx.form.scopes))
    const { secret } = await ctx.services.settings.createKey(
      value(ctx.form, 'name'),
      expire ? `${expire}T23:59:59.999+00:00` : null,
      scopes,
    )
    // Shown once in this response; never put in a URL, where history would keep it.
    return ctx.render('API', 'api', await apiView(ctx, secret))
  })

  router.post(`${API}/keys/:id/delete`, async ({ ctx, path }) => {
    await ctx.services.settings.deleteKey(path.id!)
    return ctx.go(API, { tone: 'success', text: 'Key revoked' })
  })
}
