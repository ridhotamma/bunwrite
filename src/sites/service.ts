/**
 * Sites. A static upload (.tar.gz or .zip, chunked like function code) is
 * unpacked to `<data>/sites/<siteId>/<deploymentId>/` and served as it is.
 * With `adapter: 'ssr'` the upload is the app's source: the install and build
 * commands run here, then the start command runs as a child process and
 * requests are proxied to it (see ssr.ts). With `apiFunctionId` set, `/api/*`
 * (or every path on an SSR site with no start command) runs that function, so
 * pages can call their backend on the same origin.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

import type { Config } from '~/config'
import type { SqlDatabase } from '~/db/driver'
import { BUILD_TIMEOUT_MS, runShell } from '~/deploy/command'
import { chunkRange, chunksFor, liftSingleFolder, packFolder, unpackArchive, writeChunk } from '~/functions/deployments'
import { removeTree } from '~/functions/sandbox'
import { addSeconds, now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { hostOf, siteHost, sitesDomainOf, urlForHost } from '~/lib/hosts'
import { isValidId, uniqueId } from '~/lib/ids'
import { isSafeRelativePath, resolveInside } from '~/lib/paths'
import type { ProxyService } from '~/proxy/service'
import { parseRuntime, SERVER_BUN_LINE } from '~/runtimes/catalog'
import { ensureRuntime, withRuntime } from '~/runtimes/install'
import { siteBaseEnv } from './env'
import { SITE_ADAPTERS } from './frameworks'
import { siteHome, sitesDir } from './paths'
import { branchLabel, branchSlug, deploymentLabel, parsePreview } from './previews'
import { isPruneMode, PRUNE_MODES, pruneScript, SIZE_MARKER, type PruneMode } from './prune'
import { SOURCE_COLUMNS, sourceValues, type DeploymentSource, type ProviderColumns, type ProviderSettings, type SourceColumns } from '~/vcs/source'
import type { VariablesService } from '~/variables/service'
import { SsrRuntime, type SsrTarget } from './ssr'
import { buildContext, type DeployContext } from '~/variables/context'

/** Ready deployments kept besides the live one, for rollback. SSR sites use SITES_SSR_KEEP_PREVIOUS. */
const KEEP_PREVIOUS = 5
const MAX_LOG = 1_000_000

export { sitesDir }

/** Site IDs are subdomains: lowercase letters, digits and hyphens. */
export const SITE_ID = /^[a-z0-9](?:[a-z0-9-]{0,34}[a-z0-9])?$/
/** Taken by the server itself; a site may not use these names. */
const RESERVED_IDS = new Set(['www', 'api', 'console', 'admin', 'sites', 'cloud', 'localhost'])

export interface SiteRow extends ProviderColumns {
  seq: number
  id: string
  name: string
  enabled: number
  framework: string
  output_directory: string
  fallback_file: string
  deployment_id: string
  domain: string
  api_function_id: string
  install_command: string
  build_command: string
  start_command: string
  build_runtime: string
  adapter: string
  prune_mode: string
  /** Days to keep non-live deployments; 0 keeps every deployment. */
  deployment_retention: number
  created_at: string
  updated_at: string
}

export interface SiteDeploymentRow extends SourceColumns {
  seq: number
  id: string
  site_id: string
  status: string
  build_logs: string
  build_duration: number
  source_size: number
  file_count: number
  total_size: number
  start_command: string
  /** The build runtime when this deployment was made; '' is the server's Bun. */
  runtime: string
  activate: number
  chunks_total: number
  chunks_uploaded: number
  created_at: string
  updated_at: string
}

export interface SiteSettings {
  name: string
  enabled: boolean
  framework: string
  outputDirectory: string
  fallbackFile: string
  domains: string[]
  apiFunctionId: string
  installCommand: string
  buildCommand: string
  startCommand: string
  buildRuntime: string
  adapter: string
  /** After-build cleanup for SSR sites; see prune.ts. */
  pruneMode: string
  /** Days to keep non-live deployments; 0 keeps every deployment. */
  deploymentRetention?: number
}

export interface SiteUpload {
  code: Blob
  activate: boolean
  /** `bytes start-end/total` on chunked uploads. */
  contentRange: string | null
  /** Deployment ID, sent with every chunk after the first. */
  uploadId: string | null
}

export interface SiteFile {
  /** Path inside the site, such as `index.html` or `css/app.css`. */
  path: string
  content: string | Uint8Array
}

/** Deployment states still on their way to ready or failed. */
export const SITE_IN_PROGRESS = ['waiting', 'processing', 'building']

/** A relative folder or file inside the site: no `..`, no leading slash. */
function relativePath(value: string, what: string): string {
  const cleaned = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '')
    .replace(/\/+$/, '')
  if (!cleaned || cleaned === '.') return ''
  if (isAbsolute(cleaned) || cleaned.split('/').includes('..')) throw err('general_argument_invalid', `${what} must be a path inside the site.`)
  return cleaned
}

function countFiles(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        files++
        bytes += statSync(path).size
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

export class SiteService {
  /** The other projects' site services, so site IDs stay unique on this server. */
  peers: () => SiteService[] = () => []
  /** Runs `adapter: 'ssr'` apps; lazy and idle-stopped. */
  readonly ssr: SsrRuntime
  private byId: Map<string, SiteRow> | null = null

  constructor(
    private db: SqlDatabase,
    private config: Config,
    private proxy: ProxyService,
    private variables: VariablesService,
  ) {
    this.ssr = new SsrRuntime(
      config,
      (siteId, deploymentId) => this.ssrTarget(siteId, deploymentId),
      (siteId, context) => this.variables.siteEnvironment(siteId, context),
    )
  }

  /** Load the site cache. SQLite loads lazily; a network backend awaits this at boot. */
  async ready(): Promise<void> {
    const rows = await this.db.driver.all<SiteRow>('SELECT * FROM _sites ORDER BY seq')
    this.byId = new Map(rows.map((row) => [row.id, row]))
  }

  private cache() {
    if (!this.byId) {
      // SQLite keeps its synchronous lazy load; a network backend must have
      // awaited ready() before serving requests.
      const sqlite = this.db.sqlite
      if (sqlite)
        this.byId = new Map(
          sqlite
            .query<SiteRow, []>('SELECT * FROM _sites ORDER BY seq')
            .all()
            .map((row) => [row.id, row]),
        )
      else throw new Error('Sites are not loaded yet. Await sites.ready() before serving requests.')
    }
    return { byId: this.byId }
  }

  /** Drop the cached sites, then reload them from the database. */
  async reload(): Promise<void> {
    this.byId = null
    await this.ready()
  }

  // ---- Sites ----

  list(): SiteRow[] {
    return [...this.cache().byId.values()]
  }

  site(id: string): SiteRow {
    const row = this.cache().byId.get(id)
    if (!row) throw err('site_not_found')
    return row
  }

  has(id: string): boolean {
    return this.cache().byId.has(id)
  }

  /** The site a request's Host header points at, if it is one of this project's. */
  async byHost(host: string): Promise<SiteRow | null> {
    return (await this.resolveHost(host))?.site ?? null
  }

  /**
   * The site a host belongs to and, for a preview host
   * (`<siteId>--git-<branch>` or `<siteId>--<deploymentId>`), the deployment
   * it shows instead of the live one.
   */
  async resolveHost(host: string): Promise<{ site: SiteRow; deploymentId: string | null } | null> {
    const name = hostOf(host)
    const custom = this.proxy.byDomain(name)
    if (custom?.resource_type === 'site') return { site: this.site(custom.resource_id), deploymentId: null }
    const suffix = `.${sitesDomainOf(this.config)}`
    if (!name.endsWith(suffix)) return null
    const sub = name.slice(0, -suffix.length)
    if (sub.includes('.')) return null
    const exact = this.cache().byId.get(sub)
    if (exact) return { site: exact, deploymentId: null }
    const preview = parsePreview(sub)
    const site = preview ? this.cache().byId.get(preview.siteId) : undefined
    if (!preview || !site) return null
    if (preview.branchSlug) {
      const row = await this.db.driver.get<{ deployment_id: string }>('SELECT deployment_id FROM _site_branches WHERE site_id = ? AND slug = ?', [
        site.id,
        preview.branchSlug,
      ])
      return row ? { site, deploymentId: row.deployment_id } : null
    }
    const d = await this.db.driver.get<{ id: string }>("SELECT id FROM _site_deployments WHERE site_id = ? AND id = ? AND status = 'ready'", [
      site.id,
      preview.deploymentId!,
    ])
    return d ? { site, deploymentId: d.id } : null
  }

  // ---- Previews ----

  /** The address of one deployment: `<siteId>--<deploymentId>.<SITES_DOMAIN>`. */
  deploymentUrl(site: SiteRow, deploymentId: string): string {
    return urlForHost(this.config, `${deploymentLabel(site.id, deploymentId)}.${sitesDomainOf(this.config)}`)
  }

  /** The address of a branch's newest build: `<siteId>--git-<slug>.<SITES_DOMAIN>`. */
  branchUrl(site: SiteRow, branch: string): string {
    return urlForHost(this.config, `${branchLabel(site.id, branchSlug(site.id, branch))}.${sitesDomainOf(this.config)}`)
  }

  /** Branch previews of a site, newest first. */
  async branches(siteId: string): Promise<{ branch: string; slug: string; deployment_id: string; updated_at: string }[]> {
    return this.db.driver.all<{ branch: string; slug: string; deployment_id: string; updated_at: string }>(
      'SELECT branch, slug, deployment_id, updated_at FROM _site_branches WHERE site_id = ? ORDER BY updated_at DESC',
      [siteId],
    )
  }

  /** Point a branch's preview host at a ready deployment, and drop the build it showed before. */
  async setBranchPreview(siteId: string, branch: string, deploymentId: string): Promise<void> {
    const site = this.site(siteId)
    const slug = branchSlug(site.id, branch)
    const before = await this.db.driver.get<{ deployment_id: string }>('SELECT deployment_id FROM _site_branches WHERE site_id = ? AND slug = ?', [
      site.id,
      slug,
    ])
    const stamp = now()
    await this.db.driver.run(
      `INSERT INTO _site_branches (site_id, branch, slug, deployment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id, slug) DO UPDATE SET branch = excluded.branch, deployment_id = excluded.deployment_id, updated_at = excluded.updated_at`,
      [site.id, branch, slug, deploymentId, stamp, stamp],
    )
    if (before && before.deployment_id !== deploymentId) await this.dropPreview(site, before.deployment_id)
  }

  /** A branch is gone (deleted, or its pull request closed): drop its preview host and builds. */
  async removeBranch(siteId: string, branch: string): Promise<number> {
    const site = this.site(siteId)
    await this.db.driver.run('DELETE FROM _site_branches WHERE site_id = ? AND slug = ?', [site.id, branchSlug(site.id, branch)])
    const pr = /^pr-(\d+)$/.exec(branch)
    const rows = pr
      ? await this.db.driver.all<{ id: string }>(
          "SELECT id FROM _site_deployments WHERE site_id = ? AND type = 'vcs' AND activate = 0 AND provider_pull_request = ?",
          [site.id, Number(pr[1])],
        )
      : await this.db.driver.all<{ id: string }>(
          "SELECT id FROM _site_deployments WHERE site_id = ? AND type = 'vcs' AND activate = 0 AND provider_pull_request = 0 AND provider_branch = ?",
          [site.id, branch],
        )
    let removed = 0
    for (const { id } of rows) if (await this.dropPreview(site, id)) removed++
    return removed
  }

  /** Delete a preview deployment that is not live and no branch shows. */
  private async dropPreview(site: SiteRow, deploymentId: string): Promise<boolean> {
    if (this.site(site.id).deployment_id === deploymentId) return false
    if (await this.db.driver.get('SELECT 1 FROM _site_branches WHERE site_id = ? AND deployment_id = ?', [site.id, deploymentId])) return false
    this.ssr.stopDeployment(site.id, deploymentId)
    await this.db.driver.run('DELETE FROM _site_deployments WHERE id = ? AND site_id = ?', [deploymentId, site.id])
    removeTree(this.config.functionsSandbox, sitesDir(this.config, site.id, deploymentId))
    return true
  }

  /** `https://<id>.<SITES_DOMAIN>`, with the API's port when it has one (local development). */
  url(site: SiteRow): string {
    return urlForHost(this.config, siteHost(this.config, site.id))
  }

  /** Every address the site answers on. */
  urls(site: SiteRow): string[] {
    return [this.url(site), ...this.proxy.domainsFor('site', site.id).map((domain) => urlForHost(this.config, domain))]
  }

  /** Project origins plus this project's sites, for CORS and redirect checks. */
  allowedOrigins(): string[] {
    return [...this.config.allowedOrigins, ...this.list().flatMap((s) => this.urls(s))]
  }

  private assertUnique(id: string | null): void {
    const everyone = [this, ...this.peers().filter((p) => p !== this)]
    if (id && everyone.some((s) => s.has(id))) throw err('site_already_exists')
  }

  private clean(settings: SiteSettings, self?: { type: 'site'; id: string }): SiteSettings {
    const name = settings.name.trim()
    if (!name || name.length > 128) throw err('general_argument_invalid', 'A site needs a name of 128 characters or less.')
    const adapter = settings.adapter.trim() || 'static'
    if (!SITE_ADAPTERS.includes(adapter as (typeof SITE_ADAPTERS)[number])) {
      throw err('general_argument_invalid', `Adapter must be one of: ${SITE_ADAPTERS.join(', ')}.`)
    }
    // Appwrite's static-1 means "no runtime": served as uploaded, or built on the server's Bun.
    const buildRuntime = settings.buildRuntime.trim() === 'static-1' ? '' : settings.buildRuntime.trim()
    const parsedRuntime = buildRuntime ? parseRuntime(buildRuntime) : null
    if (buildRuntime && (!parsedRuntime || parsedRuntime.kind === 'python')) {
      throw err('general_argument_invalid', `Build runtime must be a Node.js or Bun runtime, such as node-22 or bun-${SERVER_BUN_LINE}.`)
    }
    const pruneMode = settings.pruneMode.trim() || 'auto'
    if (!isPruneMode(pruneMode)) throw err('general_argument_invalid', `Prune mode must be one of: ${PRUNE_MODES.join(', ')}.`)
    const deploymentRetention = settings.deploymentRetention ?? 0
    if (!Number.isInteger(deploymentRetention) || deploymentRetention < 0) {
      throw err('general_argument_invalid', 'Deployment retention must be a whole number of days, 0 or more.')
    }
    return {
      ...settings,
      name,
      adapter,
      pruneMode,
      deploymentRetention,
      buildRuntime,
      installCommand: settings.installCommand.trim(),
      buildCommand: settings.buildCommand.trim(),
      startCommand: settings.startCommand.trim(),
      outputDirectory: relativePath(settings.outputDirectory, 'Output directory'),
      fallbackFile: relativePath(settings.fallbackFile, 'Fallback file'),
      domains: this.proxy.normalizeAll(settings.domains, self),
      apiFunctionId: settings.apiFunctionId.trim(),
    }
  }

  async create(id: string, input: SiteSettings): Promise<SiteRow> {
    if (!SITE_ID.test(id)) {
      throw err(
        'general_argument_invalid',
        'Site ID: up to 36 lowercase letters, digits and hyphens, starting and ending with a letter or digit. It becomes the subdomain.',
      )
    }
    if (RESERVED_IDS.has(id)) throw err('general_argument_invalid', `The site ID "${id}" is reserved.`)
    const s = this.clean(input)
    this.assertUnique(id)
    this.proxy.assertDefaultHost('site', id)
    const stamp = now()
    await this.db.driver.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO _sites (id, name, enabled, framework, output_directory, fallback_file, domain, api_function_id, install_command, build_command, start_command, build_runtime, adapter, prune_mode, deployment_retention, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          s.name,
          s.enabled ? 1 : 0,
          s.framework,
          s.outputDirectory,
          s.fallbackFile,
          s.domains[0] ?? '',
          s.apiFunctionId,
          s.installCommand,
          s.buildCommand,
          s.startCommand,
          s.buildRuntime,
          s.adapter,
          s.pruneMode,
          s.deploymentRetention ?? 0,
          stamp,
          stamp,
        ],
      )
    })
    await this.proxy.set('site', id, s.domains)
    await this.reload()
    return this.site(id)
  }

  async update(id: string, input: SiteSettings): Promise<SiteRow> {
    const before = this.site(id)
    const s = this.clean(input, { type: 'site', id })
    await this.db.driver.run(
      `UPDATE _sites SET name = ?, enabled = ?, framework = ?, output_directory = ?, fallback_file = ?, domain = ?, api_function_id = ?,
       install_command = ?, build_command = ?, start_command = ?, build_runtime = ?, adapter = ?, prune_mode = ?, deployment_retention = ?, updated_at = ? WHERE id = ?`,
      [
        s.name,
        s.enabled ? 1 : 0,
        s.framework,
        s.outputDirectory,
        s.fallbackFile,
        s.domains[0] ?? '',
        s.apiFunctionId,
        s.installCommand,
        s.buildCommand,
        s.startCommand,
        s.buildRuntime,
        s.adapter,
        s.pruneMode,
        s.deploymentRetention ?? 0,
        now(),
        id,
      ],
    )
    await this.proxy.set('site', id, s.domains)
    await this.reload()
    // A different adapter, folder or on/off state changes how the live app runs.
    // Start commands are snapshotted per deployment, so changing one alone does
    // not disturb the app that is already serving.
    if (before.adapter !== s.adapter || before.output_directory !== s.outputDirectory || Boolean(before.enabled) !== s.enabled) this.ssr.stopSite(id)
    return this.site(id)
  }

  /** Connect the site to a repository, or disconnect it with NO_PROVIDER. */
  async setProvider(id: string, provider: ProviderSettings): Promise<SiteRow> {
    this.site(id)
    await this.db.driver.run(
      'UPDATE _sites SET installation_id = ?, provider_repository_id = ?, provider_branch = ?, provider_root_directory = ?, provider_silent_mode = ?, updated_at = ? WHERE id = ?',
      [
        provider.installationId,
        provider.providerRepositoryId,
        provider.providerBranch,
        provider.providerRootDirectory,
        provider.providerSilentMode ? 1 : 0,
        now(),
        id,
      ],
    )
    await this.reload()
    return this.site(id)
  }

  settingsOf(site: SiteRow): SiteSettings {
    return {
      name: site.name,
      enabled: Boolean(site.enabled),
      framework: site.framework,
      outputDirectory: site.output_directory,
      fallbackFile: site.fallback_file,
      domains: this.proxy.domainsFor('site', site.id),
      apiFunctionId: site.api_function_id,
      installCommand: site.install_command,
      buildCommand: site.build_command,
      startCommand: site.start_command,
      buildRuntime: site.build_runtime,
      adapter: site.adapter,
      pruneMode: site.prune_mode,
      deploymentRetention: site.deployment_retention,
    }
  }

  async remove(id: string): Promise<void> {
    this.site(id)
    this.ssr.stopSite(id)
    await this.db.driver.transaction(async (tx) => {
      await tx.run('DELETE FROM _site_deployments WHERE site_id = ?', [id])
      await tx.run('DELETE FROM _site_branches WHERE site_id = ?', [id])
      await tx.run('DELETE FROM _sites WHERE id = ?', [id])
    })
    await this.proxy.removeFor('site', id)
    // Best-effort cleanup: the site row is already gone and these rows are unreachable.
    void this.variables.removeSite(id).catch((error) => console.error('[sites] could not remove variables:', error))
    await this.reload()
    // A request could have started the old app between the first stop and here.
    this.ssr.forget(id)
    try {
      removeTree(this.config.functionsSandbox, sitesDir(this.config, id))
    } catch (error) {
      console.error(`[sites] ${id}: could not remove the site's files:`, error)
    }
  }

  /** Stop every SSR app (project shutdown). */
  stop(): void {
    this.ssr.stop()
  }

  /** The folder the live deployment serves from, or null when nothing is live. */
  root(site: SiteRow, deploymentId = site.deployment_id): string | null {
    if (!deploymentId) return null
    // `outputDirectory` is a site setting; it must not walk out of the
    // deployment (and an old malicious deployment ID must not either).
    const dir = resolveInside(sitesDir(this.config, site.id), join(deploymentId, site.output_directory))
    return dir && existsSync(dir) ? dir : null
  }

  /** The live SSR app, when the deployment has a start command. */
  /** The live SSR app, or with `deploymentId` a preview's app. */
  private async ssrTarget(siteId: string, deploymentId?: string | null): Promise<SsrTarget | null> {
    const site = this.cache().byId.get(siteId)
    const id = deploymentId || site?.deployment_id
    if (!site || !site.enabled || site.adapter !== 'ssr' || !id) return null
    const deployment = await this.db.driver.get<SiteDeploymentRow>('SELECT * FROM _site_deployments WHERE id = ? AND site_id = ?', [id, site.id])
    if (!deployment || deployment.status !== 'ready') return null
    const command = deployment.start_command.trim()
    if (!command) return null
    const cwd = resolveInside(sitesDir(this.config, site.id), join(deployment.id, site.output_directory))
    if (!cwd || !existsSync(cwd)) return null
    // The live app and a preview of the same build run with different values, so they are different apps.
    const context: DeployContext = deployment.id === site.deployment_id ? 'live' : 'preview'
    return { key: `${site.id}/${deployment.id}/${context}`, siteId: site.id, deploymentId: deployment.id, command, cwd, runtime: deployment.runtime, context }
  }

  /** The last output of the site's app, for the console. */
  runtimeLogs(siteId: string): string {
    return this.ssr.logs(siteId)
  }

  // ---- Deployments ----

  async deployment(siteId: string, id: string): Promise<SiteDeploymentRow> {
    const row = await this.db.driver.get<SiteDeploymentRow>('SELECT * FROM _site_deployments WHERE id = ? AND site_id = ?', [id, siteId])
    if (!row) throw err('deployment_not_found')
    return row
  }

  async deployments(siteId: string): Promise<SiteDeploymentRow[]> {
    return this.db.driver.all<SiteDeploymentRow>('SELECT * FROM _site_deployments WHERE site_id = ? ORDER BY seq DESC', [siteId])
  }

  /** The newest Git build of a branch, or of a fork's pull request when `pullRequest` is set. */
  async latestForBranch(siteId: string, branch: string, pullRequest = 0): Promise<SiteDeploymentRow | null> {
    return pullRequest
      ? this.db.driver.get<SiteDeploymentRow>(
          "SELECT * FROM _site_deployments WHERE site_id = ? AND type = 'vcs' AND provider_pull_request = ? ORDER BY seq DESC LIMIT 1",
          [siteId, pullRequest],
        )
      : this.db.driver.get<SiteDeploymentRow>(
          "SELECT * FROM _site_deployments WHERE site_id = ? AND type = 'vcs' AND provider_pull_request = 0 AND provider_branch = ? ORDER BY seq DESC LIMIT 1",
          [siteId, branch],
        )
  }

  async latest(siteId: string): Promise<SiteDeploymentRow | null> {
    return this.db.driver.get<SiteDeploymentRow>('SELECT * FROM _site_deployments WHERE site_id = ? ORDER BY seq DESC LIMIT 1', [siteId])
  }

  private archivePath(siteId: string, id: string) {
    const path = resolveInside(sitesDir(this.config, siteId), `${id}.upload`)
    if (!path) throw err('general_argument_invalid', 'Invalid deployment ID.')
    return path
  }

  private async insert(
    siteId: string,
    id: string,
    status: string,
    size: number,
    activate: boolean,
    chunks: number,
    uploaded: number,
    startCommand: string,
  ): Promise<void> {
    const stamp = now()
    const runtime = this.site(siteId).build_runtime
    await this.db.driver.run(
      `INSERT INTO _site_deployments (id, site_id, status, source_size, start_command, runtime, activate, chunks_total, chunks_uploaded, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, siteId, status, size, startCommand, runtime, activate ? 1 : 0, chunks, uploaded, stamp, stamp],
    )
  }

  /** Store one upload (or one chunk of it). The files go live once every chunk is in. */
  async upload(site: SiteRow, input: SiteUpload): Promise<SiteDeploymentRow> {
    const bytes = new Uint8Array(await input.code.arrayBuffer())
    const { start, total } = chunkRange(input.contentRange, bytes.length)
    // Like a function deployment, a client-chosen ID becomes part of a path.
    if (input.uploadId && !isValidId(input.uploadId)) {
      throw err('general_argument_invalid', 'Invalid deployment ID.')
    }
    let row: SiteDeploymentRow
    if (input.uploadId && total > bytes.length && start > 0) {
      row = await this.deployment(site.id, input.uploadId)
      if (row.status !== 'waiting') throw err('general_argument_invalid', 'This deployment has already been uploaded.')
    } else {
      const id = input.uploadId || uniqueId()
      await this.insert(site.id, id, 'waiting', total, input.activate, chunksFor(total), 0, site.start_command)
      row = await this.deployment(site.id, id)
      mkdirSync(sitesDir(this.config, site.id), { recursive: true })
    }
    writeChunk(this.archivePath(site.id, row.id), bytes, start)
    const counted = (await this.db.driver.get<{ chunks_uploaded: number }>(
      'UPDATE _site_deployments SET chunks_uploaded = chunks_uploaded + 1, updated_at = ? WHERE id = ? RETURNING chunks_uploaded',
      [now(), row.id],
    ))!
    if (counted.chunks_uploaded >= row.chunks_total) {
      await this.db.driver.run("UPDATE _site_deployments SET status = 'processing', updated_at = ? WHERE id = ?", [now(), row.id])
      // Unpacking is quick for static sites; an SSR build may take minutes, so
      // it runs in the background like a function build.
      if (site.adapter === 'ssr') {
        void this.process(site.id, row.id).catch((error) => console.error(`[sites] ${site.id}: deployment ${row.id} crashed`, error))
      } else {
        return this.process(site.id, row.id)
      }
    }
    return this.deployment(site.id, row.id)
  }

  /**
   * A deployment of a Git commit. The caller writes the code into
   * sitesDir(config, site.id, id), then calls process(…, { unpacked: true }),
   * or fail() when the code could not be fetched.
   */
  async startGit(site: SiteRow, source: DeploymentSource, activate: boolean): Promise<SiteDeploymentRow> {
    const id = uniqueId()
    const stamp = now()
    await this.db.driver.run(
      `INSERT INTO _site_deployments (id, site_id, status, source_size, start_command, runtime, activate, chunks_total, chunks_uploaded, ${SOURCE_COLUMNS}, created_at, updated_at)
       VALUES (?, ?, 'processing', 0, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, site.id, site.start_command, site.build_runtime, activate ? 1 : 0, ...sourceValues(source), stamp, stamp],
    )
    const dir = sitesDir(this.config, site.id, id)
    removeTree(this.config.functionsSandbox, dir)
    mkdirSync(dir, { recursive: true })
    return this.deployment(site.id, id)
  }

  /** Mark a deployment failed before it was processed (the code could not be fetched). */
  async fail(siteId: string, id: string, message: string): Promise<SiteDeploymentRow> {
    await this.db.driver.run("UPDATE _site_deployments SET status = 'failed', build_logs = ?, updated_at = ? WHERE id = ?", [
      message.slice(-MAX_LOG),
      now(),
      id,
    ])
    removeTree(this.config.functionsSandbox, sitesDir(this.config, siteId, id))
    return this.deployment(siteId, id)
  }

  async setSourceSize(id: string, bytes: number): Promise<void> {
    await this.db.driver.run('UPDATE _site_deployments SET source_size = ?, updated_at = ? WHERE id = ?', [bytes, now(), id])
  }

  /** Deploy files given directly: pasted HTML from the console, or a starter page. */
  async deployFiles(site: SiteRow, files: SiteFile[], activate: boolean): Promise<SiteDeploymentRow> {
    if (!files.length) throw err('general_argument_invalid', 'Add at least one file.')
    const id = uniqueId()
    const dir = sitesDir(this.config, site.id, id)
    const root = resolve(dir)
    const size = files.reduce((sum, f) => sum + (typeof f.content === 'string' ? Buffer.byteLength(f.content) : f.content.length), 0)
    for (const file of files) {
      const target = resolve(root, file.path)
      if (!file.path || isAbsolute(file.path) || !target.startsWith(root + sep)) throw err('general_argument_invalid', `Invalid file path: ${file.path}`)
    }
    await this.insert(site.id, id, 'processing', size, activate, 1, 1, site.start_command)
    removeTree(this.config.functionsSandbox, dir)
    for (const file of files) {
      const target = resolve(root, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.content)
    }
    if (site.adapter === 'ssr') {
      void this.process(site.id, id, { unpacked: true }).catch((error) => console.error(`[sites] ${site.id}: deployment ${id} crashed`, error))
      return this.deployment(site.id, id)
    }
    return this.process(site.id, id, { unpacked: true })
  }

  /**
   * Unpack, then either check the static output folder or build and validate
   * the SSR app, and go live when asked. Sets status ready or failed.
   */
  async process(siteId: string, id: string, options: { unpacked?: boolean } = {}): Promise<SiteDeploymentRow> {
    const started = performance.now()
    const archive = this.archivePath(siteId, id)
    const dir = sitesDir(this.config, siteId, id)
    const logs: string[] = []
    const set = async (status: string, counts = { files: 0, bytes: 0 }): Promise<void> => {
      await this.db.driver.run(
        'UPDATE _site_deployments SET status = ?, build_logs = ?, build_duration = ?, file_count = ?, total_size = ?, updated_at = ? WHERE id = ?',
        [status, logs.join('\n').slice(-MAX_LOG), (performance.now() - started) / 1000, counts.files, counts.bytes, now(), id],
      )
    }
    try {
      const site = this.site(siteId)
      if (!options.unpacked) {
        removeTree(this.config.functionsSandbox, dir)
        mkdirSync(dir, { recursive: true })
        try {
          await unpackArchive(archive, dir)
        } finally {
          rmSync(archive, { force: true })
        }
      }
      const fromGit = (await this.deployment(siteId, id)).type === 'vcs'
      const counts =
        site.adapter === 'ssr'
          ? await this.buildSsr(site, id, dir, logs, set)
          : fromGit
            ? await this.buildStatic(
                site,
                (await this.deployment(siteId, id)).runtime,
                dir,
                logs,
                set,
                buildContext((await this.deployment(siteId, id)).activate),
              )
            : this.checkStatic(site, dir, logs)
      logs.push('Ready.')
      await set('ready', counts)
      if ((await this.deployment(siteId, id)).activate) await this.activate(siteId, id)
    } catch (error) {
      logs.push(error instanceof Error ? error.message : String(error))
      await set('failed')
      try {
        rmSync(archive, { force: true })
        removeTree(this.config.functionsSandbox, dir)
      } catch (cleanupError) {
        // Cleanup is best effort: a file left by an older run must not hide
        // the build error or crash the deployment worker.
        console.error(`[sites] ${siteId}: could not clean up failed deployment ${id}:`, cleanupError)
      }
    }
    return this.deployment(siteId, id)
  }

  /** A static deployment: the output folder must be there, with files. */
  private checkStatic(site: SiteRow, dir: string, logs: string[], built = false): { files: number; bytes: number } {
    const marker = site.output_directory || 'index.html'
    const lifted = liftSingleFolder(dir, marker)
    if (lifted) logs.push(`Using the "${lifted}" folder inside the upload as the site folder.`)
    if (!built && (site.build_command || site.install_command)) {
      logs.push('Static sites are served as uploaded; this server runs no install or build command. Build first and upload the output.')
    }
    const out = resolveInside(dir, site.output_directory)
    if (!out || !existsSync(out) || !statSync(out).isDirectory()) {
      throw new Error(
        `Output directory "${site.output_directory}" is not in the upload. Files at the top: ${readdirSync(dir).slice(0, 20).join(', ') || '(none)'}`,
      )
    }
    const counts = countFiles(out)
    if (!counts.files) throw new Error('The upload has no files.')
    logs.push(
      `${counts.files} file${counts.files === 1 ? '' : 's'}, ${formatSize(counts.bytes)}${site.output_directory ? ` in ${normalize(site.output_directory)}/` : ''}.`,
    )
    if (!existsSync(join(out, 'index.html'))) logs.push('Note: there is no index.html at the top, so the home page will be a 404.')
    return counts
  }

  /**
   * A static site from Git: the repository holds the source, so the install
   * and build commands run here and the output folder is served. With the
   * sandbox on, the build runs as the site's user in a work folder, and only
   * the output is copied back for the server to serve.
   */
  private async buildStatic(
    site: SiteRow,
    runtime: string,
    dir: string,
    logs: string[],
    set: (status: string, counts?: { files: number; bytes: number }) => void | Promise<void>,
    context: DeployContext,
  ): Promise<{ files: number; bytes: number }> {
    if (!site.install_command.trim() && !site.build_command.trim()) return this.checkStatic(site, dir, logs, true)
    if (!this.config.sitesBuildCommands) {
      logs.push('Skipped install and build commands (SITES_BUILD_COMMANDS=false); serving the repository as it is.')
      return this.checkStatic(site, dir, logs, true)
    }
    const sandbox = this.config.functionsSandbox
    const uid = sandbox?.uidFor(this.config.projectId, `site:${site.id}`)
    if (!sandbox || uid === undefined) {
      await this.runSiteCommands(site, runtime, dir, logs, set, null, context)
      // Static files need no packages, and node_modules must not be served.
      rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
      return this.checkStatic(site, dir, logs, true)
    }
    const work = `${dir}.build`
    removeTree(sandbox, work)
    renameSync(dir, work)
    mkdirSync(dir, { recursive: true })
    try {
      sandbox.adopt(work, siteHome(this.config, site.id), uid)
      await this.runSiteCommands(site, runtime, work, logs, set, { sandbox, uid }, context)
      const out = site.output_directory || '.'
      if (out !== '.' && !isSafeRelativePath(out)) throw new Error(`Invalid output directory: ${out}`)
      const pack = Bun.spawn(sandbox.wrap(uid, work, ['tar', '-cf', '-', out]), { stdout: 'pipe', stderr: 'pipe' })
      const unpack = Bun.spawn(['tar', '-xf', '-', '-C', dir], { stdin: pack.stdout, stdout: 'ignore', stderr: 'pipe' })
      const [packErr, unpackErr, packCode, unpackCode] = await Promise.all([
        new Response(pack.stderr).text(),
        new Response(unpack.stderr).text(),
        pack.exited,
        unpack.exited,
      ])
      if (packCode !== 0 || unpackCode !== 0) throw new Error(`Could not copy the build output: ${(packErr || unpackErr).trim() || 'tar failed'}`)
    } finally {
      removeTree(sandbox, work)
    }
    return this.checkStatic(site, dir, logs, true)
  }

  /**
   * An SSR deployment: unpack is the source, install and build run here, and
   * `start_command` (snapshotted on the deployment) becomes the app.
   */
  private async buildSsr(
    site: SiteRow,
    id: string,
    dir: string,
    logs: string[],
    set: (status: string, counts?: { files: number; bytes: number }) => void | Promise<void>,
  ): Promise<{ files: number; bytes: number }> {
    const deployment = await this.deployment(site.id, id)
    const marker = site.output_directory || 'package.json'
    const lifted = liftSingleFolder(dir, marker)
    if (lifted) logs.push(`Using the "${lifted}" folder inside the upload as the app folder.`)
    const command = deployment.start_command.trim()
    if (!command && !site.api_function_id) {
      throw new Error('An SSR site needs a start command, or an API function that answers every request. Set one in Settings, then deploy again.')
    }
    // Count before the folder belongs to another user; with the sandbox on the
    // server cannot read it afterwards.
    const source = countFiles(dir)
    if (!source.files) throw new Error('The deployment has no files.')

    // The deployment folder belongs to the site's own user from here on.
    const sandbox = this.config.functionsSandbox
    const uid = sandbox?.uidFor(this.config.projectId, `site:${site.id}`)
    const isolated = sandbox !== null && sandbox !== undefined && uid !== undefined
    if (isolated) sandbox.adopt(dir, siteHome(this.config, site.id), uid)

    if (!this.config.sitesBuildCommands) {
      if (site.install_command.trim() || site.build_command.trim()) logs.push('Skipped install and build commands (SITES_BUILD_COMMANDS=false).')
    } else {
      const env = await this.runSiteCommands(site, deployment.runtime, dir, logs, set, isolated ? { sandbox, uid } : null, buildContext(deployment.activate))
      if (env) await this.pruneBuild(site, command, dir, logs, isolated ? { sandbox, uid } : null, env)
    }

    const cwd = resolveInside(dir, site.output_directory)
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      const top = isolated ? '' : ` Files at the top: ${readdirSync(dir).slice(0, 20).join(', ') || '(none)'}`
      throw new Error(`The app folder "${site.output_directory}" is not in the deployment.${top}`)
    }
    if (command) logs.push(`Start command: ${command}`)
    else logs.push(`No start command: requests run the function "${site.api_function_id}".`)

    const counts = isolated ? ((await this.measureTree(cwd, sandbox, uid)) ?? source) : countFiles(cwd)
    logs.push(
      `${counts.files} file${counts.files === 1 ? '' : 's'}, ${formatSize(counts.bytes)}${site.output_directory ? ` in ${normalize(site.output_directory)}/` : ''}.`,
    )
    return counts
  }

  /** Files and bytes of an isolated deployment, counted as its own user. */
  private async measureTree(dir: string, sandbox: NonNullable<Config['functionsSandbox']>, uid: number): Promise<{ files: number; bytes: number } | null> {
    try {
      const result = await runShell({
        command: 'find . -type f | wc -l; du -sk . | cut -f1',
        wrap: (argv) => sandbox.wrap(uid, dir, argv),
        signal: (pid, signal) => sandbox.signal(pid, signal),
        timeoutMs: 60_000,
      })
      if (result.code !== 0) return null
      const lines = result.output.trim().split('\n')
      const files = Number(lines[0] ?? '')
      const kb = Number(lines[1] ?? '')
      if (!Number.isFinite(files) || !Number.isFinite(kb)) return null
      return { files, bytes: kb * 1024 }
    } catch {
      return null
    }
  }

  /**
   * Remove what the build needed but the app does not (dev dependencies, build
   * caches). A failure is logged and the deployment keeps going: the app may
   * still start with the packages that are left.
   */
  private async pruneBuild(
    site: SiteRow,
    startCommand: string,
    dir: string,
    logs: string[],
    sandboxed: { sandbox: NonNullable<Config['functionsSandbox']>; uid: number } | null,
    env: Record<string, string>,
  ): Promise<void> {
    const mode = (isPruneMode(site.prune_mode) ? site.prune_mode : 'auto') as PruneMode
    const script = pruneScript({ mode, startCommand, installCommand: site.install_command, appDir: site.output_directory })
    if (!script) {
      logs.push('Kept node_modules as built (prune mode: none).')
      return
    }
    logs.push(`Cleaning up after the build (prune mode: ${mode}).`)
    const result = await runShell({
      command: script,
      cwd: sandboxed ? undefined : dir,
      wrap: sandboxed ? (argv) => sandboxed.sandbox.wrap(sandboxed.uid, dir, argv) : undefined,
      signal: sandboxed ? (pid, signal) => sandboxed.sandbox.signal(pid, signal) : undefined,
      env,
      timeoutMs: BUILD_TIMEOUT_MS,
    })
    const size = new RegExp(`^${SIZE_MARKER} (\\d+) (\\d+)$`, 'm').exec(result.output)
    const output = result.output.replace(new RegExp(`^${SIZE_MARKER} .*$`, 'm'), '').trim()
    if (output) logs.push(output)
    if (result.code !== 0 || result.timedOut) {
      logs.push(
        `The cleanup ${result.timedOut ? 'timed out' : `exited with code ${result.code}`}; continuing with the packages that are left. If the app does not start, set the prune mode to "none" and deploy again.`,
      )
      return
    }
    if (size) logs.push(`Deployment size: ${formatSize(Number(size[1]) * 1024)} → ${formatSize(Number(size[2]) * 1024)}.`)
  }

  /**
   * Run `install_command` then `build_command` on the deployment's runtime, as
   * the site's user when isolated. Returns the environment they ran with, or
   * null when there was nothing to run.
   */
  private async runSiteCommands(
    site: SiteRow,
    runtimeId: string,
    dir: string,
    logs: string[],
    set: (status: string, counts?: { files: number; bytes: number }) => void | Promise<void>,
    sandboxed: { sandbox: NonNullable<Config['functionsSandbox']>; uid: number } | null,
    /** Builds that go live see live values; previews see preview values. */
    context: DeployContext,
  ): Promise<Record<string, string> | null> {
    const commands = [
      ['install', site.install_command.trim()],
      ['build', site.build_command.trim()],
    ].filter(([, command]) => Boolean(command)) as [string, string][]
    if (!commands.length) {
      logs.push('No install or build command; using the upload as it is.')
      return null
    }
    await set('building')
    const runtime = await ensureRuntime(this.config, runtimeId, (line) => {
      logs.push(line)
      void set('building')
    })
    logs.push(`Runtime: ${runtime.version ? `${runtime.kind === 'node' ? 'Node.js' : 'Bun'} ${runtime.version}` : `this server's Bun ${process.versions.bun}`}`)
    const env = withRuntime(siteBaseEnv(this.config, site.id, await this.variables.siteEnvironment(site.id, context)), runtime)
    for (const [label, command] of commands) {
      logs.push(`$ ${command}`)
      await set('building')
      const result = await runShell({
        command,
        cwd: sandboxed ? undefined : dir,
        wrap: sandboxed ? (argv) => sandboxed.sandbox.wrap(sandboxed.uid, dir, argv) : undefined,
        signal: sandboxed ? (pid, signal) => sandboxed.sandbox.signal(pid, signal) : undefined,
        env,
        timeoutMs: BUILD_TIMEOUT_MS,
      })
      logs.push(result.output)
      if (result.timedOut) throw new Error(`The ${label} command timed out after ${BUILD_TIMEOUT_MS / 60000} minutes.`)
      if (result.code !== 0) throw new Error(`The ${label} command exited with code ${result.code}.`)
    }
    return env
  }

  /** Make a ready deployment the one that is served. Instant, so it is also how you roll back. */
  async activate(siteId: string, id: string): Promise<SiteRow> {
    const d = await this.deployment(siteId, id)
    if (d.status !== 'ready') throw err('build_not_ready')
    const previous = this.site(siteId).deployment_id
    await this.db.driver.run('UPDATE _sites SET deployment_id = ?, updated_at = ? WHERE id = ?', [id, now(), siteId])
    await this.reload()
    // The next request starts the new deployment; the old app is stopped now.
    if (previous && previous !== id) this.ssr.stopDeployment(siteId, previous)
    this.ssr.stopDeployment(siteId, id)
    try {
      await this.prune(siteId)
    } catch (error) {
      // The new deployment is already live. Retention cleanup must never turn
      // a successful build into a failed deployment.
      console.error(`[sites] ${siteId}: cleanup after activation failed:`, error)
    }
    return this.site(siteId)
  }

  async removeDeployment(siteId: string, id: string): Promise<void> {
    await this.deployment(siteId, id)
    if (this.site(siteId).deployment_id === id) throw err('general_argument_invalid', 'The live deployment cannot be deleted. Make another one live first.')
    await this.removeStored(siteId, id)
  }

  /**
   * Delete several deployments at once. The live deployment and builds that
   * have not finished are kept. Returns what was removed and what was skipped.
   */
  async removeDeployments(siteId: string, ids: readonly string[]): Promise<{ removed: number; skipped: number }> {
    const site = this.site(siteId)
    let removed = 0
    let skipped = 0
    for (const id of new Set(ids)) {
      const deployment = await this.db.driver.get<{ status: string }>('SELECT status FROM _site_deployments WHERE id = ? AND site_id = ?', [id, site.id])
      if (!deployment || id === site.deployment_id || SITE_IN_PROGRESS.includes(deployment.status)) {
        skipped++
        continue
      }
      await this.removeStored(siteId, id)
      removed++
    }
    return { removed, skipped }
  }

  /** Delete a deployment's row, preview link and files. Callers check that it may be deleted. */
  private async removeStored(siteId: string, id: string): Promise<void> {
    this.ssr.stopDeployment(siteId, id)
    await this.db.driver.run('DELETE FROM _site_deployments WHERE id = ? AND site_id = ?', [id, siteId])
    // A branch preview that pointed here has nothing left to serve.
    await this.db.driver.run('DELETE FROM _site_branches WHERE site_id = ? AND deployment_id = ?', [siteId, id])
    try {
      removeTree(this.config.functionsSandbox, sitesDir(this.config, siteId, id))
      rmSync(this.archivePath(siteId, id), { force: true })
    } catch (error) {
      // Deployments made by an older server user may not be removable by the
      // current one. The row is already gone; keep serving and log the path.
      console.error(`[sites] ${siteId}: could not remove deployment ${id}:`, error)
    }
  }

  /** The deployment's files as .tar.gz. For SSR sites these are the sources after the build. */
  async download(siteId: string, id: string): Promise<Blob> {
    const site = this.site(siteId)
    await this.deployment(siteId, id)
    const dir = sitesDir(this.config, siteId, id)
    if (!existsSync(dir)) throw err('deployment_not_found', 'The files of this deployment are no longer kept on this server.')
    // Installed packages are large and can be installed again on the server.
    const exclude = site.adapter === 'ssr' ? ['./node_modules'] : []
    // An isolated site's folder is readable by its own user only, so pack it as that user.
    const sandbox = this.config.functionsSandbox
    if (!sandbox) return packFolder(dir, exclude)
    const uid = sandbox.uidFor(this.config.projectId, `site:${siteId}`)
    const pack = Bun.spawn(sandbox.wrap(uid, dir, ['tar', '-czf', '-', ...exclude.map((pattern) => `--exclude=${pattern}`), '.']), {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [bytes, errText, code] = await Promise.all([new Response(pack.stdout).arrayBuffer(), new Response(pack.stderr).text(), pack.exited])
    if (code !== 0) throw new Error(`Could not pack deployment ${id}: ${errText.trim()}`)
    return new Blob([bytes], { type: 'application/gzip' })
  }

  /** Delete non-live deployments older than each site's retention setting. Returns how many were deleted. */
  async pruneDeployments(): Promise<number> {
    let removed = 0
    for (const site of this.list()) removed += await this.pruneSiteRetention(site)
    return removed
  }

  /** Apply one site's retention setting. */
  private async pruneSiteRetention(site: SiteRow): Promise<number> {
    if (site.deployment_retention <= 0) return 0
    const cutoff = addSeconds(-site.deployment_retention * 86400)
    const old = await this.db.driver.all<{ id: string }>(
      "SELECT id FROM _site_deployments WHERE site_id = ? AND id != ? AND status IN ('ready', 'failed') AND created_at < ?",
      [site.id, site.deployment_id, cutoff],
    )
    for (const { id } of old) await this.removeStored(site.id, id)
    return old.length
  }

  /** Keep disk use flat: the live deployment plus the last few ready ones, then apply retention. */
  private async prune(siteId: string): Promise<void> {
    const site = this.site(siteId)
    const keep = site.adapter === 'ssr' ? this.config.sitesSsrKeepPrevious : KEEP_PREVIOUS
    const live = site.deployment_id
    // Branch previews (Git builds that were not made live) are kept by their branch, not here.
    const ready = await this.db.driver.all<{ id: string }>(
      "SELECT id FROM _site_deployments WHERE site_id = ? AND status = 'ready' AND id != ? AND NOT (type = 'vcs' AND activate = 0) ORDER BY seq DESC",
      [siteId, live],
    )
    for (const { id } of ready.slice(keep)) await this.removeStored(siteId, id)
    const failed = await this.db.driver.all<{ id: string }>("SELECT id FROM _site_deployments WHERE site_id = ? AND status = 'failed' ORDER BY seq DESC", [
      siteId,
    ])
    for (const { id } of failed.slice(keep)) await this.removeStored(siteId, id)
    await this.pruneSiteRetention(site)
  }
}
