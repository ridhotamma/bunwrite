import type { AppContext } from '~/app'
import { callerHasScope } from '~/auth/caller'
import { requireKey } from '~/auth/routes'
import { json, list, noContent, str } from '~/lib/http'
import { page } from '~/lib/paging'
import type { Router } from '~/lib/router'
import { webhookModel } from './service'

/** Only a caller that may change the webhook needs to see its signing secret. */
const revealSecrets = (ctx: AppContext): boolean => callerHasScope(ctx.caller, 'webhooks.write')

/** The Webhooks service (`appwrite pull/push webhooks`). API keys and console admins only. */
export function webhookRoutes(router: Router<AppContext>): void {
  router.get('/webhooks', async ({ ctx, params }) => {
    requireKey(ctx, 'webhooks.read')
    const reveal = { revealSecrets: revealSecrets(ctx) }
    const { total, items } = page(
      (await ctx.webhooks.list()).map((hook) => webhookModel(hook, reveal)),
      list(params.queries),
      {
        search: str(params.search),
        searchFields: ['$id', 'name', 'url'],
      },
    )
    return json({ total, webhooks: items })
  })

  router.post('/webhooks', async ({ ctx, params }) => {
    requireKey(ctx, 'webhooks.write')
    return json(webhookModel(await ctx.webhooks.create(params.webhookId, params), { revealSecrets: true }), 201)
  })

  router.get('/webhooks/:webhookId', async ({ ctx, path }) => {
    requireKey(ctx, 'webhooks.read')
    return json(webhookModel(await ctx.webhooks.get(path.webhookId!), { revealSecrets: revealSecrets(ctx) }))
  })

  router.put('/webhooks/:webhookId', async ({ ctx, path, params }) => {
    requireKey(ctx, 'webhooks.write')
    return json(webhookModel(await ctx.webhooks.update(path.webhookId!, params), { revealSecrets: true }))
  })

  router.patch('/webhooks/:webhookId/secret', async ({ ctx, path, params }) => {
    requireKey(ctx, 'webhooks.write')
    return json(webhookModel(await ctx.webhooks.updateSecret(path.webhookId!, params.secret), { revealSecrets: true }))
  })

  router.delete('/webhooks/:webhookId', async ({ ctx, path }) => {
    requireKey(ctx, 'webhooks.write')
    await ctx.webhooks.delete(path.webhookId!)
    return noContent()
  })
}
