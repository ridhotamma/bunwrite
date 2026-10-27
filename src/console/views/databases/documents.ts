/**
 * Presentation for the document list and form. These functions render data
 * they are given; loading data and handling writes stays in pages/databases.
 */
import type { Collection } from '~/schema/types'
import type { ConsoleContext } from '~/console/context'
import { html, type Html } from '~/console/html'
import { DOCUMENT_ACTIONS, permissionsField } from '~/console/permissions'
import { alert, badge, emptyState, listCard, pager, searchForm, when } from '~/console/ui'
import { collectionHeader, collectionUrl, tabs } from '~/console/pages/databases/shared'

type Attr = Collection['attributes'][number]

/** What the field accepts, in words: "Text · up to 255 characters". */
function describe(a: Attr): string {
  const kind =
    a.format === 'enum' ? 'One of the listed values'
    : a.format === 'email' ? 'Email address'
    : a.format === 'url' ? 'URL'
    : a.format === 'ip' ? 'IP address'
    : a.type === 'string' ? `Text · up to ${(a.size ?? 255).toLocaleString('en-US')} characters`
    : a.type === 'integer' ? 'Whole number'
    : a.type === 'double' ? 'Number'
    : a.type === 'boolean' ? 'True or false'
    : 'Date and time (UTC)'
  const range = (a.type === 'integer' || a.type === 'double') && (a.min !== undefined || a.max !== undefined) ? ` · ${a.min ?? '−∞'} to ${a.max ?? '∞'}` : ''
  return `${kind}${range}${a.array ? ' · one per line' : ''}`
}

/** A stored datetime as the value of a datetime-local input, in UTC. */
function localValue(v: unknown): string {
  if (typeof v !== 'string' || !v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 19)
}

function shown(a: Attr, v: unknown): string {
  if (v === null || v === undefined) return ''
  return a.type === 'datetime' ? localValue(v) : String(v)
}

function fieldWidget(a: Attr, v: unknown): Html {
  const name = `field:${a.key}`
  if (a.array) {
    const items = Array.isArray(v) ? v.map((x) => shown(a, x)) : []
    return html`<textarea name="${name}" class="mono" rows="3" spellcheck="false" placeholder="${a.format === 'enum' ? (a.elements ?? []).join('\n') : ''}">${items.join('\n')}</textarea>`
  }
  if (a.format === 'enum') {
    return html`<select name="${name}">${a.required ? '' : html`<option value="">Not set</option>`}${(a.elements ?? []).map((e) => html`<option ${e === v ? 'selected' : ''}>${e}</option>`)}</select>`
  }
  if (a.type === 'boolean') {
    return html`<select name="${name}">${a.required ? '' : html`<option value="" ${v === null || v === undefined ? 'selected' : ''}>Not set</option>`}<option value="true" ${v === true ? 'selected' : ''}>True</option><option value="false" ${v === false ? 'selected' : ''}>False</option></select>`
  }
  if (a.type === 'integer' || a.type === 'double') {
    return html`<input name="${name}" type="number" step="${a.type === 'integer' ? '1' : 'any'}" ${a.min !== undefined ? html`min="${a.min}"` : ''} ${a.max !== undefined ? html`max="${a.max}"` : ''} value="${shown(a, v)}">`
  }
  if (a.type === 'datetime') {
    return html`<div class="doc-inline"><input name="${name}" type="datetime-local" step="1" value="${shown(a, v)}"><button type="button" class="small" data-doc-now>Now</button></div>`
  }
  const type = a.format === 'email' ? 'email' : a.format === 'url' ? 'url' : 'text'
  if (a.type === 'string' && !a.format && (a.size ?? 255) > 255) {
    return html`<textarea name="${name}" rows="3" maxlength="${a.size}">${shown(a, v)}</textarea>`
  }
  return html`<input name="${name}" type="${type}" ${a.type === 'string' && a.size ? html`maxlength="${a.size}"` : ''} value="${shown(a, v)}">`
}

export function documentFormView(ctx: ConsoleContext, c: Collection, doc: Record<string, unknown> | null): Html {
  const data: Record<string, unknown> = {}
  for (const a of c.attributes) data[a.key] = doc ? doc[a.key] : (a.default ?? (a.array ? [] : null))
  const action = doc ? `${collectionUrl(c)}/documents/${encodeURIComponent(String(doc.$id))}` : `${collectionUrl(c)}/documents`
  const schema = c.attributes.map((a) => ({ key: a.key, type: a.type, array: a.array }))
  return html`<form method="post" action="${action}" class="layout">
    <div class="card docform" data-docform="${JSON.stringify(schema)}">
      <div class="docform-head"><h2>Data</h2>
        <div class="seg" role="tablist"><button type="button" class="on" data-doc-tab="form" role="tab" aria-selected="true">Form</button><button type="button" data-doc-tab="json" role="tab" aria-selected="false">JSON</button></div></div>
      ${doc ? '' : html`<label>Document ID<input name="id" class="mono" value="unique()"><small>Keep <code>unique()</code> to generate one, or type your own.</small></label>`}
      <div class="doc-fields">
        ${c.attributes.length
          ? c.attributes.map((a) => html`<label class="doc-field" data-key="${a.key}">
              <span class="doc-label"><span class="mono">${a.key}</span>${a.required ? badge('Required', 'attention') : ''}</span>
              ${fieldWidget(a, data[a.key])}
              <small>${describe(a)}</small>
            </label>`)
          : html`<p class="subdued">This collection has no attributes yet. <a href="${collectionUrl(c)}/attributes/new">Add one</a> first.</p>`}
      </div>
      <div class="doc-json" hidden>
        <textarea name="data" class="mono tall" spellcheck="false" aria-label="Document JSON">${JSON.stringify(data, null, 2)}</textarea>
        <small class="help">Fields not in the form stay as they are. Switch back to Form to see the changes.</small>
      </div>
      <p class="perm-error doc-error" hidden></p>
      <div class="foot"><a class="btn" href="${collectionUrl(c)}/documents">Cancel</a><button class="primary">${doc ? 'Save' : 'Create'}</button></div>
    </div>
    <div>
      <div class="card"><h2>Permissions</h2>
        ${c.documentSecurity
          ? ''
          : alert('warning', html`Row security is off for this collection, so these permissions are not used: only the <a href="${collectionUrl(c)}/settings">collection permissions</a> apply.`)}
        ${permissionsField(ctx, {
          value: (doc?.$permissions as string[]) ?? [],
          actions: DOCUMENT_ACTIONS,
          note: html`Who can see and change this document, on top of the collection permissions.`,
        })}
      </div>
      ${doc ? html`<div class="card"><h2>Details</h2><ul class="list">
        <li><span class="subdued">ID</span><span class="mono">${doc.$id}</span></li>
        <li><span class="subdued">Sequence</span><span>${doc.$sequence}</span></li>
        <li><span class="subdued">Created</span><span>${when(doc.$createdAt as string | null)}</span></li>
        <li><span class="subdued">Updated</span><span>${when(doc.$updatedAt as string | null)}</span></li></ul></div>` : ''}
    </div>
  </form>`
}

export interface DocumentsListView {
  collection: Collection
  documents: Record<string, unknown>[]
  total: number
  page: number
  pages: number
  filter: string
  filterError: string
}

export function documentsListView(ctx: ConsoleContext, view: DocumentsListView): Html {
  const { collection: c, documents, total, page, pages, filter, filterError } = view
  const shown = c.attributes.slice(0, 4)
  const cell = (v: unknown) => (v === null || v === undefined ? html`<span class="subdued">—</span>` : typeof v === 'object' ? JSON.stringify(v) : String(v))
  const toolbar = searchForm({
    action: `${collectionUrl(c)}/documents`,
    target: 'docs',
    name: 'q',
    value: filter,
    placeholder: 'Filter by document ID or query JSON',
    title: 'e.g. {"method":"equal","attribute":"status","values":["active"]}',
    delay: 400,
    submit: 'Filter',
    mono: true,
  })
  const body = html`${filterError ? alert('critical', html`${filterError}`, { style: 'margin:12px' }) : ''}
    ${documents.length
      ? html`<div class="scroll"><table><thead><tr><th>ID</th>${shown.map((a, i) => html`<th class="${i > 1 ? 'hide-sm' : ''}">${a.key}</th>`)}<th class="hide-sm">Updated</th></tr></thead><tbody>
        ${documents.map((d) => html`<tr class="row-link" onclick="location='${collectionUrl(c)}/documents/${encodeURIComponent(String(d.$id))}'"><td class="mono"><a href="${collectionUrl(c)}/documents/${encodeURIComponent(String(d.$id))}">${d.$id}</a></td>
          ${shown.map((a, i) => html`<td class="clip ${i > 1 ? 'hide-sm' : ''}">${cell(d[a.key])}</td>`)}<td class="hide-sm">${when(d.$updatedAt as string | null)}</td></tr>`)}
        </tbody></table></div>`
      : emptyState(
          filter ? 'No matching documents' : 'No documents yet',
          filter ? 'Try a different filter.' : c.attributes.length ? 'Create one here, or let your apps write them.' : 'Add attributes first, then documents.',
        )}`
  const footer = documents.length
    ? pager({
        page,
        pages,
        params: { q: filter },
        always: true,
        label: html`Page ${page} of ${pages} · ${total.toLocaleString('en-US')}${total >= 5000 ? '+' : ''} documents`,
      })
    : html``
  return html`${collectionHeader(ctx, c, html`<a class="btn primary" href="${collectionUrl(c)}/documents/new">Create document</a>`)}
    ${tabs(c, 'documents')}
    ${listCard('docs', { toolbar, body, footer })}`
}
