/**
 * The control store keeps console admins, the organization and the project
 * registry separate from every project database. Before it existed the first
 * project's database doubled as the control database, which made that project
 * impossible to delete.
 *
 * Existing installs are migrated once: the old database stays the first
 * project, and the console tables move to `data/control/bunwrite.sqlite`
 * (or a sibling Postgres schema). After that every project, including the
 * first, can be removed without touching the console.
 */
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { Config } from '~/config'
import { openDatabase, sqlDatabaseOf, type Database, type DatabaseOptions } from '~/db'
import type { SqlDatabase } from '~/db/driver'
import { bootstrapInstance, bootstrapInstanceAsync, type BootstrapOptions, type BootstrapResult } from '~/instance/bootstrap'
import { dataDirOf, projectNamespace } from './paths'

/** Reserved synthetic project ID for the control store. */
export const CONTROL_PROJECT_ID = 'console'
/** Marks a control database that has finished migrating from the old layout. */
export const CONTROL_STATE_KEY = 'control'
export const CONTROL_STATE_VERSION = 1

/** Tables that belong to the console/organization rather than to a project. */
const CONTROL_TABLES = [
  '_organizations',
  '_organization_members',
  '_console_admins',
  '_console_mfa_challenges',
  '_console_sessions',
  '_vcs_installations',
  '_vcs_github_app',
  '_vcs_repositories',
  '_vcs_comments',
] as const

interface ControlState {
  version: number
  /** The project whose database used to be the control database. */
  legacyProjectId?: string
}

export interface ControlStoreResult {
  /** The control store's own identity: projectId is the synthetic console ID. */
  instance: BootstrapResult
  /** The first project's identity when this boot migrated an existing install. */
  legacyInstance?: BootstrapResult
  /** Whether this boot moved an old single-database install to the new layout. */
  migrated: boolean
}

/** Where the SQLite control database lives. Ignored by Postgres. */
export function controlDatabasePath(config: Pick<Config, 'databasePath' | 'controlDatabasePath'>): string {
  if (config.controlDatabasePath) return resolve(config.controlDatabasePath)
  return join(dataDirOf(config.databasePath), 'control', 'bunwrite.sqlite')
}

/** The control connection options, sharing the server's backend and credentials. */
export function controlDatabaseOptions(
  config: Pick<Config, 'databasePath' | 'controlDatabasePath' | 'controlDatabaseNamespace' | 'databaseNamespace'>,
  base: DatabaseOptions,
): DatabaseOptions {
  if (base.backend === 'sqlite') return { ...base, path: controlDatabasePath(config), namespace: undefined }
  return {
    ...base,
    path: undefined,
    namespace: config.controlDatabaseNamespace || projectNamespace(config.databaseNamespace, CONTROL_PROJECT_ID),
  }
}

function quote(dialect: 'sqlite' | 'postgres', name: string): string {
  return dialect === 'sqlite' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`
}

async function setting(db: SqlDatabase, key: string): Promise<string | null> {
  const row = await db.driver.get<{ value: string }>('SELECT value FROM _settings WHERE key = ?', [key])
  return row?.value ?? null
}

async function writeSetting(db: SqlDatabase, key: string, value: unknown): Promise<void> {
  await db.driver.run(
    'INSERT INTO _settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [key, JSON.stringify(value), new Date().toISOString()],
  )
}

async function columnsOf(db: SqlDatabase, table: string): Promise<string[]> {
  if (db.dialect === 'sqlite') {
    return db
      .sqlite!.query<{ name: string }, []>(`PRAGMA table_info(${quote('sqlite', table)})`)
      .all()
      .map((row) => row.name)
  }
  return (
    await db.driver.all<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?',
      [table],
    )
  ).map((row) => row.column_name)
}

/** Copy the columns both databases share, replacing the target rows. */
async function copyTable(source: SqlDatabase, target: SqlDatabase, table: string): Promise<void> {
  const sourceColumns = await columnsOf(source, table)
  const targetColumns = new Set(await columnsOf(target, table))
  const columns = sourceColumns.filter((column) => targetColumns.has(column))
  if (!columns.length) return
  const list = columns.map((column) => quote(source.dialect, column)).join(', ')
  const rows = await source.driver.all<Record<string, unknown>>(`SELECT ${list} FROM ${quote(source.dialect, table)}`)
  const placeholders = columns.map(() => '?').join(', ')
  await target.driver.run(`DELETE FROM ${quote(target.dialect, table)}`)
  for (const row of rows) {
    await target.driver.run(
      `INSERT INTO ${quote(target.dialect, table)} (${list}) VALUES (${placeholders})`,
      columns.map((column) => (row[column] ?? null) as string | number | null),
    )
  }
}

/** Copy console settings but leave the control store's own identity and marker alone. */
async function copySettings(source: SqlDatabase, target: SqlDatabase): Promise<void> {
  const rows = await source.driver.all<{ key: string; value: string; updated_at: string }>('SELECT key, value, updated_at FROM _settings')
  await target.driver.run('DELETE FROM _settings WHERE key NOT IN (?, ?, ?)', ['instance', 'env_seed', CONTROL_STATE_KEY])
  for (const row of rows) {
    if (row.key === 'instance' || row.key === 'env_seed' || row.key === CONTROL_STATE_KEY) continue
    await target.driver.run(
      'INSERT INTO _settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [row.key, row.value, row.updated_at],
    )
  }
}

interface ProjectCopyRow {
  id: string
  name: string
  org_id: string
  created_at: string
  updated_at: string
}

/** Move the registry to the control store, making the old project the default. */
async function copyProjects(source: SqlDatabase, target: SqlDatabase, legacyId: string): Promise<void> {
  const rows = await source.driver.all<ProjectCopyRow>('SELECT id, name, org_id, created_at, updated_at FROM _projects ORDER BY seq')
  await target.driver.run('DELETE FROM _projects')
  const seen = new Set<string>()
  for (const row of rows) {
    seen.add(row.id)
    const legacy = row.id === legacyId
    await target.driver.run('INSERT INTO _projects (id, name, org_id, is_default, legacy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      row.id,
      row.name,
      row.org_id,
      legacy ? 1 : 0,
      legacy ? 1 : 0,
      row.created_at,
      row.updated_at,
    ])
  }
  if (!seen.has(legacyId)) {
    const stamp = new Date().toISOString()
    await target.driver.run('INSERT INTO _projects (id, name, org_id, is_default, legacy, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)', [
      legacyId,
      legacyId,
      '',
      stamp,
      stamp,
    ])
  }
}

async function bootstrap(db: SqlDatabase, env: Record<string, string | undefined>, options: BootstrapOptions): Promise<BootstrapResult> {
  return db.dialect === 'sqlite' ? bootstrapInstance(db, env, options) : bootstrapInstanceAsync(db, env, options)
}

async function ensureDefault(db: SqlDatabase): Promise<void> {
  const row = await db.driver.get<{ id: string }>('SELECT id FROM _projects WHERE is_default = 1 LIMIT 1')
  if (row) return
  const first = await db.driver.get<{ id: string }>('SELECT id FROM _projects ORDER BY seq LIMIT 1')
  if (first) await db.driver.run('UPDATE _projects SET is_default = 1 WHERE id = ?', [first.id])
}

/**
 * Ensure the control store matches this server, migrating the old shared
 * database on first boot. The caller owns both database handles; the legacy
 * handle is returned so the caller can close it when migration opened it.
 */
async function initialiseControlStoreUnlocked(options: {
  config: Config
  databaseOptions: DatabaseOptions
  control: SqlDatabase
  /** Identity env for the first project; defaults to the process environment. */
  env?: Record<string, string | undefined>
  log?: (line: string) => void
}): Promise<ControlStoreResult & { legacy?: Database }> {
  const { config, databaseOptions, control } = options
  const env = options.env ?? process.env
  const log = options.log ?? (() => {})
  const state = await setting(control, CONTROL_STATE_KEY)
  if (state) {
    // Already decoupled. Read the identity without ever touching the legacy
    // database path, which may no longer exist after its project was deleted.
    const instance = await bootstrap(control, {}, { generateApiKey: false, seedConsoleSmtp: false })
    await ensureDefault(control)
    return { instance, migrated: false }
  }

  const legacyOptions: DatabaseOptions = databaseOptions.backend === 'sqlite' ? { ...databaseOptions, path: config.databasePath } : databaseOptions
  const controlOptions = controlDatabaseOptions(config, databaseOptions)
  if (legacyOptions.backend === 'sqlite' && controlOptions.path && resolve(controlOptions.path) === resolve(legacyOptions.path!)) {
    throw new Error('CONTROL_DATABASE_PATH must not be the same file as DATABASE_PATH.')
  }

  log('control: migrating the project registry and console data')
  const legacyDatabase = await openDatabase(legacyOptions)
  const legacy = sqlDatabaseOf(legacyDatabase)
  try {
    const legacyInstance = await bootstrap(legacy, env, { generateApiKey: true, projectName: config.projectName })

    // The control store gets its own synthetic identity. The original
    // organisation and name are kept so console branding and invitations do
    // not change during the migration.
    const instance = await bootstrap(
      control,
      { ORG_ID: legacyInstance.orgId, PROJECT_ID: CONTROL_PROJECT_ID, SECRET: legacyInstance.secret },
      { generateApiKey: false, seedConsoleSmtp: false, projectName: legacyInstance.projectName },
    )

    for (const table of CONTROL_TABLES) await copyTable(legacy, control, table)
    await copySettings(legacy, control)
    await copyProjects(legacy, control, legacyInstance.projectId)
    // The registry insert above uses the project's name; keep a row that came
    // from an older registry but not its organisation id.
    await control.driver.run('UPDATE _projects SET org_id = ?, name = ? WHERE id = ?', [
      legacyInstance.orgId,
      legacyInstance.projectName,
      legacyInstance.projectId,
    ])
    await writeSetting(control, CONTROL_STATE_KEY, { version: CONTROL_STATE_VERSION, legacyProjectId: legacyInstance.projectId } satisfies ControlState)
    await ensureDefault(control)
    log(`control: registry ready; first project is ${legacyInstance.projectId}`)
    return { instance, legacyInstance, migrated: true, legacy: legacyDatabase }
  } catch (error) {
    await legacyDatabase.close().catch(() => {})
    throw error
  }
}

/**
 * Serialise the one-time migration across cluster workers. Postgres migrates
 * through the schema's own advisory lock; SQLite uses a directory next to the
 * control database, the same way the Drizzle migrator does.
 */
export async function initialiseControlStore(options: {
  config: Config
  databaseOptions: DatabaseOptions
  control: SqlDatabase
  env?: Record<string, string | undefined>
  log?: (line: string) => void
}): Promise<ControlStoreResult & { legacy?: Database }> {
  const controlOptions = controlDatabaseOptions(options.config, options.databaseOptions)
  if (controlOptions.backend !== 'sqlite' || !controlOptions.path) return initialiseControlStoreUnlocked(options)

  const lock = `${controlOptions.path}.init.lock`
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60_000) {
          rmSync(lock, { recursive: true, force: true })
          continue
        }
      } catch {
        // The holder removed it between the two calls: try again.
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the control database lock at ${lock}.`, { cause: error })
      await Bun.sleep(25)
    }
  }
  try {
    return await initialiseControlStoreUnlocked(options)
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}
