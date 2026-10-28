/**
 * Function deployments, as `appwrite push functions` makes them: the CLI
 * uploads a .tar.gz of the function folder (in 5 MB chunks when larger, the
 * later ones in parallel), we unpack it to
 * `<data>/deployments/<functionId>/<deploymentId>/`, run the function's build
 * command there, and make it the active code once built when asked to.
 *
 * The console also uploads .zip files, and deploys starter templates and
 * pasted code by writing the files straight into the deployment folder.
 *
 * Build commands run with `sh -c` on this host, not in Appwrite's runtime
 * image, so Alpine-only steps such as `apk` fail; set
 * FUNCTIONS_BUILD_COMMANDS=false to skip them and install what the code needs
 * on the host instead.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import type { Config } from '~/config'
import type { Db } from '~/db/connection'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { uniqueId } from '~/lib/ids'
import type { FunctionRow, FunctionService } from './service'
import { buildToolsDir, PYTHON_PACKAGES_DIR } from './runtime'
import { removeTree } from './sandbox'
import { extractZip, isZip } from './zip'

/** The SDKs upload in chunks of this size. */
const CHUNK_SIZE = 5 * 1024 * 1024
const MAX_SIZE = 512 * 1024 * 1024
const BUILD_TIMEOUT_MS = 15 * 60 * 1000
const MAX_LOG = 1_000_000
/** Ready deployments kept on disk besides the active one. */
const KEEP_PREVIOUS = 2
/** macOS tar would add `._name` metadata files to archives; other tars ignore this. */
const TAR_ENV = { ...process.env, COPYFILE_DISABLE: '1' }

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

/** A function's own writable home (HOME, TMPDIR, package caches) when functions are isolated. */
export function functionHome(config: Config, functionId: string): string {
  return join(deploymentDir(config, functionId), '.home')
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

export interface CodeFile {
  /** Relative path inside the function folder, such as src/main.js. */
  path: string
  content: string
}

export interface FilesInput {
  files: CodeFile[]
  entrypoint: string
  commands: string
  activate: boolean
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
    return join(deploymentDir(this.config, functionId), `${id}.upload`)
  }

  /** The deployment's code as uploaded, before its build command ran (`appwrite pull functions`). */
  private sourcePath(functionId: string, id: string) {
    return join(deploymentDir(this.config, functionId), `${id}.source.tar.gz`)
  }

  /**
   * A .tar.gz of the deployment: its source as uploaded, or with `output` the
   * folder after the build. Deployments made before sources were kept fall
   * back to the built folder.
   */
  async download(functionId: string, id: string, type: 'source' | 'output' = 'source'): Promise<Blob> {
    this.get(functionId, id)
    const source = this.sourcePath(functionId, id)
    if (type === 'source' && existsSync(source)) return Bun.file(source)
    const dir = deploymentDir(this.config, functionId, id)
    if (!existsSync(dir)) throw err('deployment_not_found', 'The code of this deployment is no longer kept on this server.')
    // An isolated function's folder is readable by its own user only, so pack it as that user.
    const sandbox = this.config.functionsSandbox
    const tar = ['tar', '-czf', '-', '.']
    const pack = sandbox
      ? Bun.spawn(sandbox.wrap(sandbox.uidFor(this.config.projectId, functionId), dir, tar), { stdout: 'pipe', stderr: 'pipe', env: TAR_ENV })
      : Bun.spawn([...tar.slice(0, 3), '-C', dir, '.'], { stdout: 'pipe', stderr: 'pipe', env: TAR_ENV })
    const [bytes, errText, code] = await Promise.all([new Response(pack.stdout).arrayBuffer(), new Response(pack.stderr).text(), pack.exited])
    if (code !== 0) throw new Error(`Could not pack deployment ${id}: ${errText.trim()}`)
    return new Blob([bytes], { type: 'application/gzip' })
  }

  /** Keep a copy of the code as uploaded, before the build changes the folder. */
  private async keepSource(functionId: string, id: string, dir: string): Promise<void> {
    const pack = Bun.spawn(['tar', '-czf', this.sourcePath(functionId, id), '-C', dir, '.'], { stdout: 'ignore', stderr: 'pipe', env: TAR_ENV })
    const [errText, code] = await Promise.all([new Response(pack.stderr).text(), pack.exited])
    if (code !== 0) throw new Error(`Could not keep the deployment source: ${errText.trim() || `tar exited with ${code}`}`)
  }

  /**
   * Deploy files given as text: a starter template or code pasted in the
   * console. The build (if any) runs in the background, as for uploads.
   */
  deployFiles(f: FunctionRow, input: FilesInput): DeploymentRow {
    if (!input.files.length) throw err('general_argument_invalid', 'Add at least one file.')
    const id = uniqueId()
    const dir = deploymentDir(this.config, f.id, id)
    const root = resolve(dir)
    const size = input.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0)
    if (size > MAX_SIZE) throw err('deployment_invalid_file_size')
    for (const file of input.files) {
      const target = resolve(root, file.path)
      if (!file.path || isAbsolute(file.path) || !target.startsWith(root + sep)) throw err('general_argument_invalid', `Invalid file path: ${file.path}`)
    }
    const stamp = now()
    this.sql
      .query(
        `INSERT INTO _deployments (id, function_id, entrypoint, commands, status, source_size, activate, chunks_total, chunks_uploaded, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'processing', ?, ?, 1, 1, ?, ?)`,
      )
      .run(id, f.id, input.entrypoint, input.commands, size, input.activate ? 1 : 0, stamp, stamp)
    rmSync(dir, { recursive: true, force: true })
    for (const file of input.files) {
      const target = resolve(root, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.content)
    }
    this.build(f.id, id, { unpacked: true }).catch((e) => console.error(`[functions] ${f.id}: build ${id} crashed`, e))
    return this.get(f.id, id)
  }

  /** Unpack a .tar.gz or .zip upload into `dir`. */
  private async unpack(archive: string, dir: string): Promise<void> {
    const head = new Uint8Array(4)
    const fd = openSync(archive, 'r')
    try {
      readSync(fd, head, 0, 4, 0)
    } finally {
      closeSync(fd)
    }
    if (isZip(head)) {
      extractZip(readFileSync(archive), dir)
      return
    }
    const untar = Bun.spawn(['tar', '-xzf', archive, '-C', dir], { stdout: 'pipe', stderr: 'pipe' })
    const [untarErr, untarCode] = await Promise.all([new Response(untar.stderr).text(), untar.exited])
    if (untarCode !== 0) throw new Error(`Could not unpack the upload. Use a .tar.gz or .zip file. ${untarErr.trim() || `tar exited with ${untarCode}`}`)
  }

  /**
   * Archives made by zipping a folder put everything under that folder. When
   * the entrypoint is missing at the top but sits inside the only folder,
   * use that folder as the function root.
   */
  private liftSingleFolder(dir: string, entrypoint: string): string | null {
    if (existsSync(join(dir, entrypoint))) return null
    const top = readdirSync(dir).filter((name) => !name.startsWith('.'))
    if (top.length !== 1) return null
    const inner = join(dir, top[0]!)
    if (!statSync(inner).isDirectory() || !existsSync(join(inner, entrypoint))) return null
    const temp = `${dir}.lift`
    rmSync(temp, { recursive: true, force: true })
    renameSync(inner, temp)
    for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true })
    for (const name of readdirSync(temp)) renameSync(join(temp, name), join(dir, name))
    rmdirSync(temp)
    return top[0]!
  }

  /** Unpack, run the build command, and activate when asked. Sets status ready or failed. */
  async build(functionId: string, id: string, options: { unpacked?: boolean } = {}): Promise<DeploymentRow> {
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
      if (!options.unpacked) {
        removeTree(this.config.functionsSandbox, dir)
        mkdirSync(dir, { recursive: true })
        try {
          await this.unpack(archive, dir)
        } finally {
          rmSync(archive, { force: true })
        }
      }

      const d = this.get(functionId, id)
      const lifted = this.liftSingleFolder(dir, d.entrypoint)
      if (lifted) logs.push(`Using the "${lifted}" folder inside the upload as the function folder.`)
      if (!existsSync(join(dir, d.entrypoint))) {
        throw new Error(`Entrypoint "${d.entrypoint}" is not in the upload. Files at the top: ${readdirSync(dir).slice(0, 20).join(', ') || '(none)'}`)
      }
      await this.keepSource(functionId, id, dir)
      // From here on the folder belongs to the function's own user.
      const sandbox = this.config.functionsSandbox
      const uid = sandbox?.uidFor(this.config.projectId, functionId)
      if (sandbox && uid !== undefined) sandbox.adopt(dir, functionHome(this.config, functionId), uid)

      if (d.commands.trim() && !this.config.functionsBuildCommands) {
        logs.push(`Skipped the build command (FUNCTIONS_BUILD_COMMANDS=false): ${d.commands}`)
      } else if (d.commands.trim()) {
        logs.push(`$ ${d.commands}`)
        set('building')
        const f = this.functions.fn(functionId)
        const command = ['sh', '-c', d.commands]
        const proc = Bun.spawn(sandbox && uid !== undefined ? sandbox.wrap(uid, dir, command) : command, {
          cwd: sandbox ? undefined : dir,
          env: this.buildEnv(f, dir),
          stdout: 'pipe',
          stderr: 'pipe',
        })
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
      removeTree(this.config.functionsSandbox, dir)
    }
    return this.get(functionId, id)
  }

  /**
   * The build command's environment: the function's own, plus `bun`, `npm`
   * and friends as a fallback at the end of PATH, and for Python a PIP_TARGET
   * so `pip install -r requirements.txt` puts packages where the function
   * imports them from (and never into the system Python). A PIP_TARGET set in
   * the function's variables wins.
   */
  private buildEnv(f: FunctionRow, dir: string): Record<string, string> {
    const env = this.functions.env(f, 'build')
    env.PATH = [env.PATH, buildToolsDir(this.config)].filter(Boolean).join(':')
    if (this.config.functionsSandbox) env.HOME = env.TMPDIR = functionHome(this.config, f.id)
    if (f.runtime.startsWith('python')) {
      env.PIP_TARGET ??= join(dir, PYTHON_PACKAGES_DIR)
      env.PIP_DISABLE_PIP_VERSION_CHECK ??= '1'
    }
    return env
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
    removeTree(this.config.functionsSandbox, deploymentDir(this.config, functionId, id))
    rmSync(this.archivePath(functionId, id), { force: true })
    rmSync(this.sourcePath(functionId, id), { force: true })
  }

  /** Keep disk use flat: drop the code of all but the active and the last few ready deployments. */
  private prune(functionId: string): void {
    const active = this.functions.fn(functionId).deployment_id
    const ready = this.sql
      .query<{ id: string }, [string, string]>("SELECT id FROM _deployments WHERE function_id = ? AND status = 'ready' AND id != ? ORDER BY seq DESC")
      .all(functionId, active)
    for (const { id } of ready.slice(KEEP_PREVIOUS)) {
      this.sql.query('DELETE FROM _deployments WHERE id = ?').run(id)
      removeTree(this.config.functionsSandbox, deploymentDir(this.config, functionId, id))
      rmSync(this.sourcePath(functionId, id), { force: true })
    }
    // Failed builds keep their source so it can be pulled and fixed; only the latest few.
    const failed = this.sql.query<{ id: string }, [string]>("SELECT id FROM _deployments WHERE function_id = ? AND status = 'failed' ORDER BY seq DESC").all(functionId)
    for (const { id } of failed.slice(KEEP_PREVIOUS)) rmSync(this.sourcePath(functionId, id), { force: true })
  }
}
