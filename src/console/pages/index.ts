import type { ConsoleRouter } from '~/console/context'
import { apiPages } from './api'
import { backupPages } from './backups'
import { databasePages } from './databases'
import { functionPages } from './functions'
import { logPages } from './logs'
import { mcpPages } from './mcp'
import { observabilityPages } from './observability'
import { organizationPages } from './organization'
import { overviewPages } from './overview'
import { profilePages } from './profile'
import { projectPages } from './projects'
import { realtimePages } from './realtime'
import { schemaPages } from './schema'
import { securityPages } from './security'
import { settingsPages } from './settings'
import { sitePages } from './sites'
import { vcsPages } from './vcs'
import { storagePages } from './storage'
import { teamPages } from './teams'
import { userPages } from './users'
import { vectorPages } from './vectors'
import { webhookPages } from './webhooks'

/** Mount every console page group. Order matters only within a group. */
export function registerConsolePages(router: ConsoleRouter): void {
  overviewPages(router)
  organizationPages(router)
  backupPages(router)
  projectPages(router)
  userPages(router)
  teamPages(router)
  databasePages(router)
  vectorPages(router)
  storagePages(router)
  functionPages(router)
  sitePages(router)
  realtimePages(router)
  vcsPages(router)
  logPages(router)
  observabilityPages(router)
  settingsPages(router)
  securityPages(router)
  profilePages(router)
  apiPages(router)
  mcpPages(router)
  webhookPages(router)
  schemaPages(router)
}
