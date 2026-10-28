import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { ConsoleAuth } from '~/console/auth'
import { Deployments } from '~/functions/deployments'
import { parseRuntime, runtimeLabel, SERVER_BUN } from '~/runtimes/catalog'
import { installedRuntime } from '~/runtimes/install'
import type { SiteDeploymentRow } from '~/sites/service'
import { KEY, PROJECT, startServer, testSchema, type TestServer } from './helpers'

let dir: string
let server: TestServer
let mirror: ReturnType<typeof Bun.serve>
let base: string

const os = process.platform === 'darwin' ? 'darwin' : 'linux'
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const bunArch = arch === 'arm64' ? 'aarch64' : 'x64'
const downloads: string[] = []

// ---- A fake Node.js mirror and Bun releases list ----

/** A shell script standing in for a runtime: it marks itself, then runs the test's own Bun. */
const fakeBinary = (label: string) => `#!/bin/sh\nexport FAKE_RUNTIME="${label}"\nexec '${process.execPath}' "$@"\n`

function nodeTarball(version: string): Uint8Array {
  const src = mkdtempSync(join(dir, 'node-'))
  const top = join(src, `node-v${version}-${os}-${arch}`, 'bin')
  mkdirSync(top, { recursive: true })
  writeFileSync(join(top, 'node'), fakeBinary(`node ${version}`), { mode: 0o755 })
  const out = `${src}.tar.gz`
  // Like nodejs.org's tarballs: one top folder, no leading ./
  const tar = Bun.spawnSync(['tar', '-czf', out, '-C', src, `node-v${version}-${os}-${arch}`], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString())
  return new Uint8Array(readFileSync(out))
}

/** A .zip with stored (uncompressed) entries, as Bun's release zips hold one binary. */
function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const nameBytes = Buffer.from(name)
    const crc = Bun.hash.crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, cd, end]))
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

let node22: Uint8Array
let node20: Uint8Array
let bunZip: Uint8Array

async function fakeMirror(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname
  if (path === '/dist/index.json') return Response.json([{ version: 'v22.9.1' }, { version: 'v22.8.0' }, { version: 'v20.3.0' }])
  if (path === '/dist/v22.9.1/SHASUMS256.txt') return new Response(`${sha256(node22)}  node-v22.9.1-${os}-${arch}.tar.gz\n`)
  // Node 20's checksum is wrong on purpose.
  if (path === '/dist/v20.3.0/SHASUMS256.txt') return new Response(`${'0'.repeat(64)}  node-v20.3.0-${os}-${arch}.tar.gz\n`)
  if (path === `/dist/v22.9.1/node-v22.9.1-${os}-${arch}.tar.gz`) {
    downloads.push(path)
    return new Response(node22)
  }
  if (path === `/dist/v20.3.0/node-v20.3.0-${os}-${arch}.tar.gz`) return new Response(node20)
  if (path === '/releases') {
    return Response.json([
      { tag_name: 'bun-v1.2.4', assets: [] },
      {
        tag_name: 'bun-v1.2.5',
        assets: [
          { name: `bun-${os}-${bunArch}.zip`, browser_download_url: `${base}/bun/bun-${os}-${bunArch}.zip` },
          { name: 'SHASUMS256.txt', browser_download_url: `${base}/bun/SHASUMS256.txt` },
        ],
      },
    ])
  }
  if (path === `/bun/bun-${os}-${bunArch}.zip`) {
    downloads.push(path)
    return new Response(bunZip)
  }
  if (path === '/bun/SHASUMS256.txt') return new Response(`${sha256(bunZip)}  bun-${os}-${bunArch}.zip\n`)
  return new Response('not found', { status: 404 })
}

// ---- Helpers ----

function archive(files: Record<string, string>): Blob {
  const src = mkdtempSync(join(dir, 'src-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(src, path)), { recursive: true })
    writeFileSync(join(src, path), content)
  }
  const out = `${src}.tar.gz`
  const tar = Bun.spawnSync(['tar', '-czf', out, '-C', src, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString())
  return new Blob([readFileSync(out)], { type: 'application/gzip' })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until<T>(what: string, fn: () => T, ok: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = fn()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await sleep(50)
  }
}

/** An app that says which runtime started it. */
const APP = `Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: () => new Response(process.env.FAKE_RUNTIME || 'server bun') })`

function createSite(id: string, buildRuntime: string) {
  return server.services.sites.create(id, {
    name: id,
    enabled: true,
    framework: 'node',
    outputDirectory: '',
    fallbackFile: '',
    domains: [],
    apiFunctionId: '',
    installCommand: '',
    buildCommand: 'echo built > built.txt',
    startCommand: 'node server.js',
    buildRuntime,
    adapter: 'ssr',
    pruneMode: 'none',
  })
}

async function deploy(siteId: string, activate = true): Promise<SiteDeploymentRow> {
  const first = await server.services.sites.upload(server.services.sites.site(siteId), { code: archive({ 'server.js': APP }), activate, contentRange: null, uploadId: null })
  return until(`deployment ${first.id}`, () => server.services.sites.deployment(siteId, first.id), (d) => d.status === 'ready' || d.status === 'failed')
}

const visit = (site: string) =>
  fetch(`http://127.0.0.1:${server.config.port}/`, { headers: { host: `${site}.sites.localhost:${server.config.port}` } }).then((r) => r.text())

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${server.endpoint}${path}`, { ...init, headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bunwrite-runtimes-'))
  node22 = nodeTarball('22.9.1')
  node20 = nodeTarball('20.3.0')
  bunZip = zip({ [`bun-${os}-${bunArch}/bun`]: fakeBinary('bun 1.2.5') })
  mirror = Bun.serve({ port: 0, fetch: fakeMirror })
  base = `http://127.0.0.1:${mirror.port}`
  // A database file in the temp folder keeps the downloaded runtimes there too.
  server = startServer(testSchema, { databasePath: join(dir, 'bunwrite.sqlite'), runtimes: { download: true, nodeMirror: `${base}/dist`, bunReleases: `${base}/releases` } }, dir)
})

afterAll(() => {
  for (const site of server.services.sites.list()) server.services.sites.remove(site.id)
  server.services.sites.stop()
  server.stop()
  mirror.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

describe('runtimes', () => {
  test('runtime IDs parse, and the server Bun needs no download', () => {
    expect(parseRuntime('node-22')).toEqual({ kind: 'node', line: '22' })
    expect(parseRuntime('node-16.0')).toEqual({ kind: 'node', line: '16' })
    expect(parseRuntime('bun-1.3')).toEqual({ kind: 'bun', line: '1.3' })
    expect(parseRuntime('python-3.12')).toEqual({ kind: 'python', line: '3.12' })
    expect(parseRuntime('ruby-3.3')).toBeNull()
    // The server's own Bun: no version to download, its shims go first on PATH.
    const own = installedRuntime(server.config, SERVER_BUN)!
    expect(own).toMatchObject({ kind: 'bun', version: '' })
    expect(own.bin).toEndWith(join('.runtimes', 'bin'))
    expect(installedRuntime(server.config, '')).toMatchObject({ bin: null })
    expect(runtimeLabel(SERVER_BUN)).toContain('this server')
  })

  test('a site build installs Node.js once, checks it, and the app runs on it', async () => {
    createSite('node-app', 'node-22')
    const d = await deploy('node-app')
    expect(d.status).toBe('ready')
    expect(d.runtime).toBe('node-22')
    expect(d.build_logs).toContain('Installing Node.js 22.9.1 (first use of node-22)')
    expect(d.build_logs).toContain('Runtime: Node.js 22.9.1')
    expect(await visit('node-app')).toBe('node 22.9.1')

    const again = await deploy('node-app')
    expect(again.build_logs).not.toContain('Installing')
    expect(downloads.filter((p) => p.includes('node-v22'))).toHaveLength(1)
  })

  test('a rollback runs on the runtime its deployment was built with', async () => {
    const onNode = server.services.sites.site('node-app').deployment_id
    server.services.sites.update('node-app', { ...server.services.sites.settingsOf(server.services.sites.site('node-app')), buildRuntime: 'bun-1.2' })
    const onBun = await deploy('node-app')
    expect(onBun.build_logs).toContain('Installing Bun 1.2.5')
    expect(await visit('node-app')).toBe('bun 1.2.5')
    server.services.sites.activate('node-app', onNode)
    expect(await visit('node-app')).toBe('node 22.9.1')
  })

  test('a download that does not match its checksum fails the build', async () => {
    createSite('bad-sum', 'node-20')
    const d = await deploy('bad-sum')
    expect(d.status).toBe('failed')
    expect(d.build_logs).toContain('does not match its published checksum')
    expect(installedRuntime(server.config, 'node-20')).toBeNull()
  })

  test('with downloads off, Node.js runtimes run on the server Bun', async () => {
    server.config.runtimes.download = false
    try {
      createSite('offline', 'node-24')
      const d = await deploy('offline')
      expect(d.status).toBe('ready')
      expect(d.build_logs).toContain('RUNTIMES_DOWNLOAD=false')
      expect(await visit('offline')).toBe('server bun')
    } finally {
      server.config.runtimes.download = true
    }
  })

  test('a function runs on its runtime through the JavaScript runner', async () => {
    const res = await api('/functions', { method: 'POST', body: JSON.stringify({ functionId: 'on-node', name: 'On Node', runtime: 'node-22', entrypoint: 'main.js', execute: ['any'] }) })
    expect(res.status).toBe(201)
    const deployments = new Deployments(server.db, server.config, server.services.functions)
    const f = server.services.functions.fn('on-node')
    const started = deployments.deployFiles(f, { files: [{ path: 'main.js', content: 'module.exports = async ({ res }) => res.text(process.env.FAKE_RUNTIME || "server bun")' }], entrypoint: 'main.js', commands: '', activate: true })
    const d = await until('the function build', () => deployments.get('on-node', started.id), (x) => x.status === 'ready' || x.status === 'failed')
    expect(d.status).toBe('ready')
    expect(d.runtime).toBe('node-22')
    const run = (await (await api('/functions/on-node/executions', { method: 'POST', body: JSON.stringify({}) })).json()) as any
    expect(run.status).toBe('completed')
    expect(run.responseBody).toBe('node 22.9.1')
  })

  test('the console create pages offer framework groups and runtimes, and plain files stay plain', async () => {
    const auth = new ConsoleAuth(server.db)
    await auth.upsert('rt-admin@example.com', 'console-password')
    const cookie = `bunwrite_console=${(await auth.login('rt-admin@example.com', 'console-password'))!}; console_project=${PROJECT}`
    const root = server.endpoint.replace(/\/v1$/, '')
    const page = await (await fetch(`${root}/console/sites/new`, { headers: { cookie } })).text()
    expect(page).toContain('<optgroup label="Static site: files to serve">')
    expect(page).toContain('<option value="tanstack-start"')
    expect(page).toContain('<option value="ssr-other"')
    expect(page).toContain('name="build_runtime"')
    expect(page).toContain('<optgroup label="Bun">')
    // The TanStack Start preset fills the start command.
    expect(page).toContain('&quot;tanstack-start&quot;:&quot;node .output/server/index.mjs&quot;')
    // Build settings show only for uploads (and GitHub): the starter and Write HTML have none.
    expect(page).toMatch(/<section class="settings-section"\s+data-show-for="upload" data-for-select="source" hidden>/)

    const fnPage = await (await fetch(`${root}/console/functions/new`, { headers: { cookie } })).text()
    expect(fnPage).toContain('<optgroup label="Python">')
    expect(fnPage).toMatch(/<option value="node-22"\s+selected>/)

    // A starter page is a static Plain HTML site, even when server fields are posted with it.
    const created = await fetch(`${root}/console/sites`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Plain', id: 'plain', source: 'starter', framework: 'nextjs', start_command: 'node server.js', build_runtime: 'node-22' }),
      redirect: 'manual',
    })
    expect(created.status).toBe(303)
    expect(server.services.sites.site('plain')).toMatchObject({ framework: 'other', adapter: 'static', start_command: '', build_runtime: '' })
  })
})
