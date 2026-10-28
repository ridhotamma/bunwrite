/** Webhooks page handlers. Markup lives in console/views/webhooks. */
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { arrayOf, checked, lines, value } from '~/console/forms'
import { eventGroups, type DatabaseChoice } from '~/console/views/webhook-events'
import {
  WEBHOOKS,
  draftOf,
  webhookCreateView,
  webhookUrl,
  webhookView,
  webhooksView,
  type WebhookDraft,
  type WebhookEnv,
} from '~/console/views/webhooks'
import { webhookHeaderName } from '~/lib/compat'
import { BunwriteError, err } from '~/lib/errors'
import type { WebhookRow } from '~/webhooks/service'

/** Checked presets and hand-typed patterns, without duplicates. */
const eventsOf = (form: Record<string, any>): string[] => [...new Set([...arrayOf(form.events), ...lines(form.customEvents)])]

/** The schema's databases and collections, as the event picker lists them. */
function databasesOf(ctx: ConsoleContext): DatabaseChoice[] {
  const collections = ctx.schema.collectionDefinitions()
  return [...ctx.services.registry.databases.values()].map((database) => ({
    id: database.id,
    name: database.name,
    collections: collections.filter((c) => c.databaseId === database.id).map((c) => ({ id: c.$id, name: c.name })),
  }))
}

function envOf(ctx: ConsoleContext): WebhookEnv {
  return {
    headerName: webhookHeaderName(ctx.services.config),
    appwrite: ctx.services.config.apiCompat === 'appwrite',
    groups: eventGroups(databasesOf(ctx)),
  }
}

function draftOfForm(form: Record<string, any>, existing?: WebhookRow): WebhookDraft {
  return {
    id: existing?.id ?? value(form, 'id'),
    name: value(form, 'name') || existing?.name || '',
    url: value(form, 'url') || existing?.url || '',
    // The general settings form has no event fields, so it keeps the stored events.
    events: existing && form.events === undefined && form.customEvents === undefined ? JSON.parse(existing.events) : eventsOf(form),
    enabled: checked(form.enabled),
    tls: checked(form.tls),
    authUsername: value(form, 'authUsername'),
  }
}

export function webhookPages(router: ConsoleRouter): void {
  router.get(WEBHOOKS, ({ ctx }) => ctx.render('Webhooks', 'webhooks', webhooksView(ctx.services.webhooks.list())))

  router.get(`${WEBHOOKS}/new`, ({ ctx }) => ctx.render('Create webhook', 'webhooks', webhookCreateView(envOf(ctx))))

  router.post(WEBHOOKS, ({ ctx }) => {
    const draft = draftOfForm(ctx.form)
    try {
      if (!draft.events.length) throw err('general_argument_invalid', 'Choose at least one event.')
      const hook = ctx.services.webhooks.create(value(ctx.form, 'id'), {
        name: draft.name,
        url: draft.url,
        events: draft.events,
        enabled: draft.enabled,
        tls: draft.tls,
        authUsername: draft.authUsername,
        authPassword: String(ctx.form.authPassword ?? '') || undefined,
        secret: value(ctx.form, 'secret') || undefined,
      })
      return ctx.go(webhookUrl(hook.id), { tone: 'success', text: 'Webhook created' })
    } catch (error) {
      // Keep what was typed on the page instead of losing it on a redirect.
      if (!(error instanceof BunwriteError)) throw error
      return ctx.render('Create webhook', 'webhooks', webhookCreateView(envOf(ctx), { draft, error: error.message }))
    }
  })

  router.get(`${WEBHOOKS}/:webhook`, ({ ctx, path }) => {
    const hook = ctx.services.webhooks.get(path.webhook!)
    return ctx.render(hook.name, 'webhooks', webhookView(envOf(ctx), hook, 'deliveries'))
  })

  router.get(`${WEBHOOKS}/:webhook/settings`, ({ ctx, path }) => {
    const hook = ctx.services.webhooks.get(path.webhook!)
    return ctx.render(hook.name, 'webhooks', webhookView(envOf(ctx), hook, 'settings'))
  })

  // Endpoint, status and basic authentication. Events and the secret have their own forms.
  router.post(`${WEBHOOKS}/:webhook/settings`, ({ ctx, path }) => {
    const hook = ctx.services.webhooks.get(path.webhook!)
    const draft = draftOfForm(ctx.form, hook)
    try {
      ctx.services.webhooks.update(hook.id, {
        name: draft.name,
        url: draft.url,
        enabled: draft.enabled,
        tls: draft.tls,
        authUsername: draft.authUsername,
        authPassword: String(ctx.form.authPassword ?? '') || undefined,
      })
      return ctx.go(`${webhookUrl(hook.id)}/settings`, { tone: 'success', text: 'Webhook saved' })
    } catch (error) {
      if (!(error instanceof BunwriteError)) throw error
      return ctx.render(hook.name, 'webhooks', webhookView(envOf(ctx), hook, 'settings', { draft, error: error.message }))
    }
  })

  router.post(`${WEBHOOKS}/:webhook/events`, ({ ctx, path }) => {
    const hook = ctx.services.webhooks.get(path.webhook!)
    const events = eventsOf(ctx.form)
    try {
      if (!events.length) throw err('general_argument_invalid', 'Choose at least one event.')
      ctx.services.webhooks.update(hook.id, { events })
      return ctx.go(`${webhookUrl(hook.id)}/settings`, { tone: 'success', text: 'Events saved' })
    } catch (error) {
      if (!(error instanceof BunwriteError)) throw error
      return ctx.render(hook.name, 'webhooks', webhookView(envOf(ctx), hook, 'settings', { draft: { ...draftOf(hook), events }, error: error.message }))
    }
  })

  // One delivery now, so the endpoint and its signature check can be tried by hand.
  router.post(`${WEBHOOKS}/:webhook/test`, async ({ ctx, path }) => {
    const hook = ctx.services.webhooks.get(path.webhook!)
    const result = await ctx.services.webhooks.sendTest(hook.id)
    return ctx.go(webhookUrl(hook.id), { tone: result.ok ? 'success' : 'critical', text: result.message })
  })

  // A new secret is shown once, in this response, like an API key; never in the URL.
  router.post(`${WEBHOOKS}/:webhook/secret`, ({ ctx, path }) => {
    const hook = ctx.services.webhooks.updateSecret(path.webhook!, undefined)
    return ctx.render(hook.name, 'webhooks', webhookView(envOf(ctx), hook, 'settings', { secret: hook.secret }))
  })

  router.post(`${WEBHOOKS}/:webhook/delete`, ({ ctx, path }) => {
    ctx.services.webhooks.delete(path.webhook!)
    return ctx.go(WEBHOOKS, { tone: 'success', text: 'Webhook deleted' })
  })
}
