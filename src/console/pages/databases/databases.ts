import { aggregatePermissions } from '~/auth/permissions'
import type { ConsoleRouter } from '~/console/context'
import { checked, lines, value } from '~/console/forms'
import { COLLECTION_ACTIONS, permissionsField, securityChoice } from '~/console/permissions'
import { html } from '~/console/html'
import { badge, destroy, emptyState, formFooter, header, when } from '~/console/ui'
import { COL, DB, collectionUrl, countDocuments } from './shared'

/** Database and collection index/detail pages. */
export function databaseAndCollectionPages(router: ConsoleRouter): void {
  router.get(DB, ({ ctx }) => {
    const databases = [...ctx.services.registry.databases.values()]
    const collections = [...ctx.services.registry.collections.values()]
    return ctx.render(
      'Databases',
      'databases',
      html`${header('Databases', { actions: html`<a class="btn primary" href="${DB}/new">Create database</a>` })}
      <div class="card flush">
        ${databases.length
          ? html`<div class="scroll"><table><thead><tr><th>Name</th><th>ID</th><th class="num">Collections</th><th class="hide-sm">Status</th><th class="hide-sm">Created</th></tr></thead><tbody>
            ${databases.map((d) => html`<tr class="row-link" onclick="location='${DB}/${d.id}'"><td><a href="${DB}/${d.id}">${d.name}</a></td><td class="mono">${d.id}</td>
              <td class="num">${collections.filter((c) => c.databaseId === d.id).length}</td><td class="hide-sm">${d.enabled ? badge('Enabled', 'success') : badge('Disabled')}</td><td class="hide-sm">${when(d.createdAt)}</td></tr>`)}
            </tbody></table></div>`
          : emptyState('No databases yet', 'Create one, or import appwrite.config.json from Schema.', html`<a class="btn primary" href="${DB}/new">Create database</a>`)}
      </div>`,
    )
  })

  router.get(`${DB}/new`, ({ ctx }) =>
    ctx.render(
      'Create database',
      'databases',
      html`${header('Create database', { back: DB })}
      <form method="post" action="${DB}" class="card">
        <div class="fields"><label>Name<input name="name" required data-slug-source autofocus placeholder="Main"></label><label>ID<input name="id" class="mono" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}" required data-slug-from="name" placeholder="main"><small>Apps use this ID. Filled in from the name; it cannot change later.</small></label></div>
        ${formFooter(DB, 'Create')}
      </form>`,
    ),
  )

  router.post(DB, ({ ctx }) => {
    const id = value(ctx.form, 'id')
    ctx.schema.createDatabase(id, value(ctx.form, 'name'))
    return ctx.go(`${DB}/${id}`, { tone: 'success', text: 'Database created' })
  })

  router.get(`${DB}/:db`, ({ ctx, path }) => {
    const d = ctx.services.registry.database(path.db!, true)
    const collections = [...ctx.services.registry.collections.values()].filter((c) => c.databaseId === d.id).sort((a, b) => a.name.localeCompare(b.name))
    return ctx.render(
      d.name,
      'databases',
      html`${header(d.name, { back: DB, badges: [d.enabled ? badge('Enabled', 'success') : badge('Disabled')], actions: html`<a class="btn primary" href="${DB}/${d.id}/new">Create collection</a>` })}
      <div class="card flush">
        ${collections.length
          ? html`<div class="toolbar"><input type="search" placeholder="Filter collections" oninput="for(const r of document.querySelectorAll('#cols tbody tr'))r.hidden=!r.dataset.k.includes(this.value.toLowerCase())"></div>
            <div class="scroll"><table id="cols"><thead><tr><th>Name</th><th class="hide-sm">ID</th><th class="num">Documents</th><th class="num hide-sm">Attributes</th><th class="hide-sm">Security</th></tr></thead><tbody>
            ${collections.map((c) => html`<tr class="row-link" data-k="${(c.name + ' ' + c.id).toLowerCase()}" onclick="location='${collectionUrl(c)}/documents'"><td><a href="${collectionUrl(c)}/documents">${c.name}</a></td>
              <td class="mono hide-sm">${c.id}</td><td class="num">${countDocuments(ctx, c).toLocaleString('en-US')}</td><td class="num hide-sm">${c.attributes.length}</td>
              <td class="hide-sm">${c.documentSecurity ? badge('Row', 'info') : badge('Collection')}</td></tr>`)}
            </tbody></table></div>`
          : emptyState('No collections yet', 'Collections hold your documents.', html`<a class="btn primary" href="${DB}/${d.id}/new">Create collection</a>`)}
      </div>
      <form method="post" action="${DB}/${d.id}" class="card">
        <h2>Database settings</h2>
        <div class="fields"><label>Name<input name="name" value="${d.name}" required></label></div>
        <label class="check"><input type="checkbox" name="enabled" ${d.enabled ? 'checked' : ''}>Enabled for apps</label>
        <div class="foot">${'' /* spacer */}<button class="primary">Save</button></div>
      </form>
      <div class="card"><h2>Delete database</h2><p class="hint">Removes every collection and document in it. This cannot be undone.</p>
        ${destroy(`${DB}/${d.id}/delete`, 'Delete database', `Delete ${d.name} and all ${collections.length} collections?`)}</div>`,
    )
  })

  router.post(`${DB}/:db`, ({ ctx, path }) => {
    ctx.schema.updateDatabase(path.db!, value(ctx.form, 'name'), checked(ctx.form.enabled))
    return ctx.go(`${DB}/${path.db}`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${DB}/:db/delete`, ({ ctx, path }) => {
    ctx.schema.deleteDatabase(path.db!)
    return ctx.go(DB, { tone: 'success', text: 'Database deleted' })
  })

  router.get(`${DB}/:db/new`, ({ ctx, path }) => {
    const d = ctx.services.registry.database(path.db!, true)
    return ctx.render(
      'Create collection',
      'databases',
      html`${header('Create collection', { back: `${DB}/${d.id}` })}
      <form method="post" action="${DB}/${d.id}/collections" class="card">
        <div class="fields">
          <label>Name<input name="name" required data-slug-source autofocus placeholder="Orders"></label>
          <label>ID<input name="id" class="mono" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}" required data-slug-from="name" placeholder="orders"><small>Apps use this ID. Filled in from the name; it cannot change later.</small></label>
        </div>
        <h2 style="margin-top:4px">Who can access documents</h2>
        ${securityChoice('documentSecurity', true, 'document')}
        <h2>Collection permissions</h2>
        ${permissionsField(ctx, { value: [], actions: COLLECTION_ACTIONS, note: html`Applies to every document. API keys and server functions always have full access.` })}
        ${formFooter(`${DB}/${d.id}`, 'Create')}
      </form>`,
    )
  })

  router.post(`${DB}/:db/collections`, ({ ctx, path }) => {
    const id = value(ctx.form, 'id')
    ctx.schema.createCollection(path.db!, id, value(ctx.form, 'name'), checked(ctx.form.documentSecurity), aggregatePermissions(lines(ctx.form.permissions), COLLECTION_ACTIONS) ?? [])
    return ctx.go(`${DB}/${path.db}/collections/${id}/attributes`, { tone: 'success', text: 'Collection created. Add its attributes next.' })
  })

  router.get(COL, ({ ctx, path }) => ctx.go(`${collectionUrl(ctx.services.registry.collection(path.db!, path.col!, true))}/documents`))
}
