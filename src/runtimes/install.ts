/**
 * Node.js and Bun builds for sites and functions, downloaded the first time a
 * runtime is needed and kept in `<data>/.runtimes/<id>/<version>/`:
 *
 * - Node.js: the newest `v<major>.x` from the mirror's index.json, as the
 *   official .tar.gz, checked against that release's SHASUMS256.txt.
 * - Bun: the newest `bun-v<major>.<minor>.x` GitHub release, as the official
 *   .zip, checked against the release's SHASUMS256.txt. Its `bin` also gets
 *   `node`, `npm`, `npx` and `bunx` commands that run through that Bun.
 *
 * The first version installed for a runtime is kept until it is removed, so
 * builds stay the same and work offline. The Bun line this server runs on, an
 * empty runtime (deployments made before runtimes were real) and Python use
 * what is already here.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Config } from '~/config'
import { bunShims, buildToolsDir, runtimesRoot, writeShims } from '~/functions/runtime'
import { allowPassThrough } from '~/functions/sandbox'
import { extractZip } from '~/functions/zip'
import { parseRuntime, runtimeLabel, SERVER_BUN_LINE } from './catalog'

/**
 * Where a runtime's commands are, put first on PATH. For the server's own Bun
 * that is its shims folder (`bun`, and `node`/`npm`/`npx` through Bun), so a
 * `node` installed on the host does not take over. `bin` is null for Python
 * and for deployments made before runtimes were real: PATH stays as it was.
 */
export interface ResolvedRuntime {
  id: string
  kind: 'node' | 'bun' | 'python'
  bin: string | null
  /** The exact version, such as 22.14.0; empty for the server's Bun or Python. */
  version: string
}

export interface RuntimesConfig {
  /** Download Node.js and Bun builds (RUNTIMES_DOWNLOAD). Off: they run on the server's Bun. */
  download: boolean
  /** Node.js dist mirror (RUNTIMES_NODE_MIRROR). */
  nodeMirror: string
  /** Bun's releases, as the GitHub releases API lists them (RUNTIMES_BUN_RELEASES). */
  bunReleases: string
}

export const DEFAULT_RUNTIMES: RuntimesConfig = {
  download: true,
  nodeMirror: 'https://nodejs.org/dist',
  bunReleases: 'https://api.github.com/repos/oven-sh/bun/releases?per_page=100',
}

const installing = new Map<string, Promise<ResolvedRuntime>>()

const exe = (kind: 'node' | 'bun') => (kind === 'node' ? 'node' : 'bun')

const platform = (): { os: 'linux' | 'darwin'; arch: 'x64' | 'arm64' } => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error(`Downloading runtimes is not supported on ${process.platform}.`)
  if (process.arch !== 'x64' && process.arch !== 'arm64') throw new Error(`Downloading runtimes is not supported on ${process.arch}.`)
  return { os: process.platform, arch: process.arch }
}

/** Nothing to install: PATH as it is (Python, or no runtime set). */
const asIs = (id: string, kind: ResolvedRuntime['kind']): ResolvedRuntime => ({ id, kind, bin: null, version: '' })

/** The server's own Bun, with its shims first on PATH. */
const serverBun = (config: Config, id: string): ResolvedRuntime => ({ id, kind: 'bun', bin: buildToolsDir(config), version: '' })

/** The runtime when it is already on disk, without network. Null when it still needs installing. */
export function installedRuntime(config: Config, id: string): ResolvedRuntime | null {
  const parsed = id ? parseRuntime(id) : null
  if (!parsed) return asIs(id, 'bun')
  if (parsed.kind === 'python') return asIs(id, 'python')
  if (parsed.kind === 'bun' && parsed.line === SERVER_BUN_LINE) return serverBun(config, id)
  if (!config.runtimes.download) return serverBun(config, id)
  const dir = join(runtimesRoot(config), id)
  let version = ''
  try {
    version = readFileSync(join(dir, 'current'), 'utf8').trim()
  } catch {
    return null
  }
  const bin = join(dir, version, 'bin')
  return existsSync(join(bin, exe(parsed.kind))) ? { id, kind: parsed.kind, bin, version } : null
}

/** The runtime, installing it first when it is not on disk yet. `log` gets a line for each step. */
export async function ensureRuntime(config: Config, id: string, log: (line: string) => void = () => {}): Promise<ResolvedRuntime> {
  const parsed = id ? parseRuntime(id) : null
  if (parsed && (parsed.kind === 'node' || (parsed.kind === 'bun' && parsed.line !== SERVER_BUN_LINE)) && !config.runtimes.download) {
    log(`RUNTIMES_DOWNLOAD=false: running on this server's Bun ${process.versions.bun} instead of ${runtimeLabel(id)}.`)
  }
  const ready = installedRuntime(config, id)
  if (ready) return ready
  const key = join(runtimesRoot(config), id)
  let pending = installing.get(key)
  if (!pending) {
    pending = install(config, id, parsed as { kind: 'node' | 'bun'; line: string }, log).finally(() => installing.delete(key))
    installing.set(key, pending)
  } else {
    log(`Waiting for ${runtimeLabel(id)} to finish installing…`)
  }
  return pending
}

async function install(config: Config, id: string, parsed: { kind: 'node' | 'bun'; line: string }, log: (line: string) => void): Promise<ResolvedRuntime> {
  const { os, arch } = platform()
  const root = join(runtimesRoot(config), id)
  mkdirSync(root, { recursive: true })
  const found = parsed.kind === 'node' ? await findNode(config, parsed.line, os, arch) : await findBun(config, parsed.line, os, arch)
  log(`Installing ${parsed.kind === 'node' ? 'Node.js' : 'Bun'} ${found.version} (first use of ${id})…`)

  const bytes = await download(found.url)
  const sum = createHash('sha256').update(bytes).digest('hex')
  if (sum !== found.sha256) throw new Error(`The download of ${found.file} does not match its published checksum, so it was not installed.`)

  const target = join(root, found.version)
  const work = `${target}.partial`
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  try {
    if (parsed.kind === 'node') {
      const archive = `${work}.tar.gz`
      writeFileSync(archive, bytes)
      try {
        const tar = Bun.spawnSync(['tar', '-xzf', archive, '-C', work, '--strip-components=1'], { stderr: 'pipe' })
        if (tar.exitCode !== 0) throw new Error(`Could not unpack ${found.file}: ${tar.stderr.toString().trim()}`)
      } finally {
        rmSync(archive, { force: true })
      }
    } else {
      const unpacked = join(work, 'unpacked')
      extractZip(bytes, unpacked)
      const binary = findFile(unpacked, 'bun')
      if (!binary) throw new Error(`${found.file} has no bun binary in it.`)
      mkdirSync(join(work, 'bin'), { recursive: true })
      renameSync(binary, join(work, 'bin', 'bun'))
      chmodSync(join(work, 'bin', 'bun'), 0o755)
      rmSync(unpacked, { recursive: true, force: true })
    }
    if (!existsSync(join(work, 'bin', exe(parsed.kind)))) throw new Error(`${found.file} does not have bin/${exe(parsed.kind)} where it should be, so it was not installed.`)
    rmSync(target, { recursive: true, force: true })
    renameSync(work, target)
  } catch (error) {
    rmSync(work, { recursive: true, force: true })
    throw error
  }
  const bin = join(target, 'bin')
  if (parsed.kind === 'bun') {
    const bun = `exec '${join(bin, 'bun')}'`
    writeShims(config, bin, bunShims(bun))
  }
  share(config, target)
  writeFileSync(join(root, 'current'), `${found.version}\n`)
  log(`Installed ${parsed.kind === 'node' ? 'Node.js' : 'Bun'} ${found.version}.`)
  return { id, kind: parsed.kind, bin, version: found.version }
}

interface Found {
  version: string
  file: string
  url: string
  sha256: string
}

async function findNode(config: Config, major: string, os: string, arch: string): Promise<Found> {
  const mirror = config.runtimes.nodeMirror.replace(/\/+$/, '')
  const index = (await fetchJson(`${mirror}/index.json`)) as { version: string }[]
  const tag = index.map((e) => e.version).find((v) => v.startsWith(`v${major}.`))
  if (!tag) throw new Error(`Node.js ${major} is not on ${mirror}.`)
  const file = `node-${tag}-${os}-${arch}.tar.gz`
  const sums = await fetchText(`${mirror}/${tag}/SHASUMS256.txt`)
  return { version: tag.slice(1), file, url: `${mirror}/${tag}/${file}`, sha256: checksumOf(sums, file) }
}

interface Release {
  tag_name: string
  assets: { name: string; browser_download_url: string }[]
}

async function findBun(config: Config, line: string, os: string, arch: string): Promise<Found> {
  const releases = (await fetchJson(config.runtimes.bunReleases)) as Release[]
  const newest = releases
    .map((r) => ({ r, m: /^bun-v(\d+)\.(\d+)\.(\d+)$/.exec(r.tag_name) }))
    .filter((x) => x.m && `${x.m[1]}.${x.m[2]}` === line)
    .sort((a, b) => Number(b.m![3]) - Number(a.m![3]))[0]
  if (!newest) throw new Error(`Bun ${line} is not in the Bun releases.`)
  const file = `bun-${os}-${arch === 'arm64' ? 'aarch64' : 'x64'}.zip`
  const asset = newest.r.assets.find((a) => a.name === file)
  const sumsAsset = newest.r.assets.find((a) => a.name === 'SHASUMS256.txt')
  if (!asset || !sumsAsset) throw new Error(`Bun ${newest.r.tag_name} has no ${file} or SHASUMS256.txt.`)
  const sums = await fetchText(sumsAsset.browser_download_url)
  return { version: newest.r.tag_name.replace(/^bun-v/, ''), file, url: asset.browser_download_url, sha256: checksumOf(sums, file) }
}

function checksumOf(sums: string, file: string): string {
  const line = sums.split('\n').find((l) => l.trim().split(/\s+/)[1]?.replace(/^\*/, '') === file)
  const sum = line?.trim().split(/\s+/)[0]
  if (!sum || !/^[0-9a-f]{64}$/.test(sum)) throw new Error(`No published checksum for ${file}.`)
  return sum
}

async function request(url: string): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, { headers: { 'user-agent': 'bunwrite', accept: '*/*' } })
  } catch (error) {
    throw new Error(`Could not reach ${new URL(url).host} to download a runtime (${error instanceof Error ? error.message : String(error)}). Set RUNTIMES_DOWNLOAD=false to use this server's Bun instead.`)
  }
  if (!res.ok) throw new Error(`${url} answered ${res.status}.`)
  return res
}

const fetchJson = async (url: string) => (await request(url)).json() as Promise<unknown>
const fetchText = async (url: string) => (await request(url)).text()
const download = async (url: string) => new Uint8Array(await (await request(url)).arrayBuffer())

/** The first file named `name` under `dir`. */
function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return path
    if (entry.isDirectory()) {
      const inner = findFile(path, name)
      if (inner) return inner
    }
  }
  return null
}

/** Isolated sites and functions run as their own users: let them read and run the runtime. */
function share(config: Config, dir: string): void {
  Bun.spawnSync(['chmod', '-R', 'a+rX', dir])
  if (config.functionsSandbox) allowPassThrough(config.functionsSandbox.root, dir)
}

/** Installed runtimes and their size on disk, for the console. */
export function installedRuntimes(config: Config): { id: string; version: string; bytes: number }[] {
  const root = runtimesRoot(config)
  if (!existsSync(root)) return []
  const out: { id: string; version: string; bytes: number }[] = []
  for (const id of readdirSync(root)) {
    const runtime = installedRuntime(config, id)
    if (!runtime?.bin || !runtime.version) continue
    out.push({ id, version: runtime.version, bytes: sizeOf(join(root, id)) })
  }
  return out
}

function sizeOf(path: string): number {
  const st = lstatSync(path)
  if (!st.isDirectory()) return st.size
  return readdirSync(path).reduce((total, name) => total + sizeOf(join(path, name)), 0)
}

/** `env` with the runtime's commands first on PATH. */
export function withRuntime(env: Record<string, string>, runtime: ResolvedRuntime | null): Record<string, string> {
  if (runtime?.bin) env.PATH = [runtime.bin, env.PATH].filter(Boolean).join(':')
  return env
}
