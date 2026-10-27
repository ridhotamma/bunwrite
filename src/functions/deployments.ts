/**
 * Function deployments, as `appwrite push functions` makes them: the CLI
 * uploads a .tar.gz of the function folder (in 5 MB chunks when larger, the
 * later ones in parallel), we unpack it to
 * `<data>/deployments/<functionId>/<deploymentId>/`, run the function's build
 * command there, and make it the active code once built when asked to.
 *
 * Build commands run with `sh -c` on this host, not in Appwrite's runtime
 * image, so Alpine-only steps such as `apk` fail; set
 * FUNCTIONS_BUILD_COMMANDS=false to skip them and install what the code needs
 * on the host instead.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { Config } from '~/config'
import type { Db } from '~/db/connection'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { uniqueId } from '~/lib/ids'
import type { FunctionRow, FunctionService } from './service'

/** The SDKs upload in chunks of this size. */
const CHUNK_SIZE = 5 * 1024 * 1024
const MAX_SIZE = 512 * 1024 * 1024
const BUILD_TIMEOUT_MS = 15 * 60 * 1000
const MAX_LOG = 1_000_000
/** Ready deployments kept on disk besides the active one. */
const KEEP_PREVIOUS = 2

export interface DeploymentRow {
  seq: number
  id: string
  function_id: string
  entrypoint: string
  commands: string
  status: string
  build_logs: string
  build_duration: number
  source_size: number
  activate: number
  chunks_total: number
  chunks_uploaded: number
  created_at: string
  updated_at: string
}

/** `<data>/deployments[/<functionId>[/<deploymentId>]]`, next to the database file. */
export function deploymentDir(config: Config, functionId?: string, deploymentId?: string): string {
  const memory = config.databasePath === ':memory:' || config.databasePath.startsWith('file::memory:')
  const base = memory ? join(tmpdir(), 'bunwrite', config.projectId, 'deployments') : join(dirname(resolve(config.databasePath)), 'deployments')
  return join(...[base, functionId, deploymentId].filter((p): p is string => Boolean(p)))
}

export function deploymentModel(d: DeploymentRow) {
  return {
    $id: d.id,
    $createdAt: d.created_at,
    $updatedAt: d.updated_at,
    type: 'manual',
    resourceId: d.function_id,
    resourceType: 'functions',
    entrypoint: d.entrypoint,
    sourceSize: d.source_size,
    buildSize: 0,
    totalSize: d.source_size,
    buildId: d.id,
    activate: Boolean(d.activate),
    screenshotLight: '',
    screenshotDark: '',
    status: d.status,
    buildLogs: d.build_logs,
    buildDuration: d.build_duration,
    providerRepositoryName: '',
    providerRepositoryOwner: '',
    providerRepositoryUrl: '',
    providerCommitHash: '',
    providerCommitAuthorUrl: '',
    providerCommitAuthor: '',
    providerCommitMessage: '',
    providerCommitUrl: '',
    providerBranch: '',
    providerBranchUrl: '',
    // The SDKs read these to tell when a chunked upload is complete.
    chunksTotal: d.chunks_total,
    chunksUploaded: d.chunks_uploaded,
  }
}

export interface UploadInput {
  code: Blob
  entrypoint: string
  commands: string
  activate: boolean
  /** `bytes start-end/total` on chunked uploads. */
  contentRange: string | null
  /** Deployment ID, sent with every chunk after the first. */
  uploadId: string | null
}

export class Deployments {
  constructor(
    private db: Db,
    private config: Config,
    private functions: FunctionService,
  ) {}

  private get sql() {
    return this.db.sqlite
  }

  get(functionId: string, id: string): DeploymentRow {
    const row = this.sql.query<DeploymentRow, [string, string]>('SELECT * FROM _deployments WHERE id = ? AND function_id = ?').get(id, functionId)
    if (!row) throw err('deployment_not_found')
    return row
  }

  list(functionId: string): DeploymentRow[] {
    return this.sql.query<DeploymentRow, [string]>('SELECT * FROM _deployments WHERE function_id = ? ORDER BY seq DESC').all(functionId)
  }

  latest(functionId: string): DeploymentRow | null {
    return this.sql.query<DeploymentRow, [string]>('SELECT * FROM _deployments WHERE function_id = ? ORDER BY seq DESC LIMIT 1').get(functionId)
  }

  /** Store one upload (or one chunk of it). The build starts once every chunk is in. */
  async upload(f: FunctionRow, input: UploadInput): Promise<DeploymentRow> {
    const bytes = new Uint8Array(await input.code.arrayBuffer())
    let start = 0
    let total = bytes.length
    if (input.contentRange) {
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(input.contentRange.trim())
      if (!m) throw err('general_argument_invalid', 'Invalid Content-Range header.')
      start = Number(m[1])
      total = Number(m[3])
      if (Number(m[2]) - start + 1 !== bytes.length || start + bytes.length > total) throw err('general_argument_invalid', 'Content-Range does not match the chunk size.')
    }
    if (total === 0 || total > MAX_SIZE) throw err('deployment_invalid_file_size')

    let row: DeploymentRow
    if (input.uploadId && total > bytes.length && start > 0) {
      row = this.get(f.id, input.uploadId)
      if (row.status !== 'waiting') throw err('general_argument_invalid', 'This deployment has already been uploaded.')
    } else {
      const id = input.uploadId || uniqueId()
      const stamp = now()
      this.sql
        .query(
          `INSERT INTO _deployments (id, function_id, entrypoint, commands, status, source_size, activate, chunks_total, chunks_uploaded, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, 0, ?, ?)`,
        )
        .run(id, f.id, input.entrypoint, input.commands, total, input.activate ? 1 : 0, Math.max(1, Math.ceil(total / CHUNK_SIZE)), stamp, stamp)
      row = this.get(f.id, id)
      mkdirSync(deploymentDir(this.config, f.id), { recursive: true })
    }

    const archive = this.archivePath(f.id, row.id)
    const fd = openSync(archive, existsSync(archive) ? 'r+' : 'w')
    try {
      writeSync(fd, bytes, 0, bytes.length, start)
    } finally {
      closeSync(fd)
    }
    const counted = this.sql
      .query<{ chunks_uploaded: number }, [string, string]>('UPDATE _deployments SET chunks_uploaded = chunks_uploaded + 1, updated_at = ? WHERE id = ? RETURNING chunks_uploaded')
      .get(now(), row.id)!
    if (counted.chunks_uploaded >= row.chunks_total) {
      this.sql.query("UPDATE _deployments SET status = 'processing', updated_at = ? WHERE id = ?").run(now(), row.id)
      this.build(f.id, row.id).catch((e) => console.error(`[functions] ${f.id}: build ${row.id} crashed`, e))
    }
    return this.get(f.id, row.id)
  }

  private archivePath(functionId: string, id: string) {
    return join(deploymentDir(this.config, functionId), `${id}.tar.gz`)
  }

  /** Unpack, run the build command, and activate when asked. Sets status ready or failed. */
  async build(functionId: string, id: string): Promise<DeploymentRow> {
    const started = performance.now()
    const archive = this.archivePath(functionId, id)
    const dir = deploymentDir(this.config, functionId, id)
    const logs: string[] = []
    const set = (status: string) =>
      this.sql
        .query('UPDATE _deployments SET status = ?, build_logs = ?, build_duration = ?, updated_at = ? WHERE id = ?')
        .run(status, logs.join('\n').slice(-MAX_LOG), (performance.now() - started) / 1000, now(), id)
    try {
      set('building')
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      const untar = Bun.spawn(['tar', '-xzf', archive, '-C', dir], { stdout: 'pipe', stderr: 'pipe' })
      const [untarErr, untarCode] = await Promise.all([new Response(untar.stderr).text(), untar.exited])
      rmSync(archive, { force: true })
      if (untarCode !== 0) throw new Error(`Could not unpack the upload: ${untarErr.trim() || `tar exited with ${untarCode}`}`)

      const d = this.get(functionId, id)
      if (!existsSync(join(dir, d.entrypoint))) {
        throw new Error(`Entrypoint "${d.entrypoint}" is not in the upload. Files at the top: ${readdirSync(dir).slice(0, 20).join(', ') || '(none)'}`)
      }

      if (d.commands.trim() && !this.config.functionsBuildCommands) {
        logs.push(`Skipped the build command (FUNCTIONS_BUILD_COMMANDS=false): ${d.commands}`)
      } else if (d.commands.trim()) {
        logs.push(`$ ${d.commands}`)
        set('building')
        const f = this.functions.fn(functionId)
        const proc = Bun.spawn(['sh', '-c', d.commands], { cwd: dir, env: this.functions.env(f, 'build'), stdout: 'pipe', stderr: 'pipe' })
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          proc.kill()
        }, BUILD_TIMEOUT_MS)
        const [out, errOut, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
        clearTimeout(timer)
        logs.push([out.trim(), errOut.trim()].filter(Boolean).join('\n'))
        if (timedOut) throw new Error(`Build timed out after ${BUILD_TIMEOUT_MS / 60000} minutes.`)
        if (code !== 0) throw new Error(`Build command exited with code ${code}.`)
      }

      logs.push('Build ready.')
      set('ready')
      if (d.activate) this.activate(functionId, id)
    } catch (error) {
      logs.push(error instanceof Error ? error.message : String(error))
      set('failed')
      rmSync(archive, { force: true })
      rmSync(dir, { recursive: true, force: true })
    }
    return this.get(functionId, id)
  }

  /** Make a built deployment the code that runs (functions.updateFunctionDeployment). */
  activate(functionId: string, id: string): FunctionRow {
    const d = this.get(functionId, id)
    if (d.status !== 'ready') throw err('build_not_ready')
    this.sql.query('UPDATE _functions SET deployment_id = ?, updated_at = ? WHERE id = ?').run(id, now(), functionId)
    this.prune(functionId)
    return this.functions.fn(functionId)
  }

  /** Delete a deployment that is not the active one. */
  remove(functionId: string, id: string): void {
    this.get(functionId, id)
    if (this.functions.fn(functionId).deployment_id === id) throw err('general_argument_invalid', 'The active deployment cannot be deleted. Activate another one first.')
    this.sql.query('DELETE FROM _deployments WHERE id = ?').run(id)
    rmSync(deploymentDir(this.config, functionId, id), { recursive: true, force: true })
    rmSync(this.archivePath(functionId, id), { force: true })
  }

  /** Keep disk use flat: drop the code of all but the active and the last few ready deployments. */
  private prune(functionId: string): void {
    const active = this.functions.fn(functionId).deployment_id
    const ready = this.sql
      .query<{ id: string }, [string, string]>("SELECT id FROM _deployments WHERE function_id = ? AND status = 'ready' AND id != ? ORDER BY seq DESC")
      .all(functionId, active)
    for (const { id } of ready.slice(KEEP_PREVIOUS)) {
      this.sql.query('DELETE FROM _deployments WHERE id = ?').run(id)
      rmSync(deploymentDir(this.config, functionId, id), { recursive: true, force: true })
    }
  }
}
