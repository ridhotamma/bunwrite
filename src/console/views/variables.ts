/**
 * One variable manager for every scope: global project variables, a
 * function's own variables and a site's variables.
 *
 * The list is a table with Edit and Remove inline on each row; adding or
 * editing opens a dialog. Bulk import uses the env-file dialog.
 */
import { dialog } from '~/console/dialog'
import { envBulkDialog } from '~/console/env-vars'
import { html, type Html } from '~/console/html'
import { badge, icon, menu, plural } from '~/console/ui'
import { CONTEXT_LABELS, VARIABLE_CONTEXTS, type VariableContext } from '~/variables/context'

export interface VariableEntry {
  key: string
  value: string
  secret: number
  /** '' for every deployment, or live / preview. */
  context?: string
}

/** Live-only and preview-only values carry a badge; every-deployment ones do not. */
const contextBadge = (context: string | undefined): Html =>
  context === 'live' ? badge('Live only', 'success') : context === 'preview' ? badge('Previews only', 'attention') : html``

const contextPicker = (): Html => html`<label>Deployments<select name="context">${VARIABLE_CONTEXTS.map(
  (context) => html`<option value="${context}">${CONTEXT_LABELS[context]}</option>`,
)}</select><small>Previews are builds that do not go live, such as Git branches other than the production one. A live-only or preview-only value wins over an all-deployments one with the same name.</small></label>`

export interface VariableListOptions {
  /** Prefix for this list's dialog ids. One variable list per page today. */
  id: string
  /** POST route that saves one variable (receives `key`, `value`, `secret`); it upserts. */
  save: string
  /** POST route that deletes one variable (receives `key`). */
  remove: string
  addLabel?: string
  bulk?: { id: string; title: string; action: string }
  clear?: { action: string; confirm: string }
  empty?: Html
}

const editId = (options: VariableListOptions, index: number) => `${options.id}-edit-${index}`
const addId = (options: VariableListOptions) => `${options.id}-add`

const valueCell = (v: VariableEntry): Html =>
  v.secret ? html`<span class="subdued">••••••</span>` : v.value ? html`<span class="mono">${v.value}</span>` : html`<span class="subdued">(empty)</span>`

function addDialog(options: VariableListOptions): Html {
  const id = addId(options)
  const form = `${id}-form`
  return dialog({
    id,
    title: options.addLabel ?? 'Add variable',
    body: html`<form id="${form}" method="post" action="${options.save}" class="stack-fields">
      <label>Name<input name="key" class="mono" required pattern="[A-Za-z_][A-Za-z0-9_]*" placeholder="API_KEY"><small>Letters, numbers and underscores; cannot start with a number.</small></label>
      <label>Value<input name="value" placeholder="Value"></label>
      ${contextPicker()}
      <label class="check"><input type="checkbox" name="secret" checked>Hide the value</label>
    </form>`,
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="${form}" class="primary">Add variable</button>`,
  })
}

function editDialog(v: VariableEntry, index: number, options: VariableListOptions): Html {
  const id = editId(options, index)
  const form = `${id}-form`
  return dialog({
    id,
    title: `Edit ${v.key}`,
    body: html`<form id="${form}" method="post" action="${options.save}" class="stack-fields">
      <input type="hidden" name="key" value="${v.key}">
      <input type="hidden" name="context" value="${v.context ?? ''}">
      <label>Name<input value="${v.key}" class="mono" readonly></label>
      <label>Deployments<input value="${CONTEXT_LABELS[(v.context ?? '') as VariableContext] ?? v.context}" readonly></label>
      <label>Value<input name="value" value="${v.secret ? '' : v.value}" placeholder="${v.secret ? 'Leave blank to keep the current value' : 'Value'}">${v.secret ? html`<small>The current value is hidden. Leave it blank to keep it.</small>` : ''}</label>
      <label class="check"><input type="checkbox" name="secret" ${v.secret ? 'checked' : ''}>Hide the value</label>
    </form>`,
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="${form}" class="primary">Save</button>`,
  })
}

function removeForm(v: VariableEntry, options: VariableListOptions): Html {
  return html`<form method="post" action="${options.remove}" class="inline" data-confirm="Remove ${v.key}?" data-confirm-label="Remove" data-confirm-tone="critical">
    <input type="hidden" name="key" value="${v.key}">
    <input type="hidden" name="context" value="${v.context ?? ''}">
    <button class="critical small">Remove</button>
  </form>`
}

export function variableList(vars: VariableEntry[], options: VariableListOptions): Html {
  return html`
    <div class="var-toolbar">
      <span class="var-count">${plural(vars.length, 'variable')}</span>
      <div class="var-toolbar-actions">
        ${options.bulk ? html`<button type="button" class="btn" data-dialog-open="#${options.bulk.id}">${icon('upload-simple')}<span>Bulk upload</span></button>` : ''}
        <button type="button" class="btn primary" data-dialog-open="#${addId(options)}">${icon('plus')}<span>${options.addLabel ?? 'Add variable'}</span></button>
      </div>
    </div>
    ${vars.length
      ? html`<div class="scroll"><table class="var-table">
          <thead><tr><th>Name</th><th>Value</th><th class="var-actions-col">${options.clear
            ? menu(
                html`<form method="post" action="${options.clear.action}" data-confirm="${options.clear.confirm}" data-confirm-label="Delete all" data-confirm-tone="critical"><button class="critical">Delete all</button></form>`,
                { label: 'Variable actions', align: 'end' },
              )
            : ''}</th></tr></thead>
          <tbody>${vars.map(
            (v, index) => html`<tr>
              <td class="var-name" title="${v.key}"><span class="mono">${v.key}</span>${contextBadge(v.context)}</td>
              <td class="clip" title="${v.secret ? '' : v.value}">${valueCell(v)}</td>
              <td class="var-actions">
                <button type="button" class="btn small" data-dialog-open="#${editId(options, index)}">Edit</button>
                ${removeForm(v, options)}
              </td>
            </tr>`,
          )}</tbody>
        </table></div>`
      : options.empty ?? html`<p class="hint">No variables yet.</p>`}
    ${addDialog(options)}
    ${vars.map((v, index) => editDialog(v, index, options))}
    ${options.bulk ? envBulkDialog(options.bulk) : ''}`
}
