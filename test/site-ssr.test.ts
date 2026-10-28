import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { ConsoleAuth } from '~/console/auth'
import { configFromEnv } from '~/config'
import type { SiteDeploymentRow, SiteSettings } from '~/sites/service'
import { KEY, PROJECT, startServer, testSchema, type TestServer } from './helpers'

let dir: string
let server: TestServer

/** Pack `files` into a .tar.gz, the way `bunwrite push sites` does. */
function archive(files: Record<string, string>): Blob {
  const src = mkdtempSync(join(dir, 'src-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(src, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  const out = join(src, '..', `${Math.random().toString(36).slice(2)}.tar.gz`)
  const tar = Bun.spawnSync(['tar', '-czf', out, '-C', src, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString())
  return new Blob([readFileSync(out)], { type: 'application/gzip' })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until<T>(what: string, fn: () => T | Promise<T>, ok: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await sleep(50)
  }
}

const settings = (over: Partial<SiteSettings> = {}): SiteSettings => ({
  name: 'App',
  enabled: true,
  framework: 'other',
  outputDirectory: '',
  fallbackFile: '',
  domains: [],
  apiFunctionId: '',
  installCommand: '',
  buildCommand: '',
  startCommand: 'bun server.js',
  buildRuntime: '',
  adapter: 'ssr',
  ...over,
})

function createSite(id: string, over: Partial<SiteSettings> = {}) {
  return server.services.sites.create(id, settings(over))
}

async function deploy(siteId: string, files: Record<string, string>, activate = true): Promise<SiteDeploymentRow> {
  const first = await server.services.sites.upload(server.services.sites.site(siteId), {
    code: archive(files),
    activate,
    contentRange: null,
    uploadId: null,
  })
  return until(`deployment ${first.id}`, () => server.services.sites.deployment(siteId, first.id), (d) => d.status === 'ready' || d.status === 'failed')
}

const base = () => server.endpoint.replace(/\/v1$/, '')

const visit = (path: string, init: RequestInit & { site?: string } = {}) => {
  const { site = 'app', ...rest } = init
  return fetch(`http://127.0.0.1:${server.config.port}${path}`, {
    ...rest,
    headers: { ...(rest.headers as Record<string, string>), host: `${site}.sites.localhost:${server.config.port}` },
    redirect: 'manual',
  })
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${server.endpoint}${path}`, {
    ...init,
    headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  })

/** An app that echoes what it receives, plus a few endpoints the tests probe. */
const APP = `const port = Number(process.env.PORT)
const marker = process.argv[2] || 'none'
Bun.serve({
  hostname: process.env.HOST || '127.0.0.1',
  port,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/marker') return new Response(marker)
    if (url.pathname === '/files') {
      const fs = require('node:fs')
      return Response.json({
        installed: fs.existsSync('installed.txt'),
        built: fs.existsSync('built.txt'),
      })
    }
    if (url.pathname === '/boom') return new Response('boom', { status: 500, headers: { 'x-upstream': 'boom' } })
    if (url.pathname === '/cookies') {
      const headers = new Headers()
      headers.append('set-cookie', 'a=1; Path=/')
      headers.append('set-cookie', 'b=2; Path=/')
      return new Response('ok', { headers })
    }
    if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: '/after' } })
    if (url.pathname === '/exit') {
      setTimeout(() => process.exit(3), 30)
      return new Response('bye')
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.text()
    return Response.json({
      path: url.pathname,
      search: url.search,
      method: req.method,
      body,
      host: req.headers.get('x-forwarded-host'),
      proto: req.headers.get('x-forwarded-proto'),
      cookie: req.headers.get('cookie'),
    }, { headers: { 'x-upstream': 'yes' } })
  },
})
`

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bunwrite-site-ssr-'))
  mkdirSync(join(dir, 'functions', 'renderer'), { recursive: true })
  writeFileSync(
    join(dir, 'functions', 'renderer', 'main.js'),
    `module.exports = async ({ req, res }) => res.json({ mode: 'function', method: req.method, path: req.path, query: req.query })`,
  )
  const schema = {
    ...testSchema,
    functions: [{ $id: 'renderer', name: 'Renderer', runtime: 'node-22', entrypoint: 'main.js', path: 'functions/renderer', execute: ['any'], timeout: 15 }],
  }
  server = startServer(schema, { sitesSsrIdleMs: 5 * 60 * 1000, sitesSsrMaxProcesses: 2 }, dir)
})

afterAll(() => {
  for (const site of server.services.sites.list()) server.services.sites.remove(site.id)
  server.services.sites.stop()
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('SSR sites: API and frameworks', () => {
  test('SSR settings come from the environment', () => {
    const defaults = configFromEnv({})
    expect(defaults.sitesSsr).toBe(true)
    expect(defaults.sitesBuildCommands).toBe(true)
    expect(defaults.sitesSsrIdleMs).toBe(5 * 60 * 1000)
    expect(defaults.sitesSsrMaxProcesses).toBe(2)
    const off = configFromEnv({
      SITES_SSR: 'false',
      SITES_BUILD_COMMANDS: 'false',
      SITES_SSR_IDLE_MS: '0',
      SITES_SSR_MAX_PROCESSES: '3',
    })
    expect(off.sitesSsr).toBe(false)
    expect(off.sitesBuildCommands).toBe(false)
    expect(off.sitesSsrIdleMs).toBe(0)
    expect(off.sitesSsrMaxProcesses).toBe(3)
  })

  test('frameworks expose SSR adapters with their defaults', async () => {
    const res = await api('/sites/frameworks')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const next = body.frameworks.find((f: any) => f.key === 'nextjs')
    expect(next.adapters[0]).toMatchObject({
      key: 'ssr',
      installCommand: 'npm install',
      buildCommand: 'npm run build',
      startCommand: 'node .next/standalone/server.js',
    })
    expect(body.frameworks.find((f: any) => f.key === 'vite').adapters[0].key).toBe('static')
  })

  test('a framework preset sets the adapter, commands and start command', async () => {
    const res = await api('/sites', {
      method: 'POST',
      body: JSON.stringify({ siteId: 'preset', name: 'Preset', framework: 'nuxt', buildRuntime: 'node-22' }),
    })
    expect(res.status).toBe(201)
    const site = (await res.json()) as any
    expect(site.adapter).toBe('ssr')
    expect(site.installCommand).toBe('npm install')
    expect(site.buildCommand).toBe('npm run build')
    expect(site.startCommand).toBe('node .output/server/index.mjs')
    server.services.sites.remove('preset')
  })

  test('startCommand can be set and updated through the API', async () => {
    const created = (await (
      await api('/sites', {
        method: 'POST',
        body: JSON.stringify({ siteId: 'api-ssr', name: 'API SSR', adapter: 'ssr', startCommand: 'bun app.js' }),
      })
    ).json()) as any
    expect(created.startCommand).toBe('bun app.js')
    const updated = (await (
      await api('/sites/api-ssr', { method: 'PUT', body: JSON.stringify({ startCommand: 'bun other.js' }) })
    ).json()) as any
    expect(updated.startCommand).toBe('bun other.js')
    server.services.sites.remove('api-ssr')
  })

  test('an unknown adapter is rejected', async () => {
    const res = await api('/sites', { method: 'POST', body: JSON.stringify({ siteId: 'bad-adapter', name: 'Bad', adapter: 'docker' }) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.message).toContain('Adapter must be one of')
  })
})

describe('SSR sites: build and serve', () => {
  test('builds the upload, then proxies methods, headers, cookies and status', async () => {
    createSite('app', {
      name: 'App',
      installCommand: 'echo installed > installed.txt',
      buildCommand: 'echo built > built.txt',
    })
    const d = await deploy('app', { 'server.js': APP })
    expect(d.status).toBe('ready')
    expect(d.start_command).toBe('bun server.js')
    expect(d.build_logs).toContain('$ echo installed > installed.txt')
    expect(d.build_logs).toContain('$ echo built > built.txt')
    expect(d.build_logs).toContain('Start command: bun server.js')
    expect(d.file_count).toBeGreaterThan(0)
    expect(d.total_size).toBeGreaterThan(0)

    const files = await (await visit('/files')).json()
    expect(files).toEqual({ installed: true, built: true })

    const echo = await visit('/hello?a=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=abc' },
      body: JSON.stringify({ x: 1 }),
    })
    expect(echo.status).toBe(200)
    expect(echo.headers.get('x-upstream')).toBe('yes')
    expect(await echo.json()).toEqual({
      path: '/hello',
      search: '?a=1',
      method: 'POST',
      body: '{"x":1}',
      host: `app.sites.localhost:${server.config.port}`,
      proto: 'http',
      cookie: 'session=abc',
    })

    const boom = await visit('/boom')
    expect(boom.status).toBe(500)
    expect(await boom.text()).toBe('boom')

    const forwarded = await visit('/forwarded', {
      headers: { 'x-forwarded-host': 'www.example.com', 'x-forwarded-proto': 'https' },
    })
    expect(await forwarded.json()).toMatchObject({ path: '/forwarded', host: 'www.example.com', proto: 'https' })

    const redirect = await visit('/redirect')
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe('/after')

    const cookies = await visit('/cookies')
    const setCookie = cookies.headers.getSetCookie()
    expect(setCookie).toContain('a=1; Path=/')
    expect(setCookie).toContain('b=2; Path=/')
  })

  test('activation starts a new deployment and the previous app is stopped', async () => {
    expect(server.services.sites.ssr.running('app')).toBe(1)
    const old = server.services.sites.site('app').deployment_id
    const second = await deploy('app', { 'server.js': APP }, false)
    expect(second.status).toBe('ready')
    // The old deployment keeps serving until the new one is activated.
    expect(await (await visit('/marker')).text()).toBe('none')
    server.services.sites.activate('app', second.id)
    expect(server.services.sites.ssr.running('app')).toBe(0)
    expect(await (await visit('/marker')).text()).toBe('none')
    expect(server.services.sites.ssr.running('app')).toBe(1)
    expect(server.services.sites.site('app').deployment_id).not.toBe(old)
  })

  test('a rollback runs the start command that belonged to that deployment', async () => {
    server.services.sites.update('app', { ...server.services.sites.settingsOf(server.services.sites.site('app')), startCommand: 'bun server.js one' })
    const one = await deploy('app', { 'server.js': APP })
    expect(one.start_command).toBe('bun server.js one')
    expect(await (await visit('/marker')).text()).toBe('one')

    server.services.sites.update('app', { ...server.services.sites.settingsOf(server.services.sites.site('app')), startCommand: 'bun server.js two' })
    const two = await deploy('app', { 'server.js': APP })
    expect(two.start_command).toBe('bun server.js two')
    expect(await (await visit('/marker')).text()).toBe('two')

    server.services.sites.activate('app', one.id)
    expect(await (await visit('/marker')).text()).toBe('one')
    server.services.sites.activate('app', two.id)
    expect(await (await visit('/marker')).text()).toBe('two')
  })

  test('a failed build leaves the live deployment alone', async () => {
    const failed = await deploy('app', { 'server.js': APP })
    expect(failed.status).toBe('ready')
    const live = server.services.sites.site('app').deployment_id
    server.services.sites.update('app', {
      ...server.services.sites.settingsOf(server.services.sites.site('app')),
      buildCommand: 'exit 9',
    })
    const bad = await deploy('app', { 'server.js': APP }, true)
    expect(bad.status).toBe('failed')
    expect(bad.build_logs).toContain('The build command exited with code 9.')
    expect(server.services.sites.site('app').deployment_id).toBe(live)
    server.services.sites.activate('app', failed.id)
    expect(await (await visit('/marker')).text()).toBe('two')
  })

  test('SITES_BUILD_COMMANDS=false skips install and build', async () => {
    server.config.sitesBuildCommands = false
    try {
      createSite('no-build', { installCommand: 'echo installed > installed.txt', buildCommand: 'echo built > built.txt' })
      const d = await deploy('no-build', { 'server.js': APP })
      expect(d.status).toBe('ready')
      expect(d.build_logs).toContain('Skipped install and build commands')
      expect(await (await visit('/files', { site: 'no-build' })).json()).toEqual({ installed: false, built: false })
    } finally {
      server.config.sitesBuildCommands = true
      server.services.sites.remove('no-build')
    }
  })

  test('a failed start command answers 502 with the runtime log', async () => {
    createSite('broken', { startCommand: 'sh -c "exit 7"' })
    const d = await deploy('broken', { 'server.js': APP })
    expect(d.status).toBe('ready')
    const res = await visit('/', { site: 'broken' })
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('did not start')
    await until('the runtime log', () => server.services.sites.runtimeLogs('broken'), (log) => log.includes('exited with code 7'))
    // Give the backoff a moment, then a working deployment recovers the site.
    server.services.sites.update('broken', { ...server.services.sites.settingsOf(server.services.sites.site('broken')), startCommand: 'bun server.js' })
    await deploy('broken', { 'server.js': APP })
    expect(await (await visit('/marker', { site: 'broken' })).text()).toBe('none')
    server.services.sites.remove('broken')
  })

  test('an SSR site with no start command and no function says so', async () => {
    createSite('empty', { startCommand: '' })
    const d = await deploy('empty', { 'index.html': '<h1>x</h1>' })
    expect(d.status).toBe('failed')
    expect(d.build_logs).toContain('needs a start command')
    server.services.sites.remove('empty')
  })
})

describe('SSR sites: modes and limits', () => {
  test('without a start command, every path runs the API function', async () => {
    createSite('fn-site', { startCommand: '', apiFunctionId: 'renderer' })
    const d = await deploy('fn-site', { 'index.html': '<h1>rendered by a function</h1>' })
    expect(d.status).toBe('ready')
    expect(d.build_logs).toContain('requests run the function "renderer"')
    const res = await visit('/docs/page?x=1', { site: 'fn-site' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: 'function', method: 'GET', path: '/docs/page', query: { x: '1' } })
    expect(server.services.sites.ssr.running('fn-site')).toBe(0)
  })

  test('SITES_SSR=false turns SSR hosts off', async () => {
    server.config.sitesSsr = false
    try {
      const res = await visit('/marker')
      expect(res.status).toBe(503)
      expect(await res.text()).toContain('turned off')
    } finally {
      server.config.sitesSsr = true
    }
  })

  test('an idle app is stopped and starts again on the next request', async () => {
    createSite('idle')
    await deploy('idle', { 'server.js': APP })
    server.config.sitesSsrIdleMs = 300
    try {
      expect(await (await visit('/marker', { site: 'idle' })).text()).toBe('none')
      expect(server.services.sites.ssr.running('idle')).toBe(1)
      await until('the idle app to stop', () => server.services.sites.ssr.running('idle'), (n) => n === 0, 5000)
      expect(await (await visit('/marker', { site: 'idle' })).text()).toBe('none')
      expect(server.services.sites.ssr.running('idle')).toBe(1)
    } finally {
      server.config.sitesSsrIdleMs = 5 * 60 * 1000
      server.services.sites.remove('idle')
    }
  })

  test('at most SITES_SSR_MAX_PROCESSES apps run, least recently used first out', async () => {
    server.config.sitesSsrMaxProcesses = 1
    try {
      createSite('lru-a')
      createSite('lru-b')
      await deploy('lru-a', { 'server.js': APP })
      await deploy('lru-b', { 'server.js': APP })
      expect(await (await visit('/marker', { site: 'lru-a' })).text()).toBe('none')
      expect(await (await visit('/marker', { site: 'lru-b' })).text()).toBe('none')
      expect(server.services.sites.ssr.running('lru-a')).toBe(0)
      expect(server.services.sites.ssr.running('lru-b')).toBe(1)
    } finally {
      server.services.sites.remove('lru-a')
      server.services.sites.remove('lru-b')
      server.config.sitesSsrMaxProcesses = 2
    }
  })

  test('a crashed app answers 502 once and restarts on the next request', async () => {
    createSite('crash')
    await deploy('crash', { 'server.js': APP })
    expect((await visit('/exit', { site: 'crash' })).status).toBe(200)
    await until('the crash', () => server.services.sites.ssr.running('crash'), (n) => n === 0, 5000)
    // The next request starts a fresh process.
    expect(await (await visit('/marker', { site: 'crash' })).text()).toBe('none')
    server.services.sites.remove('crash')
  })

  test('the console shows only the fields of the current adapter, and saves each card on its own', async () => {
    createSite('static-console', { adapter: 'static', startCommand: '', installCommand: 'npm install', buildCommand: 'npm run build' })
    try {
      const auth = new ConsoleAuth(server.db)
      await auth.upsert('ssr-admin@example.com', 'console-password')
      const cookie = `bunwrite_console=${(await auth.login('ssr-admin@example.com', 'console-password'))!}; console_project=${PROJECT}`

      const ssrPage = await (await fetch(`${base()}/console/sites/app/settings`, { headers: { cookie } })).text()
      expect(ssrPage).toContain('name="start_command"')
      expect(ssrPage).toContain('value="bun server.js two"')
      expect(ssrPage).toContain('name="adapter"')
      expect(ssrPage).toContain('name="install_command"')
      // SSR: the SSR block is visible and the static block is hidden.
      expect(ssrPage).toMatch(/data-show-for="ssr"[^>]*>/)
      expect(ssrPage).not.toMatch(/data-show-for="ssr"[^>]* hidden[^>]*>/)
      expect(ssrPage).toMatch(/data-show-for="static"[^>]* hidden[^>]*>/)

      const staticPage = await (await fetch(`${base()}/console/sites/static-console/settings`, { headers: { cookie } })).text()
      expect(staticPage).toMatch(/data-show-for="static"[^>]*>/)
      expect(staticPage).not.toMatch(/data-show-for="static"[^>]* hidden[^>]*>/)
      expect(staticPage).toMatch(/data-show-for="ssr"[^>]* hidden[^>]*>/)

      // Each card is its own form, with its own Save inside the card.
      for (const section of ['general', 'build', 'api']) {
        expect(ssrPage).toContain(`name="section" value="${section}"`)
      }
      expect(ssrPage).not.toContain('class="page-foot"')

      // The Site ID belongs with the addresses, below the Site URL.
      const addresses = ssrPage.slice(ssrPage.indexOf('id="site-addresses"'), ssrPage.indexOf('id="site-general"'))
      expect(addresses).toContain('Site URL')
      expect(addresses).toContain('Site ID')
      expect(addresses.indexOf('Site URL')).toBeLessThan(addresses.indexOf('Site ID'))
      const general = ssrPage.slice(ssrPage.indexOf('id="site-general"'), ssrPage.indexOf('id="site-runtime"'))
      expect(general).not.toContain('Site ID')

      const list = await (await fetch(`${base()}/console/sites`, { headers: { cookie } })).text()
      expect(list).toContain('id="create-site" class="dialog dialog-wide"')

      const live = server.services.sites.site('app').deployment_id
      const view = await (await fetch(`${base()}/console/sites/app/deployments/${live}`, { headers: { cookie } })).text()
      expect(view).toContain('Runtime')
    } finally {
      server.services.sites.remove('static-console')
    }
  })
})
