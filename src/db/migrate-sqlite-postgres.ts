/**
 * Offline SQLite -> Postgres migration.
 *
 * The server keeps SQLite as the system of record until the operator switches
 * the environment. This module reads the stopped SQLite control/project files
 * and writes the same rows into Postgres schemas, then reports exactly what
 * moved. It is intentionally not an online replication tool: stop the server
 * first so the source files do not change while they are copied.
 */
import { Database as BunDatabase } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { configFromEnv } from '~/config'
import { copyTable, columnsOf, copyTables, listTables, nonEmptyTables, reportTotals, resetSequences, rowCount } from './copy'
import { dropDatabase, openDatabase, sqlDatabaseOf, type Database } from './index'
import type { SqlDatabase } from './driver'
import { postgresCollectionVersionStatements, postgresDocumentIndexStatements, postgresDocumentTableStatements } from './postgres-schema'
import { createSqliteDriver } from './sqlite-driver'
import { bootstrapInstanceAsync } from '~/instance/bootstrap'
import { now } from '~/lib/datetime'
import { CONTROL_PROJECT_ID, CONTROL_STATE_KEY, CONTROL_STATE_VERSION, CONTROL_TABLES, controlDatabasePath } from '~/projects/control'
import { dataDirOf, projectNamespace, projectPaths } from '~/projects/paths'
import { normalizeAttribute, normalizeIndex, tableName } from '~/schema/types'

export interface MigrateSqliteOptions {
  /** Main SQLite database; defaults to DATABASE_PATH. */
  source?: string
  /** SQLite control database; defaults to control/bunwrite.sqlite beside the source. */
  control?: string
  /** Folder containing projects/; defaults to the source database's folder. */
  dataDir?: string
  /** Postgres URL; defaults to DATABASE_URL. */
  url?: string
  /** Require TLS for the target; defaults to DATABASE_SSL. */
  ssl?: boolean
  /** Base Postgres schema; defaults to DATABASE_SCHEMA or bunwrite. */
  schema?: string
  /** Control schema; defaults to CONTROL_DATABASE_SCHEMA or <base>_console. */
  controlSchema?: string
  /** Replace data already in the target schemas. */
  force?: boolean
  /** Print the plan and source table counts without writing. */
  dryRun?: boolean
  /** Skip request logs, telemetry spans/events/minutes and queue history. */
  skipLogs?: boolean
  log?: (line: string) => void
}

export interface MigrationProjectPlan {
  id: string
  name: string
  legacy: boolean
  source: string
  schema: string
  tables: number
}

export interface MigrationPlan {
  source: string
  controlSource: string
  controlCurrentLayout: boolean
  dataDir: string
  targetUrl: string
  targetSsl: boolean
  targetBase: string
  controlSchema: string
  projects: MigrationProjectPlan[]
}

export interface MigrationProjectReport {
  id: string
  source: string
  schema: string
  tables: number
  rows: number
  missingColumns: string[]
}

export interface MigrationReport {
  ok: boolean
  dryRun: boolean
  plan: MigrationPlan
  control?: { source: string; schema: string; tables: number; rows: number; missingColumns: string[] }
  projects: MigrationProjectReport[]
  durationMs: number
}

interface ProjectRow {
  id: string
  name: string
  org_id?: string
  legacy?: number | boolean
  is_default?: number | boolean
}

interface LegacyInstance {
  orgId?: string
  projectId?: string
  projectName?: string
  secret?: string
}

const LOG_TABLES = new Set(['_request_logs', '_telemetry_spans', '_telemetry_events', '_telemetry_minutes'])
const CONTROL_ONLY_TABLES = new Set<string>([
  '_projects',
  '_organizations',
  '_organization_members',
  '_console_admins',
  '_console_mfa_challenges',
  '_console_sessions',
  '_vcs_installations',
  '_vcs_github_app',
  '_vcs_repositories',
  '_vcs_comments',
])

const logOf = (options: MigrateSqliteOptions) => options.log ?? (() => {})

function openReadonly(path: string): SqlDatabase {
  if (!existsSync(path)) throw new Error(`SQLite database not found: ${path}`)
  const sqlite = new BunDatabase(path, { readonly: true, strict: true })
  const driver = createSqliteDriver({ db: sqlite })
  return { driver, dialect: 'sqlite', capabilities: driver.capabilities, sqlite }
}

async function closeReadonly(db: SqlDatabase): Promise<void> {
  await db.driver.close()
}

async function setting(db: SqlDatabase, key: string): Promise<string | null> {
  try {
    const row = await db.driver.get<{ value: string }>('SELECT value FROM _settings WHERE key = ?', [key])
    return row?.value ?? null
  } catch {
    return null
  }
}

async function projectRows(db: SqlDatabase): Promise<ProjectRow[]> {
  try {
    const columns = new Set(await columnsOf(db, '_projects'))
    const legacy = columns.has('legacy') ? 'legacy' : '0 AS legacy'
    const isDefault = columns.has('is_default') ? 'is_default' : '0 AS is_default'
    return await db.driver.all<ProjectRow>(`SELECT id, name, org_id, ${legacy}, ${isDefault} FROM _projects ORDER BY seq`)
  } catch {
    return []
  }
}

function parseInstance(value: string | null): LegacyInstance | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as LegacyInstance
  } catch {
    return null
  }
}

function normalizeSchema(value: string): string {
  const schema = value.trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`Postgres schema "${value}" is not a valid identifier. Use letters, numbers and underscores, starting with a letter or underscore.`)
  }
  if (schema.length > 63) throw new Error(`Postgres schema "${value}" is longer than 63 characters.`)
  return schema
}

/**
 * Read the SQLite layout and produce the schema/plan without touching
 * Postgres. Useful for `--dry-run` and tests.
 */
export async function planSqliteMigration(options: MigrateSqliteOptions = {}): Promise<MigrationPlan> {
  const config = configFromEnv()
  const sourcePath = resolve(options.source ?? config.databasePath)
  const dataDir = resolve(options.dataDir ?? dataDirOf(sourcePath))
  const targetUrl = options.url ?? config.databaseUrl ?? ''
  if (!targetUrl) throw new Error('A Postgres target URL is required. Pass --url or set DATABASE_URL.')
  const targetSsl = options.ssl ?? config.databaseSsl ?? false

  const defaultControl = config.controlDatabasePath ? resolve(config.controlDatabasePath) : controlDatabasePath({ ...config, databasePath: sourcePath })
  const controlPath = resolve(options.control ?? defaultControl)
  const targetBase = normalizeSchema(options.schema ?? config.databaseNamespace ?? 'bunwrite')
  const controlSchema = normalizeSchema(options.controlSchema ?? config.controlDatabaseNamespace ?? projectNamespace(targetBase, CONTROL_PROJECT_ID))

  let main: SqlDatabase | null = null
  let control: SqlDatabase | null = null
  const mainDb = () => (main ??= openReadonly(sourcePath))
  try {
    if (existsSync(controlPath) && controlPath !== sourcePath) control = openReadonly(controlPath)
    const currentControl = Boolean(control && (await setting(control, CONTROL_STATE_KEY)))
    const registrySource = currentControl && control ? control : mainDb()
    let rows = await projectRows(registrySource)
    if (!currentControl && rows.length === 0) {
      const instance = parseInstance(await setting(registrySource, 'instance'))
      const id = instance?.projectId || 'default'
      rows = [{ id, name: instance?.projectName || id, org_id: instance?.orgId || '', legacy: true, is_default: true }]
    }
    const instance = currentControl ? null : parseInstance(await setting(registrySource, 'instance'))
    const legacyId = currentControl ? rows.find((row) => Boolean(row.legacy))?.id : instance?.projectId || rows[0]?.id
    const projects: MigrationProjectPlan[] = []
    const schemas = new Set<string>([controlSchema])
    for (const row of rows) {
      const legacy = Boolean(row.legacy) || (!currentControl && row.id === legacyId)
      const schema = normalizeSchema(legacy ? targetBase : projectNamespace(targetBase, row.id))
      if (schemas.has(schema)) throw new Error(`Two projects map to the same Postgres schema "${schema}". Use a different --schema.`)
      schemas.add(schema)
      const source = legacy ? sourcePath : projectPaths(dataDir, row.id).database
      if (!existsSync(source)) throw new Error(`Project "${row.id}" database not found: ${source}`)
      const db = source === sourcePath ? mainDb() : openReadonly(source)
      try {
        projects.push({ id: row.id, name: row.name, legacy, source, schema, tables: (await listTables(db)).length })
      } finally {
        if (db !== main) await closeReadonly(db)
      }
    }
    return {
      source: sourcePath,
      controlSource: currentControl ? controlPath : sourcePath,
      controlCurrentLayout: currentControl,
      dataDir,
      targetUrl,
      targetSsl,
      targetBase,
      controlSchema,
      projects,
    }
  } finally {
    if (control) await closeReadonly(control)
    if (main) await closeReadonly(main)
  }
}

async function createDocumentTables(source: SqlDatabase, target: SqlDatabase, projectId: string, log: (line: string) => void): Promise<void> {
  const databases = await source.driver.all<{ seq: number; id: string }>('SELECT seq, id FROM _databases')
  const collectionRows = await source.driver.all<{ database_id: string; id: string; attributes: string; indexes: string }>(
    'SELECT database_id, id, attributes, indexes FROM _collections',
  )
  const databaseSeq = new Map(databases.map((database) => [database.id, Number(database.seq)]))
  for (const collection of collectionRows) {
    const dseq = databaseSeq.get(collection.database_id)
    if (!dseq) throw new Error(`Project "${projectId}" collection "${collection.id}" points at unknown database "${collection.database_id}".`)
    const table = tableName(dseq, collection.id)
    let attributes
    let indexes
    try {
      attributes = (JSON.parse(collection.attributes || '[]') as unknown[]).map(normalizeAttribute)
      indexes = (JSON.parse(collection.indexes || '[]') as unknown[]).map(normalizeIndex)
    } catch (error) {
      throw new Error(
        `Project "${projectId}" collection "${collection.id}" has invalid schema metadata: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    for (const statement of postgresDocumentTableStatements(table, attributes)) await target.driver.exec(statement)
    for (const statement of postgresDocumentIndexStatements(table, indexes, attributes)) await target.driver.exec(statement)
    for (const statement of postgresCollectionVersionStatements(collection.database_id, collection.id, table)) await target.driver.exec(statement)
  }
  if (collectionRows.length > 0) log(`  ${collectionRows.length} collection table(s) prepared`)
}

async function migrateLegacyControl(source: SqlDatabase, target: SqlDatabase, plan: MigrationPlan, log: (line: string) => void): Promise<void> {
  const instance = parseInstance(await setting(source, 'instance'))
  await bootstrapInstanceAsync(
    target,
    {
      ORG_ID: instance?.orgId,
      PROJECT_ID: CONTROL_PROJECT_ID,
      SECRET: instance?.secret,
    },
    { generateApiKey: false, seedConsoleSmtp: false, projectName: instance?.projectName ?? 'Bunwrite' },
  )
  const sourceTables = new Set(await listTables(source))
  for (const table of CONTROL_TABLES) {
    if (sourceTables.has(table)) await copyTable(source, target, table, { log })
  }

  const settings = await source.driver.all<{ key: string; value: string; updated_at: string }>('SELECT key, value, updated_at FROM _settings')
  await target.driver.run('DELETE FROM _settings WHERE key NOT IN (?, ?, ?)', ['instance', 'env_seed', CONTROL_STATE_KEY])
  for (const row of settings) {
    if (row.key === 'instance' || row.key === 'env_seed' || row.key === CONTROL_STATE_KEY) continue
    await target.driver.run(
      'INSERT INTO _settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [row.key, row.value, row.updated_at],
    )
  }

  const rows = await projectRows(source)
  const legacyId = plan.projects.find((project) => project.legacy)?.id ?? instance?.projectId ?? rows[0]?.id ?? 'default'
  const projects = rows.length
    ? rows
    : [{ id: legacyId, name: instance?.projectName ?? legacyId, org_id: instance?.orgId ?? '', legacy: true, is_default: true }]
  await target.driver.run('DELETE FROM _projects')
  for (const row of projects) {
    const legacy = row.id === legacyId
    const stamp = now()
    await target.driver.run('INSERT INTO _projects (id, name, org_id, is_default, legacy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      row.id,
      row.name,
      row.org_id ?? '',
      legacy ? 1 : 0,
      legacy ? 1 : 0,
      stamp,
      stamp,
    ])
  }
  await target.driver.run(
    'INSERT INTO _settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [CONTROL_STATE_KEY, JSON.stringify({ version: CONTROL_STATE_VERSION, legacyProjectId: legacyId }), now()],
  )
  log(`  legacy control store migrated (${projects.length} project${projects.length === 1 ? '' : 's'})`)
}

async function prepareTarget(url: string, ssl: boolean, force: boolean, schema: string, log: (line: string) => void): Promise<Database> {
  if (force) {
    if (schema === 'public') {
      throw new Error('--force cannot replace the public schema. Use a dedicated --schema such as bunwrite.')
    }
    await dropDatabase({ backend: 'postgres', url, ssl, namespace: schema })
  }
  return openDatabase({
    backend: 'postgres',
    url,
    ssl,
    namespace: schema,
    bootstrap: true,
    log,
  })
}

async function assertEmpty(target: Database, schema: string): Promise<void> {
  const nonEmpty = await nonEmptyTables(sqlDatabaseOf(target))
  if (nonEmpty.length === 0) return
  const summary = nonEmpty
    .slice(0, 8)
    .map((entry) => `${entry.table} (${entry.rows})`)
    .join(', ')
  throw new Error(
    `Target schema "${schema}" already contains data: ${summary}${nonEmpty.length > 8 ? ', …' : ''}. Re-run with --force to replace it, or choose another --schema.`,
  )
}

/**
 * Copy a stopped SQLite install into Postgres. The target schemas are empty by
 * default; `force` replaces non-empty non-public schemas.
 */
export async function migrateSqliteToPostgres(options: MigrateSqliteOptions = {}): Promise<MigrationReport> {
  const log = logOf(options)
  const started = performance.now()
  const plan = await planSqliteMigration(options)
  const skip = options.skipLogs ? new Set(LOG_TABLES) : undefined
  if (options.dryRun) {
    return { ok: true, dryRun: true, plan, projects: [], durationMs: Math.round(performance.now() - started) }
  }

  const schemas = [plan.controlSchema, ...plan.projects.map((project) => project.schema)]
  if (options.force) {
    const publicSchema = schemas.find((schema) => schema === 'public')
    if (publicSchema) throw new Error('--force cannot replace the public schema. Use a dedicated --schema such as bunwrite.')
  } else {
    // Check every target before writing so a non-empty project schema cannot
    // leave a half-migrated control store behind.
    for (const schema of schemas) {
      const target = await openDatabase({ backend: 'postgres', url: plan.targetUrl, ssl: plan.targetSsl, namespace: schema, bootstrap: true, log })
      try {
        await assertEmpty(target, schema)
      } finally {
        await target.close()
      }
    }
  }

  let main: SqlDatabase | null = null
  let control: SqlDatabase | null = null
  const mainDb = () => (main ??= openReadonly(plan.source))
  try {
    control = plan.controlCurrentLayout ? openReadonly(plan.controlSource) : mainDb()
    const controlSource = control ?? mainDb()
    log(`[migrate] control -> ${plan.controlSchema}`)
    const targetControl = await prepareTarget(plan.targetUrl, plan.targetSsl, Boolean(options.force), plan.controlSchema, log)
    const controlTarget = sqlDatabaseOf(targetControl)
    let controlReport: MigrationReport['control']
    try {
      if (!options.force) await assertEmpty(targetControl, plan.controlSchema)
      let reports: Awaited<ReturnType<typeof copyTables>>
      if (plan.controlCurrentLayout) {
        reports = await copyTables(controlSource, controlTarget, { skip, log })
        await resetSequences(controlTarget, plan.controlSchema)
      } else {
        await migrateLegacyControl(mainDb(), controlTarget, plan, log)
        await resetSequences(controlTarget, plan.controlSchema)
        reports = []
        for (const table of await listTables(controlTarget)) {
          reports.push({ table, rows: await rowCount(controlTarget, table), columns: 0, missingColumns: [] })
        }
      }
      const totals = reportTotals(reports)
      controlReport = { source: plan.controlSource, schema: plan.controlSchema, tables: totals.tables, rows: totals.rows, missingColumns: totals.missing }
      log(`[migrate] control: ${totals.tables} tables, ${totals.rows.toLocaleString('en-US')} rows`)
    } finally {
      await targetControl.close()
    }

    const projectReports: MigrationProjectReport[] = []
    for (const project of plan.projects) {
      log(`[migrate] ${project.id} -> ${project.schema}`)
      const source = project.source === plan.source ? mainDb() : openReadonly(project.source)
      const target = await prepareTarget(plan.targetUrl, plan.targetSsl, Boolean(options.force), project.schema, log)
      const projectTarget = sqlDatabaseOf(target)
      try {
        if (!options.force) await assertEmpty(target, project.schema)
        await createDocumentTables(source, projectTarget, project.id, log)
        const projectSkip = new Set(skip ?? [])
        for (const table of CONTROL_ONLY_TABLES) projectSkip.add(table)
        const reports = await copyTables(source, projectTarget, { skip: projectSkip, log })
        await resetSequences(projectTarget, project.schema)
        const totals = reportTotals(reports)
        projectReports.push({
          id: project.id,
          source: project.source,
          schema: project.schema,
          tables: totals.tables,
          rows: totals.rows,
          missingColumns: totals.missing,
        })
        log(`[migrate] ${project.id}: ${totals.tables} tables, ${totals.rows.toLocaleString('en-US')} rows`)
      } finally {
        await target.close()
        if (source !== main) await closeReadonly(source)
      }
    }
    return {
      ok: true,
      dryRun: false,
      plan,
      control: controlReport,
      projects: projectReports,
      durationMs: Math.round(performance.now() - started),
    }
  } finally {
    if (control) await closeReadonly(control)
    if (main) await closeReadonly(main)
  }
}

/** Format the environment switch without leaking the database password. */
export function migrationEnvironment(plan: MigrationPlan): Record<string, string> {
  return {
    DB_DRIVER: 'postgres',
    DATABASE_URL: '<the URL passed to --url or DATABASE_URL>',
    DATABASE_SCHEMA: plan.targetBase,
    CONTROL_DATABASE_SCHEMA: plan.controlSchema,
  }
}
