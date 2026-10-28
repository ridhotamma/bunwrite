/**
 * The variable list used by global and per-function variables: each row shows
 * the key and value with an inline editor and a remove button, and the whole
 * list can be emptied at once.
 */
import { html, type Html } from '~/console/html'
import { destroy } from '~/console/ui'

export interface VariableEntry {
  key: string
  value: string
  secret: number
}

export interface VariableListOptions {
  /** POST route that saves one variable (receives `key`, `value`, `secret`); it upserts. */
  save: string
  /** POST route that deletes one variable (receives `key`). */
  remove: string
  /** Delete-all button, with the question it asks first. */
  clear?: { action: string; confirm: string }
}

/** A hidden value is shown as dots and edited through a blank field, so it is never revealed. */
const valueCell = (v: VariableEntry): Html => (v.secret ? html`<span class="subdued">••••••</span>` : html`<span class="mono clip">${v.value}</span>`)

function editor(v: VariableEntry, save: string): Html {
  return html`<details class="var-edit"><summary>Edit</summary>
    <form method="post" action="${save}" class="var-edit-form">
      <input type="hidden" name="key" value="${v.key}">
      <input name="value" value="${v.secret ? '' : v.value}" placeholder="${v.secret ? 'New value, blank to keep' : 'Value'}">
      <label class="check"><input type="checkbox" name="secret" ${v.secret ? 'checked' : ''}>Hide</label>
      <button class="small">Save</button>
    </form>
  </details>`
}

export function variableList(vars: VariableEntry[], options: VariableListOptions): Html {
  return html`${options.clear
      ? html`<form method="post" action="${options.clear.action}" class="var-toolbar" data-confirm="${options.clear.confirm}" data-confirm-label="Delete all" data-confirm-tone="critical"><button class="critical plain" ${vars.length ? '' : 'disabled'}>Delete all</button></form>`
      : ''}
    <ul class="list">${vars.map(
      (v) => html`<li class="var-row">
        <span class="mono">${v.key}</span>
        <span>${valueCell(v)}${editor(v, options.save)}${destroy(options.remove, 'Remove', `Remove ${v.key}?`, { key: v.key })}</span>
      </li>`,
    )}</ul>`
}
