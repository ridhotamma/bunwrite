/** Shared variable list with inline editing and delete-all, used by global and per-function variables. */
import { html, type Html } from '~/console/html'
import { destroy } from '~/console/ui'

export interface VariableEntry {
  key: string
  value: string
  secret: number
}

export interface VariableListOptions {
  /** POST route that deletes one variable (receives `key`). */
  action: string
  /** POST route that saves one variable (receives `key`, `value`, `secret`); upserts. */
  save: string
  /** Shown when the remove button confirms. Defaults to `Remove <key>?`. */
  removeConfirm?: (key: string) => string
  /** Delete-all button; omitted when undefined. */
  clear?: { action: string; label: string; confirm: string }
}

/** Each row shows the key and value with an inline Edit toggle and a Remove button. */
export function variableList(vars: VariableEntry[], options: VariableListOptions): Html {
  return html`${options.clear
      ? html`<form method="post" action="${options.clear.action}" class="inline" data-confirm="${options.clear.confirm}" data-confirm-label="${options.clear.label}" data-confirm-tone="critical" style="display:block;text-align:right;margin-bottom:8px"><button class="critical plain" ${vars.length ? '' : 'disabled'}>${options.clear.label}</button></form>`
      : ''}
    <ul class="list">${vars.map(
      (v) => html`<li class="var-row"><span class="mono">${v.key}</span><span>${v.secret ? html`<span class="subdued">••••••</span>` : html`<span class="mono clip">${v.value}</span>`}
          <details class="var-edit"><summary class="subdued">Edit</summary>
            <form method="post" action="${options.save}" class="var-edit-form"><input type="hidden" name="key" value="${v.key}">
              <input name="value" value="${v.secret ? '' : v.value}" placeholder="${v.secret ? 'New value, blank to keep' : 'Value'}">
              <label class="check"><input type="checkbox" name="secret" ${v.secret ? 'checked' : ''}>Hide</label>
              <button class="small">Save</button></form>
          </details>
          ${destroy(options.action, 'Remove', options.removeConfirm ? options.removeConfirm(v.key) : `Remove ${v.key}?`, { key: v.key })}</span></li>`,
    )}</ul>`
}
