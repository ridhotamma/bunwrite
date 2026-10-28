/**
 * Guess how to build a repository folder, from the files GitHub lists and a
 * few of their contents: a site's framework (and so its adapter, commands and
 * runtime) or a function's runtime. Appwrite's createRepositoryDetection.
 */
import { DEFAULT_RUNTIME, NODE_RUNTIMES, SERVER_BUN } from '~/runtimes/catalog'
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
  buildRuntime: string
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
  engines?: { node?: string }
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

/**
 * The Node.js runtime for a version range such as `>=20`, `^22`, `22.x` or
 * an .nvmrc's `v24.1.0`: that line when it is offered, else the next newer
 * one. An open range (`>=18`) gets the default when that satisfies it.
 */
export function nodeRuntimeFor(spec: string): string | null {
  const match = /(\d+)/.exec(spec)
  if (!match) return null
  const want = Number(match[1])
  const target = /^\s*>/.test(spec) ? Math.max(want, Number(DEFAULT_RUNTIME.slice(5))) : want
  const lines = NODE_RUNTIMES.map((r) => Number(r.id.slice(5))).sort((a, b) => a - b)
  const line = lines.find((l) => l >= target) ?? lines.at(-1)!
  return `node-${line}`
}

/** The runtime a project asks for: Bun when it has Bun's lockfile, else its Node.js version, else the default. */
async function runtimeOf(files: string[], pkg: PackageJson | null, read: ReadFile): Promise<string> {
  if (packageManager(files) === 'bun') return SERVER_BUN
  for (const file of ['.nvmrc', '.node-version']) {
    if (!files.includes(file)) continue
    const found = nodeRuntimeFor((await read(file)) ?? '')
    if (found) return found
  }
  return (pkg?.engines?.node && nodeRuntimeFor(pkg.engines.node)) || DEFAULT_RUNTIME
}

/** The framework key, from the packages the app depends on. Order matters: meta-frameworks before the tools they use. */
async function frameworkKey(pkg: PackageJson, files: string[], read: ReadFile): Promise<string> {
  const deps = { ...pkg.devDependencies, ...pkg.dependencies }
  const has = (name: string) => name in deps
  if (has('next')) {
    // `output: 'export'` in next.config makes plain files.
    for (const file of ['next.config.js', 'next.config.mjs', 'next.config.ts']) {
      if (files.includes(file) && /output\s*:\s*['"]export['"]/.test((await read(file)) ?? '')) return 'next-static'
    }
    return 'nextjs'
  }
  if (has('nuxt')) return /nuxt generate/.test(pkg.scripts?.build ?? '') ? 'nuxt-static' : 'nuxt'
  if (has('@sveltejs/kit')) return has('@sveltejs/adapter-static') ? 'sveltekit-static' : 'sveltekit'
  if (has('astro')) return has('@astrojs/node') ? 'astro-ssr' : 'astro'
  if (has('@tanstack/react-start') || has('@tanstack/solid-start') || has('@tanstack/start')) return 'tanstack-start'
  if (has('@react-router/dev')) return 'react-router'
  if (has('@remix-run/node') || has('@remix-run/react') || has('@remix-run/dev')) return 'remix'
  if (has('@solidjs/start')) return 'solidstart'
  if (has('@analogjs/platform')) return 'analog'
  if (has('@angular/core')) return 'angular'
  if (has('@docusaurus/core')) return 'docusaurus'
  if (has('vitepress')) return 'vitepress'
  if (has('gatsby')) return 'gatsby'
  if (has('@11ty/eleventy')) return 'eleventy'
  if (has('hono')) return 'hono'
  if (has('express') || has('fastify') || has('koa') || has('@nestjs/core')) return 'node'
  if (has('vite')) {
    if (has('vue')) return 'vue'
    if (has('react')) return 'react'
    if (has('svelte')) return 'svelte'
    if (has('solid-js')) return 'solid'
    return 'vite'
  }
  if (files.includes('index.html')) return 'other'
  return pkg.scripts?.start ? 'node' : 'static-other'
}

/** A site's framework, commands and runtime. `files` are the names at the top of the folder. */
export async function detectFramework(files: string[], read: ReadFile): Promise<FrameworkDetection> {
  const pkg = files.includes('package.json') ? parse(await read('package.json')) : null
  if (!pkg) return { ...fromPreset(frameworkOf('other'), '', '', ''), buildRuntime: DEFAULT_RUNTIME }
  const preset = frameworkOf(await frameworkKey(pkg, files, read))
  const pm = packageManager(files)
  const scripts = pkg.scripts ?? {}
  // The project's own script wins over the preset's guess.
  const buildScript = preset.key === 'vitepress' && scripts['docs:build'] ? 'docs:build' : preset.key === 'nuxt-static' && scripts.generate ? 'generate' : scripts.build ? 'build' : ''
  const build = buildScript ? runFor(pm, buildScript) : preset.buildCommand
  const start = preset.startCommand === 'npm start' && scripts.start ? runFor(pm, 'start') : preset.startCommand
  return fromPreset(preset, installFor(pm, files), build, start, await runtimeOf(files, pkg, read))
}

function fromPreset(preset: SiteFramework, install: string, build: string, start = preset.startCommand, buildRuntime = DEFAULT_RUNTIME): FrameworkDetection {
  return {
    framework: preset.key,
    installCommand: install,
    buildCommand: build,
    outputDirectory: preset.outputDirectory,
    adapter: preset.adapter,
    startCommand: start,
    fallbackFile: preset.fallbackFile,
    buildRuntime,
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
  const entry = pkg?.main || (files.includes('index.js') ? 'index.js' : files.includes('main.js') ? 'main.js' : 'src/main.js')
  const hasDeps = Boolean(pkg && Object.keys({ ...pkg.dependencies }).length)
  return { runtime: await runtimeOf(files, pkg, read), entrypoint: entry, commands: hasDeps ? installFor(pm, files) : '' }
}
