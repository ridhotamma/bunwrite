import type { ConsoleRouter } from '~/console/context'
import { apiPages } from './api'
import { databasePages } from './databases'
import { functionPages } from './functions'
import { logPages } from './logs'
import { organizationPages } from './organization'
import { overviewPages } from './overview'
import { projectPages } from './projects'
import { schemaPages } from './schema'
import { settingsPages } from './settings'
import { sitePages } from './sites'
import { storagePages } from './storage'
import { teamPages } from './teams'
import { userPages } from './users'
import { webhookPages } from './webhooks'

/** Mount every console page group. Order matters only within a group. */
export function registerConsolePages(router: ConsoleRouter): void {
  overviewPages(router)
  organizationPages(router)
  projectPages(router)
  userPages(router)
  teamPages(router)
  databasePages(router)
  storagePages(router)
  functionPages(router)
  sitePages(router)
  logPages(router)
  settingsPages(router)
  apiPages(router)
  webhookPages(router)
  schemaPages(router)
}
