import { dirname, join, resolve } from 'node:path'

import { isValidId, sha256 } from '~/lib/ids'

/** Per-project folders under the server's data directory. */
export interface ProjectPaths {
  dir: string
  database: string
  storage: string
  backups: string
  functions: string
}

/** The folder used for a project ID; invalid IDs are hashed so they stay path-safe. */
export function projectFolder(id: string): string {
  return isValidId(id) ? id : `p_${sha256(id).slice(0, 16)}`
}

/** Where one project's database, uploads, backups and functions live. */
export function projectPaths(dataDir: string, id: string): ProjectPaths {
  const dir = join(dataDir, 'projects', projectFolder(id))
  return {
    dir,
    database: join(dir, 'bunwrite.sqlite'),
    storage: join(dir, 'storage'),
    backups: join(dir, 'backups'),
    functions: join(dir, 'functions'),
  }
}

const MAX_NAMESPACE_LENGTH = 63

/** A Postgres schema or MongoDB database name is a single SQL/URL-safe label. */
function namespacePart(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned || 'project'
}

/**
 * The network-backend namespace of one project. The default project uses the
 * configured namespace; every other project gets a sibling so two projects can
 * never share `_settings`, `_users` or document tables.
 *
 * Postgres identifiers are limited to 63 bytes and a `pg_` prefix is reserved,
 * so a long or unusual project ID is shortened with its hash instead of being
 * passed through. A valid project ID such as `project-b` stays readable.
 */
export function projectNamespace(base: string | undefined, id: string): string {
  let root = namespacePart(base || 'bunwrite')
  if (root.startsWith('pg_')) root = `bw_${root}`
  const name = `${root}_${namespacePart(projectFolder(id))}`
  if (name.length <= MAX_NAMESPACE_LENGTH) return name
  return `${root.slice(0, MAX_NAMESPACE_LENGTH - 17)}_${sha256(id).slice(0, 16)}`
}

/** The namespace options for one project, leaving SQLite file paths alone. */
export function projectNamespaceOf(base: string | undefined, id: string, backend: string): string | undefined {
  if (backend === 'sqlite') return base
  return projectNamespace(base, id)
}

/** The data directory that contains the control database and `projects/`. */
export function dataDirOf(databasePath: string): string {
  return databasePath === ':memory:' || databasePath.startsWith('file::memory:')
    ? resolve('data')
    : dirname(resolve(databasePath))
}
