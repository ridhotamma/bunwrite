/**
 * Project registry and per-project runtime cache. The control database holds
 * `_projects`, console admins and the organization; it is separate from every
 * project database, so a project can be deleted without taking the console
 * with it.
 *
 * The first project created by an older install is kept at the original
 * DATABASE_PATH (`legacy`) so existing files, deployments and backups keep
 * working. Every project created afterwards lives under
 * `projects/<id>/bunwrite.sqlite`.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { Config } from '~/config'
import { databaseOptionsOf, dropDatabase, openDatabase, sqlDatabaseOf, sqliteDatabase, type Database, type DatabaseOptions } from '~/db'
import { openDb } from '~/db/connection'
import type { SqlDatabase } from '~/db/driver'
import {
  bootstrapInstance,
  bootstrapInstanceAsync,
  clearInstanceApiKey,
  clearInstanceApiKeyAsync,
  type BootstrapOptions,
  type BootstrapResult,
} from '~/instance/bootstrap'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { siteHost } from '~/lib/hosts'
import { randomSecret, resolveId } from '~/lib/ids'
import { removeTree } from '~/functions/sandbox'
import type { FunctionRow } from '~/functions/service'
import { pruneRateLimits } from '~/lib/limits'
import { flushBackgroundMail } from '~/mail/mailer'
import { telemetryOptionsOf } from '~/observability/settings'
import { createServices, type Services } from '~/services'
import type { SiteRow } from '~/sites/service'
import type { SqliteSynchronous } from '~/system/autotune'
import { dataDirOf, projectNamespaceOf, projectPaths, type ProjectPaths } from './paths'
import type { ProjectCreateInput, ProjectInfo, ProjectResolver, ProjectRuntime } from './types'

interface ProjectRow {
  id: string
  name: string
  org_id: string
  is_default: number
  legacy: number
  created_at: string
  updated_at: string
}

export interface ProjectManagerOptions {
  config: Config
  db: SqlDatabase
  /** The console/control services, built on the separate control database. */
  services: Services
  /** Root for `projects/<id>/...`; defaults to DATABASE_PATH's folder. */
  dataDir?: string
  /**
   * Environment default for new project databases. The default project's
   * console setting must not become the default for every other project.
   */
  sqliteSynchronous?: SqliteSynchronous
  /** Backend options the control database was opened with; project schemas inherit them. */
  database?: DatabaseOptions
}

const infoOf = (row: ProjectRow): ProjectInfo => ({
  id: row.id,
  name: row.name,
  orgId: row.org_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  isDefault: Boolean(row.is_default),
})

const PROJECT_COLUMNS = 'id, name, org_id, is_default, legacy, created_at, updated_at'

export class ProjectManager implements ProjectResolver {
  readonly control: Services
  private readonly config: Config
  private readonly db: SqlDatabase
  private readonly dataDir: string
  private readonly databaseOptions: DatabaseOptions
  /** Env default for project databases, before a project's console override. */
  private readonly sqliteSynchronous: SqliteSynchronous
  private readonly runtimes = new Map<string, ProjectRuntime>()
  private readonly legacy = new Set<string>()
  private defaultId = ''
  private readyOnce: Promise<void> | null = null

  constructor(options: ProjectManagerOptions) {
    this.control = options.services
    this.config = options.config
    this.db = options.db
    this.dataDir = options.dataDir ?? dataDirOf(options.config.databasePath)
    this.sqliteSynchronous = options.sqliteSynchronous ?? options.config.sqliteSynchronous
    this.databaseOptions = options.database ?? databaseOptionsOf(options.config)
  }

  /**
   * Load the control caches and every project runtime. SQLite used to do this
   * synchronously in the constructor; the network backends need the driver, so
   * the server awaits this before it starts listening.
   */
  ready(): Promise<void> {
    this.readyOnce ??= this.loadAll()
    return this.readyOnce
  }

  private async loadAll(): Promise<void> {
    // Load the control caches first: bootstrap and the project list read the
    // settings overlay (project name, SMTP) they produce.
    await this.control.ready()
    await this.load()
    for (const runtime of this.runtimes.values()) this.linkServices(runtime.services)
    // The rows this process just wrote are already reflected in memory.
    await this.control.versions.resetAsync()
    this.control.backups.start()
  }

  private async load(): Promise<void> {
    const rows = await this.db.driver.all<ProjectRow>(`SELECT ${PROJECT_COLUMNS} FROM _projects ORDER BY seq`)
    let defaultId = ''
    for (const row of rows) {
      const info = infoOf(row)
      try {
        const runtime = await this.open(info, Boolean(row.legacy))
        this.runtimes.set(info.id, runtime)
        if (row.legacy) this.legacy.add(info.id)
        if (row.is_default) defaultId = info.id
      } catch (error) {
        console.error(`[projects] could not open ${info.id}:`, error)
      }
    }
    if (!defaultId) {
      defaultId = rows.find((row) => this.runtimes.has(row.id))?.id ?? ''
      if (defaultId) await this.setDefault(defaultId)
    }
    this.defaultId = defaultId
  }

  private paths(id: string, legacy = false): ProjectPaths {
    if (!legacy) return projectPaths(this.dataDir, id)
    return {
      dir: this.dataDir,
      database: this.config.databasePath,
      storage: this.config.storagePath,
      backups: this.config.backupsPath,
      functions: this.config.functionsDir,
    }
  }

  /** The network namespace a project owns, or the SQLite file's base namespace. */
  private projectOptions(id: string): DatabaseOptions {
    const paths = this.paths(id)
    return {
      ...this.databaseOptions,
      path: paths.database,
      namespace: projectNamespaceOf(this.databaseOptions.namespace, id, this.databaseOptions.backend),
    }
  }

  private configFor(info: ProjectInfo, paths: ProjectPaths, instance: BootstrapResult, namespace: string | undefined, legacy: boolean): Config {
    const base = this.config
    return {
      ...base,
      projectId: instance.projectId,
      orgId: instance.orgId,
      projectName: instance.projectName,
      databasePath: paths.database,
      databaseDriver: this.databaseOptions.backend,
      databaseUrl: this.databaseOptions.url,
      databaseNamespace: namespace,
      databasePoolMax: this.databaseOptions.poolMax,
      databaseSsl: this.databaseOptions.ssl,
      sqliteSynchronous: this.sqliteSynchronous,
      storagePath: paths.storage,
      backupsPath: paths.backups,
      instanceBackups: false,
      functionsDir: paths.functions,
      functionsEnvFile: legacy ? base.functionsEnvFile : undefined,
      schemaPath: legacy ? base.schemaPath : undefined,
      schemaSyncOnStart: false,
      apiKeys: legacy ? [...base.apiKeys] : [],
      secret: instance.secret,
      internalKey: undefined,
      skipSchedules: legacy ? [...base.skipSchedules] : [],
      bootstrap: { orgId: info.orgId, projectId: info.id, apiKey: instance.apiKey, generated: instance.generated },
      s3: { ...base.s3 },
      storagePrefix: info.id,
      backups: { ...base.backups, s3: { ...base.backups.s3 } },
      backupsPrefix: info.id,
      render: { ...base.render },
      cache: { ...base.cache },
      smtp: null,
      consoleSmtp: null,
      oauth: Object.fromEntries(Object.entries(base.oauth).map(([id, config]) => [id, config ? { ...config } : config])),
      allowedOrigins: [...base.allowedOrigins],
      legacyDatabasePath: undefined,
      controlDatabasePath: undefined,
      controlDatabaseNamespace: undefined,
    }
  }

  private async open(info: ProjectInfo, legacy: boolean): Promise<ProjectRuntime> {
    const paths = this.paths(info.id, legacy)
    if (!legacy) {
      mkdirSync(paths.storage, { recursive: true })
      mkdirSync(paths.backups, { recursive: true })
      mkdirSync(paths.functions, { recursive: true })
    } else if (paths.storage) {
      mkdirSync(paths.storage, { recursive: true })
    }
    if (this.databaseOptions.backend === 'sqlite' && !existsSync(paths.database)) {
      console.warn(`[projects] database missing for ${info.id}; creating a new empty project`)
    }

    const database = legacy ? await this.openLegacyDatabase() : await this.openProjectDatabase(info.id)
    const db = sqlDatabaseOf(database)

    try {
      const instance = await this.bootstrap(
        db,
        {
          ORG_ID: info.orgId,
          PROJECT_ID: info.id,
          SECRET: randomSecret(32),
        },
        { generateApiKey: false, seedConsoleSmtp: false, projectName: info.name },
      )

      if (info.orgId !== instance.orgId) {
        info.orgId = instance.orgId
        info.updatedAt = now()
        await this.db.driver.run('UPDATE _projects SET org_id = ?, updated_at = ? WHERE id = ?', [info.orgId, info.updatedAt, info.id])
      }
      const namespace = legacy ? this.databaseOptions.namespace : projectNamespaceOf(this.databaseOptions.namespace, info.id, this.databaseOptions.backend)
      const config = this.configFor(info, paths, instance, namespace, legacy)
      const services = createServices(config, db)
      // A network backend starts empty; load settings, registry and the other
      // caches before the runtime can receive traffic.
      await services.ready()
      // Before observability became per project it lived in the control
      // database. Give an existing project its own copy once, then let it
      // diverge; later resets or edits only affect this project.
      if (this.control.observabilitySettings.overridden && !services.observabilitySettings.overridden) {
        await services.observabilitySettings.save(this.control.observabilitySettings.settings)
      }
      if (services.config.projectName !== info.name) {
        info.name = services.config.projectName
        info.updatedAt = now()
        await this.db.driver.run('UPDATE _projects SET name = ?, updated_at = ? WHERE id = ?', [info.name, info.updatedAt, info.id])
      }
      return { info, services }
    } catch (error) {
      await database.close().catch(() => {})
      throw error
    }
  }

  private openLegacyDatabase(): Promise<Database> {
    if (this.databaseOptions.backend === 'sqlite') {
      const db = openDb(this.config.databasePath, undefined, undefined, undefined, undefined, this.sqliteSynchronous)
      return Promise.resolve(sqliteDatabase(db))
    }
    return openDatabase(this.databaseOptions)
  }

  private openProjectDatabase(id: string): Promise<Database> {
    if (this.databaseOptions.backend === 'sqlite') {
      // Use the server default for a new project database; the control
      // project's console setting must not leak into other projects.
      const db = openDb(this.paths(id).database, undefined, undefined, undefined, undefined, this.sqliteSynchronous)
      return Promise.resolve(sqliteDatabase(db))
    }
    return openDatabase(this.projectOptions(id))
  }

  private async bootstrap(db: SqlDatabase, env: Record<string, string | undefined>, options: BootstrapOptions): Promise<BootstrapResult> {
    return db.dialect === 'sqlite' ? bootstrapInstance(db, env, options) : bootstrapInstanceAsync(db, env, options)
  }

  private async clearBootstrapKey(db: SqlDatabase): Promise<void> {
    // Keep the row: create() returns this key to the caller and it must work.
    if (db.dialect === 'sqlite') {
      clearInstanceApiKey(db, false)
      return
    }
    await clearInstanceApiKeyAsync(db, false)
  }

  async clearDefaultApiKey(revoke = true): Promise<void> {
    const runtime = this.defaultProject()
    if (runtime.services.db.dialect === 'sqlite') clearInstanceApiKey(runtime.services.db, revoke)
    else await clearInstanceApiKeyAsync(runtime.services.db, revoke)
    if (runtime.services.config.bootstrap) runtime.services.config.bootstrap.apiKey = undefined
  }

  defaultProject(): ProjectRuntime {
    const runtime = this.runtimes.get(this.defaultId) ?? this.runtimes.values().next().value
    if (!runtime) throw err('project_not_found')
    return runtime
  }

  defaultProjectId(): string {
    return this.defaultProject().info.id
  }

  get(id: string): ProjectRuntime | null {
    return this.runtimes.get(id) ?? null
  }

  list(): ProjectRuntime[] {
    return [...this.runtimes.values()]
  }

  async findFunction(functionId: string): Promise<ProjectRuntime | null> {
    for (const runtime of this.runtimes.values()) {
      if ((await runtime.services.functions.list()).some((f) => f.id === functionId)) return runtime
    }
    return null
  }

  async findFunctionByHost(host: string): Promise<{ project: ProjectRuntime; fn: FunctionRow } | null> {
    for (const runtime of this.runtimes.values()) {
      const fn = await runtime.services.functions.byHost(host)
      if (fn) return { project: runtime, fn }
    }
    return null
  }

  async findSite(host: string): Promise<{ project: ProjectRuntime; site: SiteRow; deploymentId: string | null } | null> {
    for (const runtime of this.runtimes.values()) {
      const found = await runtime.services.sites.resolveHost(host)
      if (found) return { project: runtime, ...found }
    }
    return null
  }

  /** Site IDs and custom domains are hosts, so they must be unique across projects. */
  private linkServices(services: Services): void {
    // Each project's observability store and local telemetry limits are its own.
    services.telemetry.configure(telemetryOptionsOf(services.observabilitySettings.config))
    services.sites.peers = () => [...this.runtimes.values()].map((r) => r.services.sites)
    services.functions.peers = () => [...this.runtimes.values()].map((r) => r.services.functions)
    services.proxy.peers = () => [...this.runtimes.values()].map((r) => r.services.proxy)
    services.proxy.reservedHosts = () =>
      [...this.runtimes.values()].flatMap((r) => [
        ...r.services.sites.list().map((site) => siteHost(r.services.config, site.id)),
        ...r.services.functions.hosts(),
      ])
  }

  private async setDefault(id: string): Promise<void> {
    await this.db.driver.run('UPDATE _projects SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END', [id])
    this.defaultId = id
  }

  async create(input: ProjectCreateInput): Promise<{ project: ProjectRuntime; apiKey?: string }> {
    const id = resolveId(input.id, 'Project ID')
    // `console` is how the Appwrite CLI addresses the console API.
    if (id.toLowerCase() === 'console') throw err('general_argument_invalid', 'The project ID "console" is reserved.')
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.length > 128) throw err('general_argument_invalid', 'A project needs a name of 128 characters or less.')
    if (this.runtimes.has(id) || (await this.db.driver.get<{ id: string }>('SELECT id FROM _projects WHERE id = ?', [id]))) {
      throw err('general_argument_invalid', `Project ${id} already exists.`)
    }

    const paths = this.paths(id)
    let database: Database | undefined
    let services: Services | undefined
    let inserted = false
    const isDefault = !(await this.db.driver.get<{ id: string }>('SELECT id FROM _projects LIMIT 1'))
    try {
      mkdirSync(paths.storage, { recursive: true })
      mkdirSync(paths.backups, { recursive: true })
      mkdirSync(paths.functions, { recursive: true })
      database = await this.openProjectDatabase(id)
      const db = sqlDatabaseOf(database)

      const instance = await this.bootstrap(
        db,
        { ORG_ID: input.orgId, PROJECT_ID: id, SECRET: randomSecret(32) },
        { generateApiKey: true, seedConsoleSmtp: false, projectName: name },
      )
      const info: ProjectInfo = { id, name, orgId: instance.orgId, createdAt: now(), updatedAt: now(), isDefault }
      const config = this.configFor(info, paths, instance, projectNamespaceOf(this.databaseOptions.namespace, id, this.databaseOptions.backend), false)
      services = createServices(config, db)
      await services.ready()
      await this.db.driver.run('INSERT INTO _projects (id, name, org_id, is_default, legacy, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)', [
        info.id,
        info.name,
        info.orgId,
        isDefault ? 1 : 0,
        info.createdAt,
        info.updatedAt,
      ])
      inserted = true
      const apiKey = instance.apiKey
      // The key is returned to the caller once and stays hashed in _api_keys.
      await this.clearBootstrapKey(db)
      if (config.bootstrap) config.bootstrap.apiKey = undefined
      const runtime: ProjectRuntime = { info, services }
      this.runtimes.set(id, runtime)
      if (isDefault) this.defaultId = id
      this.linkServices(services)
      services.functions.start()
      services.backups.start()
      services.queue.start()
      services.render.start()
      await this.control.versions.resetAsync()
      return { project: runtime, apiKey }
    } catch (error) {
      this.runtimes.delete(id)
      if (inserted) await this.db.driver.run('DELETE FROM _projects WHERE id = ?', [id]).catch(() => {})
      if (services) {
        await services.observability.close()
        services.functions.stop()
        services.sites.stop()
        services.backups.stop()
        services.queue.stop()
        services.render.stop()
        services.realtime.stop()
        services.consoleEvents.stop()
      }
      await database?.close().catch(() => {})
      if (this.databaseOptions.backend !== 'sqlite') await dropDatabase(this.projectOptions(id)).catch(() => {})
      rmSync(paths.dir, { recursive: true, force: true })
      throw error
    }
  }

  async update(id: string, fields: { name?: string; orgId?: string }): Promise<ProjectInfo> {
    const runtime = this.runtimes.get(id)
    if (!runtime) throw err('general_argument_invalid', 'Unknown project.')
    if (fields.name !== undefined) runtime.info.name = fields.name
    if (fields.orgId !== undefined) runtime.info.orgId = fields.orgId
    runtime.info.updatedAt = now()
    await this.db.driver.run('UPDATE _projects SET name = ?, org_id = ?, updated_at = ? WHERE id = ?', [
      runtime.info.name,
      runtime.info.orgId,
      runtime.info.updatedAt,
      id,
    ])
    await this.control.versions.resetAsync()
    return runtime.info
  }

  /** Reconcile the open project runtimes with the control database. */
  private async reloadProjects(): Promise<void> {
    const rows = await this.db.driver.all<ProjectRow>(`SELECT ${PROJECT_COLUMNS} FROM _projects ORDER BY seq`)
    const seen = new Set<string>()
    let defaultId = ''
    for (const row of rows) {
      seen.add(row.id)
      if (row.is_default) defaultId = row.id
      const existing = this.runtimes.get(row.id)
      if (existing) {
        Object.assign(existing.info, infoOf(row))
        if (row.legacy) this.legacy.add(row.id)
        else this.legacy.delete(row.id)
        continue
      }
      try {
        const runtime = await this.open(infoOf(row), Boolean(row.legacy))
        this.runtimes.set(row.id, runtime)
        if (row.legacy) this.legacy.add(row.id)
        this.linkServices(runtime.services)
        runtime.services.functions.start()
        runtime.services.backups.start()
        runtime.services.queue.start()
        runtime.services.render.start()
      } catch (error) {
        console.error(`[projects] could not open ${row.id} after restore:`, error)
      }
    }
    for (const [id, runtime] of [...this.runtimes]) {
      if (seen.has(id)) continue
      runtime.services.functions.stop()
      runtime.services.sites.stop()
      runtime.services.backups.stop()
      runtime.services.queue.stop()
      runtime.services.render.stop()
      runtime.services.render.shutdown()
      runtime.services.realtime.stop()
      runtime.services.consoleEvents.stop()
      // The runtime is going away; close the connection once its buffered logs are safe.
      await runtime.services.requestLogs.flush()
      await runtime.services.observability.close()
      await runtime.services.db.driver.close()
      this.runtimes.delete(id)
      this.legacy.delete(id)
    }
    if (!defaultId) defaultId = rows.find((row) => this.runtimes.has(row.id))?.id ?? ''
    this.defaultId = defaultId
    for (const runtime of this.runtimes.values()) this.linkServices(runtime.services)
  }

  /** Remove one project's database, uploads and backups, keeping the console. */
  async delete(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime) throw err('general_argument_invalid', 'Unknown project.')
    const legacy = this.legacy.has(id)
    const replacement = [...this.runtimes.values()].find((entry) => entry.info.id !== id)
    // Stop routing new requests to it before the asynchronous cleanup.
    this.runtimes.delete(id)
    this.legacy.delete(id)

    runtime.services.functions.stop()
    runtime.services.sites.stop()
    runtime.services.backups.stop()
    runtime.services.queue.stop()
    runtime.services.render.stop()
    runtime.services.render.shutdown()
    runtime.services.realtime.stop()
    runtime.services.consoleEvents.stop()

    // Best effort: remove external objects before the local database goes away.
    for (const bucket of await runtime.services.storage.buckets()) {
      try {
        await runtime.services.storage.deleteBucket(bucket.id)
      } catch (error) {
        console.error(`[projects] could not delete bucket ${bucket.id} in ${id}:`, error)
      }
    }

    await runtime.services.requestLogs.flush()
    await runtime.services.observability.close()
    await this.db.driver.run('DELETE FROM _projects WHERE id = ?', [id])
    await runtime.services.db.driver.close()

    const paths = this.paths(id, legacy)
    if (legacy) {
      // The original project shares the data folder with the control store.
      // Never remove the folder itself, the instance backups or the external
      // functions folder; only this project's database, uploads and builds.
      if (this.databaseOptions.backend === 'sqlite') {
        for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${paths.database}${suffix}`, { force: true })
      } else {
        try {
          await dropDatabase({ ...this.databaseOptions, namespace: this.databaseOptions.namespace })
        } catch (error) {
          console.error(`[projects] could not remove the ${this.databaseOptions.backend} namespace for ${id}:`, error)
        }
      }
      if (this.config.storagePath) rmSync(this.config.storagePath, { recursive: true, force: true })
      const base = dirname(resolve(this.config.databasePath))
      rmSync(resolve(base, 'sites'), { recursive: true, force: true })
      rmSync(resolve(base, 'deployments'), { recursive: true, force: true })
    } else {
      if (this.databaseOptions.backend !== 'sqlite') {
        try {
          await dropDatabase(this.projectOptions(id))
        } catch (error) {
          console.error(`[projects] could not remove the ${this.databaseOptions.backend} namespace for ${id}:`, error)
        }
      }
      // Isolated functions own their folders, so the sandbox deletes them.
      removeTree(this.config.functionsSandbox, paths.dir)
    }

    if (this.defaultId === id) {
      if (replacement) await this.setDefault(replacement.info.id)
      else this.defaultId = ''
    }
    await this.control.versions.resetAsync()
  }

  /** Start schedulers for every project and the instance backup timer. */
  start(): void {
    this.control.backups.start()
    for (const runtime of this.runtimes.values()) {
      runtime.services.functions.start()
      runtime.services.backups.start()
      runtime.services.queue.start()
      runtime.services.render.start()
    }
  }

  /**
   * Apply schema, settings and project-list changes made by another process.
   * Called at the start of a request; the version check is throttled.
   */
  async sync(): Promise<void> {
    // Single-process servers also use these counters for session/API-key caches.
    const changed = await this.control.versions.pollAsync()
    if (changed.schema) await this.control.registry.load()
    if (changed.settings) {
      await this.control.settings.load()
      await this.control.observabilitySettings.load()
      await this.control.access.load()
    }
    if (changed.catalog) {
      await this.control.proxy.reload()
      this.control.sites.reload()
    }
    if (changed.projects) await this.reloadProjects()
  }

  /** Run the periodic cleanup for every project. */
  async prune(): Promise<void> {
    await this.control.requestLogs.prune()
    await this.control.telemetry.prune()
    await pruneRateLimits(this.control.db)
    for (const runtime of this.runtimes.values()) {
      await runtime.services.transactions.prune()
      await runtime.services.auth.pruneExpired()
      await runtime.services.functions.prune()
      await runtime.services.functions.pruneDeployments()
      await runtime.services.sites.pruneDeployments()
      runtime.services.queue.prune()
      await runtime.services.requestLogs.prune()
      await runtime.services.telemetry.prune()
      await runtime.services.storage.prunePreviews()
      runtime.services.realtime.pruneBus()
      await pruneRateLimits(runtime.services.db)
    }
  }

  async close(): Promise<void> {
    this.control.backups.stop()
    const closing = [...this.runtimes]
    for (const [, runtime] of closing) {
      // Schedulers would otherwise tick on into a closed database.
      runtime.services.functions.stop()
      runtime.services.sites.stop()
      runtime.services.backups.stop()
      runtime.services.queue.stop()
      runtime.services.render.stop()
      runtime.services.realtime.stop()
      runtime.services.consoleEvents.stop()
    }
    await Promise.all(closing.map(([, runtime]) => runtime.services.requestLogs.flush()))
    await flushBackgroundMail()
    await Promise.all(closing.map(([, runtime]) => runtime.services.observability.close()))
    await Promise.all(closing.map(([, runtime]) => runtime.services.telemetry.close()))
    for (const [, runtime] of closing) await runtime.services.db.driver.close()
  }
}

export function createProjectManager(options: ProjectManagerOptions): ProjectManager {
  return new ProjectManager(options)
}
