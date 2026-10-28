import { aggregatePermissions } from '~/auth/permissions'
import type { ConsoleRouter } from '~/console/context'
import { checked, lines, value } from '~/console/forms'
import { html } from '~/console/html'
import { COLLECTION_ACTIONS, permissionsField, securityChoice } from '~/console/permissions'
import { destroy, icon, settingsSection } from '~/console/ui'
import { COL, DB, collectionHeader, collectionUrl, countDocuments, loadCollection, tabs } from './shared'

export function collectionSettingsPages(router: ConsoleRouter): void {
  router.get(`${COL}/settings`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    const documents = countDocuments(ctx, c)
    return ctx.render(
      c.name,
      'databases',
      html`${collectionHeader(c)}${tabs(c, 'settings')}
      ${settingsSection(
        'General',
        'The name shown here, and whether apps can use the collection.',
        html`<form method="post" action="${collectionUrl(c)}/settings">
          <input type="hidden" name="section" value="general">
          <label>Name<input name="name" value="${c.name}" required></label>
          <label>ID<div class="copy-row"><input id="collection-id" class="mono" readonly value="${c.id}"><button type="button" data-copy-target="#collection-id">${icon('copy')}<span data-copy-label>Copy</span></button></div></label>
          <label class="check"><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}>Enabled for apps</label>
          <div class="foot"><button class="primary">Save</button></div>
        </form>`,
        { id: 'collection-general' },
      )}
      ${settingsSection(
        'Access',
        'Choose how documents are protected, and who can create, read, update and delete them. API keys and server functions always have full access.',
        html`<form method="post" action="${collectionUrl(c)}/settings">
          <input type="hidden" name="section" value="access">
          ${securityChoice('documentSecurity', c.documentSecurity, 'document')}
          <h3 class="field-heading">Collection permissions</h3>
          ${permissionsField(ctx, { value: c.permissions, actions: COLLECTION_ACTIONS, note: html`Applies to every document.` })}
          <div class="foot"><button class="primary">Save</button></div>
        </form>`,
        { id: 'collection-access' },
      )}
      ${settingsSection(
        'Delete collection',
        'Permanently removes the collection and every document in it. This cannot be undone.',
        html`<p class="hint" style="margin:0 0 12px">${documents.toLocaleString('en-US')} document${documents === 1 ? '' : 's'} will be deleted with it.</p>
          ${destroy(`${collectionUrl(c)}/delete`, 'Delete collection', `Delete ${c.name} and its documents?`)}`,
      )}`,
    )
  })

  router.post(`${COL}/settings`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    const section = value(ctx.form, 'section')
    const name = section === 'access' ? c.name : value(ctx.form, 'name') || c.name
    const enabled = section === 'access' ? c.enabled : checked(ctx.form.enabled)
    ctx.schema.updateCollection(c.databaseId, c.id, {
      name,
      enabled,
      documentSecurity: section === 'general' ? c.documentSecurity : checked(ctx.form.documentSecurity),
      permissions: section === 'general' ? c.permissions : (aggregatePermissions(lines(ctx.form.permissions), COLLECTION_ACTIONS) ?? []),
    })
    return ctx.go(`${collectionUrl(c)}/settings`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${COL}/delete`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    ctx.schema.deleteCollection(c.databaseId, c.id)
    return ctx.go(`${DB}/${encodeURIComponent(c.databaseId)}`, { tone: 'success', text: 'Collection deleted' })
  })
}
