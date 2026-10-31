/**
 * Database validation and the offline restore of a whole-instance archive.
 *
 * A global backup replaces the control database, so it cannot be swapped into
 * a running server the way a per-project backup used to be. `bunwrite restore`
 * runs while Bunwrite is stopped: it extracts the archive to a staging folder,
 * checks every database, then moves the current files aside and puts the
 * restored ones in place. The previous files stay as `*.before-restore-<stamp>`.
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { Config } from '~/config'
import { dataDirOf, projectFolder, projectPaths } from '~/projects/paths'
import { readArchive, type ArchiveManifest } from './archive'

/** The database file to replace, or null for the in-memory test database. */
export function databaseFile(config: Config): string | null {
  if (config.databasePath === ':memory:' || config.databasePath.startsWith('file::memory:')) return null
  return resolve(config.databasePath)
}

/** Integrity and shape only; use `inspectBackup` when the project must match too. */
export function inspectDatabase(path: string): { projectId: string; projects: string[] } {
  const db = new Database(path, { readonly: true })
  try {
    const check = db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()
    const result = check?.integrity_check ?? 'no result'
    if (result !== 'ok') throw new Error(`The database is damaged: ${result}.`)
    const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
    for (const table of ['_settings', '_projects']) {
      if (!tables.has(table)) throw new Error('The file is not a Bunwrite database.')
    }
    const row = db.query<{ value: string }, []>("SELECT value FROM _settings WHERE key = 'instance'").get()
    if (!row) throw new Error('The database has no instance record.')
    let stored: { projectId?: unknown }
    try {
      stored = JSON.parse(row.value) as { projectId?: unknown }
    } catch {
      throw new Error('The database instance record is not valid JSON.')
    }
    const projectId = typeof stored.projectId === 'string' ? stored.projectId : ''
    if (!projectId) throw new Error('The database has no project ID.')
    const projects = db.query<{ id: string }, []>('SELECT id FROM _projects ORDER BY seq').all().map((entry) => entry.id)
    return { projectId, projects }
  } finally {
    db.close()
  }
}

/**
 * Check that a decrypted database is a Bunwrite database for `projectId`
 * before it can replace a live one. Returns the project ID it belongs to.
 */
export function inspectBackup(path: string, projectId: string): string {
  const found = inspectDatabase(path)
  if (found.projectId !== projectId) {
    throw new Error(`This backup belongs to project "${found.projectId}", not "${projectId}".`)
  }
  return found.projectId
}

export interface InstanceRestoreOptions {
  databasePath: string
  archive: string
  key?: string
  dryRun?: boolean
  log?: (line: string) => void
}

export interface RestoreOutcome {
  target: 'control' | 'project'
  id?: string
  path: string
  result: 'restored' | 'planned'
}

export interface InstanceRestoreResult {
  manifest: ArchiveManifest
  outcomes: RestoreOutcome[]
  /** Files kept as `*.before-restore-<stamp>` after a real restore. */
  previous: string[]
}

interface Swapped {
  target: string
  old?: string
}

function replaceDatabase(target: string, source: string, stamp: string): Swapped {
  let old: string | undefined
  if (existsSync(target)) {
    old = `${target}.before-restore-${stamp}`
    rmSync(old, { force: true })
    renameSync(target, old)
  }
  try {
    for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${target}${suffix}`, { force: true })
    renameSync(source, target)
  } catch (error) {
    // The old file is already aside; put it back before surfacing the error.
    if (old && !existsSync(target)) {
      try {
        renameSync(old, target)
      } catch {
        /* the rollback in restoreInstance reports the paths */
      }
    }
    throw error
  }
  return { target, old }
}

function rollback(swapped: Swapped[]): void {
  for (const { target, old } of [...swapped].reverse()) {
    try {
      rmSync(target, { force: true })
      for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${target}${suffix}`, { force: true })
      if (old) renameSync(old, target)
    } catch (error) {
      console.error(`[restore] could not roll back ${target}:`, error)
    }
  }
}

/**
 * Validate and restore a whole-instance archive. Every database is checked
 * before the first live file is touched, and a failure while swapping puts the
 * previous files back.
 */
export async function restoreInstance(options: InstanceRestoreOptions): Promise<InstanceRestoreResult> {
  const log = options.log ?? ((line: string) => console.log(line))
  const archive = resolve(options.archive)
  if (!existsSync(archive)) throw new Error(`Backup archive not found: ${archive}`)
  const databasePath = resolve(options.databasePath)
  if (databasePath === ':memory:' || databasePath.startsWith('file::memory:')) {
    throw new Error('Cannot restore an in-memory database.')
  }

  const dataDir = dataDirOf(databasePath)
  const stagingParent = options.dryRun ? tmpdir() : dataDir
  mkdirSync(stagingParent, { recursive: true })
  const staging = mkdtempSync(join(stagingParent, '.restore-'))

  try {
    log(`restore: reading ${archive}`)
    const manifest = await readArchive({ input: archive, destDir: staging, secret: options.key })

    const controlSource = join(staging, manifest.control)
    if (!existsSync(controlSource)) throw new Error(`Backup archive is missing ${manifest.control}.`)
    const control = inspectDatabase(controlSource)
    const listed = [...manifest.projects].sort()
    const stored = [...control.projects].sort()
    if (listed.length !== stored.length || listed.some((id, index) => id !== stored[index])) {
      throw new Error('Backup archive project list does not match its control database.')
    }

    const projects = manifest.projects.map((id) => {
      const path = `projects/${projectFolder(id)}/bunwrite.sqlite`
      const source = join(staging, path)
      if (!existsSync(source)) throw new Error(`Backup archive is missing ${path}.`)
      try {
        inspectBackup(source, id)
      } catch (error) {
        throw new Error(`Backup for project "${id}" is invalid: ${error instanceof Error ? error.message : String(error)}`)
      }
      return { id, source, target: projectPaths(dataDir, id).database }
    })

    const targets: RestoreOutcome[] = [
      { target: 'control', path: databasePath, result: options.dryRun ? 'planned' : 'restored' },
      ...projects.map((project) => ({
        target: 'project' as const,
        id: project.id,
        path: project.target,
        result: options.dryRun ? ('planned' as const) : ('restored' as const),
      })),
    ]

    if (options.dryRun) {
      for (const outcome of targets) {
        log(`restore: would restore ${outcome.target}${outcome.id ? ` ${outcome.id}` : ''} to ${outcome.path}`)
      }
      return { manifest, outcomes: targets, previous: [] }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const swapped: Swapped[] = []
    try {
      log(`restore: replacing control database ${databasePath}`)
      swapped.push(replaceDatabase(databasePath, controlSource, stamp))
      for (const project of projects) {
        log(`restore: replacing project ${project.id}`)
        mkdirSync(dirname(project.target), { recursive: true })
        swapped.push(replaceDatabase(project.target, project.source, stamp))
      }
    } catch (error) {
      rollback(swapped)
      throw error
    }
    return {
      manifest,
      outcomes: targets,
      previous: swapped.flatMap((entry) => (entry.old ? [entry.old] : [])),
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
