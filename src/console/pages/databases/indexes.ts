import type { ConsoleRouter } from '~/console/context'
import { arrayOf, checked, value } from '~/console/forms'
import { html } from '~/console/html'
import { badge, destroy, emptyState } from '~/console/ui'
import { COL, collectionHeader, collectionUrl, loadCollection, tabs } from './shared'

export function indexPages(router: ConsoleRouter): void {
  router.get(`${COL}/indexes`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    const options = ['$id', '$createdAt', '$updatedAt', ...c.attributes.map((a) => a.key)]
    return ctx.render(
      c.name,
      'databases',
      html`${collectionHeader(ctx, c)}${tabs(c, 'indexes')}
      <div class="layout">
        <div class="card flush">
          ${c.indexes.length
            ? html`<div class="scroll"><table><thead><tr><th>Key</th><th>Type</th><th>Attributes</th><th></th></tr></thead><tbody>
              ${c.indexes.map((i) => html`<tr><td class="mono">${i.key}</td><td>${i.type === 'unique' ? badge('Unique', 'info') : i.type === 'fulltext' ? badge('Full text', 'attention') : badge('Key')}</td>
                <td class="mono">${i.attributes.map((a, n) => `${a}${i.orders[n] === 'DESC' ? ' ↓' : ''}`).join(', ')}</td>
                <td class="num">${destroy(`${collectionUrl(c)}/indexes/${encodeURIComponent(i.key)}/delete`, 'Delete', `Delete index ${i.key}?`)}</td></tr>`)}
              </tbody></table></div>`
            : emptyState('No indexes', 'Add one for the attributes your queries filter or sort on.')}
        </div>
        <form method="post" action="${collectionUrl(c)}/indexes" class="card">
          <h2>Add index</h2>
          <label>Key<input name="key" class="mono" required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}" placeholder="idx_status"></label>
          <label>Type<select name="type" data-show-by>
            <option value="key">Key: faster filters and sorting</option>
            <option value="unique">Unique: no two documents share these values</option>
            <option value="fulltext">Full text: for search queries</option>
          </select></label>
          <span class="subdued">Attributes</span>
          <div class="attr-order">
            ${options.map((o) => html`<label><input type="checkbox" name="attributes" value="${o}"><span class="mono">${o}</span>
              <select name="order:${o}" aria-label="Order for ${o}" data-show-for="key unique" data-for-select="type"><option value="ASC">Ascending</option><option value="DESC">Descending</option></select></label>`)}
          </div>
          <small class="help" style="margin:-8px 0 12px">Ticked attributes are indexed in the order listed. Most indexes need only one.</small>
          <div class="foot"><button class="primary">Add index</button></div>
        </form>
      </div>`,
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
