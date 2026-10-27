/**
 * Loads sharp. A compiled Bun executable cannot load sharp's native addon from
 * its virtual filesystem, so the runtime packages are embedded as assets and
 * extracted under the data folder. The extracted sharp is patched to load
 * detect-libc by path and the native addon from the extraction directory.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

let loaded: Promise<any> | null = null

function cacheDir(config: Config): string {
  const base = config.databasePath === ':memory:' ? join(tmpdir(), 'bunwrite') : dirname(resolve(config.databasePath))
  return join(base, '.runtimes', 'sharp')
}

function addonPath(dir: string): string {
  return join(
    dir,
    'node_modules',
    'sharp',
    'node_modules',
    '@img',
    `sharp-${process.platform}-${process.arch}`,
    'lib',
    `sharp-${process.platform}-${process.arch}.node`,
  )
}

function patchSharp(lib: string): void {
  const nested = join(lib, 'detect-libc')
  cpSync(join(lib, '..', 'node_modules', 'detect-libc'), nested, { recursive: true })
  for (const name of ['sharp.js', 'libvips.js', 'utility.js']) {
    const file = join(lib, name)
    let source = readFileSync(file, 'utf8')
    source = source.replaceAll("require('detect-libc')", "require('./detect-libc/lib/detect-libc.js')")
    if (name === 'sharp.js') {
      if (!source.includes('const paths = [')) throw new Error('unsupported sharp release')
      source = source.replace('const paths = [', 'const paths = [\n  process.env.BUNWRITE_SHARP_ADDON,')
    }
    writeFileSync(file, source)
  }
}

async function extractSharp(config: Config): Promise<string> {
  const dir = cacheDir(config)
  const files = Bun.embeddedFiles.filter((file) => PREFIXES.some((prefix) => (file as EmbeddedFile).name.startsWith(prefix))) as EmbeddedFile[]
  if (files.length === 0) throw new Error('sharp runtime assets are missing from this build')
  const version = `${Bun.version}:${files.length}:${files.reduce((size, file) => size + file.size, 0)}`
  const marker = join(dir, '.complete')
  if (
    existsSync(marker) &&
    readFileSync(marker, 'utf8') === version &&
    existsSync(join(dir, 'node_modules', 'sharp', 'lib', 'index.js')) &&
    existsSync(addonPath(dir))
  ) {
    process.env.BUNWRITE_SHARP_ADDON = addonPath(dir)
    return dir
  }

  rmSync(dir, { recursive: true, force: true })
  for (const file of files) {
    const dest = file.name.startsWith('sharp/')
      ? join(dir, 'node_modules', file.name)
      : join(dir, 'node_modules', 'sharp', 'node_modules', file.name)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, Buffer.from(await file.arrayBuffer()))
  }
  patchSharp(join(dir, 'node_modules', 'sharp', 'lib'))
  process.env.BUNWRITE_SHARP_ADDON = addonPath(dir)
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
      return tune((await import(pathToFileURL(join(dir, 'node_modules', 'sharp', 'lib', 'index.js')).href)).default)
    })().catch((error) => {
      loaded = null
      throw error
    })
  }
  return loaded
}
