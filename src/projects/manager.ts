/**
 * Project registry and per-project runtime cache. The control database (the
 * default project's database) holds `_projects` and console admins. Every
 * additional project has its own SQLite file, storage, backups and functions
 * folder, so the existing single-project services stay unchanged.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import type { Config } from '~/config'
import { openDb, type Db } from '~/db/connection'
import { bootstrapInstance, clearInstanceApiKey } from '~/instance/bootstrap'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { isValidId, randomSecret, resolveId, sha256 } from '~/lib/ids'
import { removeTree } from '~/functions/sandbox'
import { createServices, type Services } from '~/services'
import type { SiteRow } from '~/sites/service'
import type { ProjectCreateInput, ProjectInfo, ProjectResolver, ProjectRuntime } from './types'

interface ProjectRow {
  id: string
  name: string
  org_id: string
  created_at: string
  updated_at: string
}

interface ProjectPaths {
  dir: string
  database: string
  storage: string
  backups: string
  functions: string
}

export interface ProjectManagerOptions {
  config: Config
  db: Db
  services: Services
  /** Root for `projects/<id>/...`; defaults to the control database's folder. */
  dataDir?: string
}

const dataDirOf = (config: Config): string =>
  config.databasePath === ':memory:' || config.databasePath.startsWith('file::memory:')
    ? resolve('data')
    : dirname(resolve(config.databasePath))

const infoOf = (row: ProjectRow): ProjectInfo => ({
  id: row.id,
  name: row.name,
  orgId: row.org_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export class ProjectManager implements ProjectResolver {
  readonly control: Services
  private readonly config: Config
  private readonly db: Db
  private readonly dataDir: string
  private readonly runtimes = new Map<string, ProjectRuntime>()

  constructor(options: ProjectManagerOptions) {
    this.control = options.services
    this.config = options.config
    this.db = options.db
    this.dataDir = options.dataDir ?? dataDirOf(options.config)
    this.ensureDefault()
    this.load()
    for (const runtime of this.runtimes.values()) this.linkSites(runtime.services)
  }

  private ensureDefault(): void {
    if (!this.config.projectId) throw new Error('The default project ID is missing; run bootstrap before opening projects.')
    const stamp = now()
    this.db.sqlite
      .query(
        `INSERT INTO _projects (id, name, org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, org_id = excluded.org_id, updated_at = excluded.updated_at`,
      )
      .run(this.config.projectId, this.config.projectName, this.config.orgId, stamp, stamp)
  }

  private load(): void {
    const rows = this.db.sqlite
      .query<ProjectRow, []>('SELECT id, name, org_id, created_at, updated_at FROM _projects ORDER BY seq')
      .all()
    for (const row of rows) {
      const info = infoOf(row)
      if (info.id === this.config.projectId) {
        this.runtimes.set(info.id, { info, services: this.control })
        continue
      }
      try {
        this.runtimes.set(info.id, this.open(info))
      } catch (error) {
        console.error(`[projects] could not open ${info.id}:`, error)
      }
    }
  }

  private paths(id: string): ProjectPaths {
    const folder = isValidId(id) ? id : `p_${sha256(id).slice(0, 16)}`
    const dir = join(this.dataDir, 'projects', folder)
    return {
      dir,
      database: join(dir, 'bunwrite.sqlite'),
      storage: join(dir, 'storage'),
      backups: join(dir, 'backups'),
      functions: join(dir, 'functions'),
    }
  }

  private configFor(info: ProjectInfo, paths: ProjectPaths, instance: ReturnType<typeof bootstrapInstance>): Config {
    const base = this.config
    return {
      ...base,
      projectId: instance.projectId,
      orgId: instance.orgId,
      projectName: instance.projectName,
      databasePath: paths.database,
      storagePath: paths.storage,
      backupsPath: paths.backups,
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
      smtp: base.smtp ? { ...base.smtp } : null,
      google: base.google ? { ...base.google } : null,
      allowedOrigins: [...base.allowedOrigins],
    }
  }

  private open(info: ProjectInfo): ProjectRuntime {
    const paths = this.paths(info.id)
    mkdirSync(paths.storage, { recursive: true })
    mkdirSync(paths.backups, { recursive: true })
    mkdirSync(paths.functions, { recursive: true })
    if (!existsSync(paths.database)) console.warn(`[projects] database missing for ${info.id}; creating a new empty project`)
    const db = openDb(paths.database)
    const instance = bootstrapInstance(
      db,
      { ORG_ID: info.orgId, PROJECT_ID: info.id, PROJECT_NAME: info.name, SECRET: randomSecret(32) },
      { generateApiKey: false },
    )
    if (info.orgId !== instance.orgId) {
      info.orgId = instance.orgId
      info.updatedAt = now()
      this.db.sqlite.query('UPDATE _projects SET org_id = ?, updated_at = ? WHERE id = ?').run(info.orgId, info.updatedAt, info.id)
    }
    const config = this.configFor(info, paths, instance)
    const services = createServices(config, db)
    if (services.config.projectName !== info.name) {
      info.name = services.config.projectName
      info.updatedAt = now()
      this.db.sqlite.query('UPDATE _projects SET name = ?, updated_at = ? WHERE id = ?').run(info.name, info.updatedAt, info.id)
    }
    return { info, services }
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

  findFunction(functionId: string): ProjectRuntime | null {
    for (const runtime of this.runtimes.values()) {
      if (runtime.services.functions.list().some((f) => f.id === functionId)) return runtime
    }
    return null
  }

  findSite(host: string): { project: ProjectRuntime; site: SiteRow } | null {
    for (const runtime of this.runtimes.values()) {
      const site = runtime.services.sites.byHost(host)
      if (site) return { project: runtime, site }
    }
    return null
  }

  /** Site IDs and domains are subdomains and hosts, so they must be unique across projects. */
  private linkSites(services: Services): void {
    services.sites.peers = () => [...this.runtimes.values()].map((r) => r.services.sites)
  }

  create(input: ProjectCreateInput): { project: ProjectRuntime; apiKey?: string } {
    const id = resolveId(input.id, 'Project ID')
    // `console` is how the Appwrite CLI addresses the console API.
    if (id.toLowerCase() === 'console') throw err('general_argument_invalid', 'The project ID "console" is reserved.')
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.length > 128) throw err('general_argument_invalid', 'A project needs a name of 128 characters or less.')
    if (this.runtimes.has(id) || this.db.sqlite.query<{ id: string }, [string]>('SELECT id FROM _projects WHERE id = ?').get(id)) {
      throw err('general_argument_invalid', `Project ${id} already exists.`)
    }

    const paths = this.paths(id)
    let db: Db | undefined
    let inserted = false
    try {
      mkdirSync(paths.storage, { recursive: true })
      mkdirSync(paths.backups, { recursive: true })
      mkdirSync(paths.functions, { recursive: true })
      db = openDb(paths.database)
      const instance = bootstrapInstance(
        db,
        { ORG_ID: input.orgId, PROJECT_ID: id, PROJECT_NAME: name, SECRET: randomSecret(32) },
        { generateApiKey: true },
      )
      const info: ProjectInfo = { id, name, orgId: instance.orgId, createdAt: now(), updatedAt: now() }
      const config = this.configFor(info, paths, instance)
      const services = createServices(config, db)
      this.db.sqlite
        .query('INSERT INTO _projects (id, name, org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(info.id, info.name, info.orgId, info.createdAt, info.updatedAt)
      inserted = true
      const apiKey = instance.apiKey
      // The key is returned to the caller once and stays hashed in _api_keys.
      clearInstanceApiKey(db)
      if (config.bootstrap) config.bootstrap.apiKey = undefined
      const runtime: ProjectRuntime = { info, services }
      this.runtimes.set(id, runtime)
      this.linkSites(services)
      services.functions.start()
      services.backups.start()
      return { project: runtime, apiKey }
    } catch (error) {
      this.runtimes.delete(id)
      if (inserted) this.db.sqlite.query('DELETE FROM _projects WHERE id = ?').run(id)
      db?.sqlite.close()
      rmSync(paths.dir, { recursive: true, force: true })
      throw error
    }
  }

  update(id: string, fields: { name?: string; orgId?: string }): ProjectInfo {
    const runtime = this.runtimes.get(id)
    if (!runtime) throw err('general_argument_invalid', 'Unknown project.')
    if (fields.name !== undefined) runtime.info.name = fields.name
    if (fields.orgId !== undefined) runtime.info.orgId = fields.orgId
    runtime.info.updatedAt = now()
    this.db.sqlite
      .query('UPDATE _projects SET name = ?, org_id = ?, updated_at = ? WHERE id = ?')
      .run(runtime.info.name, runtime.info.orgId, runtime.info.updatedAt, id)
    return runtime.info
  }

  async delete(id: string): Promise<void> {
    if (id === this.config.projectId) throw err('general_argument_invalid', 'The default project cannot be deleted.')
    const runtime = this.runtimes.get(id)
    if (!runtime) throw err('general_argument_invalid', 'Unknown project.')
    // Stop routing new requests to it before the asynchronous cleanup.
    this.runtimes.delete(id)

    runtime.services.functions.stop()
    runtime.services.backups.stop()
    runtime.services.render.shutdown()

    // Best effort: remove external objects before the local database goes away.
    for (const bucket of runtime.services.storage.buckets()) {
      try {
        await runtime.services.storage.deleteBucket(bucket.id)
      } catch (error) {
        console.error(`[projects] could not delete bucket ${bucket.id} in ${id}:`, error)
      }
    }
    try {
      for (const backup of await runtime.services.backups.list()) await runtime.services.backups.delete(backup.name)
    } catch (error) {
      console.error(`[projects] could not delete backups for ${id}:`, error)
    }

    runtime.services.requestLogs.flush()
    this.db.sqlite.query('DELETE FROM _projects WHERE id = ?').run(id)
    runtime.services.db.sqlite.close()
    // Isolated functions own their folders, so the sandbox deletes them.
    removeTree(this.config.functionsSandbox, this.paths(id).dir)
  }

  /** Start schedulers for every project. Idempotent. */
  start(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.services.functions.start()
      runtime.services.backups.start()
    }
  }

  /** Run the periodic cleanup for every project. */
  prune(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.services.transactions.prune()
      runtime.services.auth.pruneExpired()
      runtime.services.functions.prune()
      runtime.services.requestLogs.prune()
      runtime.services.storage.prunePreviews()
    }
  }

  close(): void {
    for (const [id, runtime] of this.runtimes) {
      // Schedulers would otherwise tick on into a closed database.
      runtime.services.functions.stop()
      runtime.services.backups.stop()
      runtime.services.requestLogs.flush()
      if (id !== this.config.projectId) runtime.services.db.sqlite.close()
    }
  }
}

export function createProjectManager(options: ProjectManagerOptions): ProjectManager {
  return new ProjectManager(options)
}
