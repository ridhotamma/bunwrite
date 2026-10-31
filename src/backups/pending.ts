/**
 * Staged whole-instance restore.
 *
 * A global restore replaces the control database, so it cannot run inside a
 * live server with open connections and cached services. The console validates
 * an uploaded archive and leaves it in `<data>/.restore-pending`; the next
 * start (supervisor, single process, or `bunwrite restore --pending`) applies
 * it before any database is opened.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { Config } from '~/config'
import { dataDirOf } from '~/projects/paths'
import { restoreInstance } from './restore'

export interface PendingRestore {
  /** Original file name, for display. */
  name: string
  uploadedAt: string
  /** Only set when the key came from the upload form. */
  key?: string
  archive: string
}

export function pendingRestoreDir(databasePath: string): string {
  return join(dataDirOf(resolve(databasePath)), '.restore-pending')
}

export function readPendingRestore(databasePath: string): PendingRestore | null {
  const dir = pendingRestoreDir(databasePath)
  const metaPath = join(dir, 'meta.json')
  const archive = join(dir, 'archive')
  if (!existsSync(metaPath) || !existsSync(archive)) return null
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { name?: unknown; uploadedAt?: unknown; key?: unknown }
    return {
      name: typeof meta.name === 'string' && meta.name ? meta.name : 'backup archive',
      uploadedAt: typeof meta.uploadedAt === 'string' ? meta.uploadedAt : '',
      key: typeof meta.key === 'string' && meta.key ? meta.key : undefined,
      archive,
    }
  } catch {
    return null
  }
}

/** Move a validated upload into the staging folder. Refuses to replace one already staged. */
export function stagePendingRestore(options: {
  databasePath: string
  archive: string
  name: string
  key?: string
}): PendingRestore {
  const dir = pendingRestoreDir(options.databasePath)
  if (existsSync(dir)) throw new Error('A restore is already staged. Restart Bunwrite to apply it, or cancel it first.')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    renameSync(options.archive, join(dir, 'archive'))
    chmodSync(join(dir, 'archive'), 0o600)
    const meta = { name: options.name, uploadedAt: new Date().toISOString(), key: options.key }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 })
    return readPendingRestore(options.databasePath)!
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

export function cancelPendingRestore(databasePath: string): boolean {
  const dir = pendingRestoreDir(databasePath)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/**
 * Apply a staged restore. Called before the database opens, so every file can
 * be replaced safely. The staging folder is removed only after a successful
 * restore; on failure it stays for a retry and the caller should stop startup.
 */
export async function applyPendingRestore(config: Config, log: (line: string) => void = console.log): Promise<boolean> {
  const pending = readPendingRestore(config.databasePath)
  if (!pending) return false
  log(`[restore] applying staged backup ${pending.name} (uploaded ${pending.uploadedAt || 'earlier'})`)
  await restoreInstance({
    databasePath: config.databasePath,
    archive: pending.archive,
    key: pending.key ?? config.backupEncryptionKey,
    log,
  })
  cancelPendingRestore(config.databasePath)
  log('[restore] done; the previous databases are kept as *.before-restore-*')
  return true
}
