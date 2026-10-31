/** Dedicated API page: endpoint, project ID and server API keys. */
import { dialog } from '~/console/dialog'
import type { ConsoleContext } from '~/console/context'
import { html, raw, type Html } from '~/console/html'
import { badge, destroy, emptyState, header, icon, settingsSection, when } from '~/console/ui'
import { API_KEY_SCOPE_GROUPS } from '~/settings/scopes'

export const API = '/console/api'

const scopeCount = (n: number) => `${n} scope${n === 1 ? '' : 's'}`

/**
 * Grouped scope picker. A group header can select the whole group, and the
 * client script keeps the counts in sync. "Full access" disables the list
 * instead of hiding it, so turning it back off restores the selection.
 */
function scopeField(): Html {
  const total = API_KEY_SCOPE_GROUPS.reduce((sum, group) => sum + group.scopes.length, 0)
  return html`<fieldset class="scope-picker">
    <legend>Scopes</legend>
    <label class="scope-full">
      <input type="checkbox" name="full" data-scope-full>
      <span><b>Full access</b><span class="subdued">Every project API, including future ones. Not recommended for an app-specific key.</span></span>
    </label>
    <p class="hint">Or pick only what this app needs. Calls outside these scopes return <code>general_unauthorized_scope</code>.</p>
    <div class="scope-toolbar">
      <span class="scope-total" data-scope-total>0 of ${total} selected</span>
      <button type="button" class="small" data-scope-clear>Clear</button>
    </div>
    <div class="scope-groups">
      ${API_KEY_SCOPE_GROUPS.map(
        (group, index) => html`<section class="scope-group">
          <div class="scope-group-head">
            <button type="button" class="scope-group-toggle" data-scope-toggle aria-expanded="false" aria-controls="scope-group-${index}">
              <span class="scope-chevron" aria-hidden="true"></span>
              <span class="scope-group-name">${group.label}</span>
              <span class="scope-group-count" data-scope-group-count>0/${group.scopes.length}</span>
            </button>
            <label class="scope-all"><input type="checkbox" data-scope-all aria-label="Select all ${group.label} scopes">All</label>
          </div>
          <div class="scope-list" id="scope-group-${index}" hidden>
            ${group.scopes.map(
              (scope) => html`<label class="scope-item">
                <input type="checkbox" name="scopes" value="${scope.id}">
                <span class="scope-item-text"><span class="scope-item-label">${scope.label}</span><span class="scope-item-code mono">${scope.id}</span></span>
              </label>`,
            )}
          </div>
        </section>`,
      )}
    </div>
  </fieldset>`
}

function createKeyDialog(): Html {
  return dialog({
    id: 'api-key-create',
    title: 'Create API key',
    wide: true,
    body: html`<p class="dialog-message">Use one key per app, so each can be rotated or revoked on its own.</p>
      <form id="api-key-create-form" method="post" action="${API}/keys">
        <div class="fields">
          <label>Name<input name="name" required placeholder="Dashboard server"></label>
          <label>Expires<input name="expire" type="date"><small>Optional. Works until the end of this day (UTC).</small></label>
        </div>
        ${scopeField()}
      </form>`,
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="api-key-create-form" class="primary">Create key</button>`,
  })
}

function keyScopes(scopes: string[] | null): Html {
  if (!scopes) return badge('Full access', 'attention')
  const groups = API_KEY_SCOPE_GROUPS.filter((group) => group.scopes.some((scope) => scopes.includes(scope.id))).map((group) => group.label)
  const shown = `${groups.slice(0, 2).join(', ')}${groups.length > 2 ? ` +${groups.length - 2}` : ''}`
  const labels = API_KEY_SCOPE_GROUPS.flatMap((group) => group.scopes)
    .filter((scope) => scopes.includes(scope.id))
    .map((scope) => scope.label)
  return html`<span class="key-scopes" title="${labels.join(', ')}"><span>${scopeCount(scopes.length)}</span><span class="subdued"> · ${shown}</span></span>`
}

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
  const create = html`<button class="primary" type="button" data-dialog-open="#api-key-create">${icon('plus')}<span>Create key</span></button>`
  return html`${header('API', { actions: create })}
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
      'Server keys are scoped: give each app only the operations it needs. Create one per app so it can be rotated or revoked on its own; a new key is shown once.',
      keys.length
        ? html`<div class="scroll"><table><thead><tr><th>Name</th><th class="hide-sm">Key</th><th>Scopes</th><th>Last used</th><th class="hide-sm">Expires</th><th></th></tr></thead><tbody>
          ${keys.map(
            (k) => html`<tr><td>${k.name}</td><td class="mono hide-sm">${k.hint}…</td><td>${keyScopes(k.scopes)}</td><td>${k.accessed_at ? when(k.accessed_at) : 'Never'}</td><td class="hide-sm">${k.expire ? when(k.expire) : 'Never'}</td>
              <td class="num">${destroy(`${API}/keys/${k.id}/delete`, 'Revoke', `Revoke ${k.name}? Apps using it stop working.`)}</td></tr>`,
          )}</tbody></table></div>`
        : emptyState('No API keys yet', 'Create one for each app that talks to the API. Revoking one key leaves the others working.', create),
      { id: 'keys' },
    )}
    ${createKeyDialog()}
    ${created ? keyDialog(created) : ''}
    <script>${raw(API_KEY_SCRIPT)}</script>`
}

/** Counts, group selects and clearing for the scope picker; event delegation survives htmx. */
const API_KEY_SCRIPT = `
(() => {
  if (window.__bunwriteApiScopes) return
  window.__bunwriteApiScopes = true

  function setOpen(toggle, open) {
    const group = toggle.closest(".scope-group")
    const list = group ? group.querySelector(".scope-list") : null
    toggle.setAttribute("aria-expanded", open ? "true" : "false")
    if (list) list.hidden = !open
  }

  function refresh(picker) {
    const full = picker.querySelector("[data-scope-full]")
    const groups = [...picker.querySelectorAll(".scope-group")]
    let selected = 0
    let total = 0
    for (const group of groups) {
      const boxes = [...group.querySelectorAll('input[name="scopes"]')]
      const checked = boxes.filter((box) => box.checked).length
      selected += checked
      total += boxes.length
      const count = group.querySelector("[data-scope-group-count]")
      if (count) count.textContent = checked + "/" + boxes.length
      const all = group.querySelector("[data-scope-all]")
      if (all) {
        all.disabled = full.checked
        all.checked = boxes.length > 0 && checked === boxes.length
        all.indeterminate = checked > 0 && checked < boxes.length
      }
      for (const box of boxes) box.disabled = full.checked
    }
    const totalLabel = picker.querySelector("[data-scope-total]")
    if (totalLabel) totalLabel.textContent = selected + " of " + total + " selected"
    const list = picker.querySelector(".scope-groups")
    if (list) list.classList.toggle("is-disabled", full.checked)
  }

  document.addEventListener("change", (event) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement)) return
    const picker = target.closest(".scope-picker")
    if (!picker) return
    if (target.matches("[data-scope-all]")) {
      const group = target.closest(".scope-group")
      if (group) for (const box of group.querySelectorAll('input[name="scopes"]')) box.checked = target.checked
    }
    refresh(picker)
  })

  function init() {
    for (const picker of document.querySelectorAll(".scope-picker")) {
      for (const group of picker.querySelectorAll(".scope-group")) {
        const toggle = group.querySelector("[data-scope-toggle]")
        if (toggle && group.querySelector('input[name="scopes"]:checked')) setOpen(toggle, true)
      }
      refresh(picker)
    }
  }

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return
    // A restored form can bring checked scopes back; sync once the dialog is open.
    if (event.target.closest('[data-dialog-open="#api-key-create"]')) setTimeout(init, 0)
    const toggle = event.target.closest("[data-scope-toggle]")
    if (toggle) {
      setOpen(toggle, toggle.getAttribute("aria-expanded") !== "true")
      return
    }
    const clear = event.target.closest("[data-scope-clear]")
    if (!clear) return
    const picker = clear.closest(".scope-picker")
    if (!picker) return
    for (const box of picker.querySelectorAll('input[name="scopes"]')) box.checked = false
    refresh(picker)
  })

  init()
})()
`
