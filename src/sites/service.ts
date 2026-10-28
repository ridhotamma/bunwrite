/**
 * Sites. A static upload (.tar.gz or .zip, chunked like function code) is
 * unpacked to `<data>/sites/<siteId>/<deploymentId>/` and served as it is.
 * With `adapter: 'ssr'` the upload is the app's source: the install and build
 * commands run here, then the start command runs as a child process and
 * requests are proxied to it (see ssr.ts). With `apiFunctionId` set, `/api/*`
 * (or every path on an SSR site with no start command) runs that function, so
 * pages can call their backend on the same origin.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

import type { Config } from '~/config'
import type { Db } from '~/db/connection'
import { BUILD_TIMEOUT_MS, runShell } from '~/deploy/command'
import { chunkRange, chunksFor, liftSingleFolder, packFolder, unpackArchive, writeChunk } from '~/functions/deployments'
import { removeTree } from '~/functions/sandbox'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { hostOf, siteHost, sitesDomainOf, urlForHost } from '~/lib/hosts'
import { uniqueId } from '~/lib/ids'
import type { ProxyService } from '~/proxy/service'
import { siteBaseEnv } from './env'
import { SITE_ADAPTERS } from './frameworks'
import { siteHome, sitesDir } from './paths'
import { SsrRuntime, type SsrTarget } from './ssr'

/** Ready deployments kept besides the live one, for rollback. */
const KEEP_PREVIOUS = 5
/** SSR deployments keep fewer, since each source tree may hold node_modules. */
const KEEP_PREVIOUS_SSR = 2
const MAX_LOG = 1_000_000

export { sitesDir }

/** Site IDs are subdomains: lowercase letters, digits and hyphens. */
export const SITE_ID = /^[a-z0-9](?:[a-z0-9-]{0,34}[a-z0-9])?$/
/** Taken by the server itself; a site may not use these names. */
const RESERVED_IDS = new Set(['www', 'api', 'console', 'admin', 'sites', 'cloud', 'localhost'])

export interface SiteRow {
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
  created_at: string
  updated_at: string
}

export interface SiteDeploymentRow {
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
  const cleaned = value.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '')
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
    private db: Db,
    private config: Config,
    private proxy: ProxyService,
  ) {
    this.ssr = new SsrRuntime(config, (siteId) => this.ssrTarget(siteId))
  }

  private get sql() {
    return this.db.sqlite
  }

  private cache() {
    if (!this.byId) {
      const rows = this.sql.query<SiteRow, []>('SELECT * FROM _sites ORDER BY seq').all()
      this.byId = new Map(rows.map((row) => [row.id, row]))
    }
    return { byId: this.byId }
  }

  private changed() {
    this.byId = null
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
  byHost(host: string): SiteRow | null {
    const name = hostOf(host)
    const custom = this.proxy.byDomain(name)
    if (custom?.resource_type === 'site') return this.site(custom.resource_id)
    const suffix = `.${sitesDomainOf(this.config)}`
    if (!name.endsWith(suffix)) return null
    const sub = name.slice(0, -suffix.length)
    return sub.includes('.') ? null : (this.cache().byId.get(sub) ?? null)
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
    return {
      ...settings,
      name,
      adapter,
      installCommand: settings.installCommand.trim(),
      buildCommand: settings.buildCommand.trim(),
      startCommand: settings.startCommand.trim(),
      outputDirectory: relativePath(settings.outputDirectory, 'Output directory'),
      fallbackFile: relativePath(settings.fallbackFile, 'Fallback file'),
      domains: this.proxy.normalizeAll(settings.domains, self),
      apiFunctionId: settings.apiFunctionId.trim(),
    }
  }

  create(id: string, input: SiteSettings): SiteRow {
    if (!SITE_ID.test(id)) {
      throw err('general_argument_invalid', 'Site ID: up to 36 lowercase letters, digits and hyphens, starting and ending with a letter or digit. It becomes the subdomain.')
    }
    if (RESERVED_IDS.has(id)) throw err('general_argument_invalid', `The site ID "${id}" is reserved.`)
    const s = this.clean(input)
    this.assertUnique(id)
    this.proxy.assertDefaultHost('site', id)
    const stamp = now()
    this.sql.transaction(() => {
      this.sql
        .query(
          `INSERT INTO _sites (id, name, enabled, framework, output_directory, fallback_file, domain, api_function_id, install_command, build_command, start_command, build_runtime, adapter, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, s.name, s.enabled ? 1 : 0, s.framework, s.outputDirectory, s.fallbackFile, s.domains[0] ?? '', s.apiFunctionId, s.installCommand, s.buildCommand, s.startCommand, s.buildRuntime, s.adapter, stamp, stamp)
      this.proxy.set('site', id, s.domains)
    })()
    this.changed()
    return this.site(id)
  }

  update(id: string, input: SiteSettings): SiteRow {
    const before = this.site(id)
    const s = this.clean(input, { type: 'site', id })
    this.sql.transaction(() => {
      this.sql
        .query(
          `UPDATE _sites SET name = ?, enabled = ?, framework = ?, output_directory = ?, fallback_file = ?, domain = ?, api_function_id = ?,
           install_command = ?, build_command = ?, start_command = ?, build_runtime = ?, adapter = ?, updated_at = ? WHERE id = ?`,
        )
        .run(s.name, s.enabled ? 1 : 0, s.framework, s.outputDirectory, s.fallbackFile, s.domains[0] ?? '', s.apiFunctionId, s.installCommand, s.buildCommand, s.startCommand, s.buildRuntime, s.adapter, now(), id)
      this.proxy.set('site', id, s.domains)
    })()
    this.changed()
    // A different adapter, folder or on/off state changes how the live app runs.
    // Start commands are snapshotted per deployment, so changing one alone does
    // not disturb the app that is already serving.
    if (before.adapter !== s.adapter || before.output_directory !== s.outputDirectory || Boolean(before.enabled) !== s.enabled) this.ssr.stopSite(id)
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
    }
  }

  remove(id: string): void {
    this.site(id)
    this.ssr.stopSite(id)
    this.sql.transaction(() => {
      this.proxy.removeFor('site', id)
      this.sql.query('DELETE FROM _site_deployments WHERE site_id = ?').run(id)
      this.sql.query('DELETE FROM _sites WHERE id = ?').run(id)
    })()
    this.changed()
    // A request could have started the old app between the first stop and here.
    this.ssr.forget(id)
    removeTree(this.config.functionsSandbox, sitesDir(this.config, id))
  }

  /** Stop every SSR app (project shutdown). */
  stop(): void {
    this.ssr.stop()
  }

  /** The folder the live deployment serves from, or null when nothing is live. */
  root(site: SiteRow): string | null {
    if (!site.deployment_id) return null
    const dir = join(sitesDir(this.config, site.id, site.deployment_id), site.output_directory)
    return existsSync(dir) ? dir : null
  }

  /** The live SSR app, when the deployment has a start command. */
  private ssrTarget(siteId: string): SsrTarget | null {
    const site = this.cache().byId.get(siteId)
    if (!site || !site.enabled || site.adapter !== 'ssr' || !site.deployment_id) return null
    const deployment = this.sql
      .query<SiteDeploymentRow, [string, string]>('SELECT * FROM _site_deployments WHERE id = ? AND site_id = ?')
      .get(site.deployment_id, site.id)
    if (!deployment || deployment.status !== 'ready') return null
    const command = deployment.start_command.trim()
    if (!command) return null
    const cwd = join(sitesDir(this.config, site.id, deployment.id), site.output_directory)
    if (!existsSync(cwd)) return null
    return { key: `${site.id}/${deployment.id}`, siteId: site.id, deploymentId: deployment.id, command, cwd }
  }

  /** The last output of the site's app, for the console. */
  runtimeLogs(siteId: string): string {
    return this.ssr.logs(siteId)
  }

  // ---- Deployments ----

  deployment(siteId: string, id: string): SiteDeploymentRow {
    const row = this.sql.query<SiteDeploymentRow, [string, string]>('SELECT * FROM _site_deployments WHERE id = ? AND site_id = ?').get(id, siteId)
    if (!row) throw err('deployment_not_found')
    return row
  }

  deployments(siteId: string): SiteDeploymentRow[] {
    return this.sql.query<SiteDeploymentRow, [string]>('SELECT * FROM _site_deployments WHERE site_id = ? ORDER BY seq DESC').all(siteId)
  }

  latest(siteId: string): SiteDeploymentRow | null {
    return this.sql.query<SiteDeploymentRow, [string]>('SELECT * FROM _site_deployments WHERE site_id = ? ORDER BY seq DESC LIMIT 1').get(siteId)
  }

  private archivePath(siteId: string, id: string) {
    return join(sitesDir(this.config, siteId), `${id}.upload`)
  }

  private insert(siteId: string, id: string, status: string, size: number, activate: boolean, chunks: number, uploaded: number, startCommand: string): void {
    const stamp = now()
    this.sql
      .query(
        `INSERT INTO _site_deployments (id, site_id, status, source_size, start_command, activate, chunks_total, chunks_uploaded, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, siteId, status, size, startCommand, activate ? 1 : 0, chunks, uploaded, stamp, stamp)
  }

  /** Store one upload (or one chunk of it). The files go live once every chunk is in. */
  async upload(site: SiteRow, input: SiteUpload): Promise<SiteDeploymentRow> {
    const bytes = new Uint8Array(await input.code.arrayBuffer())
    const { start, total } = chunkRange(input.contentRange, bytes.length)
    let row: SiteDeploymentRow
    if (input.uploadId && total > bytes.length && start > 0) {
      row = this.deployment(site.id, input.uploadId)
      if (row.status !== 'waiting') throw err('general_argument_invalid', 'This deployment has already been uploaded.')
    } else {
      const id = input.uploadId || uniqueId()
      this.insert(site.id, id, 'waiting', total, input.activate, chunksFor(total), 0, site.start_command)
      row = this.deployment(site.id, id)
      mkdirSync(sitesDir(this.config, site.id), { recursive: true })
    }
    writeChunk(this.archivePath(site.id, row.id), bytes, start)
    const counted = this.sql
      .query<{ chunks_uploaded: number }, [string, string]>('UPDATE _site_deployments SET chunks_uploaded = chunks_uploaded + 1, updated_at = ? WHERE id = ? RETURNING chunks_uploaded')
      .get(now(), row.id)!
    if (counted.chunks_uploaded >= row.chunks_total) {
      this.sql.query("UPDATE _site_deployments SET status = 'processing', updated_at = ? WHERE id = ?").run(now(), row.id)
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
    this.insert(site.id, id, 'processing', size, activate, 1, 1, site.start_command)
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
    const set = (status: string, counts = { files: 0, bytes: 0 }) =>
      this.sql
        .query('UPDATE _site_deployments SET status = ?, build_logs = ?, build_duration = ?, file_count = ?, total_size = ?, updated_at = ? WHERE id = ?')
        .run(status, logs.join('\n').slice(-MAX_LOG), (performance.now() - started) / 1000, counts.files, counts.bytes, now(), id)
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
      const counts = site.adapter === 'ssr' ? await this.buildSsr(site, id, dir, logs, set) : this.checkStatic(site, dir, logs)
      logs.push('Ready.')
      set('ready', counts)
      if (this.deployment(siteId, id).activate) this.activate(siteId, id)
    } catch (error) {
      logs.push(error instanceof Error ? error.message : String(error))
      set('failed')
      rmSync(archive, { force: true })
      removeTree(this.config.functionsSandbox, dir)
    }
    return this.deployment(siteId, id)
  }

  /** A static deployment: the output folder must be there, with files. */
  private checkStatic(site: SiteRow, dir: string, logs: string[]): { files: number; bytes: number } {
    const marker = site.output_directory || 'index.html'
    const lifted = liftSingleFolder(dir, marker)
    if (lifted) logs.push(`Using the "${lifted}" folder inside the upload as the site folder.`)
    if (site.build_command || site.install_command) {
      logs.push('Static sites are served as uploaded; this server runs no install or build command. Build first and upload the output.')
    }
    const out = join(dir, site.output_directory)
    if (!existsSync(out) || !statSync(out).isDirectory()) {
      throw new Error(`Output directory "${site.output_directory}" is not in the upload. Files at the top: ${readdirSync(dir).slice(0, 20).join(', ') || '(none)'}`)
    }
    const counts = countFiles(out)
    if (!counts.files) throw new Error('The upload has no files.')
    logs.push(`${counts.files} file${counts.files === 1 ? '' : 's'}, ${formatSize(counts.bytes)}${site.output_directory ? ` in ${normalize(site.output_directory)}/` : ''}.`)
    if (!existsSync(join(out, 'index.html'))) logs.push('Note: there is no index.html at the top, so the home page will be a 404.')
    return counts
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
    set: (status: string, counts?: { files: number; bytes: number }) => void,
  ): Promise<{ files: number; bytes: number }> {
    const deployment = this.deployment(site.id, id)
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
      await this.runSiteCommands(site, dir, logs, set, isolated ? { sandbox, uid } : null)
    }

    const cwd = join(dir, site.output_directory)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      const top = isolated ? '' : ` Files at the top: ${readdirSync(dir).slice(0, 20).join(', ') || '(none)'}`
      throw new Error(`The app folder "${site.output_directory}" is not in the deployment.${top}`)
    }
    if (command) logs.push(`Start command: ${command}`)
    else logs.push(`No start command: requests run the function "${site.api_function_id}".`)

    const counts = isolated ? (await this.measureTree(cwd, sandbox, uid)) ?? source : countFiles(cwd)
    logs.push(`${counts.files} file${counts.files === 1 ? '' : 's'}, ${formatSize(counts.bytes)}${site.output_directory ? ` in ${normalize(site.output_directory)}/` : ''}.`)
    return counts
  }

  /** Files and bytes of an isolated deployment, counted as its own user. */
  private async measureTree(dir: string, sandbox: NonNullable<Config['functionsSandbox']>, uid: number): Promise<{ files: number; bytes: number } | null> {
    try {
      const result = await runShell({
        command: "find . -type f | wc -l; du -sk . | cut -f1",
        wrap: (argv) => sandbox.wrap(uid, dir, argv),
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

  /** Run `install_command` then `build_command`, as the site's user when isolated. */
  private async runSiteCommands(
    site: SiteRow,
    dir: string,
    logs: string[],
    set: (status: string, counts?: { files: number; bytes: number }) => void,
    sandboxed: { sandbox: NonNullable<Config['functionsSandbox']>; uid: number } | null,
  ): Promise<void> {
    const commands = [
      ['install', site.install_command.trim()],
      ['build', site.build_command.trim()],
    ].filter(([, command]) => Boolean(command)) as [string, string][]
    if (!commands.length) {
      logs.push('No install or build command; using the upload as it is.')
      return
    }
    for (const [label, command] of commands) {
      logs.push(`$ ${command}`)
      set('building')
      const result = await runShell({
        command,
        cwd: sandboxed ? undefined : dir,
        wrap: sandboxed ? (argv) => sandboxed.sandbox.wrap(sandboxed.uid, dir, argv) : undefined,
        env: siteBaseEnv(this.config, site.id),
        timeoutMs: BUILD_TIMEOUT_MS,
      })
      logs.push(result.output)
      if (result.timedOut) throw new Error(`The ${label} command timed out after ${BUILD_TIMEOUT_MS / 60000} minutes.`)
      if (result.code !== 0) throw new Error(`The ${label} command exited with code ${result.code}.`)
    }
  }

  /** Make a ready deployment the one that is served. Instant, so it is also how you roll back. */
  activate(siteId: string, id: string): SiteRow {
    const d = this.deployment(siteId, id)
    if (d.status !== 'ready') throw err('build_not_ready')
    const previous = this.site(siteId).deployment_id
    this.sql.query('UPDATE _sites SET deployment_id = ?, updated_at = ? WHERE id = ?').run(id, now(), siteId)
    this.changed()
    // The next request starts the new deployment; the old app is stopped now.
    if (previous && previous !== id) this.ssr.stopDeployment(siteId, previous)
    this.ssr.stopDeployment(siteId, id)
    this.prune(siteId)
    return this.site(siteId)
  }

  removeDeployment(siteId: string, id: string): void {
    this.deployment(siteId, id)
    if (this.site(siteId).deployment_id === id) throw err('general_argument_invalid', 'The live deployment cannot be deleted. Make another one live first.')
    this.ssr.stopDeployment(siteId, id)
    this.sql.query('DELETE FROM _site_deployments WHERE id = ?').run(id)
    removeTree(this.config.functionsSandbox, sitesDir(this.config, siteId, id))
    rmSync(this.archivePath(siteId, id), { force: true })
  }

  /** The deployment's files as .tar.gz. For SSR sites these are the sources after the build. */
  async download(siteId: string, id: string): Promise<Blob> {
    const site = this.site(siteId)
    this.deployment(siteId, id)
    const dir = sitesDir(this.config, siteId, id)
    if (!existsSync(dir)) throw err('deployment_not_found', 'The files of this deployment are no longer kept on this server.')
    // Installed packages are large and can be installed again on the server.
    const exclude = site.adapter === 'ssr' ? ['./node_modules'] : []
    // An isolated site's folder is readable by its own user only, so pack it as that user.
    const sandbox = this.config.functionsSandbox
    if (!sandbox) return packFolder(dir, exclude)
    const uid = sandbox.uidFor(this.config.projectId, `site:${siteId}`)
    const pack = Bun.spawn(sandbox.wrap(uid, dir, ['tar', '-czf', '-', ...exclude.map((pattern) => `--exclude=${pattern}`), '.']), { stdout: 'pipe', stderr: 'pipe' })
    const [bytes, errText, code] = await Promise.all([new Response(pack.stdout).arrayBuffer(), new Response(pack.stderr).text(), pack.exited])
    if (code !== 0) throw new Error(`Could not pack deployment ${id}: ${errText.trim()}`)
    return new Blob([bytes], { type: 'application/gzip' })
  }

  /** Keep disk use flat: the live deployment plus the last few ready ones. */
  private prune(siteId: string): void {
    const site = this.site(siteId)
    const keep = site.adapter === 'ssr' ? KEEP_PREVIOUS_SSR : KEEP_PREVIOUS
    const live = site.deployment_id
    const ready = this.sql
      .query<{ id: string }, [string, string]>("SELECT id FROM _site_deployments WHERE site_id = ? AND status = 'ready' AND id != ? ORDER BY seq DESC")
      .all(siteId, live)
    for (const { id } of ready.slice(keep)) {
      this.ssr.stopDeployment(siteId, id)
      this.sql.query('DELETE FROM _site_deployments WHERE id = ?').run(id)
      removeTree(this.config.functionsSandbox, sitesDir(this.config, siteId, id))
    }
    const failed = this.sql.query<{ id: string }, [string]>("SELECT id FROM _site_deployments WHERE site_id = ? AND status = 'failed' ORDER BY seq DESC").all(siteId)
    for (const { id } of failed.slice(keep)) {
      this.sql.query('DELETE FROM _site_deployments WHERE id = ?').run(id)
      removeTree(this.config.functionsSandbox, sitesDir(this.config, siteId, id))
    }
  }
}
