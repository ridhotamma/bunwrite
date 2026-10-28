/** Where a site's deployments and its runtime's writable home live on disk. */
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { Config } from '~/config'

/** `<data>/sites[/<siteId>[/<deploymentId>]]`, next to the database file. */
export function sitesDir(config: Config, siteId?: string, deploymentId?: string): string {
  const memory = config.databasePath === ':memory:' || config.databasePath.startsWith('file::memory:')
  const base = memory ? join(tmpdir(), 'bunwrite', config.projectId, 'sites') : join(dirname(resolve(config.databasePath)), 'sites')
  return join(...[base, siteId, deploymentId].filter((p): p is string => Boolean(p)))
}

/**
 * A site's own writable home (HOME, TMPDIR and package caches) when the
 * sandbox is on. One per site, shared by its deployments, so a rebuild does
 * not download the same packages again.
 */
export function siteHome(config: Config, siteId: string): string {
  return join(sitesDir(config, siteId), '.home')
}
