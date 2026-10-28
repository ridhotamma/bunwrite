/**
 * Static sites. An upload (.tar.gz or .zip, chunked like function code) is
 * unpacked to `<data>/sites/<siteId>/<deploymentId>/` and served as it is:
 * there is no build step on this server, so build locally (or not at all, for
 * plain HTML and htmx sites) and upload the output.
 *
 * A site answers on `<siteId>.<SITES_DOMAIN>` and, optionally, on its own
 * custom domain. With `apiFunctionId` set, `/api/*` on the site's domain runs
 * that function, so pages can call their backend on the same origin.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

import type { Config } from '~/config'
import type { Db } from '~/db/connection'
import { chunkRange, chunksFor, liftSingleFolder, packFolder, unpackArchive, writeChunk } from '~/functions/deployments'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { uniqueId } from '~/lib/ids'

/** Ready deployments kept besides the live one, for rollback. */
const KEEP_PREVIOUS = 5
const MAX_LOG = 200_000

/** Site IDs are subdomains: lowercase letters, digits and hyphens. */
export const SITE_ID = /^[a-z0-9](?:[a-z0-9-]{0,34}[a-z0-9])?$/
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
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
  domain: string
  apiFunctionId: string
  installCommand: string
  buildCommand: string
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
export const SITE_IN_PROGRESS = ['waiting', 'processing']

/** `<data>/sites[/<siteId>[/<deploymentId>]]`, next to the database file. */
export function sitesDir(config: Config, siteId?: string, deploymentId?: string): string {
  const memory = config.databasePath === ':memory:' || config.databasePath.startsWith('file::memory:')
  const base = memory ? join(tmpdir(), 'bunwrite', config.projectId, 'sites') : join(dirname(resolve(config.databasePath)), 'sites')
  return join(...[base, siteId, deploymentId].filter((p): p is string => Boolean(p)))
}

export const sitesDomainOf = (config: Config) => config.sitesDomain || 'localhost'

/** A relative folder or file inside the site: no `..`, no leading slash. */
function relativePath(value: string, what: string): string {
  const cleaned = value.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '')
  if (!cleaned || cleaned === '.') return ''
  if (isAbsolute(cleaned) || cleaned.split('/').includes('..')) throw err('general_argument_invalid', `${what} must be a path inside the site.`)
  return cleaned
}

export function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '').replace(/\.$/, '')
  if (!domain) return ''
  if (!DOMAIN.test(domain)) throw err('general_argument_invalid', `"${value}" is not a valid domain.`)
  return domain
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
  /** The other projects' site services, so site IDs and domains stay unique on this server. */
  peers: () => SiteService[] = () => []
  private byId: Map<string, SiteRow> | null = null
  private byDomain: Map<string, SiteRow> | null = null

  constructor(
    private db: Db,
    private config: Config,
  ) {}

  private get sql() {
    return this.db.sqlite
  }

  private cache() {
    if (!this.byId || !this.byDomain) {
      const rows = this.sql.query<SiteRow, []>('SELECT * FROM _sites ORDER BY seq').all()
      this.byId = new Map(rows.map((r) => [r.id, r]))
      this.byDomain = new Map(rows.filter((r) => r.domain).map((r) => [r.domain, r]))
    }
    return { byId: this.byId, byDomain: this.byDomain }
  }

  private changed() {
    this.byId = this.byDomain = null
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
    const name = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
    const { byId, byDomain } = this.cache()
    const custom = byDomain.get(name)
    if (custom) return custom
    const suffix = `.${sitesDomainOf(this.config)}`
    if (!name.endsWith(suffix)) return null
    const sub = name.slice(0, -suffix.length)
    return sub.includes('.') ? null : (byId.get(sub) ?? null)
  }

  /** `https://<id>.<SITES_DOMAIN>`, with the API's port when it has one (local development). */
  url(site: SiteRow): string {
    const api = new URL(this.config.publicEndpoint)
    return `${api.protocol}//${site.id}.${sitesDomainOf(this.config)}${api.port ? `:${api.port}` : ''}`
  }

  /** Every address the site answers on. */
  urls(site: SiteRow): string[] {
    const api = new URL(this.config.publicEndpoint)
    return [this.url(site), ...(site.domain ? [`${api.protocol}//${site.domain}`] : [])]
  }

  /** Project origins plus this project's sites, for CORS and redirect checks. */
  allowedOrigins(): string[] {
    return [...this.config.allowedOrigins, ...this.list().flatMap((s) => this.urls(s))]
  }

  private assertUnique(id: string | null, domain: string, self?: string): void {
    const everyone = [this, ...this.peers().filter((p) => p !== this)]
    if (id && everyone.some((s) => s.has(id))) throw err('site_already_exists')
    if (domain && everyone.some((s) => s.list().some((r) => r.domain === domain && r.id !== self))) {
      throw err('general_argument_invalid', `The domain ${domain} is already used by another site.`)
    }
    if (domain && (domain === sitesDomainOf(this.config) || domain === new URL(this.config.publicEndpoint).hostname)) {
      throw err('general_argument_invalid', `${domain} is this server's own domain.`)
    }
  }

  private clean(settings: SiteSettings): SiteSettings {
    const name = settings.name.trim()
    if (!name || name.length > 128) throw err('general_argument_invalid', 'A site needs a name of 128 characters or less.')
    return {
      ...settings,
      name,
      outputDirectory: relativePath(settings.outputDirectory, 'Output directory'),
      fallbackFile: relativePath(settings.fallbackFile, 'Fallback file'),
      domain: normalizeDomain(settings.domain),
      apiFunctionId: settings.apiFunctionId.trim(),
    }
  }

  create(id: string, input: SiteSettings): SiteRow {
    if (!SITE_ID.test(id)) {
      throw err('general_argument_invalid', 'Site ID: up to 36 lowercase letters, digits and hyphens, starting and ending with a letter or digit. It becomes the subdomain.')
    }
    if (RESERVED_IDS.has(id)) throw err('general_argument_invalid', `The site ID "${id}" is reserved.`)
    const s = this.clean(input)
    this.assertUnique(id, s.domain)
    const stamp = now()
    this.sql
      .query(
        `INSERT INTO _sites (id, name, enabled, framework, output_directory, fallback_file, domain, api_function_id, install_command, build_command, build_runtime, adapter, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, s.name, s.enabled ? 1 : 0, s.framework, s.outputDirectory, s.fallbackFile, s.domain, s.apiFunctionId, s.installCommand, s.buildCommand, s.buildRuntime, s.adapter, stamp, stamp)
    this.changed()
    return this.site(id)
  }

  update(id: string, input: SiteSettings): SiteRow {
    this.site(id)
    const s = this.clean(input)
    this.assertUnique(null, s.domain, id)
    this.sql
      .query(
        `UPDATE _sites SET name = ?, enabled = ?, framework = ?, output_directory = ?, fallback_file = ?, domain = ?, api_function_id = ?,
         install_command = ?, build_command = ?, build_runtime = ?, adapter = ?, updated_at = ? WHERE id = ?`,
      )
      .run(s.name, s.enabled ? 1 : 0, s.framework, s.outputDirectory, s.fallbackFile, s.domain, s.apiFunctionId, s.installCommand, s.buildCommand, s.buildRuntime, s.adapter, now(), id)
    this.changed()
    return this.site(id)
  }

  settingsOf(site: SiteRow): SiteSettings {
    return {
      name: site.name,
      enabled: Boolean(site.enabled),
      framework: site.framework,
      outputDirectory: site.output_directory,
      fallbackFile: site.fallback_file,
      domain: site.domain,
      apiFunctionId: site.api_function_id,
      installCommand: site.install_command,
      buildCommand: site.build_command,
      buildRuntime: site.build_runtime,
      adapter: site.adapter,
    }
  }

  remove(id: string): void {
    this.site(id)
    this.sql.transaction(() => {
      this.sql.query('DELETE FROM _site_deployments WHERE site_id = ?').run(id)
      this.sql.query('DELETE FROM _sites WHERE id = ?').run(id)
    })()
    this.changed()
    rmSync(sitesDir(this.config, id), { recursive: true, force: true })
  }

  /** The folder the live deployment serves from, or null when nothing is live. */
  root(site: SiteRow): string | null {
    if (!site.deployment_id) return null
    const dir = join(sitesDir(this.config, site.id, site.deployment_id), site.output_directory)
    return existsSync(dir) ? dir : null
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

  private insert(siteId: string, id: string, status: string, size: number, activate: boolean, chunks: number, uploaded: number): void {
    const stamp = now()
    this.sql
      .query(
        `INSERT INTO _site_deployments (id, site_id, status, source_size, activate, chunks_total, chunks_uploaded, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, siteId, status, size, activate ? 1 : 0, chunks, uploaded, stamp, stamp)
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
      this.insert(site.id, id, 'waiting', total, input.activate, chunksFor(total), 0)
      row = this.deployment(site.id, id)
      mkdirSync(sitesDir(this.config, site.id), { recursive: true })
    }
    writeChunk(this.archivePath(site.id, row.id), bytes, start)
    const counted = this.sql
      .query<{ chunks_uploaded: number }, [string, string]>('UPDATE _site_deployments SET chunks_uploaded = chunks_uploaded + 1, updated_at = ? WHERE id = ? RETURNING chunks_uploaded')
      .get(now(), row.id)!
    if (counted.chunks_uploaded >= row.chunks_total) {
      this.sql.query("UPDATE _site_deployments SET status = 'processing', updated_at = ? WHERE id = ?").run(now(), row.id)
      // Unpacking is quick; wait for it so the response already says ready or failed.
      return this.process(site.id, row.id)
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
    this.insert(site.id, id, 'processing', size, activate, 1, 1)
    rmSync(dir, { recursive: true, force: true })
    for (const file of files) {
      const target = resolve(root, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.content)
    }
    return this.process(site.id, id, { unpacked: true })
  }

  /** Unpack, check the output folder, and go live when asked. Sets status ready or failed. */
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
        rmSync(dir, { recursive: true, force: true })
        mkdirSync(dir, { recursive: true })
        try {
          await unpackArchive(archive, dir)
        } finally {
          rmSync(archive, { force: true })
        }
      }
      const marker = site.output_directory || 'index.html'
      const lifted = liftSingleFolder(dir, marker)
      if (lifted) logs.push(`Using the "${lifted}" folder inside the upload as the site folder.`)
      if (site.build_command || site.install_command) {
        logs.push('Sites are served as uploaded; this server runs no install or build command. Build first and upload the output.')
      }
      const out = join(dir, site.output_directory)
      if (!existsSync(out) || !statSync(out).isDirectory()) {
        throw new Error(`Output directory "${site.output_directory}" is not in the upload. Files at the top: ${readdirSync(dir).slice(0, 20).join(', ') || '(none)'}`)
      }
      const counts = countFiles(out)
      if (!counts.files) throw new Error('The upload has no files.')
      logs.push(`${counts.files} file${counts.files === 1 ? '' : 's'}, ${formatSize(counts.bytes)}${site.output_directory ? ` in ${normalize(site.output_directory)}/` : ''}.`)
      if (!existsSync(join(out, 'index.html'))) logs.push('Note: there is no index.html at the top, so the home page will be a 404.')
      logs.push('Ready.')
      set('ready', counts)
      if (this.deployment(siteId, id).activate) this.activate(siteId, id)
    } catch (error) {
      logs.push(error instanceof Error ? error.message : String(error))
      set('failed')
      rmSync(archive, { force: true })
      rmSync(dir, { recursive: true, force: true })
    }
    return this.deployment(siteId, id)
  }

  /** Make a ready deployment the one that is served. Instant, so it is also how you roll back. */
  activate(siteId: string, id: string): SiteRow {
    const d = this.deployment(siteId, id)
    if (d.status !== 'ready') throw err('build_not_ready')
    this.sql.query('UPDATE _sites SET deployment_id = ?, updated_at = ? WHERE id = ?').run(id, now(), siteId)
    this.changed()
    this.prune(siteId)
    return this.site(siteId)
  }

  removeDeployment(siteId: string, id: string): void {
    this.deployment(siteId, id)
    if (this.site(siteId).deployment_id === id) throw err('general_argument_invalid', 'The live deployment cannot be deleted. Make another one live first.')
    this.sql.query('DELETE FROM _site_deployments WHERE id = ?').run(id)
    rmSync(sitesDir(this.config, siteId, id), { recursive: true, force: true })
    rmSync(this.archivePath(siteId, id), { force: true })
  }

  /** The deployment's files as .tar.gz. Nothing is built here, so source and output are the same. */
  async download(siteId: string, id: string): Promise<Blob> {
    this.deployment(siteId, id)
    const dir = sitesDir(this.config, siteId, id)
    if (!existsSync(dir)) throw err('deployment_not_found', 'The files of this deployment are no longer kept on this server.')
    return packFolder(dir)
  }

  /** Keep disk use flat: the live deployment plus the last few ready ones. */
  private prune(siteId: string): void {
    const live = this.site(siteId).deployment_id
    const ready = this.sql
      .query<{ id: string }, [string, string]>("SELECT id FROM _site_deployments WHERE site_id = ? AND status = 'ready' AND id != ? ORDER BY seq DESC")
      .all(siteId, live)
    for (const { id } of ready.slice(KEEP_PREVIOUS)) {
      this.sql.query('DELETE FROM _site_deployments WHERE id = ?').run(id)
      rmSync(sitesDir(this.config, siteId, id), { recursive: true, force: true })
    }
    const failed = this.sql.query<{ id: string }, [string]>("SELECT id FROM _site_deployments WHERE site_id = ? AND status = 'failed' ORDER BY seq DESC").all(siteId)
    for (const { id } of failed.slice(KEEP_PREVIOUS)) this.sql.query('DELETE FROM _site_deployments WHERE id = ?').run(id)
  }
}
