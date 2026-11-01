/**
 * Project registry and per-project runtime cache. The control database (the
 * default project's database) holds `_projects` and console admins. Every
 * additional project has its own database, storage, backups and functions
 * folder, so the existing single-project services stay unchanged.
 *
 * On SQLite a project database is a file. On Postgres it is a schema in the
 * same server; the project ID decides the schema name.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'

import type { Config, SmtpConfig } from '~/config'
import { databaseOptionsOf, dropDatabase, openDatabase, sqlDatabaseOf, sqliteDatabase, type Database, type DatabaseOptions } from '~/db'
import { openDb } from '~/db/connection'
import type { SqlDatabase } from '~/db/driver'
import { bootstrapInstance, bootstrapInstanceAsync, clearInstanceApiKey, clearInstanceApiKeyAsync, type BootstrapResult } from '~/instance/bootstrap'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { siteHost } from '~/lib/hosts'
import { randomSecret, resolveId } from '~/lib/ids'
import { removeTree } from '~/functions/sandbox'
import type { FunctionRow } from '~/functions/service'
import { pruneRateLimits } from '~/lib/limits'
import { createServices, type Services } from '~/services'
import type { SiteRow } from '~/sites/service'
import type { SqliteSynchronous } from '~/system/autotune'
import { dataDirOf, projectNamespaceOf, projectPaths, type ProjectPaths } from './paths'
import type { ProjectCreateInput, ProjectInfo, ProjectResolver, ProjectRuntime } from './types'

interface ProjectRow {
  id: string
  name: string
  org_id: string
  created_at: string
  updated_at: string
}

export interface ProjectManagerOptions {
  config: Config
  db: SqlDatabase
  services: Services
  /** Root for `projects/<id>/...`; defaults to the control database's folder. */
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
})

const PROJECT_COLUMNS = 'id, name, org_id, created_at, updated_at'

export class ProjectManager implements ProjectResolver {
  readonly control: Services
  private readonly config: Config
  private readonly db: SqlDatabase
  private readonly dataDir: string
  private readonly databaseOptions: DatabaseOptions
  /** Env default for project databases, before a project's console override. */
  private readonly sqliteSynchronous: SqliteSynchronous
  private readonly runtimes = new Map<string, ProjectRuntime>()
  private readyOnce: Promise<void> | null = null
  /** The default project's current SMTP; other projects use it unless they store their own. */
  private readonly serverSmtp = (): SmtpConfig | null => (this.control.config.smtp ? { ...this.control.config.smtp } : null)

  constructor(options: ProjectManagerOptions) {
    this.control = options.services
    this.config = options.config
    this.db = options.db
    this.dataDir = options.dataDir ?? dataDirOf(options.config.databasePath)
    this.sqliteSynchronous = options.sqliteSynchronous ?? options.config.sqliteSynchronous
    this.databaseOptions = options.database ?? databaseOptionsOf(options.config)
  }

  /**
   * Load the control project and every project runtime. SQLite used to do this
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
    await this.ensureDefault()
    await this.load()
    for (const runtime of this.runtimes.values()) this.linkServices(runtime.services)
    // The rows this process just wrote are already reflected in memory.
    await this.control.versions.resetAsync()
    this.control.settings.subscribe((key) => {
      if (key !== 'smtp') return
      for (const runtime of this.runtimes.values()) {
        if (runtime.services !== this.control) runtime.services.settings.refresh('smtp')
      }
    })
  }

  private async ensureDefault(): Promise<void> {
    if (!this.config.projectId) throw new Error('The default project ID is missing; run bootstrap before opening projects.')
    const stamp = now()
    await this.db.driver.run(
      `INSERT INTO _projects (id, name, org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, org_id = excluded.org_id, updated_at = excluded.updated_at`,
      [this.config.projectId, this.config.projectName, this.config.orgId, stamp, stamp],
    )
  }

  private async load(): Promise<void> {
    const rows = await this.db.driver.all<ProjectRow>(`SELECT ${PROJECT_COLUMNS} FROM _projects ORDER BY seq`)
    for (const row of rows) {
      const info = infoOf(row)
      if (info.id === this.config.projectId) {
        this.runtimes.set(info.id, { info, services: this.control })
        continue
      }
      try {
        this.runtimes.set(info.id, await this.open(info))
      } catch (error) {
        console.error(`[projects] could not open ${info.id}:`, error)
      }
    }
  }

  private paths(id: string): ProjectPaths {
    return projectPaths(this.dataDir, id)
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

  private configFor(info: ProjectInfo, paths: ProjectPaths, instance: BootstrapResult, namespace: string | undefined): Config {
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
      functionsEnvFile: undefined,
      schemaPath: undefined,
      schemaSyncOnStart: false,
      apiKeys: [],
      secret: instance.secret,
      internalKey: undefined,
      skipSchedules: [],
      bootstrap: { orgId: info.orgId, projectId: info.id, apiKey: instance.apiKey, generated: instance.generated },
      s3: { ...base.s3 },
      storagePrefix: info.id,
      backups: { ...base.backups, s3: { ...base.backups.s3 } },
      backupsPrefix: info.id,
      render: { ...base.render },
      cache: { ...base.cache },
      smtp: null,
      oauth: Object.fromEntries(Object.entries(base.oauth).map(([id, config]) => [id, config ? { ...config } : config])),
      allowedOrigins: [...base.allowedOrigins],
    }
  }

  private async open(info: ProjectInfo): Promise<ProjectRuntime> {
    const paths = this.paths(info.id)
    mkdirSync(paths.storage, { recursive: true })
    mkdirSync(paths.backups, { recursive: true })
    mkdirSync(paths.functions, { recursive: true })
    if (this.databaseOptions.backend === 'sqlite' && !existsSync(paths.database)) {
      console.warn(`[projects] database missing for ${info.id}; creating a new empty project`)
    }

    const database = await this.openProjectDatabase(info.id)
    const db = sqlDatabaseOf(database)

    try {
      const instance = await this.bootstrap(db, {
        ORG_ID: info.orgId,
        PROJECT_ID: info.id,
        PROJECT_NAME: info.name,
        SECRET: randomSecret(32),
      }, { generateApiKey: false })

      if (info.orgId !== instance.orgId) {
        info.orgId = instance.orgId
        info.updatedAt = now()
        await this.db.driver.run('UPDATE _projects SET org_id = ?, updated_at = ? WHERE id = ?', [info.orgId, info.updatedAt, info.id])
      }
      const config = this.configFor(info, paths, instance, projectNamespaceOf(this.databaseOptions.namespace, info.id, this.databaseOptions.backend))
      const services = createServices(config, db, {}, { smtpDefault: this.serverSmtp })
      // A network backend starts empty; load settings, registry and the other
      // caches before the runtime can receive traffic.
      await services.ready()
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

  private openProjectDatabase(id: string): Promise<Database> {
    if (this.databaseOptions.backend === 'sqlite') {
      // Keep the environment's durability default for a new project database;
      // the default project's console setting must not leak into other projects.
      const db = openDb(this.paths(id).database, undefined, undefined, undefined, undefined, this.sqliteSynchronous)
      return Promise.resolve(sqliteDatabase(db))
    }
    return openDatabase(this.projectOptions(id))
  }

  private async bootstrap(
    db: SqlDatabase,
    env: Record<string, string | undefined>,
    options: { generateApiKey: boolean },
  ): Promise<BootstrapResult> {
    return db.dialect === 'sqlite' ? bootstrapInstance(db, env, options) : bootstrapInstanceAsync(db, env, options)
  }

  private async clearBootstrapKey(db: SqlDatabase): Promise<void> {
    if (db.dialect === 'sqlite') {
      clearInstanceApiKey(db)
      return
    }
    await clearInstanceApiKeyAsync(db)
  }

  defaultProject(): ProjectRuntime {
    return this.runtimes.get(this.config.projectId)!
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
    services.sites.peers = () => [...this.runtimes.values()].map((r) => r.services.sites)
    services.functions.peers = () => [...this.runtimes.values()].map((r) => r.services.functions)
    services.proxy.peers = () => [...this.runtimes.values()].map((r) => r.services.proxy)
    services.proxy.reservedHosts = () =>
      [...this.runtimes.values()].flatMap((r) => [
        ...r.services.sites.list().map((site) => siteHost(r.services.config, site.id)),
        ...r.services.functions.hosts(),
      ])
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
    try {
      mkdirSync(paths.storage, { recursive: true })
      mkdirSync(paths.backups, { recursive: true })
      mkdirSync(paths.functions, { recursive: true })
      database = await this.openProjectDatabase(id)
      const db = sqlDatabaseOf(database)

      const instance = await this.bootstrap(
        db,
        { ORG_ID: input.orgId, PROJECT_ID: id, PROJECT_NAME: name, SECRET: randomSecret(32) },
        { generateApiKey: true },
      )
      const info: ProjectInfo = { id, name, orgId: instance.orgId, createdAt: now(), updatedAt: now() }
      const config = this.configFor(info, paths, instance, projectNamespaceOf(this.databaseOptions.namespace, id, this.databaseOptions.backend))
      services = createServices(config, db, {}, { smtpDefault: this.serverSmtp })
      await services.ready()
      await this.db.driver.run('INSERT INTO _projects (id, name, org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
        info.id,
        info.name,
        info.orgId,
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
        services.functions.stop()
        services.sites.stop()
        services.backups.stop()
        services.queue.stop()
        services.render.stop()
        services.realtime.stop()
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
    for (const row of rows) {
      seen.add(row.id)
      const existing = this.runtimes.get(row.id)
      if (existing) {
        Object.assign(existing.info, infoOf(row))
        continue
      }
      try {
        const runtime = await this.open(infoOf(row))
        this.runtimes.set(row.id, runtime)
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
      if (seen.has(id) || runtime.services === this.control) continue
      runtime.services.functions.stop()
      runtime.services.sites.stop()
      runtime.services.backups.stop()
      runtime.services.queue.stop()
      runtime.services.render.stop()
      runtime.services.render.shutdown()
      runtime.services.realtime.stop()
      // The runtime is going away; close the connection once its buffered logs are safe.
      await runtime.services.requestLogs.flush()
      await runtime.services.db.driver.close()
      this.runtimes.delete(id)
    }
    for (const runtime of this.runtimes.values()) this.linkServices(runtime.services)
  }

  async delete(id: string): Promise<void> {
    if (id === this.config.projectId) throw err('general_argument_invalid', 'The default project cannot be deleted.')
    const runtime = this.runtimes.get(id)
    if (!runtime) throw err('general_argument_invalid', 'Unknown project.')
    // Stop routing new requests to it before the asynchronous cleanup.
    this.runtimes.delete(id)

    runtime.services.functions.stop()
    runtime.services.sites.stop()
    runtime.services.backups.stop()
    runtime.services.queue.stop()
    runtime.services.render.stop()
    runtime.services.render.shutdown()
    runtime.services.realtime.stop()

    // Best effort: remove external objects before the local database goes away.
    for (const bucket of await runtime.services.storage.buckets()) {
      try {
        await runtime.services.storage.deleteBucket(bucket.id)
      } catch (error) {
        console.error(`[projects] could not delete bucket ${bucket.id} in ${id}:`, error)
      }
    }

    await runtime.services.requestLogs.flush()
    await this.db.driver.run('DELETE FROM _projects WHERE id = ?', [id])
    await runtime.services.db.driver.close()
    if (this.databaseOptions.backend !== 'sqlite') {
      try {
        await dropDatabase(this.projectOptions(id))
      } catch (error) {
        console.error(`[projects] could not remove the ${this.databaseOptions.backend} namespace for ${id}:`, error)
      }
    }
    await this.control.versions.resetAsync()
    // Isolated functions own their folders, so the sandbox deletes them.
    removeTree(this.config.functionsSandbox, this.paths(id).dir)
  }

  /** Start schedulers for every project. Idempotent. */
  start(): void {
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
    for (const runtime of this.runtimes.values()) {
      await runtime.services.transactions.prune()
      await runtime.services.auth.pruneExpired()
      await runtime.services.functions.prune()
      await runtime.services.functions.pruneDeployments()
      await runtime.services.sites.pruneDeployments()
      runtime.services.queue.prune()
      await runtime.services.requestLogs.prune()
      runtime.services.storage.prunePreviews()
      runtime.services.realtime.pruneBus()
      await pruneRateLimits(runtime.services.db)
    }
  }

  async close(): Promise<void> {
    const closing = [...this.runtimes]
    for (const [, runtime] of closing) {
      // Schedulers would otherwise tick on into a closed database.
      runtime.services.functions.stop()
      runtime.services.sites.stop()
      runtime.services.backups.stop()
      runtime.services.queue.stop()
      runtime.services.render.stop()
      runtime.services.realtime.stop()
    }
    await Promise.all(closing.map(([, runtime]) => runtime.services.requestLogs.flush()))
    await Promise.all(closing.map(([, runtime]) => runtime.services.telemetry.close()))
    for (const [id, runtime] of closing) {
      if (id !== this.config.projectId) await runtime.services.db.driver.close()
    }
  }
}

export function createProjectManager(options: ProjectManagerOptions): ProjectManager {
  return new ProjectManager(options)
}
