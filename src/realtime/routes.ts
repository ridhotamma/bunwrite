/**
 * /v1/realtime — custom event publishing and replay.
 *
 * `POST /realtime/publish` is a Bunwrite extension for server-published
 * events. Only a privileged caller (API key) may publish, and the key needs
 * the `realtime.write` scope. Browsers can subscribe to the `custom.*`
 * channels through /v1/realtime and read history through /realtime/events.
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { err } from '~/lib/errors'
import { json, num } from '~/lib/http'
import { RateLimiter } from '~/lib/limits'
import type { Router } from '~/lib/router'

function strings(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw err('general_argument_invalid', `Param "${name}" must be an array of strings.`)
  return value.map((item) => {
    if (typeof item !== 'string') throw err('general_argument_invalid', `Param "${name}" must be an array of strings.`)
    return item
  })
}

function channelFilter(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null
  if (!raw) throw err('general_argument_invalid', 'Param "channels" must be a comma-separated list or an array.')
  const channels = raw.map((item) => {
    if (typeof item !== 'string') throw err('general_argument_invalid', 'Param "channels" must contain only strings.')
    return item.trim()
  })
  if (channels.some((channel) => !channel.startsWith('custom.'))) {
    throw err('general_argument_invalid', 'Param "channels" may only name "custom." channels.')
  }
  return [...new Set(channels.filter(Boolean))]
}

export function realtimeRoutes(router: Router<AppContext>): void {
  router.post('/realtime/publish', async ({ ctx, params }) => {
    requireKey(ctx, 'realtime.write')
    const limit = ctx.config.realtimePublishRate
    if (limit > 0) {
      await new RateLimiter(ctx.db).hit(`realtime-publish:${ctx.config.projectId}`, limit, 60)
    }
    const channels = strings(params.channels, 'channels')
    if (!channels || channels.length === 0) {
      throw err('general_argument_invalid', 'Param "channels" is required: send at least one "custom." channel.')
    }
    const events = strings(params.events, 'events')
    const event = await ctx.realtime.publishCustom(channels, params.payload, events)
    return json({ channels: event.channels, events: event.events, timestamp: event.timestamp, seq: event.seq })
  })

  router.get('/realtime/events', async ({ ctx, params }) => {
    const after = num(params.after)
    if (after !== undefined && (!Number.isInteger(after) || after < 0)) {
      throw err('general_argument_invalid', 'Param "after" must be a non-negative integer sequence.')
    }
    const limit = num(params.limit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
      throw err('general_argument_invalid', 'Param "limit" must be between 1 and 500.')
    }
    const channels = channelFilter(params.channels)
    const events = await ctx.realtime.listCustomEvents(ctx.caller, { channels, after: after ?? 0, limit: limit ?? 100 })
    return json({ total: events.length, events, next: events.at(-1)?.seq ?? after ?? 0 })
  })
}
