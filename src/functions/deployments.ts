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
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import type { Config } from '~/config'
import type { SqlDatabase } from '~/db/driver'
import { BUILD_TIMEOUT_MS, runShell } from '~/deploy/command'
import { addSeconds, now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { isValidId, uniqueId } from '~/lib/ids'
import { isSafeRelativePath, resolveInside } from '~/lib/paths'
import { ensureRuntime, withRuntime } from '~/runtimes/install'
import { SOURCE_COLUMNS, sourceModel, sourceValues, type DeploymentSource, type SourceColumns } from '~/vcs/source'
import { isPython } from './templates'
import type { FunctionRow, FunctionService } from './service'
import { buildToolsDir, PYTHON_PACKAGES_DIR } from './runtime'
import { removeTree } from './sandbox'
import { extractZip, isZip } from './zip'
import { buildContext, type DeployContext } from '~/variables/context'

/** The SDKs upload in chunks of this size. */
const CHUNK_SIZE = 5 * 1024 * 1024
const MAX_SIZE = 512 * 1024 * 1024
const MAX_LOG = 1_000_000
/** Ready deployments kept on disk besides the active one. */
const KEEP_PREVIOUS = 2
/** Ready Git builds of other branches kept on disk. */
const KEEP_PREVIEWS = 5
/** A deployment that is still uploading or building is never deleted by retention. */
const UNSETTLED = ['waiting', 'processing', 'building']
/** macOS tar would add `._name` metadata files to archives; other tars ignore this. */
const TAR_ENV = { ...process.env, COPYFILE_DISABLE: '1' }

export interface DeploymentRow extends SourceColumns {
  seq: number
  id: string
  function_id: string
  entrypoint: string
  commands: string
  status: string
  build_logs: string
  build_duration: number
  source_size: number
  /** The function's runtime when this was built; '' runs on the server's Bun. */
  runtime: string
  activate: number
  chunks_total: number
  chunks_uploaded: number
  created_at: string
  updated_at: string
}

/** `<data>/deployments[/<functionId>[/<deploymentId>]]`, next to the database file. */
export function deploymentDir(config: Config, functionId?: string, deploymentId?: string): string {
  const memory = config.databasePath === ':memory:' || config.databasePath.startsWith('file::memory:')
  // See sitesDir: in-memory test servers need a key so they do not share folders.
  const scope = config.instanceKey ? `${config.projectId}-${config.instanceKey}` : config.projectId
  const base = memory ? join(tmpdir(), 'bunwrite', scope, 'deployments') : join(dirname(resolve(config.databasePath)), 'deployments')
  let path = base
  for (const part of [functionId, deploymentId]) {
    if (!part) continue
    const next = resolveInside(path, part)
    if (!next) throw new Error(`Invalid deployment path component: ${part}`)
    path = next
  }
  return path
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
    ...sourceModel(d),
    // The SDKs read these to tell when a chunked upload is complete.
    chunksTotal: d.chunks_total,
    chunksUploaded: d.chunks_uploaded,
  }
}

/** Where one uploaded chunk goes, from its `Content-Range` (none for a single upload). */
export function chunkRange(contentRange: string | null, length: number): { start: number; total: number } {
  let start = 0
  let total = length
  if (contentRange) {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange.trim())
    if (!m) throw err('general_argument_invalid', 'Invalid Content-Range header.')
    start = Number(m[1])
    total = Number(m[3])
    if (Number(m[2]) - start + 1 !== length || start + length > total) throw err('general_argument_invalid', 'Content-Range does not match the chunk size.')
  }
  if (total === 0 || total > MAX_SIZE) throw err('deployment_invalid_file_size')
  return { start, total }
}

/** Write a chunk at its offset in the upload file. */
export function writeChunk(path: string, bytes: Uint8Array, start: number): void {
  const fd = openSync(path, existsSync(path) ? 'r+' : 'w')
  try {
    writeSync(fd, bytes, 0, bytes.length, start)
  } finally {
    closeSync(fd)
  }
}

export const chunksFor = (total: number) => Math.max(1, Math.ceil(total / CHUNK_SIZE))

/** Read at most `limit` bytes of a child's output, so a broken archive cannot exhaust memory. */
async function readLimited(stream: ReadableStream<Uint8Array> | undefined, limit: number): Promise<string> {
  if (!stream) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.length
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      throw new Error('The archive listing is too large.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Refuse tar members that are not plain files or directories. Symlinks (and
 * hardlinks, devices and FIFOs) are how an archive escapes its extraction
 * folder when a later member is written through them.
 */
async function assertSafeTar(archive: string): Promise<void> {
  // Names come from `tar -t` (one member per line), because verbose output
  // aligns owner/group columns and is easy to misparse. Types come from the
  // verbose listing, where the first character is always the member type.
  const names = Bun.spawn(['tar', '-tzf', archive], { stdout: 'pipe', stderr: 'pipe', env: { ...TAR_ENV, LC_ALL: 'C' } })
  const [list, listError, listCode] = await Promise.all([
    readLimited(names.stdout, 8 * 1024 * 1024),
    readLimited(names.stderr, 64 * 1024),
    names.exited,
  ])
  if (listCode !== 0) throw new Error(`Could not read the upload archive. ${listError.trim() || `tar exited with ${listCode}`}`)
  for (const raw of list.split('\n')) {
    if (!raw) continue
    const name = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    // `tar -C folder .` writes a harmless root entry named "./".
    if (name === '.' || name === './') continue
    const clean = name.replace(/^\.\//, '')
    if (!isSafeRelativePath(clean) || clean.split('/').includes('..')) {
      throw new Error(`Unsafe path in the upload: ${name}`)
    }
  }

  const types = Bun.spawn(['tar', '-tvzf', archive, '--numeric-owner'], { stdout: 'pipe', stderr: 'pipe', env: { ...TAR_ENV, LC_ALL: 'C' } })
  const [listing, typeError, typeCode] = await Promise.all([
    readLimited(types.stdout, 8 * 1024 * 1024),
    readLimited(types.stderr, 64 * 1024),
    types.exited,
  ])
  if (typeCode !== 0) throw new Error(`Could not read the upload archive. ${typeError.trim() || `tar exited with ${typeCode}`}`)
  for (const line of listing.split('\n')) {
    if (!line) continue
    const type = line[0]
    if (type !== '-' && type !== 'd') throw new Error('The upload contains a symbolic link, hard link or special file, which is not allowed.')
  }
}

/** Reject links and special files that would let a later request escape a deployment folder. */
export function assertNoLinks(root: string): void {
  const seen = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const stats = lstatSync(path)
      if (stats.isSymbolicLink()) throw new Error(`The upload contains a symbolic link: ${path.slice(root.length + 1)}`)
      if (stats.isDirectory()) {
        const real = resolve(path)
        if (seen.has(real)) continue
        seen.add(real)
        walk(path)
      } else if (!stats.isFile()) throw new Error('The upload contains a special file, which is not allowed.')
    }
  }
  walk(root)
}

/** Unpack a .tar.gz or .zip upload into `dir`. */
export async function unpackArchive(archive: string, dir: string): Promise<void> {
  const head = new Uint8Array(4)
  const fd = openSync(archive, 'r')
  try {
    readSync(fd, head, 0, 4, 0)
  } finally {
    closeSync(fd)
  }
  try {
    if (isZip(head)) {
      extractZip(readFileSync(archive), dir)
    } else {
      await assertSafeTar(archive)
      const untar = Bun.spawn(['tar', '-xzf', archive, '-C', dir, '--no-same-owner', '--no-same-permissions'], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: TAR_ENV,
      })
      const [untarErr, untarCode] = await Promise.all([readLimited(untar.stderr, 64 * 1024), untar.exited])
      if (untarCode !== 0) throw new Error(`Could not unpack the upload. Use a .tar.gz or .zip file. ${untarErr.trim() || `tar exited with ${untarCode}`}`)
    }
    assertNoLinks(dir)
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    throw error
  }
}

/** Pack a folder as .tar.gz in memory. `exclude` entries are tar patterns relative to the folder. */
export async function packFolder(dir: string, exclude: string[] = []): Promise<Blob> {
  const args = ['tar', '-czf', '-', ...exclude.map((pattern) => `--exclude=${pattern}`), '-C', dir, '.']
  const pack = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', env: TAR_ENV })
  const [bytes, errText, code] = await Promise.all([new Response(pack.stdout).arrayBuffer(), new Response(pack.stderr).text(), pack.exited])
  if (code !== 0) throw new Error(`Could not pack ${dir}: ${errText.trim()}`)
  return new Blob([bytes], { type: 'application/gzip' })
}

/**
 * Archives made by zipping a folder put everything under that folder. When
 * `marker` is missing at the top but sits inside the only folder, move that
 * folder's contents up. Returns the lifted folder's name.
 */
export function liftSingleFolder(dir: string, marker: string): string | null {
  if (existsSync(join(dir, marker))) return null
  const top = readdirSync(dir).filter((name) => !name.startsWith('.') && name !== '__MACOSX')
  if (top.length !== 1) return null
  const inner = join(dir, top[0]!)
  // lstat: a symlinked folder must never be followed, or its target's files
  // would be moved into the deployment.
  const stats = lstatSync(inner)
  if (stats.isSymbolicLink() || !stats.isDirectory() || !existsSync(join(inner, marker))) return null
  const temp = `${dir}.lift`
  rmSync(temp, { recursive: true, force: true })
  renameSync(inner, temp)
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true })
  for (const name of readdirSync(temp)) renameSync(join(temp, name), join(dir, name))
  rmdirSync(temp)
  return top[0]!
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
    private db: SqlDatabase,
    private config: Config,
    private functions: FunctionService,
  ) {}

  async get(functionId: string, id: string): Promise<DeploymentRow> {
    const row = await this.db.driver.get<DeploymentRow>('SELECT * FROM _deployments WHERE id = ? AND function_id = ?', [id, functionId])
    if (!row) throw err('deployment_not_found')
    return row
  }

  async list(functionId: string): Promise<DeploymentRow[]> {
    return this.db.driver.all<DeploymentRow>('SELECT * FROM _deployments WHERE function_id = ? ORDER BY seq DESC', [functionId])
  }

  /** The newest Git build of a branch, or of a fork's pull request when `pullRequest` is set. */
  async latestForBranch(functionId: string, branch: string, pullRequest = 0): Promise<DeploymentRow | null> {
    return pullRequest
      ? this.db.driver.get<DeploymentRow>(
          "SELECT * FROM _deployments WHERE function_id = ? AND type = 'vcs' AND provider_pull_request = ? ORDER BY seq DESC LIMIT 1",
          [functionId, pullRequest],
        )
      : this.db.driver.get<DeploymentRow>(
          "SELECT * FROM _deployments WHERE function_id = ? AND type = 'vcs' AND provider_pull_request = 0 AND provider_branch = ? ORDER BY seq DESC LIMIT 1",
          [functionId, branch],
        )
  }

  async latest(functionId: string): Promise<DeploymentRow | null> {
    return this.db.driver.get<DeploymentRow>('SELECT * FROM _deployments WHERE function_id = ? ORDER BY seq DESC LIMIT 1', [functionId])
  }

  /** Store one upload (or one chunk of it). The build starts once every chunk is in. */
  async upload(f: FunctionRow, input: UploadInput): Promise<DeploymentRow> {
    const bytes = new Uint8Array(await input.code.arrayBuffer())
    const { start, total } = chunkRange(input.contentRange, bytes.length)
    // The SDK may choose the deployment ID, but it is still a filename below:
    // `../../projects/x` must never become a path.
    if (input.uploadId && !isValidId(input.uploadId)) {
      throw err('general_argument_invalid', 'Invalid deployment ID.')
    }
    if (input.entrypoint && !isSafeRelativePath(input.entrypoint)) {
      throw err('general_argument_invalid', `Invalid entrypoint: ${input.entrypoint}`)
    }

    let row: DeploymentRow
    if (input.uploadId && total > bytes.length && start > 0) {
      row = await this.get(f.id, input.uploadId)
      if (row.status !== 'waiting') throw err('general_argument_invalid', 'This deployment has already been uploaded.')
    } else {
      const id = input.uploadId || uniqueId()
      const stamp = now()
      await this.db.driver.run(
        `INSERT INTO _deployments (id, function_id, entrypoint, commands, status, source_size, runtime, activate, chunks_total, chunks_uploaded, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?, 0, ?, ?)`,
        [id, f.id, input.entrypoint, input.commands, total, f.runtime, input.activate ? 1 : 0, chunksFor(total), stamp, stamp],
      )
      row = await this.get(f.id, id)
      mkdirSync(deploymentDir(this.config, f.id), { recursive: true })
    }

    writeChunk(this.archivePath(f.id, row.id), bytes, start)
    const counted = (await this.db.driver.get<{ chunks_uploaded: number }>(
      'UPDATE _deployments SET chunks_uploaded = chunks_uploaded + 1, updated_at = ? WHERE id = ? RETURNING chunks_uploaded',
      [now(), row.id],
    ))!
    if (counted.chunks_uploaded >= row.chunks_total) {
      await this.db.driver.run("UPDATE _deployments SET status = 'processing', updated_at = ? WHERE id = ?", [now(), row.id])
      this.build(f.id, row.id).catch((e) => console.error(`[functions] ${f.id}: build ${row.id} crashed`, e))
    }
    return this.get(f.id, row.id)
  }

  private archivePath(functionId: string, id: string) {
    const path = resolveInside(deploymentDir(this.config, functionId), `${id}.upload`)
    if (!path) throw err('general_argument_invalid', 'Invalid deployment ID.')
    return path
  }

  /** The deployment's code as uploaded, before its build command ran (`appwrite pull functions`). */
  private sourcePath(functionId: string, id: string) {
    const path = resolveInside(deploymentDir(this.config, functionId), `${id}.source.tar.gz`)
    if (!path) throw err('general_argument_invalid', 'Invalid deployment ID.')
    return path
  }

  /**
   * A .tar.gz of the deployment: its source as uploaded, or with `output` the
   * folder after the build. Deployments made before sources were kept fall
   * back to the built folder.
   */
  async download(functionId: string, id: string, type: 'source' | 'output' = 'source'): Promise<Blob> {
    await this.get(functionId, id)
    const source = this.sourcePath(functionId, id)
    if (type === 'source' && existsSync(source)) return Bun.file(source)
    const dir = deploymentDir(this.config, functionId, id)
    if (!existsSync(dir)) throw err('deployment_not_found', 'The code of this deployment is no longer kept on this server.')
    // An isolated function's folder is readable by its own user only, so pack it as that user.
    const sandbox = this.config.functionsSandbox
    if (!sandbox) return packFolder(dir)
    const pack = Bun.spawn(sandbox.wrap(sandbox.uidFor(this.config.projectId, functionId), dir, ['tar', '-czf', '-', '.']), {
      stdout: 'pipe',
      stderr: 'pipe',
      env: TAR_ENV,
    })
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
  async deployFiles(f: FunctionRow, input: FilesInput): Promise<DeploymentRow> {
    if (!input.files.length) throw err('general_argument_invalid', 'Add at least one file.')
    if (input.entrypoint && !isSafeRelativePath(input.entrypoint)) throw err('general_argument_invalid', `Invalid entrypoint: ${input.entrypoint}`)
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
    await this.db.driver.run(
      `INSERT INTO _deployments (id, function_id, entrypoint, commands, status, source_size, runtime, activate, chunks_total, chunks_uploaded, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'processing', ?, ?, ?, 1, 1, ?, ?)`,
      [id, f.id, input.entrypoint, input.commands, size, f.runtime, input.activate ? 1 : 0, stamp, stamp],
    )
    rmSync(dir, { recursive: true, force: true })
    for (const file of input.files) {
      const target = resolve(root, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.content)
    }
    this.build(f.id, id, { unpacked: true }).catch((e) => console.error(`[functions] ${f.id}: build ${id} crashed`, e))
    return this.get(f.id, id)
  }

  /**
   * A deployment of a Git commit. The caller writes the code into
   * deploymentDir(config, f.id, id) and then calls build(…, { unpacked: true }),
   * or fail() when the code could not be fetched.
   */
  async startGit(f: FunctionRow, source: DeploymentSource, activate: boolean): Promise<DeploymentRow> {
    const id = uniqueId()
    const stamp = now()
    await this.db.driver.run(
      `INSERT INTO _deployments (id, function_id, entrypoint, commands, status, source_size, runtime, activate, chunks_total, chunks_uploaded, ${SOURCE_COLUMNS}, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'processing', 0, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, f.id, f.entrypoint, f.commands, f.runtime, activate ? 1 : 0, ...sourceValues(source), stamp, stamp],
    )
    const dir = deploymentDir(this.config, f.id, id)
    removeTree(this.config.functionsSandbox, dir)
    mkdirSync(dir, { recursive: true })
    return this.get(f.id, id)
  }

  /** Mark a deployment failed before its build ran (the code could not be fetched). */
  async fail(functionId: string, id: string, message: string): Promise<DeploymentRow> {
    await this.db.driver.run("UPDATE _deployments SET status = 'failed', build_logs = ?, updated_at = ? WHERE id = ?", [message.slice(-MAX_LOG), now(), id])
    removeTree(this.config.functionsSandbox, deploymentDir(this.config, functionId, id))
    return this.get(functionId, id)
  }

  /** Record the size of code written straight into the folder. */
  async setSourceSize(id: string, bytes: number): Promise<void> {
    await this.db.driver.run('UPDATE _deployments SET source_size = ?, updated_at = ? WHERE id = ?', [bytes, now(), id])
  }

  /** Unpack, run the build command, and activate when asked. Sets status ready or failed. */
  async build(functionId: string, id: string, options: { unpacked?: boolean } = {}): Promise<DeploymentRow> {
    const started = performance.now()
    const archive = this.archivePath(functionId, id)
    const dir = deploymentDir(this.config, functionId, id)
    const logs: string[] = []
    const set = async (status: string) =>
      this.db.driver.run('UPDATE _deployments SET status = ?, build_logs = ?, build_duration = ?, updated_at = ? WHERE id = ?', [
        status,
        logs.join('\n').slice(-MAX_LOG),
        (performance.now() - started) / 1000,
        now(),
        id,
      ])
    try {
      await set('building')
      if (!options.unpacked) {
        removeTree(this.config.functionsSandbox, dir)
        mkdirSync(dir, { recursive: true })
        try {
          await unpackArchive(archive, dir)
        } finally {
          rmSync(archive, { force: true })
        }
      }

      const d = await this.get(functionId, id)
      const lifted = liftSingleFolder(dir, d.entrypoint)
      if (lifted) logs.push(`Using the "${lifted}" folder inside the upload as the function folder.`)
      if (!existsSync(join(dir, d.entrypoint))) {
        throw new Error(`Entrypoint "${d.entrypoint}" is not in the upload. Files at the top: ${readdirSync(dir).slice(0, 20).join(', ') || '(none)'}`)
      }
      await this.keepSource(functionId, id, dir)
      // From here on the folder belongs to the function's own user.
      const sandbox = this.config.functionsSandbox
      const uid = sandbox?.uidFor(this.config.projectId, functionId)
      if (sandbox && uid !== undefined) sandbox.adopt(dir, functionHome(this.config, functionId), uid)

      // Install the runtime now, so the first execution does not wait for a download.
      const runtime = isPython(d.runtime)
        ? null
        : await ensureRuntime(this.config, d.runtime, (line) => {
            logs.push(line)
            void set('building')
          })
      if (runtime?.version) logs.push(`Runtime: ${runtime.kind === 'node' ? 'Node.js' : 'Bun'} ${runtime.version}`)

      if (d.commands.trim() && !this.config.functionsBuildCommands) {
        logs.push(`Skipped the build command (FUNCTIONS_BUILD_COMMANDS=false): ${d.commands}`)
      } else if (d.commands.trim()) {
        logs.push(`$ ${d.commands}`)
        await set('building')
        const f = await this.functions.fn(functionId)
        const result = await runShell({
          command: d.commands,
          cwd: sandbox && uid !== undefined ? undefined : dir,
          wrap: sandbox && uid !== undefined ? (argv) => sandbox.wrap(uid, dir, argv) : undefined,
          // The build's group belongs to the function's user, so only the helper can signal it.
          signal: sandbox && uid !== undefined ? (pid, signal) => sandbox.signal(pid, signal) : undefined,
          // A build that goes live sees live values; one that does not (a Git preview) sees preview values.
          env: withRuntime(await this.buildEnv(f, dir, buildContext(d.activate)), runtime),
          timeoutMs: BUILD_TIMEOUT_MS,
        })
        logs.push(result.output)
        if (result.timedOut) throw new Error(`Build timed out after ${BUILD_TIMEOUT_MS / 60000} minutes.`)
        if (result.code !== 0) throw new Error(`Build command exited with code ${result.code}.`)
      }

      logs.push('Build ready.')
      await set('ready')
      if (d.activate) await this.activate(functionId, id)
    } catch (error) {
      logs.push(error instanceof Error ? error.message : String(error))
      await set('failed')
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
  private async buildEnv(f: FunctionRow, dir: string, context: DeployContext): Promise<Record<string, string>> {
    const env = await this.functions.env(f, 'build', context)
    env.PATH = [env.PATH, buildToolsDir(this.config)].filter(Boolean).join(':')
    if (this.config.functionsSandbox) env.HOME = env.TMPDIR = functionHome(this.config, f.id)
    if (f.runtime.startsWith('python')) {
      env.PIP_TARGET ??= join(dir, PYTHON_PACKAGES_DIR)
      env.PIP_DISABLE_PIP_VERSION_CHECK ??= '1'
    }
    return env
  }

  /** Make a built deployment the code that runs (functions.updateFunctionDeployment). */
  async activate(functionId: string, id: string): Promise<FunctionRow> {
    const d = await this.get(functionId, id)
    if (d.status !== 'ready') throw err('build_not_ready')
    await this.db.driver.run('UPDATE _functions SET deployment_id = ?, updated_at = ? WHERE id = ?', [id, now(), functionId])
    await this.prune(functionId)
    return this.functions.fn(functionId)
  }

  /** Delete a deployment that is not the active one. */
  async remove(functionId: string, id: string): Promise<void> {
    await this.get(functionId, id)
    if ((await this.functions.fn(functionId)).deployment_id === id)
      throw err('general_argument_invalid', 'The active deployment cannot be deleted. Activate another one first.')
    await this.removeStored(functionId, id)
  }

  /**
   * Delete several deployments at once. The active deployment and builds that
   * have not finished are kept. Returns what was removed and what was skipped.
   */
  async removeMany(functionId: string, ids: readonly string[]): Promise<{ removed: number; skipped: number }> {
    const active = (await this.functions.fn(functionId)).deployment_id
    let removed = 0
    let skipped = 0
    for (const id of new Set(ids)) {
      const deployment = await this.db.driver.get<{ status: string }>('SELECT status FROM _deployments WHERE id = ? AND function_id = ?', [id, functionId])
      if (!deployment || id === active || UNSETTLED.includes(deployment.status)) {
        skipped++
        continue
      }
      await this.removeStored(functionId, id)
      removed++
    }
    return { removed, skipped }
  }

  /** Delete a deployment's row, code and source archive. Callers check that it may be deleted. */
  private async removeStored(functionId: string, id: string): Promise<void> {
    await this.db.driver.run('DELETE FROM _deployments WHERE id = ? AND function_id = ?', [id, functionId])
    removeTree(this.config.functionsSandbox, deploymentDir(this.config, functionId, id))
    rmSync(this.archivePath(functionId, id), { force: true })
    rmSync(this.sourcePath(functionId, id), { force: true })
  }

  /** Delete non-active deployments older than each function's retention setting. */
  async pruneDeployments(): Promise<number> {
    let removed = 0
    for (const f of await this.functions.list()) removed += await this.pruneFunctionRetention(f)
    return removed
  }

  /** Apply one function's retention setting. */
  private async pruneFunctionRetention(f: FunctionRow): Promise<number> {
    if (f.deployment_retention <= 0) return 0
    const cutoff = addSeconds(-f.deployment_retention * 86400)
    const old = await this.db.driver.all<{ id: string }>(
      "SELECT id FROM _deployments WHERE function_id = ? AND id != ? AND status IN ('ready', 'failed') AND created_at < ?",
      [f.id, f.deployment_id, cutoff],
    )
    for (const { id } of old) await this.removeStored(f.id, id)
    return old.length
  }

  /** Keep disk use flat: drop the code of all but the active and the last few ready deployments, then apply retention. */
  async prune(functionId: string): Promise<void> {
    const f = await this.functions.fn(functionId)
    const active = f.deployment_id
    // Git builds of other branches (never made active) are pruned on their own, so they do not push out rollbacks.
    const preview = "type = 'vcs' AND activate = 0"
    const ready = await this.db.driver.all<{ id: string }>(
      `SELECT id FROM _deployments WHERE function_id = ? AND status = 'ready' AND id != ? AND NOT (${preview}) ORDER BY seq DESC`,
      [functionId, active],
    )
    const previews = await this.db.driver.all<{ id: string }>(
      `SELECT id FROM _deployments WHERE function_id = ? AND status = 'ready' AND id != ? AND ${preview} ORDER BY seq DESC`,
      [functionId, active],
    )
    for (const { id } of [...ready.slice(KEEP_PREVIOUS), ...previews.slice(KEEP_PREVIEWS)]) await this.removeStored(functionId, id)
    // Failed builds keep their source so it can be pulled and fixed; only the latest few.
    const failed = await this.db.driver.all<{ id: string }>("SELECT id FROM _deployments WHERE function_id = ? AND status = 'failed' ORDER BY seq DESC", [
      functionId,
    ])
    for (const { id } of failed.slice(KEEP_PREVIOUS)) rmSync(this.sourcePath(functionId, id), { force: true })
    await this.pruneFunctionRetention(f)
  }
}
