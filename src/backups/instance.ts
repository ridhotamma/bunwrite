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
  /** The first project's database when the control store is separate. */
  legacyDatabasePath?: string
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

interface BackupProject {
  id: string
  source: string
}

function projectEntries(databasePath: string, legacyDatabasePath: string | undefined): BackupProject[] {
  const db = new Database(databasePath, { readonly: true })
  try {
    // The control project's database is the control database itself in the
    // pre-decoupling layout; it must not be archived a second time.
    const row = db.query<{ value: string }, []>("SELECT value FROM _settings WHERE key = 'instance'").get()
    let controlId = ''
    if (row) {
      try {
        const value = JSON.parse(row.value) as { projectId?: unknown }
        controlId = typeof value.projectId === 'string' ? value.projectId : ''
      } catch {
        /* inspectDatabase reports a broken instance record later */
      }
    }
    const columns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(`_projects`)')
        .all()
        .map((entry) => entry.name),
    )
    const legacyColumn = columns.has('legacy') ? 'legacy' : '0 AS legacy'
    const rows = db.query<{ id: string; legacy: number }, []>(`SELECT id, ${legacyColumn} FROM _projects ORDER BY seq`).all()
    const dataDir = dataDirOf(legacyDatabasePath ?? databasePath)
    return rows
      .filter((entry) => controlId === 'console' || entry.id !== controlId)
      .map((entry) => ({
        id: entry.id,
        source: entry.legacy && legacyDatabasePath ? legacyDatabasePath : projectPaths(dataDir, entry.id).database,
      }))
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

  const projectsToCopy = projectEntries(databasePath, options.legacyDatabasePath ? resolve(options.legacyDatabasePath) : undefined)
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
    for (const project of projectsToCopy) {
      const source = project.source
      if (!existsSync(source)) {
        // A whole-instance archive that silently omits a listed project is not
        // restorable; fail so the operator sees it instead.
        throw new Error(`Project ${project.id} has no database at ${source}. Delete the project or restore its database, then back up again.`)
      }
      const path = `projects/${projectFolder(project.id)}/bunwrite.sqlite`
      const target = join(snapshotDir, path)
      mkdirSync(dirname(target), { recursive: true })
      options.log?.(`backup: snapshotting project ${project.id}`)
      snapshot(source, target)
      entries.push({ path, source: target })
      projects.push(project.id)
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
