import type { ConsoleRouter } from '../../context'
import { attributePages } from './attributes'
import { databaseAndCollectionPages } from './databases'
import { documentPages } from './documents'
import { indexPages } from './indexes'
import { collectionSettingsPages } from './settings'

/** Databases, collections, documents, attributes, indexes and collection settings. */
export function databasePages(router: ConsoleRouter): void {
  databaseAndCollectionPages(router)
  documentPages(router)
  attributePages(router)
  indexPages(router)
  collectionSettingsPages(router)
}
