import type { ConsoleRouter } from '../../context'
import { arrayOf, checked, value } from '../../forms'
import { html } from '../../html'
import { badge, destroy, emptyState } from '../../ui'
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
          <label>Key<input name="key" class="mono" required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}"></label>
          <label>Type<select name="type"><option value="key">Key</option><option value="unique">Unique</option><option value="fulltext">Full text (for search)</option></select></label>
          <label>Attributes<select name="attributes" multiple size="6" required>${options.map((o) => html`<option>${o}</option>`)}</select><small>Hold ⌘/Ctrl to pick several, in order.</small></label>
          <label class="check"><input type="checkbox" name="desc">Descending</label>
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
      orders: attributes.map(() => (checked(ctx.form.desc) ? 'DESC' : 'ASC')),
    })
    return ctx.go(`${collectionUrl(c)}/indexes`, { tone: 'success', text: 'Index added' })
  })

  router.post(`${COL}/indexes/:key/delete`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    ctx.schema.deleteIndex(c.databaseId, c.id, path.key!)
    return ctx.go(`${collectionUrl(c)}/indexes`, { tone: 'success', text: 'Index deleted' })
  })
}
