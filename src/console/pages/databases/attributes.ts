import { err } from '~/lib/errors'
import type { Collection } from '~/schema/types'
import type { ConsoleRouter } from '~/console/context'
import { checked, lines, numberOrUndefined, value } from '~/console/forms'
import { html, type Html } from '~/console/html'
import { badge, destroy, emptyState, header, icon, listCard } from '~/console/ui'
import { COL, collectionHeader, collectionUrl, loadCollection, tabs } from './shared'

const TYPES: [string, string][] = [
  ['string', 'Text'],
  ['integer', 'Whole number'],
  ['double', 'Decimal number'],
  ['boolean', 'True / false'],
  ['datetime', 'Date and time'],
  ['email', 'Email'],
  ['url', 'URL'],
  ['enum', 'One of a list (enum)'],
]

/** Parse the value typed for a default/document field into the attribute's type. */
function typedDefault(type: string, raw: unknown): unknown {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  if (type === 'integer') return Number.parseInt(text, 10)
  if (type === 'double') return Number(text)
  if (type === 'boolean') return text === 'true'
  // datetime-local has no zone; the console shows and stores UTC.
  if (type === 'datetime' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) return new Date(`${text}Z`).toISOString()
  return text
}

const typeOf = (a: Collection['attributes'][number]) => (a.format && a.format !== '' ? a.format : a.type)

function attributeForm(c: Collection, a: Collection['attributes'][number] | null): Html {
  const type = a ? (a.format && a.format !== '' && a.format !== 'ip' ? a.format : a.type) : 'string'
  const d = a?.default === null || a?.default === undefined ? '' : a.default
  const show = (types: string) => html`data-show-for="${types}" data-for-select="type"`
  return html`<form method="post" action="${collectionUrl(c)}/attributes${a ? `/${encodeURIComponent(a.key)}` : ''}" class="card">
    <div class="fields">
      <label>Key<input name="key" class="mono" value="${a?.key ?? ''}" ${a ? 'readonly' : 'autofocus'} required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}" placeholder="title"><small>${a ? 'The key cannot change.' : 'The field name in every document, e.g. title or createdBy.'}</small></label>
      <label>Type<select name="type" data-show-by>${TYPES.map(([t, label]) => html`<option value="${t}" ${t === type ? 'selected' : ''}>${label}</option>`)}</select>${a ? html`<small>Changing the type rebuilds the table and keeps the data.</small>` : ''}</label>
    </div>
    <div ${show('string')}><label>Maximum length<input name="size" type="number" min="1" value="${a?.size ?? 255}"><small>Characters. Over 255 shows a multi-line box in the document form.</small></label></div>
    <div class="fields" ${show('integer double')}>
      <label>Minimum<input name="min" type="number" step="any" value="${a?.min ?? ''}" placeholder="No minimum"></label>
      <label>Maximum<input name="max" type="number" step="any" value="${a?.max ?? ''}" placeholder="No maximum"></label>
    </div>
    <div ${show('enum')}><label>Allowed values<textarea name="elements" class="mono" rows="3" placeholder="draft&#10;published&#10;archived">${a?.elements?.join('\n') ?? ''}</textarea><small>One per line.</small></label></div>
    <label class="check"><input type="checkbox" name="required" ${a?.required ? 'checked' : ''}>Required<small>&nbsp;· every document must have a value</small></label>
    <label class="check"><input type="checkbox" name="array" ${a?.array ? 'checked' : ''}>List of values<small>&nbsp;· an array, e.g. tags</small></label>
    <div ${show('string email url enum')}><label>Default<input name="default" data-disable-when="required" value="${String(d)}" placeholder="Empty means no default"><small>Used when a document leaves it out. Not allowed on required attributes.</small></label></div>
    <div ${show('integer double')}><label>Default<input name="default" type="number" step="any" data-disable-when="required" value="${String(d)}" placeholder="Empty means no default"><small>Not allowed on required attributes.</small></label></div>
    <div ${show('boolean')}><label>Default<select name="default" data-disable-when="required"><option value="" ${d === '' ? 'selected' : ''}>No default</option><option value="true" ${d === true ? 'selected' : ''}>True</option><option value="false" ${d === false ? 'selected' : ''}>False</option></select><small>Not allowed on required attributes.</small></label></div>
    <div ${show('datetime')}><label>Default (UTC)<input name="default" type="datetime-local" step="1" data-disable-when="required" value="${typeof d === 'string' && d ? new Date(d).toISOString().slice(0, 19) : ''}"><small>Not allowed on required attributes.</small></label></div>
    <div class="foot"><a class="btn" href="${collectionUrl(c)}/attributes">Cancel</a><button class="primary">${a ? 'Save' : 'Add attribute'}</button></div>
  </form>`
}

function attributeFromForm(form: Record<string, any>) {
  const type = value(form, 'type') || 'string'
  const base = ['email', 'url', 'enum'].includes(type) ? 'string' : type
  return {
    key: value(form, 'key'),
    type: base,
    format: base === type ? '' : type,
    required: checked(form.required),
    array: checked(form.array),
    size: base === 'string' ? numberOrUndefined(form.size) ?? 255 : undefined,
    min: numberOrUndefined(form.min),
    max: numberOrUndefined(form.max),
    elements: type === 'enum' ? lines(form.elements) : undefined,
    // Several typed default inputs share the name; the visible one is the last non-empty value.
    default: checked(form.required) ? null : typedDefault(base, [form.default ?? ''].flat().filter((v: unknown) => String(v ?? '').trim() !== '').pop()),
  }
}

export function attributePages(router: ConsoleRouter): void {
  router.get(`${COL}/attributes`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    return ctx.render(
      c.name,
      'databases',
      html`${collectionHeader(
        ctx,
        c,
        c.attributes.length ? html`<a class="btn primary" href="${collectionUrl(c)}/attributes/new">${icon('plus')}<span>Add attribute</span></a>` : undefined,
      )}${tabs(c, 'attributes')}
      ${listCard('attributes', {
        body: c.attributes.length
          ? html`<div class="scroll"><table><thead><tr><th>Attribute</th><th>Type</th><th class="hide-sm">Required</th><th class="hide-sm">Default</th><th class="hide-sm">Limits</th><th></th></tr></thead><tbody>
            ${c.attributes.map((a) => html`<tr><td><a class="mono" href="${collectionUrl(c)}/attributes/${encodeURIComponent(a.key)}">${a.key}</a></td>
              <td>${typeOf(a)}${a.array ? '[]' : ''}</td><td class="hide-sm">${a.required ? badge('Required', 'attention') : ''}</td>
              <td class="clip mono hide-sm subdued">${a.default === null || a.default === undefined ? '' : JSON.stringify(a.default)}</td>
              <td class="subdued hide-sm">${a.type === 'string' && a.format !== 'enum' ? `≤ ${a.size}` : a.elements ? a.elements.join(', ') : a.min !== undefined || a.max !== undefined ? `${a.min ?? '−∞'} … ${a.max ?? '∞'}` : ''}</td>
              <td class="num">${destroy(`${collectionUrl(c)}/attributes/${encodeURIComponent(a.key)}/delete`, 'Delete', `Delete ${a.key}? Its data in every document is removed.`)}</td></tr>`)}
            </tbody></table></div>`
          : emptyState('No attributes yet', 'Attributes are the fields every document has.', html`<a class="btn primary" href="${collectionUrl(c)}/attributes/new">Add attribute</a>`),
      })}`,
    )
  })

  router.get(`${COL}/attributes/new`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    return ctx.render('Add attribute', 'databases', html`${header('Add attribute', { back: `${collectionUrl(c)}/attributes`, subtitle: c.name })}${attributeForm(c, null)}`)
  })

  router.post(`${COL}/attributes`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    const changes = ctx.schema.saveAttribute(c.databaseId, c.id, attributeFromForm(ctx.form))
    return ctx.go(`${collectionUrl(c)}/attributes`, { tone: 'success', text: `Attribute added${changes.length ? '' : ' (no change)'}` })
  })

  router.get(`${COL}/attributes/:key`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    const a = c.attributeMap.get(path.key!)
    if (!a) throw err('attribute_not_found', undefined, [path.key])
    return ctx.render(a.key, 'databases', html`${header(a.key, { back: `${collectionUrl(c)}/attributes`, subtitle: c.name })}${attributeForm(c, a)}`)
  })

  router.post(`${COL}/attributes/:key`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    ctx.schema.saveAttribute(c.databaseId, c.id, { ...attributeFromForm(ctx.form), key: path.key }, true)
    return ctx.go(`${collectionUrl(c)}/attributes`, { tone: 'success', text: 'Attribute saved' })
  })

  router.post(`${COL}/attributes/:key/delete`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    ctx.schema.deleteAttribute(c.databaseId, c.id, path.key!)
    return ctx.go(`${collectionUrl(c)}/attributes`, { tone: 'success', text: 'Attribute deleted' })
  })
}
