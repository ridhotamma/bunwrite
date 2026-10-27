import { aggregatePermissions } from '~/auth/permissions'
import type { ConsoleRouter } from '~/console/context'
import { checked, lines, value } from '~/console/forms'
import { COLLECTION_ACTIONS, permissionsField, securityChoice } from '~/console/permissions'
import { html } from '~/console/html'
import { badge, copyableId, destroy, emptyState, header, icon, listCard, pageFooter, searchForm, settingsSection, tabs, when } from '~/console/ui'
import { COL, DB, collectionUrl, countDocuments } from './shared'

const databaseUrl = (id: string) => `${DB}/${encodeURIComponent(id)}`
const collectionCount = (n: number) => `${n.toLocaleString('en-US')} collection${n === 1 ? '' : 's'}`

const databaseTabs = (id: string, on: 'collections' | 'settings') =>
  tabs(
    [
      { key: 'collections', label: 'Collections', href: databaseUrl(id) },
      { key: 'settings', label: 'Settings', href: `${databaseUrl(id)}/settings` },
    ],
    on,
  )

/** Database and collection index/detail pages. */
export function databaseAndCollectionPages(router: ConsoleRouter): void {
  router.get(DB, ({ ctx }) => {
    const databases = [...ctx.services.registry.databases.values()]
    const collections = [...ctx.services.registry.collections.values()]
    const create = html`<a class="btn primary" href="${DB}/new">${icon('plus')}<span>Create database</span></a>`
    return ctx.render(
      'Databases',
      'databases',
      html`${header('Databases', { actions: databases.length ? create : undefined })}
      ${listCard('databases', {
        body: databases.length
          ? html`<div class="scroll"><table><thead><tr><th>Database</th><th class="num">Collections</th><th class="hide-sm">Status</th><th class="hide-sm">Created</th></tr></thead><tbody>
            ${databases.map((d) => html`<tr class="row-link" onclick="location='${databaseUrl(d.id)}'"><td><a href="${databaseUrl(d.id)}">${d.name}</a><div class="mono subdued cell-sub">${d.id}</div></td>
              <td class="num">${collections.filter((c) => c.databaseId === d.id).length}</td><td class="hide-sm">${d.enabled ? badge('Enabled', 'success') : badge('Disabled')}</td><td class="hide-sm subdued">${when(d.createdAt)}</td></tr>`)}
            </tbody></table></div>`
          : emptyState('No databases yet', 'Databases hold collections, and collections hold your documents.', create),
      })}`,
    )
  })

  router.get(`${DB}/new`, ({ ctx }) =>
    ctx.render(
      'Create database',
      'databases',
      html`${header('Create database', { back: DB })}
      <form method="post" action="${DB}">
        ${settingsSection(
          'General',
          'A database groups related collections. Apps use its ID in every request.',
          html`<div class="fields"><label>Name<input name="name" required data-slug-source autofocus placeholder="Main"></label>
            <label>ID<input name="id" class="mono" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}" required data-slug-from="name" placeholder="main"><small>Filled in from the name; it cannot change later.</small></label></div>`,
        )}
        ${pageFooter(DB, 'Create database')}
      </form>`,
    ),
  )

  router.post(DB, ({ ctx }) => {
    const id = value(ctx.form, 'id')
    ctx.schema.createDatabase(id, value(ctx.form, 'name'))
    return ctx.go(databaseUrl(id), { tone: 'success', text: 'Database created' })
  })

  router.get(`${DB}/:db`, ({ ctx, path, url }) => {
    const d = ctx.services.registry.database(path.db!, true)
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const all = [...ctx.services.registry.collections.values()].filter((c) => c.databaseId === d.id).sort((a, b) => a.name.localeCompare(b.name))
    const collections = query ? all.filter((c) => `${c.name} ${c.id}`.toLowerCase().includes(query)) : all
    const create = html`<a class="btn primary" href="${DB}/${d.id}/new">${icon('plus')}<span>Create collection</span></a>`
    const body = collections.length
      ? html`<div class="scroll"><table><thead><tr><th>Collection</th><th class="num">Documents</th><th class="num hide-sm">Attributes</th><th class="hide-sm">Security</th></tr></thead><tbody>
        ${collections.map((c) => html`<tr class="row-link" onclick="location='${collectionUrl(c)}/documents'"><td><a href="${collectionUrl(c)}/documents">${c.name}</a><div class="mono subdued cell-sub">${c.id}</div></td>
          <td class="num">${countDocuments(ctx, c).toLocaleString('en-US')}</td><td class="num hide-sm">${c.attributes.length}</td>
          <td class="hide-sm subdued">${c.documentSecurity ? 'Row security' : 'Collection permissions'}</td></tr>`)}
        </tbody></table></div>`
      : query
        ? emptyState('No collections match', 'Try another name or ID.', html`<a class="btn" href="${databaseUrl(d.id)}">Clear search</a>`)
        : emptyState('No collections yet', 'Collections hold your documents and define their fields.', create)
    return ctx.render(
      d.name,
      'databases',
      html`${header(d.name, {
        back: DB,
        subtitle: html`${copyableId(d.id, 'database-id-label')}<span class="dot" aria-hidden="true">·</span><span>${collectionCount(all.length)}</span>`,
        badges: [d.enabled ? badge('Enabled', 'success') : badge('Disabled')],
        actions: all.length ? create : undefined,
      })}${databaseTabs(d.id, 'collections')}
      ${listCard('collections', {
        toolbar: all.length ? searchForm({ action: databaseUrl(d.id), target: 'collections', value: url.searchParams.get('q') ?? '', placeholder: 'Search collections' }) : undefined,
        body,
      })}`,
    )
  })

  router.get(`${DB}/:db/settings`, ({ ctx, path }) => {
    const d = ctx.services.registry.database(path.db!, true)
    const collections = [...ctx.services.registry.collections.values()].filter((c) => c.databaseId === d.id)
    return ctx.render(
      d.name,
      'databases',
      html`${header(d.name, {
        back: DB,
        subtitle: html`${copyableId(d.id, 'database-id-label')}<span class="dot" aria-hidden="true">·</span><span>${collectionCount(collections.length)}</span>`,
        badges: [d.enabled ? badge('Enabled', 'success') : badge('Disabled')],
      })}${databaseTabs(d.id, 'settings')}
      ${settingsSection(
        'General',
        'The name shown here, and whether apps can use the database.',
        html`<form method="post" action="${databaseUrl(d.id)}">
          <label>Name<input name="name" value="${d.name}" required></label>
          <label>ID<div class="copy-row"><input id="database-id" class="mono" readonly value="${d.id}"><button type="button" data-copy-target="#database-id">${icon('copy')}<span data-copy-label>Copy</span></button></div></label>
          <label class="check"><input type="checkbox" name="enabled" ${d.enabled ? 'checked' : ''}>Enabled for apps</label>
          <div class="foot"><button class="primary">Save</button></div>
        </form>`,
        { id: 'database-general' },
      )}
      ${settingsSection(
        'Delete database',
        'Permanently removes every collection and document in it. This cannot be undone.',
        html`<p class="hint" style="margin:0 0 12px">${collections.length.toLocaleString('en-US')} collection${collections.length === 1 ? '' : 's'} will be deleted with it.</p>
          ${destroy(`${databaseUrl(d.id)}/delete`, 'Delete database', `Delete ${d.name} and all its collections?`)}`,
      )}`,
    )
  })

  router.post(`${DB}/:db`, ({ ctx, path }) => {
    ctx.schema.updateDatabase(path.db!, value(ctx.form, 'name'), checked(ctx.form.enabled))
    return ctx.go(`${databaseUrl(path.db!)}/settings`, { tone: 'success', text: 'Saved' })
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
      html`${header('Create collection', { back: databaseUrl(d.id), subtitle: d.name })}
      <form method="post" action="${DB}/${d.id}/collections">
        ${settingsSection(
          'General',
          'Collections hold the documents your apps create and read.',
          html`<div class="fields">
            <label>Name<input name="name" required data-slug-source autofocus placeholder="Orders"></label>
            <label>ID<input name="id" class="mono" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}" required data-slug-from="name" placeholder="orders"><small>Apps use this ID. Filled in from the name; it cannot change later.</small></label>
          </div>`,
        )}
        ${settingsSection(
          'Access',
          'Choose how documents are protected, and who can create, read, update and delete them. API keys and server functions always have full access.',
          html`${securityChoice('documentSecurity', true, 'document')}
            <h3 class="field-heading">Collection permissions</h3>
            ${permissionsField(ctx, { value: [], actions: COLLECTION_ACTIONS, note: html`Applies to every document.` })}`,
        )}
        ${pageFooter(databaseUrl(d.id), 'Create collection')}
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
