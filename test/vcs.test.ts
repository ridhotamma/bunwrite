import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { vcsGithubFromEnv } from '~/config'
import { ConsoleAuth } from '~/console/auth'
import { poll } from '~/console/ui'
import { branchOptions, repositoryOptions } from '~/console/views/vcs'
import { sitesDir } from '~/sites/paths'
import { branchSlug, parsePreview, slugify } from '~/sites/previews'
import { SERVER_BUN } from '~/runtimes/catalog'
import { detectFramework, detectRuntime } from '~/vcs/detect'
import { signState } from '~/vcs/state'
import { KEY, PROJECT, startServer, testSchema, type TestServer } from './helpers'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const WEBHOOK_SECRET = 'whsec_test'
const REPO_ID = 500
const FORK_ID = 600
const INSTALLATION = 42

let dir: string
let server: TestServer
let github: ReturnType<typeof Bun.serve>
let gh: string

// ---- A fake GitHub: one repository whose branches and commits the tests set ----

interface Commit {
  files: Record<string, string>
  message: string
}
const commits = new Map<string, Commit>()
const refs = new Map<string, string>()
/** Open pull request number per head branch (same repository). */
const openPulls = new Map<string, number>()
const pulls = new Map<number, any>()
const calls: { method: string; path: string; body: any }[] = []
let commentSeq = 1000

function commit(branch: string, files: Record<string, string>, message = `Update ${branch}`): string {
  const sha = createHmac('sha1', 'x').update(`${branch}${JSON.stringify(files)}${Math.random()}`).digest('hex')
  commits.set(sha, { files, message })
  refs.set(branch, sha)
  return sha
}

const shaOf = (ref: string) => (commits.has(ref) ? ref : refs.get(ref || 'main'))

const repoJson = () => ({
  id: REPO_ID,
  name: 'web',
  full_name: 'acme/web',
  private: true,
  default_branch: 'main',
  html_url: `${gh}/acme/web`,
  pushed_at: new Date().toISOString(),
  owner: { login: 'acme', type: 'Organization' },
})

function tarball(sha: string): string {
  const src = mkdtempSync(join(dir, 'tar-'))
  const top = join(src, `acme-web-${sha.slice(0, 7)}`)
  for (const [path, content] of Object.entries(commits.get(sha)!.files)) {
    mkdirSync(dirname(join(top, path)), { recursive: true })
    writeFileSync(join(top, path), content)
  }
  const out = `${src}.tar.gz`
  const tar = Bun.spawnSync(['tar', '-czf', out, '-C', src, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString())
  return out
}

function verifyJwt(auth: string | null): boolean {
  const jwt = auth?.replace(/^Bearer /, '') ?? ''
  const [h, p, s] = jwt.split('.')
  if (!h || !p || !s) return false
  const verify = createVerify('RSA-SHA256')
  verify.update(`${h}.${p}`)
  return verify.verify(publicKey, Buffer.from(s, 'base64url')) && JSON.parse(Buffer.from(p, 'base64url').toString()).iss === '123'
}

async function fakeGithub(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const body = req.method === 'GET' ? null : await req.json().catch(() => null)
  calls.push({ method: req.method, path: `${path}${url.search}`, body })
  const json = (value: unknown, status = 200) => Response.json(value, { status })
  const repo = '/repos/acme/web'

  if (req.method === 'POST' && path === `/app/installations/${INSTALLATION}/access_tokens`) {
    if (!verifyJwt(req.headers.get('authorization'))) return json({ message: 'Bad JWT' }, 401)
    return json({ token: 'ghs_installation', expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201)
  }
  if (path === `/app/installations/${INSTALLATION}`) return json({ id: INSTALLATION, account: { login: 'acme', type: 'Organization' } })
  if (req.method === 'POST' && path === '/app-manifests/good-code/conversions') {
    return json({ id: 999, slug: 'bunwrite-made', name: 'Bunwrite made', owner: { login: 'acme' }, html_url: `${gh}/apps/bunwrite-made`, client_id: 'made-id', client_secret: 'made-secret', webhook_secret: 'made-hook', pem: 'made-pem' }, 201)
  }
  if (req.method === 'POST' && path === '/login/oauth/access_token') return json({ access_token: 'gho_user' })
  if (path === '/user/installations') return json({ installations: [{ id: INSTALLATION }] })

  // Everything below needs the installation token.
  if (req.headers.get('authorization') !== 'token ghs_installation') return json({ message: 'Bad credentials' }, 401)
  if (path === '/installation/repositories') return json({ repositories: [repoJson()] })
  if (path === `/repositories/${REPO_ID}`) return json(repoJson())
  if (path === `${repo}/branches`) return json([...refs.keys()].map((name) => ({ name })))
  if (path.startsWith(`${repo}/commits/`)) {
    const sha = shaOf(decodeURIComponent(path.slice(`${repo}/commits/`.length)))
    if (!sha) return json({ message: 'No commit found' }, 422)
    return json({ sha, html_url: `${gh}/acme/web/commit/${sha}`, commit: { message: commits.get(sha)!.message, author: { name: 'Dev' } }, author: { login: 'dev', html_url: `${gh}/dev` } })
  }
  if (path.startsWith(`${repo}/tarball/`)) {
    const sha = path.slice(`${repo}/tarball/`.length)
    if (!commits.has(sha)) return json({ message: 'Not Found' }, 404)
    return new Response(Bun.file(tarball(sha)))
  }
  if (path.startsWith(`${repo}/contents`)) {
    const sha = shaOf(url.searchParams.get('ref') ?? '')!
    const files = commits.get(sha)!.files
    const wanted = decodeURIComponent(path.slice(`${repo}/contents`.length)).replace(/^\/+|\/+$/g, '')
    if (req.headers.get('accept')?.includes('raw')) return wanted in files ? new Response(files[wanted]) : json({ message: 'Not Found' }, 404)
    const prefix = wanted ? `${wanted}/` : ''
    const names = new Map<string, string>()
    for (const file of Object.keys(files)) {
      if (!file.startsWith(prefix)) continue
      const rest = file.slice(prefix.length)
      const [first, ...more] = rest.split('/')
      names.set(first!, more.length ? 'dir' : 'file')
    }
    if (!names.size) return json({ message: 'Not Found' }, 404)
    return json([...names].map(([name, type]) => ({ name, path: `${prefix}${name}`, type, size: 1 })))
  }
  if (req.method === 'POST' && path.startsWith(`${repo}/statuses/`)) return json({ id: 1 }, 201)
  if (path === `${repo}/pulls`) {
    const head = url.searchParams.get('head')?.split(':')[1] ?? ''
    const number = openPulls.get(head)
    return json(number ? [pulls.get(number)] : [])
  }
  if (path.startsWith(`${repo}/pulls/`)) {
    const pr = pulls.get(Number(path.slice(`${repo}/pulls/`.length)))
    return pr ? json(pr) : json({ message: 'Not Found' }, 404)
  }
  if (req.method === 'POST' && /\/issues\/\d+\/comments$/.test(path)) return json({ id: ++commentSeq }, 201)
  if (req.method === 'PATCH' && path.startsWith(`${repo}/issues/comments/`)) return json({ id: Number(path.split('/').pop()) })
  return json({ message: `Not handled: ${req.method} ${path}` }, 404)
}

function pullJson(number: number, branch: string, sha: string, fork: boolean) {
  return {
    number,
    html_url: `${gh}/acme/web/pull/${number}`,
    title: `PR ${number}`,
    state: 'open',
    user: { login: 'dev', html_url: `${gh}/dev` },
    head: { ref: branch, sha, repo: { id: fork ? FORK_ID : REPO_ID, full_name: fork ? 'stranger/web' : 'acme/web' } },
    base: { ref: 'main', repo: { id: REPO_ID, full_name: 'acme/web' } },
  }
}

// ---- Helpers ----

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${server.endpoint}${path}`, {
    ...init,
    headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  })

const base = () => server.endpoint.replace(/\/v1$/, '')

const visit = (host: string, path = '/') =>
  fetch(`http://127.0.0.1:${server.config.port}${path}`, { headers: { host: `${host}.sites.localhost:${server.config.port}` }, redirect: 'manual' })

async function webhook(event: string, payload: unknown, secret = WEBHOOK_SECRET): Promise<Response> {
  const body = JSON.stringify(payload)
  const res = await fetch(`${server.endpoint}/vcs/github/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
    body,
  })
  await server.hub.settled()
  return res
}

const push = (branch: string, sha: string, message = commits.get(sha)?.message ?? 'update') =>
  webhook('push', {
    ref: `refs/heads/${branch}`,
    after: sha,
    deleted: false,
    repository: { id: REPO_ID, full_name: 'acme/web' },
    installation: { id: INSTALLATION },
    head_commit: { id: sha, message, url: `${gh}/acme/web/commit/${sha}`, author: { name: 'Dev', username: 'dev' } },
  })

/** The newest text of any PR comment, created or edited. */
const lastComment = () => calls.filter((c) => (c.method === 'POST' && c.path.endsWith('/comments')) || (c.method === 'PATCH' && c.path.includes('/issues/comments/'))).at(-1)?.body.body ?? ''

const statuses = (context: string) => calls.filter((c) => c.method === 'POST' && c.path.includes('/statuses/') && c.body?.context === context)

let installationId = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bunwrite-vcs-'))
  github = Bun.serve({ port: 0, fetch: fakeGithub })
  gh = `http://127.0.0.1:${github.port}`
  const vcsGithub = {
    ...vcsGithubFromEnv({}),
    appId: '123',
    appName: 'bunwrite-test',
    privateKey,
    clientId: 'cid',
    clientSecret: 'csec',
    webhookSecret: WEBHOOK_SECRET,
    apiUrl: gh,
    url: gh,
  }
  server = startServer(testSchema, { vcsGithub, sitesSsrIdleMs: 60_000 }, dir)
  server.hub.commentDelayMs = 0
  commit('main', { 'index.html': '<h1>v1</h1>', 'api/index.js': 'module.exports = async ({ res }) => res.text("fn v1")' })
})

afterAll(() => {
  for (const site of server.services.sites.list()) server.services.sites.remove(site.id)
  server.services.sites.stop()
  server.stop()
  github.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

describe('Git: detection and preview names', () => {
  test('frameworks and runtimes are detected from the files', async () => {
    const pkg = (deps: Record<string, string>, scripts: Record<string, string> = { build: 'x' }) => async (p: string) =>
      p === 'package.json' ? JSON.stringify({ dependencies: deps, scripts }) : null
    expect((await detectFramework(['package.json', 'package-lock.json'], pkg({ next: '15' }))).framework).toBe('nextjs')
    const nuxt = await detectFramework(['package.json', 'pnpm-lock.yaml'], pkg({ nuxt: '3' }))
    expect(nuxt).toMatchObject({ framework: 'nuxt', adapter: 'ssr', installCommand: 'pnpm install', buildCommand: 'pnpm run build' })
    expect((await detectFramework(['package.json'], pkg({ '@sveltejs/kit': '2' }))).framework).toBe('sveltekit')
    const vite = await detectFramework(['package.json', 'package-lock.json'], pkg({ vite: '6', react: '19' }))
    expect(vite).toMatchObject({ framework: 'react', adapter: 'static', outputDirectory: 'dist', installCommand: 'npm ci', buildCommand: 'npm run build' })
    expect((await detectFramework(['index.html'], async () => null)).framework).toBe('other')
    expect(await detectRuntime(['main.py', 'requirements.txt'], async () => null)).toEqual({ runtime: 'python-3.12', entrypoint: 'main.py', commands: 'pip install -r requirements.txt' })
    expect((await detectRuntime(['package.json', 'bun.lock'], pkg({ hono: '4' }))).runtime).toBe(SERVER_BUN)

    // The frameworks added with real runtimes, and the runtime a project asks for.
    expect(await detectFramework(['package.json'], pkg({ '@tanstack/react-start': '1', react: '19', vite: '7' }))).toMatchObject({ framework: 'tanstack-start', adapter: 'ssr', startCommand: 'node .output/server/index.mjs' })
    expect(await detectFramework(['package.json'], pkg({ express: '5' }, { start: 'node server.js' }))).toMatchObject({ framework: 'node', adapter: 'ssr', startCommand: 'npm run start', buildCommand: '' })
    expect((await detectFramework(['package.json'], pkg({ '@react-router/dev': '7' }))).framework).toBe('react-router')
    expect((await detectFramework(['package.json'], pkg({ '@sveltejs/kit': '2', '@sveltejs/adapter-static': '3' }))).framework).toBe('sveltekit-static')
    const nextExport = async (p: string) => (p === 'package.json' ? JSON.stringify({ dependencies: { next: '15' }, scripts: { build: 'next build' } }) : p === 'next.config.mjs' ? "export default { output: 'export' }" : null)
    expect(await detectFramework(['package.json', 'next.config.mjs'], nextExport)).toMatchObject({ framework: 'next-static', adapter: 'static', outputDirectory: 'out' })
    const engines = (node: string) => async (p: string) => (p === 'package.json' ? JSON.stringify({ dependencies: { next: '15' }, engines: { node } }) : null)
    expect((await detectFramework(['package.json'], engines('>=18'))).buildRuntime).toBe('node-22')
    expect((await detectFramework(['package.json'], engines('^24.1'))).buildRuntime).toBe('node-24')
    const nvmrc = async (p: string) => (p === 'package.json' ? '{"dependencies":{"vite":"7"}}' : p === '.nvmrc' ? 'v20.11.0\n' : null)
    expect((await detectFramework(['package.json', '.nvmrc'], nvmrc)).buildRuntime).toBe('node-20')
    expect((await detectFramework(['package.json', 'bun.lock'], pkg({ hono: '4' }))).buildRuntime).toBe(SERVER_BUN)
  })

  test('preview labels fit a DNS label and split at the last --', () => {
    expect(slugify('feature/Login_Page')).toBe('feature-login-page')
    const long = branchSlug('a'.repeat(36), 'feature/' + 'x'.repeat(80))
    expect(`${'a'.repeat(36)}--git-${long}`.length).toBeLessThanOrEqual(63)
    expect(parsePreview('my--site--git-main')).toEqual({ siteId: 'my--site', branchSlug: 'main' })
    expect(parsePreview('web--0123abcdef')).toEqual({ siteId: 'web', deploymentId: '0123abcdef' })
    expect(parsePreview('plain-site')).toBeNull()
  })
})

describe('Git: GitHub App and installations', () => {
  test('the manifest flow stores the app, and env vars still win', async () => {
    const state = signState(server.config.secret, { kind: 'manifest', returnTo: '/console/organization' })
    const res = await fetch(`${server.endpoint}/vcs/github/manifest?code=good-code&state=${encodeURIComponent(state)}`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toStartWith('/console/organization?ok=')
    expect(server.hub.apps.stored()).toBe(true)
    const app = server.hub.apps.get()!
    expect(app.appId).toBe('123')
    expect(app.source).toBe('env')
    expect(app.name).toBe('Bunwrite made')
    const forged = await fetch(`${server.endpoint}/vcs/github/manifest?code=good-code&state=nope`, { redirect: 'manual' })
    expect(forged.status).toBe(400)
  })

  test('the install callback adds only installations the GitHub user can access', async () => {
    const state = (installation?: string) => encodeURIComponent(signState(server.config.secret, { kind: 'install', projectId: PROJECT, returnTo: '/console/settings/git', installationId: installation }))
    const denied = await fetch(`${server.endpoint}/vcs/github/callback?installation_id=77&setup_action=install&code=c&state=${state()}`, { redirect: 'manual' })
    expect(denied.headers.get('location')).toContain('err=')
    expect(server.services.vcs.list()).toHaveLength(0)

    // Without a code the server asks GitHub who is signed in first.
    const noCode = await fetch(`${server.endpoint}/vcs/github/callback?installation_id=${INSTALLATION}&setup_action=install&state=${state()}`, { redirect: 'manual' })
    expect(noCode.headers.get('location')).toStartWith(`${gh}/login/oauth/authorize?client_id=cid`)

    const ok = await fetch(`${server.endpoint}/vcs/github/callback?installation_id=${INSTALLATION}&setup_action=install&code=c&state=${state()}`, { redirect: 'manual' })
    expect(ok.headers.get('location')).toStartWith('/console/settings/git?ok=')
    const list = (await (await api('/vcs/installations')).json()) as any
    expect(list.total).toBe(1)
    expect(list.installations[0]).toMatchObject({ provider: 'github', organization: 'acme', providerInstallationId: String(INSTALLATION) })
    installationId = list.installations[0].$id
  })

  test('repositories, branches, contents and detection are browsable', async () => {
    const repos = (await (await api(`/vcs/github/installations/${installationId}/providerRepositories?type=framework`)).json()) as any
    expect(repos.frameworkProviderRepositories[0]).toMatchObject({ id: String(REPO_ID), name: 'web', organization: 'acme', framework: 'other' })
    const branches = (await (await api(`/vcs/github/installations/${installationId}/providerRepositories/${REPO_ID}/branches`)).json()) as any
    expect(branches.branches.map((b: any) => b.name)).toContain('main')
    const contents = (await (await api(`/vcs/github/installations/${installationId}/providerRepositories/${REPO_ID}/contents`)).json()) as any
    expect(contents.contents).toContainEqual({ name: 'api', isDirectory: true, size: 1 })
    const detection = (await (
      await api(`/vcs/github/installations/${installationId}/detections`, { method: 'POST', body: JSON.stringify({ type: 'runtime', providerRepositoryId: String(REPO_ID), providerRootDirectory: 'api' }) })
    ).json()) as any
    expect(detection).toMatchObject({ runtime: 'node-22', entrypoint: 'index.js' })
    expect((await api(`/vcs/github/installations/${installationId}/providerRepositories/31337`)).status).toBe(404)
  })

  test('repository and branch lists are cached, not fetched on every visit', async () => {
    const repoCalls = () => calls.filter((c) => c.path.startsWith('/installation/repositories')).length
    const branchCalls = () => calls.filter((c) => c.path.startsWith('/repos/acme/web/branches')).length
    const installation = server.services.vcs.get(installationId)

    await server.hub.github.repositories(installation.provider_installation_id)
    const afterRepos = repoCalls()
    await server.hub.github.repositories(installation.provider_installation_id)
    expect(repoCalls()).toBe(afterRepos)

    await server.hub.github.branches(installation.provider_installation_id, String(REPO_ID))
    const afterBranches = branchCalls()
    await server.hub.github.branches(installation.provider_installation_id, String(REPO_ID))
    expect(branchCalls()).toBe(afterBranches)

    // Removing an installation drops what was kept for it, so the next visit
    // reads GitHub again instead of a list that may be gone.
    server.hub.github.forget(installation.provider_installation_id)
    await server.hub.github.branches(installation.provider_installation_id, String(REPO_ID))
    expect(branchCalls()).toBe(afterBranches + 1)
  })

  test('a webhook with a bad signature is refused', async () => {
    const res = await webhook('push', { ref: 'refs/heads/main' }, 'wrong-secret')
    expect(res.status).toBe(401)
  })
})

describe('Git: console pickers', () => {
  test('a polling card keeps its target and select out of the links inside it', () => {
    // hx-target and hx-select are inherited. Without hx-disinherit, a
    // deployment link inside the polling deployments card swaps the detail
    // page into that card instead of navigating, leaving the page blank
    // while a build runs.
    const attrs = String(poll('/console/sites/web', 'deployments', 2))
    expect(attrs).toContain('hx-select="#deployments"')
    expect(attrs).toContain('hx-target="#deployments"')
    expect(attrs).toContain('hx-disinherit="*"')
  })

  test('the branch select starts on the default, keeps an unlisted branch, and falls back to typing', () => {
    const select = String(branchOptions(['develop', 'main'], 'main', 'main'))
    expect(select).toContain('<option value="main" selected>main (default)</option>')
    expect(select).toContain('value="develop"')
    expect(select).toContain('>develop</option>')
    // A branch GitHub no longer lists stays selected instead of being replaced.
    expect(String(branchOptions(['main'], 'old-branch', 'main'))).toContain('<option value="old-branch" selected>old-branch</option>')
    // GitHub could not be read: the form still takes a typed branch.
    const fallback = String(branchOptions([], 'main', '', 'GitHub is down'))
    expect(fallback).toContain('<input name="provider_branch" class="mono" value="main"')
    expect(fallback).toContain('GitHub is down')
  })

  test('picking a repository loads its branches into the branch field', () => {
    const select = String(repositoryOptions([{ id: 500, full_name: 'acme/web', private: true }], '', { installationId: 'inst', branchTarget: 'branch-create-site' }))
    expect(select).toContain('hx-get="/console/vcs/branches?installation_id=inst"')
    expect(select).toContain('hx-target="#branch-create-site"')
    expect(select).toContain('hx-trigger="load, change"')
    // Without a branch field to fill, the select is a plain select.
    expect(String(repositoryOptions([{ id: 500, full_name: 'acme/web', private: false }]))).not.toContain('hx-get')
    // Long lists (repositories, branches) are filterable comboboxes.
    expect(select).toContain('data-combobox="Repository"')
    expect(String(branchOptions(['main'], 'main', 'main'))).toContain('data-combobox="Production branch"')
  })
})

describe('Git: deployments', () => {
  test('connecting a site builds the production branch and goes live', async () => {
    const res = await api('/sites', {
      method: 'POST',
      body: JSON.stringify({ siteId: 'web', name: 'Web', framework: 'other', installationId, providerRepositoryId: String(REPO_ID), providerBranch: 'main' }),
    })
    expect(res.status).toBe(201)
    const site = (await res.json()) as any
    expect(site).toMatchObject({ installationId, providerRepositoryId: String(REPO_ID), providerBranch: 'main', providerSilentMode: false })
    await server.hub.settled()
    expect(await (await visit('web')).text()).toBe('<h1>v1</h1>')
    const live = server.services.sites.deployment('web', server.services.sites.site('web').deployment_id)
    expect(live).toMatchObject({ type: 'vcs', provider_branch: 'main', provider_repository: 'acme/web', provider_commit_author: 'dev' })
    const model = (await (await api(`/sites/web/deployments/${live.id}`)).json()) as any
    expect(model).toMatchObject({ type: 'vcs', providerRepositoryOwner: 'acme', providerRepositoryName: 'web', providerBranch: 'main', providerRepositoryUrl: `${gh}/acme/web` })
    const context = `bunwrite/${PROJECT}/sites/web`
    expect(statuses(context).map((c) => c.body.state)).toEqual(['pending', 'success'])
  })

  test('a push to the production branch replaces the live site', async () => {
    const sha = commit('main', { 'index.html': '<h1>v2</h1>', 'api/index.js': 'module.exports = async ({ res }) => res.text("fn v2")' })
    expect((await push('main', sha)).status).toBe(202)
    expect(await (await visit('web')).text()).toBe('<h1>v2</h1>')
  })

  test('[skip ci] commits are not built', async () => {
    const before = server.services.sites.deployments('web').length
    const sha = commit('main', { 'index.html': '<h1>v2</h1>', 'api/index.js': 'module.exports = async ({ res }) => res.text("fn v2")', 'README.md': 'docs' }, 'docs only [skip ci]')
    await push('main', sha)
    expect(server.services.sites.deployments('web').length).toBe(before)
  })

  test('another branch gets a preview host and a PR comment, and the live site stays', async () => {
    const sha = commit('feature/login', { 'index.html': '<h1>login</h1>' })
    pulls.set(7, pullJson(7, 'feature/login', sha, false))
    openPulls.set('feature/login', 7)
    await push('feature/login', sha)
    expect(await (await visit('web')).text()).toBe('<h1>v2</h1>')
    expect(await (await visit('web--git-feature-login')).text()).toBe('<h1>login</h1>')
    const created = calls.filter((c) => c.method === 'POST' && c.path === '/repos/acme/web/issues/7/comments')
    expect(created).toHaveLength(1)
    expect(lastComment()).toContain('✅ Ready')
    expect(lastComment()).toContain('web--git-feature-login')

    // The next push edits the same comment and the branch host moves on.
    const next = commit('feature/login', { 'index.html': '<h1>login 2</h1>' })
    await push('feature/login', next)
    expect(await (await visit('web--git-feature-login')).text()).toBe('<h1>login 2</h1>')
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/repos/acme/web/issues/7/comments')).toHaveLength(1)
    expect(calls.some((c) => c.method === 'PATCH' && c.path.startsWith('/repos/acme/web/issues/comments/'))).toBe(true)
    // Only one preview build of the branch is kept.
    const previews = server.services.sites.deployments('web').filter((d) => d.provider_branch === 'feature/login' && d.status === 'ready')
    expect(previews).toHaveLength(1)
  })

  test('deleting the branch drops its preview', async () => {
    await webhook('delete', { ref_type: 'branch', ref: 'feature/login', repository: { id: REPO_ID } })
    expect(server.services.sites.resolveHost(`web--git-feature-login.sites.localhost`)).toBeNull()
    expect(server.services.sites.deployments('web').some((d) => d.provider_branch === 'feature/login')).toBe(false)
  })

  test('a fork pull request builds only after approval', async () => {
    const sha = commit('stranger-patch', { 'index.html': '<h1>fork</h1>' })
    pulls.set(9, pullJson(9, 'stranger-patch', sha, true))
    const before = server.services.sites.deployments('web').length
    await webhook('pull_request', { action: 'opened', pull_request: pulls.get(9), repository: { id: REPO_ID } })
    expect(server.services.sites.deployments('web').length).toBe(before)
    const comment = calls.filter((c) => c.method === 'POST' && c.path === '/repos/acme/web/issues/9/comments')
    expect(comment).toHaveLength(1)
    expect(lastComment()).toContain('Approve builds')

    const link = server.hub.links.forResource(PROJECT, 'site', 'web')!
    const approved = await api(`/vcs/github/installations/${installationId}/repositories/${link.id}`, { method: 'PATCH', body: JSON.stringify({ providerPullRequestId: '9' }) })
    expect(approved.status).toBe(200)
    expect(((await approved.json()) as any).providerPullRequestIds).toEqual(['9'])
    await server.hub.settled()
    expect(await (await visit('web--git-pr-9')).text()).toBe('<h1>fork</h1>')
    const again = await api(`/vcs/github/installations/${installationId}/repositories/${link.id}`, { method: 'PATCH', body: JSON.stringify({ providerPullRequestId: '9' }) })
    expect(again.status).toBe(409)

    await webhook('pull_request', { action: 'closed', pull_request: pulls.get(9), repository: { id: REPO_ID } })
    expect(server.services.sites.resolveHost('web--git-pr-9.sites.localhost')).toBeNull()
  })

  test('a function from a root directory, deployed with createVcsDeployment, in silent mode', async () => {
    const res = await api('/functions', {
      method: 'POST',
      body: JSON.stringify({ functionId: 'api', name: 'API', runtime: 'node-22', entrypoint: 'index.js', execute: ['any'], installationId, providerRepositoryId: String(REPO_ID), providerRootDirectory: 'api', providerSilentMode: true }),
    })
    expect(res.status).toBe(201)
    await server.hub.settled()
    const fn = server.services.functions.fn('api')
    expect(fn.provider_branch).toBe('main')
    expect(fn.deployment_id).not.toBe('')
    const run = (await (await api('/functions/api/executions', { method: 'POST', body: JSON.stringify({}) })).json()) as any
    expect(run.responseBody).toBe('fn v2')

    const vcs = await api('/functions/api/deployments/vcs', { method: 'POST', body: JSON.stringify({ type: 'branch', reference: 'main', activate: false }) })
    expect(vcs.status).toBe(202)
    const d = (await vcs.json()) as any
    expect(d.type).toBe('vcs')
    await server.hub.settled()
    expect(((await (await api(`/functions/api/deployments/${d.$id}`)).json()) as any).status).toBe('ready')
    expect(statuses(`bunwrite/${PROJECT}/functions/api`)).toHaveLength(0)
    expect((await api('/functions/api/deployments/vcs', { method: 'POST', body: JSON.stringify({ type: 'branch', reference: 'nope' }) })).status).toBe(400)
  })

  test('an SSR site builds from Git and runs its app', async () => {
    const app = `Bun.serve({ hostname: process.env.HOST, port: Number(process.env.PORT), fetch: () => new Response(require('node:fs').existsSync('built.txt') ? 'ssr built' : 'ssr raw') })`
    const sha = commit('ssr', { 'server.js': app })
    const res = await api('/sites', {
      method: 'POST',
      body: JSON.stringify({ siteId: 'app', name: 'App', framework: 'hono', adapter: 'ssr', installCommand: '', buildCommand: 'echo ok > built.txt', startCommand: 'bun server.js', installationId, providerRepositoryId: String(REPO_ID), providerBranch: 'ssr' }),
    })
    expect(res.status).toBe(201)
    await server.hub.settled()
    expect(server.services.sites.deployment('app', server.services.sites.site('app').deployment_id).provider_commit_hash).toBe(sha)
    expect(await (await visit('app')).text()).toBe('ssr built')
  })

  test('the console shows the app, installations, the repository card and Git sources, and creates a site from Git', async () => {
    const auth = new ConsoleAuth(server.db)
    await auth.upsert('git-admin@example.com', 'console-password')
    const cookie = `bunwrite_console=${(await auth.login('git-admin@example.com', 'console-password'))!}; console_project=${PROJECT}`
    const get = async (path: string) => {
      const res = await fetch(`${base()}${path}`, { headers: { cookie }, redirect: 'manual' })
      return { status: res.status, text: await res.text(), location: res.headers.get('location') ?? '' }
    }
    const post = (path: string, fields: Record<string, string>) =>
      fetch(`${base()}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), redirect: 'manual' })

    const org = await get('/console/organization')
    expect(org.text).toContain('id="github-app"')
    expect(org.text).toContain('VCS_GITHUB_* variables')
    expect(org.text).toContain('/v1/vcs/github/events')

    const git = await get('/console/settings/git')
    expect(git.text).toContain('GitHub installations')
    expect(git.text).toContain('acme')
    // Add installation leaves the console for GitHub, also when htmx sends the request.
    expect(git.text).toContain('href="/console/vcs/install" hx-boost="false"')
    const install = await get('/console/vcs/install')
    expect(install.status).toBe(303)
    expect(install.location).toStartWith(`${gh}/apps/bunwrite-test/installations/new?state=`)
    const boosted = await fetch(`${base()}/console/vcs/install`, { headers: { cookie, 'hx-request': 'true' }, redirect: 'manual' })
    expect(boosted.headers.get('hx-redirect')).toStartWith(`${gh}/apps/bunwrite-test/installations/new?state=`)

    const settings = await get('/console/sites/web/settings')
    expect(settings.text).toContain('id="git-repository"')
    expect(settings.text).toContain('acme/web')
    expect(settings.text).toContain('Deploy main now')
    // A connected repository fills the Production branch select on its own.
    expect(settings.text).toContain('/console/vcs/branches?installation_id=')
    expect(settings.text).toContain('selected=main')

    const list = await get('/console/sites/web')
    expect(list.text).toContain('Source')
    expect(list.text).toContain(server.services.sites.deployment('web', server.services.sites.site('web').deployment_id).provider_commit_hash.slice(0, 7))

    const sites = await get('/console/sites/new')
    expect(sites.text).toContain('value="github"')
    // Like Create function: the starter is the default and GitHub is last.
    const sourceChoices = (text: string) => [...text.matchAll(/name="source" value="([a-z]+)"/g)].map((m) => m[1])
    expect(sourceChoices(sites.text)).toEqual(['starter', 'upload', 'paste', 'github'])
    expect(sites.text).not.toMatch(/value="github"[^>]*checked/)
    // The repository list swaps into its own field; the detect target must not
    // follow it, or the list lands in the build fields and the picker stays "Loading…".
    expect(sites.text).toContain('hx-target="this"')
    expect(sites.text).toContain('hx-disinherit="*"')
    expect(sites.text).toContain('id="branch-create-site"')
    const functions = await get('/console/functions/new')
    expect(functions.text).toContain('value="github"')
    expect(sourceChoices(functions.text)).toEqual(['template', 'upload', 'paste', 'github'])
    const repos = await get(`/console/vcs/repositories?installation_id=${installationId}&branch_target=branch-create-site`)
    expect(repos.text).toContain('acme/web (private)')
    expect(repos.text).toContain('hx-target="#branch-create-site"')
    // Opening the page again reads the list from memory, not from GitHub.
    const repoFetches = calls.filter((c) => c.path.startsWith('/installation/repositories')).length
    expect((await get(`/console/vcs/repositories?installation_id=${installationId}&branch_target=branch-create-site`)).text).toContain('acme/web (private)')
    expect(calls.filter((c) => c.path.startsWith('/installation/repositories')).length).toBe(repoFetches)
    expect((await get(`/console/vcs/branches?installation_id=${installationId}&provider_repository_id=${REPO_ID}`)).text).toContain(
      '<option value="main" selected>main (default)</option>',
    )
    // GitHub cannot be read: the branch stays editable instead of empty.
    expect((await get(`/console/vcs/branches?installation_id=${installationId}&provider_repository_id=31337`)).text).toContain('<input name="provider_branch"')

    const approve = await get(`/console/vcs/approve?repository=${server.hub.links.forResource(PROJECT, 'site', 'web')!.id}&pr=9`)
    expect(approve.text).toContain('This pull request is approved')

    // Create a site straight from the repository; detection picks the framework.
    const created = await post('/console/sites', { name: 'From Git', id: 'from-git', framework: 'other', source: 'github', installation_id: installationId, provider_repository_id: String(REPO_ID), provider_branch: 'main', detect: 'on' })
    expect(created.status).toBe(303)
    await server.hub.settled()
    expect(server.services.sites.site('from-git').provider_repository_id).toBe(String(REPO_ID))
    expect(await (await visit('from-git')).text()).toBe('<h1>v2</h1>')

    // Change the branch from the settings card: it deploys the new branch.
    commit('release', { 'index.html': '<h1>release</h1>' })
    const saved = await post('/console/sites/from-git/git', { installation_id: installationId, provider_repository_id: String(REPO_ID), provider_branch: 'release', provider_root_directory: '' })
    expect(saved.status).toBe(303)
    await server.hub.settled()
    expect(await (await visit('from-git')).text()).toBe('<h1>release</h1>')
    const detail = await get(`/console/sites/from-git/deployments/${server.services.sites.site('from-git').deployment_id}`)
    expect(detail.text).toContain('<h2>Source</h2>')
    expect(detail.text).toContain('release')
  })

  test('disconnecting stops deploys, and removing the installation unlinks everything', async () => {
    const off = await api('/sites/app', { method: 'PUT', body: JSON.stringify({ name: 'App', framework: 'hono', installationId: '', providerRepositoryId: '' }) })
    expect(((await off.json()) as any).providerRepositoryId).toBe('')
    expect(server.hub.links.forResource(PROJECT, 'site', 'app')).toBeNull()

    expect((await api(`/vcs/installations/${installationId}`, { method: 'DELETE' })).status).toBe(204)
    expect(server.services.sites.site('web').provider_repository_id).toBe('')
    expect(server.services.functions.fn('api').installation_id).toBe('')
    expect(server.hub.links.byRepository(String(REPO_ID))).toHaveLength(0)
    // Disconnecting keeps what was deployed.
    expect(existsSync(sitesDir(server.config, 'web'))).toBe(true)
    expect(await (await visit('web')).text()).toBe('<h1>v2</h1>')
  })
})
