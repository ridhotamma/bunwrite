import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { json, list, noContent, str } from '~/lib/http'
import { page } from '~/lib/paging'
import type { Router } from '~/lib/router'
import { webhookModel } from './service'

/** The Webhooks service (`appwrite pull/push webhooks`). API keys and console admins only. */
export function webhookRoutes(router: Router<AppContext>): void {
  router.get('/webhooks', ({ ctx, params }) => {
    requireKey(ctx, 'webhooks.read')
    const { total, items } = page(ctx.webhooks.list().map(webhookModel), list(params.queries), { search: str(params.search), searchFields: ['$id', 'name', 'url'] })
    return json({ total, webhooks: items })
  })

  router.post('/webhooks', ({ ctx, params }) => {
    requireKey(ctx, 'webhooks.write')
    return json(webhookModel(ctx.webhooks.create(params.webhookId, params)), 201)
  })

  router.get('/webhooks/:webhookId', ({ ctx, path }) => {
    requireKey(ctx, 'webhooks.read')
    return json(webhookModel(ctx.webhooks.get(path.webhookId!)))
  })

  router.put('/webhooks/:webhookId', ({ ctx, path, params }) => {
    requireKey(ctx, 'webhooks.write')
    return json(webhookModel(ctx.webhooks.update(path.webhookId!, params)))
  })

  router.patch('/webhooks/:webhookId/secret', ({ ctx, path, params }) => {
    requireKey(ctx, 'webhooks.write')
    return json(webhookModel(ctx.webhooks.updateSecret(path.webhookId!, params.secret)))
  })

  router.delete('/webhooks/:webhookId', ({ ctx, path }) => {
    requireKey(ctx, 'webhooks.write')
    ctx.webhooks.delete(path.webhookId!)
    return noContent()
  })
}
