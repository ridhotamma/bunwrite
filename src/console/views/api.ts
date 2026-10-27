/** Dedicated API page: endpoint, project ID and server API keys. */
import { dialog } from '~/console/dialog'
import type { ConsoleContext } from '~/console/context'
import { html, type Html } from '~/console/html'
import { destroy, header, icon, settingsSection, when } from '~/console/ui'

export const API = '/console/api'

function keyDialog(secret: string): Html {
  return dialog({
    id: 'api-key-dialog',
    title: 'API key created',
    open: true,
    body: html`<p class="dialog-message">Copy this key now. It is not shown again.</p>
      <label>Key<input id="api-key-value" class="mono" readonly autocomplete="off" spellcheck="false" value="${secret}"></label>`,
    actions: html`<button type="button" data-copy-target="#api-key-value">${icon('copy')}<span data-copy-label>Copy key</span></button><button type="button" class="primary" data-dialog-close>Done</button>`,
  })
}

export function apiView(ctx: ConsoleContext, created?: string): Html {
  const keys = ctx.services.settings.listKeys()
  return html`${header('API', { subtitle: ctx.currentProject.name })}
    ${settingsSection(
      'Endpoint',
      'Apps connect with this endpoint and project ID using the Appwrite SDKs or the REST API.',
      html`<div class="fields">
        <label>API endpoint<div class="copy-row"><input id="api-endpoint" class="mono" readonly value="${ctx.services.config.publicEndpoint}"><button type="button" data-copy-target="#api-endpoint">${icon('copy')}<span data-copy-label>Copy</span></button></div></label>
        <label>Project ID<div class="copy-row"><input id="api-project-id" class="mono" readonly value="${ctx.services.config.projectId}"><button type="button" data-copy-target="#api-project-id">${icon('copy')}<span data-copy-label>Copy</span></button></div></label>
      </div>`,
      { id: 'endpoint' },
    )}
    ${settingsSection(
      'API keys',
      'Server keys with full access. Create one per app so it can be rotated or revoked on its own; a new key is shown once.',
      html`${keys.length
        ? html`<div class="scroll"><table><thead><tr><th>Name</th><th class="hide-sm">Key</th><th>Last used</th><th class="hide-sm">Expires</th><th></th></tr></thead><tbody>
          ${keys.map((k) => html`<tr><td>${k.name}</td><td class="mono hide-sm">${k.hint}…</td><td>${when(k.accessed_at)}</td><td class="hide-sm">${k.expire ? when(k.expire) : 'Never'}</td>
            <td class="num">${destroy(`${API}/keys/${k.id}/delete`, 'Revoke', `Revoke ${k.name}? Apps using it stop working.`)}</td></tr>`)}</tbody></table></div>`
        : html`<p class="hint" style="margin:0 0 12px">No API keys yet. Create one for each app that talks to the API.</p>`}
      <form method="post" action="${API}/keys" style="margin-top:12px" hx-push-url="false">
        <div class="fields"><label>Name<input name="name" required placeholder="Dashboard server"></label><label>Expires<input name="expire" type="date"><small>Optional.</small></label></div>
        <div class="foot"><button class="primary">Create key</button></div>
      </form>`,
      { id: 'keys' },
    )}
    ${created ? keyDialog(created) : ''}`
}
