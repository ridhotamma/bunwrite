/**
 * Loads sharp. A compiled Bun executable cannot load sharp's native addon from
 * its virtual filesystem, so the runtime packages are embedded as assets and
 * extracted under the data folder. A standalone binary resolves bare `require`
 * calls from its embedded modules rather than from that folder, so the
 * extracted files have their dependencies rewritten to relative paths.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Config } from '~/config'

type EmbeddedFile = Blob & { name: string }

const PREFIXES = [
  'sharp/',
  '@img/',
  'color/',
  'color-convert/',
  'color-name/',
  'color-string/',
  'is-arrayish/',
  'simple-swizzle/',
  'detect-libc/',
  'semver/',
]

/** Where sharp's CommonJS entry sits inside the extraction folder. */
const ENTRY = ['sharp', 'dist', 'index.cjs']

/** Bump when the extraction or patching changes, so a cached folder is rebuilt. */
const EXTRACT_VERSION = 2

let loaded: Promise<any> | null = null

function cacheDir(config: Config): string {
  const base = config.databasePath === ':memory:' ? join(tmpdir(), 'bunwrite') : dirname(resolve(config.databasePath))
  return join(base, '.runtimes', 'sharp')
}

/** Every file under `root`, including subdirectories. */
function walk(root: string): string[] {
  const paths: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) paths.push(...walk(path))
    else if (entry.isFile()) paths.push(path)
  }
  return paths
}

/** One entry of a package's `exports` map, taking the CommonJS condition. */
function exportedValue(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return null
  const conditions = value as Record<string, unknown>
  for (const key of ['require', 'node', 'default', 'import']) {
    const found = exportedValue(conditions[key])
    if (found) return found
  }
  return null
}

/** The file a package `exports` map points at for `key` ('.' or './sub'). */
function exportsTarget(exports: unknown, key: string): string | null {
  if (typeof exports === 'string') return key === '.' ? exports : null
  if (!exports || typeof exports !== 'object') return null
  const map = exports as Record<string, unknown>
  if (key in map) return exportedValue(map[key])
  return exportedValue(map)
}

/** `candidate`, or the extension/index a CommonJS require would try. */
function asFile(candidate: string): string | null {
  for (const path of [candidate, `${candidate}.js`, `${candidate}.json`, `${candidate}.cjs`, join(candidate, 'index.js'), join(candidate, 'index.cjs')]) {
    if (existsSync(path) && statSync(path).isFile()) return path
  }
  return null
}

/**
 * Resolve a bare specifier against the extracted `node_modules`. Bun's own
 * resolver inside a standalone binary only knows the compiled module graph, so
 * packages like `detect-libc` cannot be found there even though they are on disk.
 */
function resolveDependency(specifier: string, nodeModules: string): string | null {
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
  const subpath = specifier.slice(name.length).replace(/^\//, '')
  const root = join(nodeModules, name)
  if (!existsSync(root)) return null
  let pkg: { main?: unknown; exports?: unknown } = {}
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    /* a package without a manifest resolves by plain file path */
  }
  const key = subpath ? `./${subpath}` : '.'
  const exported = exportsTarget(pkg.exports, key)
  if (exported) {
    const target = asFile(join(root, exported))
    if (target) return target
  }
  const main = subpath || (typeof pkg.main === 'string' ? pkg.main : 'index.js')
  return asFile(join(root, main))
}

/**
 * A standalone binary resolves a bare `require` from the modules compiled into
 * it, not from the extracted folder, so dependencies such as `detect-libc`,
 * `semver` and `@img/sharp-<platform>` are pointed at their file by relative
 * path. Builtins and unresolvable optional packages are left alone.
 */
function patchRequires(nodeModules: string): void {
  for (const file of walk(nodeModules)) {
    if (!/\.(c|m)?js$/.test(file)) continue
    const source = readFileSync(file, 'utf8')
    if (!source.includes('require(')) continue
    const patched = source.replace(/require\((['"])([^'"]+)\1\)/g, (match, quote: string, specifier: string) => {
      if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return match
      const target = resolveDependency(specifier, nodeModules)
      if (!target) return match
      const rel = relative(dirname(file), target).replaceAll('\\', '/')
      return `require(${quote}${rel.startsWith('.') ? rel : `./${rel}`}${quote})`
    })
    if (patched !== source) writeFileSync(file, patched)
  }
}

async function extractSharp(config: Config): Promise<string> {
  const dir = cacheDir(config)
  const files = Bun.embeddedFiles.filter((file) => PREFIXES.some((prefix) => (file as EmbeddedFile).name.startsWith(prefix))) as EmbeddedFile[]
  if (files.length === 0) throw new Error('sharp runtime assets are missing from this build')
  const version = `${EXTRACT_VERSION}:${Bun.version}:${files.length}:${files.reduce((size, file) => size + file.size, 0)}`
  const marker = join(dir, '.complete')
  const entry = join(dir, 'node_modules', ...ENTRY)
  if (existsSync(marker) && readFileSync(marker, 'utf8') === version && existsSync(entry)) return dir

  rmSync(dir, { recursive: true, force: true })
  for (const file of files) {
    const dest = join(dir, 'node_modules', file.name)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, Buffer.from(await file.arrayBuffer()))
  }
  patchRequires(join(dir, 'node_modules'))
  if (!existsSync(entry)) throw new Error('the embedded sharp package has an unexpected layout')
  writeFileSync(marker, version)
  return dir
}

/**
 * Optional limits for small hosts. libvips sizes its thread pool from the host's
 * CPU count, which ignores container CPU limits.
 */
function tune(sharp: any): any {
  const threads = Number(process.env.SHARP_CONCURRENCY)
  if (Number.isInteger(threads) && threads > 0) sharp.concurrency(threads)
  const cacheMb = process.env.SHARP_CACHE_MB
  if (cacheMb !== undefined && cacheMb !== '' && Number(cacheMb) >= 0) {
    sharp.cache(Number(cacheMb) === 0 ? false : { memory: Number(cacheMb) })
  }
  return sharp
}

export function loadSharp(config: Config): Promise<any> {
  if (!loaded) {
    loaded = (async () => {
      if (!Bun.isStandaloneExecutable) {
        const specifier = 'sharp'
        return tune((await import(specifier)).default)
      }
      const dir = await extractSharp(config)
      return tune((await import(pathToFileURL(join(dir, 'node_modules', ...ENTRY)).href)).default)
    })().catch((error) => {
      loaded = null
      throw error
    })
  }
  return loaded
}
