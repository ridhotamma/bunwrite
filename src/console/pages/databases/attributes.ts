import { err } from '~/lib/errors'
import type { Collection } from '~/schema/types'
import type { ConsoleRouter } from '~/console/context'
import { checked, lines, numberOrUndefined, value } from '~/console/forms'
import { html, type Html } from '~/console/html'
import { badge, destroy, emptyState, header } from '~/console/ui'
import { COL, collectionHeader, collectionUrl, loadCollection, tabs } from './shared'

const TYPES = ['string', 'integer', 'double', 'boolean', 'datetime', 'email', 'url', 'enum']

/** Parse the value typed for a default/document field into the attribute's type. */
function typedDefault(type: string, raw: unknown): unknown {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  if (type === 'integer') return Number.parseInt(text, 10)
  if (type === 'double') return Number(text)
  if (type === 'boolean') return text === 'true'
  return text
}

const typeOf = (a: Collection['attributes'][number]) => (a.format && a.format !== '' ? a.format : a.type)

function attributeForm(c: Collection, a: Collection['attributes'][number] | null): Html {
  const type = a ? (a.format && a.format !== '' && a.format !== 'ip' ? a.format : a.type) : 'string'
  return html`<form method="post" action="${collectionUrl(c)}/attributes${a ? `/${encodeURIComponent(a.key)}` : ''}" class="card">
    <div class="fields">
      <label>Key<input name="key" class="mono" value="${a?.key ?? ''}" ${a ? 'readonly' : ''} required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}"></label>
      <label>Type<select name="type">${TYPES.map((t) => html`<option ${t === type ? 'selected' : ''}>${t}</option>`)}</select>${a ? html`<small>Changing the type rebuilds the table and keeps the data.</small>` : ''}</label>
    </div>
    <div class="fields">
      <label>Size<input name="size" type="number" min="1" value="${a?.size ?? 255}"><small>Characters, for text.</small></label>
      <label>Min<input name="min" type="number" step="any" value="${a?.min ?? ''}"></label>
      <label>Max<input name="max" type="number" step="any" value="${a?.max ?? ''}"></label>
    </div>
    <label>Enum values<input name="elements" value="${a?.elements?.join(', ') ?? ''}"><small>Comma-separated, for enum.</small></label>
    <label>Default<input name="default" class="mono" value="${a?.default === null || a?.default === undefined ? '' : String(a.default)}"><small>Not allowed on required attributes.</small></label>
    <label class="check"><input type="checkbox" name="required" ${a?.required ? 'checked' : ''}>Required</label>
    <label class="check"><input type="checkbox" name="array" ${a?.array ? 'checked' : ''}>Array</label>
    <div class="foot"><a class="btn" href="${collectionUrl(c)}/attributes">Cancel</a><button class="primary">${a ? 'Save' : 'Add'}</button></div>
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
    default: checked(form.required) ? null : typedDefault(base, form.default),
  }
}

export function attributePages(router: ConsoleRouter): void {
  router.get(`${COL}/attributes`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    return ctx.render(
      c.name,
      'databases',
      html`${collectionHeader(ctx, c, html`<a class="btn primary" href="${collectionUrl(c)}/attributes/new">Add attribute</a>`)}${tabs(c, 'attributes')}
      <div class="card flush">
        ${c.attributes.length
          ? html`<div class="scroll"><table><thead><tr><th>Key</th><th>Type</th><th class="hide-sm">Required</th><th class="hide-sm">Default</th><th class="hide-sm">Limits</th><th></th></tr></thead><tbody>
            ${c.attributes.map((a) => html`<tr><td class="mono"><a href="${collectionUrl(c)}/attributes/${encodeURIComponent(a.key)}">${a.key}</a></td>
              <td>${typeOf(a)}${a.array ? '[]' : ''}</td><td class="hide-sm">${a.required ? badge('Required', 'attention') : ''}</td>
              <td class="clip mono hide-sm">${a.default === null || a.default === undefined ? '' : JSON.stringify(a.default)}</td>
              <td class="subdued hide-sm">${a.type === 'string' && a.format !== 'enum' ? `≤ ${a.size}` : a.elements ? a.elements.join(', ') : a.min !== undefined || a.max !== undefined ? `${a.min ?? '−∞'} … ${a.max ?? '∞'}` : ''}</td>
              <td class="num">${destroy(`${collectionUrl(c)}/attributes/${encodeURIComponent(a.key)}/delete`, 'Delete', `Delete ${a.key}? Its data in every document is removed.`)}</td></tr>`)}
            </tbody></table></div>`
          : emptyState('No attributes yet', 'Attributes are the fields every document has.', html`<a class="btn primary" href="${collectionUrl(c)}/attributes/new">Add attribute</a>`)}
      </div>`,
    )
  })

  router.get(`${COL}/attributes/new`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    return ctx.render('Add attribute', 'databases', html`${header('Add attribute', { back: `${collectionUrl(c)}/attributes` })}${attributeForm(c, null)}`)
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
    return ctx.render(a.key, 'databases', html`${header(a.key, { back: `${collectionUrl(c)}/attributes` })}${attributeForm(c, a)}`)
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
