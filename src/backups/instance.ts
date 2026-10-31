/**
 * Snapshot the control database and every project database into one archive.
 *
 * `VACUUM INTO` gives a consistent copy while the server is running, so this
 * is safe from the console, from cron and from the CLI. Uploaded files are not
 * included; back up STORAGE_PATH or the uploads bucket separately.
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { dataDirOf, projectFolder, projectPaths } from '~/projects/paths'
import { writeArchive, type ArchiveManifest } from './archive'
import { ARCHIVE_COMPRESSED_EXT, ARCHIVE_ENCRYPTED_EXT, checkKey } from './format'

export interface CreateInstanceBackupOptions {
  databasePath: string
  /** Folder that receives the archive. Created when missing. */
  outputDir: string
  /** File-name prefix, for example `backup-`, `auto-` or `snapshot-`. */
  prefix?: string
  secret?: string
  log?: (line: string) => void
}

export interface InstanceBackup {
  name: string
  path: string
  size: number
  manifest: ArchiveManifest
}

function projectIds(databasePath: string): string[] {
  const db = new Database(databasePath)
  try {
    return db.query<{ id: string }, []>('SELECT id FROM _projects ORDER BY seq').all().map((row) => row.id)
  } finally {
    db.close()
  }
}

function snapshot(source: string, target: string): void {
  const db = new Database(source, { readonly: true })
  try {
    db.run(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
}

export async function createInstanceBackup(options: CreateInstanceBackupOptions): Promise<InstanceBackup> {
  const databasePath = resolve(options.databasePath)
  if (databasePath === ':memory:' || databasePath.startsWith('file::memory:')) {
    throw new Error('Backups need a file-backed database.')
  }
  if (!existsSync(databasePath)) throw new Error(`The control database does not exist: ${databasePath}`)
  if (options.secret) checkKey(options.secret)

  const dataDir = dataDirOf(databasePath)
  const ids = projectIds(databasePath)
  mkdirSync(options.outputDir, { recursive: true })
  // Keep the snapshots next to the archive, not in a small /tmp filesystem.
  const snapshotDir = mkdtempSync(join(options.outputDir, '.snapshot-'))
  try {
    const control = basename(databasePath)
    const entries: { path: string; source: string }[] = []

    const controlSnapshot = join(snapshotDir, 'control', control)
    mkdirSync(dirname(controlSnapshot), { recursive: true })
    options.log?.(`backup: snapshotting the control database`)
    snapshot(databasePath, controlSnapshot)
    entries.push({ path: control, source: controlSnapshot })

    const projects: string[] = []
    for (const id of ids) {
      const source = projectPaths(dataDir, id).database
      if (!existsSync(source)) {
        // A whole-instance archive that silently omits a listed project is not
        // restorable; fail so the operator sees it instead.
        throw new Error(`Project ${id} has no database at ${source}. Delete the project or restore its database, then back up again.`)
      }
      const path = `projects/${projectFolder(id)}/bunwrite.sqlite`
      const target = join(snapshotDir, path)
      mkdirSync(dirname(target), { recursive: true })
      options.log?.(`backup: snapshotting project ${id}`)
      snapshot(source, target)
      entries.push({ path, source: target })
      projects.push(id)
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `${options.prefix ?? 'backup-'}${stamp}${options.secret ? ARCHIVE_ENCRYPTED_EXT : ARCHIVE_COMPRESSED_EXT}`
    const output = join(options.outputDir, name)
    const temp = `${output}.tmp-${process.pid}-${Date.now()}`
    try {
      const manifest = await writeArchive({
        output: temp,
        entries,
        control,
        projects,
        secret: options.secret,
      })
      renameSync(temp, output)
      return { name, path: output, size: statSync(output).size, manifest }
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true })
  }
}
