/**
 * Put a validated backup database back in place. The live SQLite connection is
 * closed, the current file is kept until the replacement opens successfully,
 * then every service that cached rows from the old database is refreshed.
 */
import { Database } from 'bun:sqlite'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Config } from '~/config'
import { openDb } from '~/db/connection'
import { err } from '~/lib/errors'
import type { Services } from '~/services'

/** The database file to replace, or null for the in-memory test database. */
export function databaseFile(config: Config): string | null {
  if (config.databasePath === ':memory:' || config.databasePath.startsWith('file::memory:')) return null
  return resolve(config.databasePath)
}

/**
 * Check that a decrypted file is a Bunwrite database for `projectId` before it
 * can replace the live one. Returns the project ID it belongs to.
 */
export function inspectBackup(path: string, projectId: string): string {
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
    if (!row) throw new Error('The backup has no instance record.')
    let stored: { projectId?: unknown }
    try {
      stored = JSON.parse(row.value) as { projectId?: unknown }
    } catch {
      throw new Error('The backup instance record is not valid JSON.')
    }
    const found = typeof stored.projectId === 'string' ? stored.projectId : ''
    if (!found) throw new Error('The backup has no project ID.')
    if (found !== projectId) throw new Error(`This backup belongs to project "${found}", not "${projectId}".`)
    return found
  } finally {
    db.close()
  }
}

/** Stop timers and child processes that could hold the old database open. */
function stopServices(services: Services): void {
  services.functions.stop()
  services.sites.stop()
  services.backups.stop()
  services.queue.stop()
  services.render.stop()
  services.render.shutdown(true)
}

/** Start what `stopServices` stopped, in the same order as a project start. */
function startServices(services: Services): void {
  services.functions.start()
  services.backups.start()
  services.queue.start()
  services.render.start()
}

/** Forget rows cached from the replaced database, then re-read persisted settings. */
function refreshServices(services: Services): void {
  services.registry.reload()
  services.proxy.reload()
  services.sites.reload()
  services.access.reload()
  services.settings.refreshAll()
  // The restored database has its own version counters and bus sequence; start
  // from those instead of dragging the old ones along.
  services.versions.reset()
  services.realtime.resetBus()
  services.store.clearCaches()
}

/**
 * Replace `services`' database with `restoredPath` and reopen it in place. The
 * `Db` object is shared by every service, so replacing its connection and ORM
 * lets the running server pick up the restored data without a process restart.
 */
export function restoreDatabase(services: Services, restoredPath: string): void {
  const databasePath = databaseFile(services.config)
  if (!databasePath) throw err('general_argument_invalid', 'Restoring a backup needs a file-backed database.')
  if (!existsSync(databasePath)) throw err('general_argument_invalid', 'The project database file could not be found.')
  if (!existsSync(restoredPath)) throw err('general_argument_invalid', 'The uploaded backup could not be read.')

  const old = `${databasePath}.before-restore`
  const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]
  const removeSidecars = () => {
    for (const path of sidecars) rmSync(path, { force: true })
  }

  stopServices(services)
  try {
    services.requestLogs.flush()
    services.db.sqlite.close()
  } catch (error) {
    startServices(services)
    throw error
  }

  let next: ReturnType<typeof openDb> | undefined
  let moved = false
  try {
    rmSync(old, { force: true })
    renameSync(databasePath, old)
    moved = true
    removeSidecars()
    renameSync(restoredPath, databasePath)
    next = openDb(databasePath)
    services.db.sqlite = next.sqlite
    services.db.orm = next.orm
    refreshServices(services)
    startServices(services)
    try {
      rmSync(old, { force: true })
    } catch (error) {
      console.warn('[backups] restored the database but could not remove the old copy:', error)
    }
  } catch (error) {
    // Put the old database back and reopen it, so a bad upload never leaves
    // the server without a working connection.
    try {
      stopServices(services)
      try {
        next?.sqlite.close()
      } catch {
        /* the new connection may not have opened */
      }
      if (moved) {
        rmSync(databasePath, { force: true })
        removeSidecars()
        if (existsSync(old)) renameSync(old, databasePath)
      }
      const reopened = openDb(databasePath)
      services.db.sqlite = reopened.sqlite
      services.db.orm = reopened.orm
      refreshServices(services)
      startServices(services)
    } catch (rollback) {
      console.error('[backups] could not roll back the database after a failed restore:', rollback)
    }
    throw error
  } finally {
    try {
      rmSync(restoredPath, { force: true })
    } catch {
      /* a rename may already have moved it */
    }
  }
}
