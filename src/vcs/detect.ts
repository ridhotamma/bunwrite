/**
 * Guess how to build a repository folder, from the files GitHub lists and a
 * few of their contents: a site's framework (and so its adapter and commands)
 * or a function's runtime. Appwrite's createRepositoryDetection.
 */
import { frameworkOf, type SiteFramework } from '~/sites/frameworks'

/** Reads a file in the folder being detected; null when it is not there. */
export type ReadFile = (path: string) => Promise<string | null>

export interface FrameworkDetection {
  framework: string
  installCommand: string
  buildCommand: string
  outputDirectory: string
  // Bunwrite: the rest of what a site needs.
  adapter: string
  startCommand: string
  fallbackFile: string
}

export interface RuntimeDetection {
  runtime: string
  entrypoint: string
  commands: string
}

interface PackageJson {
  main?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const parse = (text: string | null): PackageJson | null => {
  if (!text) return null
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' ? (value as PackageJson) : null
  } catch {
    return null
  }
}

/** The package manager the lockfile belongs to. */
export function packageManager(files: string[]): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm'
  if (files.includes('bun.lock') || files.includes('bun.lockb')) return 'bun'
  if (files.includes('yarn.lock')) return 'yarn'
  return 'npm'
}

const installFor = (pm: string, files: string[]) =>
  pm === 'npm' ? (files.includes('package-lock.json') ? 'npm ci' : 'npm install') : `${pm} install`

const runFor = (pm: string, script: string) => (pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`)

/** The framework key, from the packages the app depends on. */
function frameworkKey(pkg: PackageJson, files: string[]): string {
  const deps = { ...pkg.devDependencies, ...pkg.dependencies }
  const has = (name: string) => name in deps
  if (has('next')) return 'nextjs'
  if (has('nuxt')) return 'nuxt'
  if (has('@sveltejs/kit')) return has('@sveltejs/adapter-static') ? 'svelte' : 'sveltekit'
  if (has('astro')) return has('@astrojs/node') ? 'astro-ssr' : 'astro'
  if (has('@remix-run/node') || has('@remix-run/react') || has('@react-router/dev')) return 'remix'
  if (has('@angular/core')) return 'angular'
  if (has('hono')) return 'hono'
  if (has('vite')) {
    if (has('vue')) return 'vue'
    if (has('react')) return 'react'
    if (has('svelte')) return 'svelte'
    return 'vite'
  }
  return files.includes('index.html') ? 'other' : 'vite'
}

/** A site's framework and commands. `files` are the names at the top of the folder. */
export async function detectFramework(files: string[], read: ReadFile): Promise<FrameworkDetection> {
  const pkg = files.includes('package.json') ? parse(await read('package.json')) : null
  if (!pkg) {
    const plain = frameworkOf('other')
    return fromPreset(plain, '', '')
  }
  const preset = frameworkOf(frameworkKey(pkg, files))
  const pm = packageManager(files)
  const install = installFor(pm, files)
  const build = pkg.scripts?.build ? runFor(pm, 'build') : ''
  // Hono and plain Bun apps start with their own `start` script.
  if (preset.key === 'hono') return { ...fromPreset(preset, install, build), startCommand: pkg.scripts?.start ? runFor(pm, 'start') : preset.startCommand }
  return fromPreset(preset, install, build)
}

function fromPreset(preset: SiteFramework, install: string, build: string): FrameworkDetection {
  return {
    framework: preset.key,
    installCommand: install,
    buildCommand: build,
    outputDirectory: preset.outputDirectory,
    adapter: preset.adapter,
    startCommand: preset.startCommand,
    fallbackFile: preset.fallbackFile,
  }
}

/** A function's runtime, entry file and build command. */
export async function detectRuntime(files: string[], read: ReadFile): Promise<RuntimeDetection> {
  if (files.includes('requirements.txt') || files.includes('main.py') || files.includes('pyproject.toml')) {
    const entry = files.includes('main.py') ? 'main.py' : 'src/main.py'
    return { runtime: 'python-3.12', entrypoint: entry, commands: files.includes('requirements.txt') ? 'pip install -r requirements.txt' : '' }
  }
  const pkg = files.includes('package.json') ? parse(await read('package.json')) : null
  const pm = packageManager(files)
  const runtime = pm === 'bun' ? 'bun-1.1' : 'node-22'
  const entry = pkg?.main || (files.includes('index.js') ? 'index.js' : files.includes('main.js') ? 'main.js' : 'src/main.js')
  const hasDeps = Boolean(pkg && Object.keys({ ...pkg.dependencies }).length)
  return { runtime, entrypoint: entry, commands: hasDeps ? installFor(pm, files) : '' }
}
