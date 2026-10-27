/** API page handlers. Markup lives in console/views/api. */
import type { ConsoleRouter } from '~/console/context'
import { value } from '~/console/forms'
import { API, apiView } from '~/console/views/api'

export function apiPages(router: ConsoleRouter): void {
  router.get(API, ({ ctx }) => ctx.render('API', 'api', apiView(ctx)))

  router.post(`${API}/keys`, ({ ctx }) => {
    const expire = value(ctx.form, 'expire')
    const { secret } = ctx.services.settings.createKey(value(ctx.form, 'name'), expire ? `${expire}T23:59:59.999+00:00` : null)
    // Shown once in this response; never put in a URL, where history would keep it.
    return ctx.render('API', 'api', apiView(ctx, secret))
  })

  router.post(`${API}/keys/:id/delete`, ({ ctx, path }) => {
    ctx.services.settings.deleteKey(path.id!)
    return ctx.go(API, { tone: 'success', text: 'Key revoked' })
  })
}
