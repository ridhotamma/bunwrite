import { aggregatePermissions } from '~/auth/permissions'
import type { ConsoleRouter } from '~/console/context'
import { checked, lines, value } from '~/console/forms'
import { html } from '~/console/html'
import { COLLECTION_ACTIONS, permissionsField, securityChoice } from '~/console/permissions'
import { destroy } from '~/console/ui'
import { COL, DB, collectionHeader, collectionUrl, countDocuments, loadCollection, tabs } from './shared'

export function collectionSettingsPages(router: ConsoleRouter): void {
  router.get(`${COL}/settings`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    return ctx.render(
      c.name,
      'databases',
      html`${collectionHeader(ctx, c)}${tabs(c, 'settings')}
      <form method="post" action="${collectionUrl(c)}/settings" class="card">
        <div class="fields"><label>Name<input name="name" value="${c.name}" required></label><label>ID<input value="${c.id}" class="mono" readonly></label></div>
        <label class="check"><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}>Enabled for apps</label>
        <h2 style="margin-top:4px">Who can access documents</h2>
        ${securityChoice('documentSecurity', c.documentSecurity, 'document')}
        <h2>Collection permissions</h2>
        ${permissionsField(ctx, { value: c.permissions, actions: COLLECTION_ACTIONS, note: html`Applies to every document. API keys and server functions always have full access.` })}
        <div class="foot"><button class="primary">Save</button></div>
      </form>
      <div class="card"><h2>Delete collection</h2><p class="hint">Removes the collection and all ${countDocuments(ctx, c).toLocaleString('en-US')} documents. This cannot be undone.</p>
        ${destroy(`${collectionUrl(c)}/delete`, 'Delete collection', `Delete ${c.name} and its documents?`)}</div>`,
    )
  })

  router.post(`${COL}/settings`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    ctx.schema.updateCollection(c.databaseId, c.id, {
      name: value(ctx.form, 'name') || c.name,
      enabled: checked(ctx.form.enabled),
      documentSecurity: checked(ctx.form.documentSecurity),
      permissions: aggregatePermissions(lines(ctx.form.permissions), COLLECTION_ACTIONS) ?? [],
    })
    return ctx.go(`${collectionUrl(c)}/settings`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${COL}/delete`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    ctx.schema.deleteCollection(c.databaseId, c.id)
    return ctx.go(`${DB}/${encodeURIComponent(c.databaseId)}`, { tone: 'success', text: 'Collection deleted' })
  })
}
