import type { ConsoleRouter } from '~/console/context'
import { databasePages } from './databases'
import { functionPages } from './functions'
import { overviewPages } from './overview'
import { schemaPages } from './schema'
import { settingsPages } from './settings'
import { storagePages } from './storage'
import { teamPages } from './teams'
import { userPages } from './users'

/** Mount every console page group. Order matters only within a group. */
export function registerConsolePages(router: ConsoleRouter): void {
  overviewPages(router)
  userPages(router)
  teamPages(router)
  databasePages(router)
  storagePages(router)
  functionPages(router)
  settingsPages(router)
  schemaPages(router)
}
