/** Realtime page handlers. Markup lives in console/views/realtime. */
import type { ConsoleRouter } from '~/console/context'
import { lines, parseJsonObject, value } from '~/console/forms'
import { REALTIME, realtimeView } from '~/console/views/realtime'

export function realtimePages(router: ConsoleRouter): void {
  router.get(REALTIME, async ({ ctx }) => ctx.render('Realtime', 'realtime', await realtimeView(ctx)))

  router.post(`${REALTIME}/publish`, async ({ ctx }) => {
    try {
      const channels = lines(ctx.form.channels)
      const events = lines(ctx.form.events)
      const raw = value(ctx.form, 'payload')
      const payload = raw ? parseJsonObject(raw, 'Payload must be a JSON object.') : {}
      if (channels.length === 0) throw new Error('Add at least one custom channel.')
      await ctx.services.realtime.publishCustom(channels, payload, events.length > 0 ? events : undefined)
      return ctx.go(REALTIME, { tone: 'success', text: 'Custom event published' })
    } catch (error) {
      return ctx.go(REALTIME, {
        tone: 'critical',
        text: error instanceof Error ? error.message : 'Could not publish the event.',
      })
    }
  })

  router.post(`${REALTIME}/presence/:id/delete`, async ({ ctx, path }) => {
    const removed = await ctx.services.realtime.removePresenceById(path.id!)
    return ctx.go(REALTIME, {
      tone: removed ? 'success' : 'warning',
      text: removed ? 'Presence removed' : 'Presence was already gone',
    })
  })
}
