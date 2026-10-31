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

/** The data directory that contains the control database and `projects/`. */
export function dataDirOf(databasePath: string): string {
  return databasePath === ':memory:' || databasePath.startsWith('file::memory:')
    ? resolve('data')
    : dirname(resolve(databasePath))
}
