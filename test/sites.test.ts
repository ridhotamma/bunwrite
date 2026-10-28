import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { Client, Proxy, Sites } from 'node-appwrite'
import { InputFile } from 'node-appwrite/file'

import { failure, KEY, makeUser, PROJECT, startServer, testSchema, type TestServer } from './helpers'

let dir: string
let server: TestServer
let sites: Sites
let proxy: Proxy
let siteHost: string

/** Pack `files` into a .tar.gz, under `folder` when given (like zipping a folder). */
function archive(name: string, files: Record<string, string | Uint8Array>, folder = ''): Uint8Array {
  const src = join(dir, 'src', name)
  for (const [path, content] of Object.entries(files)) {
    const target = join(src, folder, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  const out = join(dir, `${name}.tar.gz`)
  const tar = Bun.spawnSync(['tar', '-czf', out, '-C', src, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString())
  return new Uint8Array(readFileSync(out))
}

const visit = (path: string, init: RequestInit & { host?: string } = {}) => {
  const { host = siteHost, ...rest } = init
  return fetch(`http://127.0.0.1:${server.config.port}${path}`, { ...rest, headers: { ...(rest.headers as Record<string, string>), host }, redirect: 'manual' })
}

async function deploy(siteId: string, files: Record<string, string | Uint8Array>, activate = true, folder = '') {
  const code = InputFile.fromBuffer(archive(`${siteId}-${Math.random().toString(36).slice(2)}`, files, folder), 'site.tar.gz')
  return sites.createDeployment({ siteId, code, activate })
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bunwrite-sites-'))
  mkdirSync(join(dir, 'functions', 'api', 'src'), { recursive: true })
  writeFileSync(
    join(dir, 'functions', 'api', 'src', 'main.js'),
    `module.exports = async (context) => {
      if (context.req.path.startsWith('/fragment')) return context.res.text('<li>from the function</li>', 200, { 'content-type': 'text/html' })
      return context.res.json({ method: context.req.method, path: context.req.path, query: context.req.query, body: context.req.bodyJson ?? null, user: context.req.headers['x-appwrite-user-id'] ?? null })
    }`,
  )
  const schema = {
    ...testSchema,
    functions: [{ $id: 'api', name: 'API', runtime: 'node-22', entrypoint: 'src/main.js', path: 'functions/api', execute: ['any'], timeout: 15 }],
  }
  server = startServer(schema, { storagePath: join(dir, 'storage') }, dir)
  const client = new Client().setEndpoint(server.endpoint).setProject(PROJECT).setKey(KEY)
  sites = new Sites(client)
  proxy = new Proxy(client)
  siteHost = `blog.localhost:${server.config.port}`
})

afterAll(() => {
  for (const s of server.services.sites.list()) server.services.sites.remove(s.id)
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('sites API', () => {
  test('creates a site with Appwrite fields plus its URL', async () => {
    const site: any = await sites.create({ siteId: 'blog', name: 'Blog', framework: 'other' as any, buildRuntime: 'static-1' as any })
    expect(site.$id).toBe('blog')
    expect(site.live).toBe(false)
    expect(site.url).toBe(`http://blog.localhost:${server.config.port}`)
    expect((await sites.list()).total).toBe(1)
    const frameworks = await sites.listFrameworks()
    expect(frameworks.frameworks.some((f) => f.key === 'vite')).toBe(true)
  })

  test('site IDs must work as subdomains and be unique', async () => {
    expect((await failure(sites.create({ siteId: 'My_Site', name: 'x', framework: 'other' as any, buildRuntime: 'static-1' as any }))).code).toBe(400)
    expect((await failure(sites.create({ siteId: 'console', name: 'x', framework: 'other' as any, buildRuntime: 'static-1' as any }))).code).toBe(400)
    expect((await failure(sites.create({ siteId: 'blog', name: 'x', framework: 'other' as any, buildRuntime: 'static-1' as any }))).code).toBe(409)
  })

  test('nothing is served before the first deployment', async () => {
    const res = await visit('/')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('no live deployment')
  })

  test('a deployment is unpacked and goes live at once', async () => {
    const d = await deploy('blog', {
      'index.html': '<!doctype html><h1>Home</h1>',
      'about.html': '<h1>About</h1>',
      'docs/index.html': '<h1>Docs</h1>',
      '404.html': '<h1>Lost</h1>',
      'assets/app.3f9a1c2b.js': 'console.log(1)',
      'style.css': 'body{color:red}',
    })
    expect(d.status as string).toBe('ready')
    expect((d as any).fileCount).toBe(6)
    const site = await sites.get({ siteId: 'blog' })
    expect(site.deploymentId).toBe(d.$id)
    expect(site.live).toBe(true)
  })

  test('serves pages, clean URLs and a custom 404', async () => {
    const home = await visit('/')
    expect(home.status).toBe(200)
    expect(home.headers.get('content-type')).toContain('text/html')
    expect(home.headers.get('cache-control')).toContain('must-revalidate')
    expect(home.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await home.text()).toContain('Home')

    expect(await (await visit('/about')).text()).toContain('About')
    const docs = await visit('/docs')
    expect(docs.status).toBe(308)
    expect(docs.headers.get('location')).toBe('/docs/')
    expect(await (await visit('/docs/')).text()).toContain('Docs')

    const missing = await visit('/nope')
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('Lost')
  })

  test('hashed assets are cached for a year, and ETags revalidate', async () => {
    const asset = await visit('/assets/app.3f9a1c2b.js')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    const css = await visit('/style.css')
    const etag = css.headers.get('etag')!
    expect(etag).toBeTruthy()
    expect((await visit('/style.css', { headers: { 'if-none-match': etag } })).status).toBe(304)
  })

  test('sends a pre-compressed file when the browser accepts it', async () => {
    const big = 'x'.repeat(5000)
    await deploy('blog', { 'index.html': '<h1>Home</h1>', 'big.txt': big, 'big.txt.gz': gzipSync(big) })
    const res = await fetch(`http://127.0.0.1:${server.config.port}/big.txt`, { headers: { host: siteHost, 'accept-encoding': 'gzip' }, decompress: false } as any)
    expect(res.headers.get('content-encoding')).toBe('gzip')
  })

  test('never serves files outside the deployment', async () => {
    for (const path of ['/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fpackage.json', '/%00']) {
      expect([400, 404]).toContain((await visit(path)).status)
    }
  })

  test('only GET and HEAD reach static files', async () => {
    expect((await visit('/', { method: 'POST', body: 'x' })).status).toBe(405)
    const head = await visit('/', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  test('a single folder inside the upload becomes the site root', async () => {
    const d = await deploy('blog', { 'index.html': '<h1>Lifted</h1>' }, true, 'my-site')
    expect(d.buildLogs).toContain('my-site')
    expect(await (await visit('/')).text()).toContain('Lifted')
  })

  test('rollback is making an older deployment live again', async () => {
    const a = await deploy('blog', { 'index.html': '<h1>Version A</h1>' })
    await deploy('blog', { 'index.html': '<h1>Version B</h1>' })
    expect(await (await visit('/')).text()).toContain('Version B')
    await sites.updateSiteDeployment({ siteId: 'blog', deploymentId: a.$id })
    expect(await (await visit('/')).text()).toContain('Version A')
  })

  test('a deployment that is not activated waits', async () => {
    const before = (await sites.get({ siteId: 'blog' })).deploymentId
    const d = await deploy('blog', { 'index.html': '<h1>Draft</h1>' }, false)
    expect(d.status as string).toBe('ready')
    expect((await sites.get({ siteId: 'blog' })).deploymentId).toBe(before)
  })

  test('the output directory is what gets served', async () => {
    await sites.update({ siteId: 'blog', name: 'Blog', framework: 'vite' as any, outputDirectory: 'dist' })
    await deploy('blog', { 'package.json': '{}', 'dist/index.html': '<h1>Built</h1>' })
    expect(await (await visit('/')).text()).toContain('Built')
    expect((await visit('/package.json')).status).toBe(404)
    const failed = await deploy('blog', { 'index.html': 'no dist here' })
    expect(failed.status as string).toBe('failed')
    expect(failed.buildLogs).toContain('Output directory "dist"')
    // The failed deployment does not replace the live one.
    expect(await (await visit('/')).text()).toContain('Built')
  })

  test('single-page apps get their fallback file, but missing assets stay 404', async () => {
    await sites.update({ siteId: 'blog', name: 'Blog', framework: 'vite' as any, outputDirectory: 'dist', fallbackFile: 'index.html' })
    const res = await visit('/settings/profile')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Built')
    expect((await visit('/missing.js')).status).toBe(404)
  })

  test('a paused site says so', async () => {
    await sites.update({ siteId: 'blog', name: 'Blog', framework: 'vite' as any, enabled: false })
    expect((await visit('/')).status).toBe(503)
    await sites.update({ siteId: 'blog', name: 'Blog', framework: 'vite' as any, enabled: true })
    expect((await visit('/')).status).toBe(200)
  })

  test('downloads a deployment as .tar.gz', async () => {
    const site = await sites.get({ siteId: 'blog' })
    const bytes = await sites.getDeploymentDownload({ siteId: 'blog', deploymentId: site.deploymentId })
    expect(new Uint8Array(bytes as ArrayBuffer).slice(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]))
  })
})

describe('sites with functions', () => {
  test('/api/* runs the site function on the same origin', async () => {
    await server.services.sites.update('blog', { ...server.services.sites.settingsOf(server.services.sites.site('blog')), apiFunctionId: 'api' })
    const res = await visit('/api/todos?done=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ method: 'POST', path: '/todos', query: { done: '1' }, body: { title: 'x' } })
  })

  test('htmx fragments come back as HTML', async () => {
    const res = await visit('/api/fragment', { headers: { 'hx-request': 'true' } })
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toBe('<li>from the function</li>')
  })

  test('the function sees the signed-in user from a JWT', async () => {
    const user = makeUser(server.db)
    const jwt = await fetch(`${server.endpoint}/account/jwts`, {
      method: 'POST',
      headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-session': user.secret },
    }).then((r) => r.json() as Promise<{ jwt: string }>)
    const res = await visit('/api/me', { headers: { 'x-appwrite-jwt': jwt.jwt } })
    expect(((await res.json()) as { user: string }).user).toBe(user.id)
  })

  test('a client cannot pretend to be a user', async () => {
    const res = await visit('/api/me', { headers: { 'x-appwrite-user-id': 'someone-else', 'x-bunwrite-user-id': 'someone-else' } })
    expect(((await res.json()) as { user: string | null }).user).toBeNull()
  })

  test('the API function setting must name a function', async () => {
    const err = await failure(
      fetch(`${server.endpoint}/sites/blog`, {
        method: 'PUT',
        headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Blog', apiFunctionId: 'missing' }),
      }).then(async (r) => {
        if (!r.ok) throw Object.assign(new Error('x'), await r.json())
      }),
    )
    expect(err.code).toBe(404)
  })

  test('the browser SDK on a site may call the API (CORS)', async () => {
    const origin = `http://blog.localhost:${server.config.port}`
    const res = await fetch(`${server.endpoint}/health`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } })
    expect(res.headers.get('access-control-allow-origin')).toBe(origin)
    const other = await fetch(`${server.endpoint}/health`, { method: 'OPTIONS', headers: { origin: 'http://evil.test', 'access-control-request-method': 'GET' } })
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('a site is a valid redirect target for account emails', async () => {
    expect(server.services.sites.allowedOrigins()).toContain(`http://blog.localhost:${server.config.port}`)
  })
})

describe('custom domains', () => {
  test('a proxy rule gives the site its own domain', async () => {
    const rule = await proxy.createSiteRule({ domain: 'www.example.org', siteId: 'blog' })
    expect(rule.domain).toBe('www.example.org')
    const res = await visit('/', { host: 'www.example.org' })
    expect(await res.text()).toContain('Built')
    const rules = await proxy.listRules()
    expect(rules.rules.map((r) => r.domain)).toEqual(expect.arrayContaining(['www.example.org', `blog.localhost:${server.config.port}`]))
  })

  test('a domain belongs to one site', async () => {
    await sites.create({ siteId: 'shop', name: 'Shop', framework: 'other' as any, buildRuntime: 'static-1' as any })
    expect((await failure(proxy.createSiteRule({ domain: 'www.example.org', siteId: 'shop' }))).code).toBe(400)
  })

  test('deleting a site frees its address', async () => {
    await sites.delete({ siteId: 'shop' })
    const res = await visit('/', { host: `shop.localhost:${server.config.port}` })
    expect(res.status).not.toBe(200)
  })

  test('the API host itself is never a site', async () => {
    const res = await fetch(`${server.endpoint}/health`)
    expect(res.status).toBe(200)
  })
})
