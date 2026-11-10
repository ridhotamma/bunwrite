/** Realtime console page: publish custom events, replay history and inspect presence. */
import { keyCaller } from '~/auth/caller'
import type { ConsoleContext } from '~/console/context'
import { html, type Html } from '~/console/html'
import { badge, destroy, emptyState, header, settingsSection, when } from '~/console/ui'

export const REALTIME = '/console/realtime'

const payloadPreview = (payload: unknown) => {
  const text = JSON.stringify(payload)
  return text.length > 120 ? `${text.slice(0, 117)}…` : text
}

export async function realtimeView(ctx: ConsoleContext): Promise<Html> {
  const presence = await ctx.services.realtime.listPresence(100)
  const history = await ctx.services.realtime.listCustomEvents(keyCaller(), { limit: 50 })

  return html`${header('Realtime')}
    ${settingsSection(
      'Publish a custom event',
      'Server-published events are delivered to subscribers of the selected custom channels and kept for replay. Channels use custom.public.*, custom.authenticated.*, custom.user.<id>, custom.team.<id> or custom.label.<label>.',
      html`<form method="post" action="${REALTIME}/publish" class="stack-fields">
        <div class="fields two">
          <label>Channels<input name="channels" required placeholder="custom.public.news"><small>Comma-separated custom channels.</small></label>
          <label>Event names<input name="events" placeholder="news.created"><small>Optional, comma-separated. Defaults to the channel names.</small></label>
        </div>
        <label>Payload<textarea name="payload" rows="4" class="mono" placeholder='{ "title": "Hello" }'></textarea><small>JSON object, up to 64 kB.</small></label>
        <div class="form-actions"><button class="primary">Publish event</button></div>
      </form>`,
      { id: 'publish' },
    )}
    ${settingsSection(
      'Presence',
      'Active presence rows. A row disappears when its socket closes or after 60 seconds without a client ping.',
      presence.length
        ? html`<div class="scroll"><table><thead><tr><th>Presence</th><th>User</th><th>Status</th><th class="hide-sm">Metadata</th><th class="hide-sm">Updated</th><th class="hide-sm">Expires</th><th></th></tr></thead><tbody>
          ${presence.map(
            (row) => html`<tr><td class="mono">${row.$id}</td><td class="mono">${row.userId}</td><td>${badge(row.status)}</td><td class="mono hide-sm">${payloadPreview(row.metadata ?? {})}</td><td class="hide-sm">${when(row.$updatedAt)}</td><td class="hide-sm">${when(row.$expiresAt)}</td><td class="num">${destroy(`${REALTIME}/presence/${encodeURIComponent(row.$id)}/delete`, 'Remove', `Remove presence ${row.$id}?`)}</td></tr>`,
          )}</tbody></table></div>`
        : emptyState('No active presence', 'Presence appears when a signed-in client calls upsertPresence on a realtime socket.'),
      { id: 'presence' },
    )}
    ${settingsSection(
      'Recent custom events',
      'The replay buffer. Clients can fetch these with GET /v1/realtime/events and continue from the last sequence they saw.',
      history.length
        ? html`<div class="scroll"><table><thead><tr><th>Seq</th><th>Channels</th><th>Events</th><th class="hide-sm">Payload</th><th class="hide-sm">Created</th></tr></thead><tbody>
          ${history.map(
            (event) => html`<tr><td class="mono">${event.seq}</td><td class="mono">${event.channels.join(', ')}</td><td class="mono">${event.events.join(', ')}</td><td class="mono hide-sm">${payloadPreview(event.payload)}</td><td class="hide-sm">${when(event.timestamp)}</td></tr>`,
          )}</tbody></table></div>`
        : emptyState('No custom events yet', 'Publish one above, or call POST /v1/realtime/publish from your server.'),
      { id: 'history' },
    )}`
}
