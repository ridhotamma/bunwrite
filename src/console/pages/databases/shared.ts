import { keyCaller } from '~/auth/caller'
import type { Collection } from '~/schema/types'
import type { ConsoleContext } from '~/console/context'
import { html, type Html } from '~/console/html'
import { badge, copyableId, header, tabs as tabList } from '~/console/ui'

export const DB = '/console/databases'
export const COL = `${DB}/:db/collections/:col`

export const collectionUrl = (c: { databaseId: string; id: string }) =>
  `${DB}/${encodeURIComponent(c.databaseId)}/collections/${encodeURIComponent(c.id)}`

export function countDocuments(ctx: ConsoleContext, c: Collection): number {
  return ctx.services.store.countDocuments(keyCaller(), c)
}

export function loadCollection(ctx: ConsoleContext, path: Record<string, string>): Collection {
  return ctx.services.registry.collection(path.db!, path.col!, true)
}

export function tabs(c: Collection, on: string): Html {
  return tabList(
    [
      { key: 'documents', label: 'Documents', href: `${collectionUrl(c)}/documents` },
      { key: 'attributes', label: 'Attributes', href: `${collectionUrl(c)}/attributes` },
      { key: 'indexes', label: 'Indexes', href: `${collectionUrl(c)}/indexes` },
      { key: 'settings', label: 'Settings', href: `${collectionUrl(c)}/settings` },
    ],
    on,
  )
}

export function collectionHeader(ctx: ConsoleContext, c: Collection, actions?: Html): Html {
  const database = ctx.services.registry.databases.get(c.databaseId)!
  const databaseHref = `${DB}/${encodeURIComponent(c.databaseId)}`
  return header(c.name, {
    back: databaseHref,
    subtitle: html`${copyableId(c.id, 'collection-id-label')}<span class="dot" aria-hidden="true">·</span><a href="${databaseHref}">${database.name}</a><span class="dot" aria-hidden="true">·</span><span>${c.documentSecurity ? 'Row security' : 'Collection permissions only'}</span>`,
    badges: [c.enabled ? badge('Enabled', 'success') : badge('Disabled')],
    actions,
  })
}
