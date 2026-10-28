import type { Collection } from '~/schema/types'
import type { ConsoleRouter } from '~/console/context'
import { dialog } from '~/console/dialog'
import { arrayOf, checked, value } from '~/console/forms'
import { html, type Html } from '~/console/html'
import { badge, destroy, emptyState, header, icon, listCard } from '~/console/ui'
import { COL, collectionHeader, collectionUrl, loadCollection, tabs } from './shared'

const optionsOf = (c: Collection) => ['$id', '$createdAt', '$updatedAt', ...c.attributes.map((a) => a.key)]

function indexFields(c: Collection): Html {
  return html`<label>Key<input name="key" class="mono" required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}" placeholder="idx_status" autofocus></label>
    <label>Type<select name="type" data-show-by>
      <option value="key">Key: faster filters and sorting</option>
      <option value="unique">Unique: no two documents share these values</option>
      <option value="fulltext">Full text: for search queries</option>
    </select></label>
    <span class="subdued">Attributes</span>
    <div class="attr-order">
      ${optionsOf(c).map((o) => html`<label><input type="checkbox" name="attributes" value="${o}"><span class="mono">${o}</span>
        <select name="order:${o}" aria-label="Order for ${o}" data-show-for="key unique" data-for-select="type"><option value="ASC">Ascending</option><option value="DESC">Descending</option></select></label>`)}
    </div>
    <small class="help" style="margin:-8px 0 12px">Ticked attributes are indexed in the order listed. Most indexes need only one.</small>`
}

function indexDialog(c: Collection): Html {
  return dialog({
    id: 'add-index',
    title: 'Add index',
    body: html`<form id="add-index-form" method="post" action="${collectionUrl(c)}/indexes" class="stack-fields">${indexFields(c)}</form>`,
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="add-index-form" class="primary">Add index</button>`,
  })
}

export function indexPages(router: ConsoleRouter): void {
  router.get(`${COL}/indexes`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    const add = html`<a class="btn primary" href="${collectionUrl(c)}/indexes/new" data-dialog-open="#add-index">${icon('plus')}<span>Add index</span></a>`
    return ctx.render(
      c.name,
      'databases',
      html`${collectionHeader(c, c.indexes.length ? add : undefined)}${tabs(c, 'indexes')}
      ${listCard('indexes', {
        body: c.indexes.length
          ? html`<div class="scroll"><table><thead><tr><th>Index</th><th>Type</th><th>Attributes</th><th></th></tr></thead><tbody>
            ${c.indexes.map((i) => html`<tr><td class="mono">${i.key}</td><td>${i.type === 'unique' ? badge('Unique', 'info') : i.type === 'fulltext' ? badge('Full text', 'attention') : badge('Key')}</td>
              <td class="mono">${i.attributes.map((a, n) => `${a}${i.orders[n] === 'DESC' ? ' ↓' : ''}`).join(', ')}</td>
              <td class="num">${destroy(`${collectionUrl(c)}/indexes/${encodeURIComponent(i.key)}/delete`, 'Delete', `Delete index ${i.key}?`)}</td></tr>`)}
            </tbody></table></div>`
          : emptyState('No indexes', 'Add one for the attributes your queries filter or sort on.', add),
      })}
      ${indexDialog(c)}`,
    )
  })

  // Without JavaScript the "Add index" link lands here instead of opening the dialog.
  router.get(`${COL}/indexes/new`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    return ctx.render(
      'Add index',
      'databases',
      html`${header('Add index', { back: `${collectionUrl(c)}/indexes` })}
      <form method="post" action="${collectionUrl(c)}/indexes" class="card narrow">
        ${indexFields(c)}
        <div class="foot"><a class="btn" href="${collectionUrl(c)}/indexes">Cancel</a><button class="primary">Add index</button></div>
      </form>`,
    )
  })

  router.post(`${COL}/indexes`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    const attributes = arrayOf(ctx.form.attributes)
    ctx.schema.saveIndex(c.databaseId, c.id, {
      key: value(ctx.form, 'key'),
      type: value(ctx.form, 'type') || 'key',
      attributes,
      orders: attributes.map((a) => (value(ctx.form, `order:${a}`) === 'DESC' || checked(ctx.form.desc) ? 'DESC' : 'ASC')),
    })
    return ctx.go(`${collectionUrl(c)}/indexes`, { tone: 'success', text: 'Index added' })
  })

  router.post(`${COL}/indexes/:key/delete`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    ctx.schema.deleteIndex(c.databaseId, c.id, path.key!)
    return ctx.go(`${collectionUrl(c)}/indexes`, { tone: 'success', text: 'Index deleted' })
  })
}
