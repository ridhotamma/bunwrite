import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Client, Project, Sites } from 'node-appwrite'

import type { SiteDeploymentRow, SiteSettings } from '~/sites/service'
import { KEY, PROJECT, startServer, testSchema, type TestServer } from './helpers'

let dir: string
let server: TestServer
let client: Client
let sites: Sites
let project: Project

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

function archive(files: Record<string, string>): Blob {
  const src = mkdtempSync(join(dir, 'src-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(src, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  const out = join(src, '..', `${Math.random().toString(36).slice(2)}.tar.gz`)
  const tar = Bun.spawnSync(['tar', '-czf', out, '-C', src, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString())
  return new Blob([readFileSync(out)], { type: 'application/gzip' })
}

const siteSettings = (over: Partial<SiteSettings> = {}): SiteSettings => ({
  name: 'Variables',
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
  pruneMode: 'auto',
  ...over,
})

async function deploy(siteId: string, files: Record<string, string>): Promise<SiteDeploymentRow> {
  const first = await server.services.sites.upload(server.services.sites.site(siteId), {
    code: archive(files),
    activate: true,
    contentRange: null,
    uploadId: null,
  })
  return until(
    `deployment ${first.id}`,
    () => server.services.sites.deployment(siteId, first.id),
    (d) => d.status === 'ready' || d.status === 'failed',
  )
}

const visit = (siteId: string, path = '/') =>
  fetch(`http://127.0.0.1:${server.config.port}${path}`, {
    headers: { host: `${siteId}.sites.localhost:${server.config.port}` },
  })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bunwrite-variables-'))
  server = startServer(testSchema, { storagePath: join(dir, 'storage') }, dir)
  client = new Client().setEndpoint(server.endpoint).setProject(PROJECT).setKey(KEY)
  sites = new Sites(client)
  project = new Project(client)
})

afterAll(() => {
  for (const site of server.services.sites.list()) server.services.sites.remove(site.id)
  server.services.sites.stop()
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('project variables', () => {
  test('create, list, update and delete', async () => {
    const created = await project.createVariable({
      variableId: 'project-var',
      key: 'PROJECT_TEST',
      value: 'one',
      secret: false,
    })
    expect(created.$id).toBe('project-var')
    expect(created.resourceType).toBe('project')
    expect(created.resourceId).toBe('')
    expect(created.value).toBe('one')

    const listed = await project.listVariables()
    expect(listed.variables.some((v) => v.$id === 'project-var')).toBe(true)

    const updated = await project.updateVariable({
      variableId: 'project-var',
      value: 'two',
    })
    expect(updated.value).toBe('two')

    await project.deleteVariable({ variableId: 'project-var' })
    const after = await project.listVariables()
    expect(after.variables.some((v) => v.$id === 'project-var')).toBe(false)
  })

  test('the console can use the same key in the project and site scopes', () => {
    server.services.variables.setVariable('project', 'SHARED_CONSOLE', 'project', false)
    server.services.variables.setVariable('site:console-scope', 'SHARED_CONSOLE', 'site', false)
    expect(server.services.variables.projectEnvironment().SHARED_CONSOLE).toBe('project')
    expect(server.services.variables.siteEnvironment('console-scope').SHARED_CONSOLE).toBe('site')
  })

  test('project variables reach function runs too', () => {
    server.services.variables.setVariable('project', 'FUNCTION_PROJECT', 'yes', false)
    const fn = server.services.functions.create('env-fn', {
      name: 'Env',
      runtime: 'bun-1.4',
      execute: ['any'],
      events: [],
      schedule: '',
      timeout: 15,
      enabled: true,
      logging: true,
      entrypoint: 'index.js',
      commands: '',
      scopes: [],
      buildSpecification: 's-1vcpu-512mb',
      runtimeSpecification: 's-1vcpu-512mb',
      deploymentRetention: 0,
    })
    expect(server.services.functions.env(fn, 'http').FUNCTION_PROJECT).toBe('yes')
  })

  test('secret values are not returned', async () => {
    const created = await project.createVariable({
      variableId: 'project-secret',
      key: 'PROJECT_SECRET',
      value: 'hidden',
      secret: true,
    })
    expect(created.value).toBe('')
    expect(created.secret).toBe(true)
    const fetched = await project.getVariable({ variableId: 'project-secret' })
    expect(fetched.value).toBe('')
    await project.deleteVariable({ variableId: 'project-secret' })
  })
})

describe('site variables', () => {
  test('create, list, update and delete', async () => {
    await sites.create({
      siteId: 'vars',
      name: 'Vars',
      framework: 'other' as any,
      buildRuntime: 'static-1' as any,
    })

    const created = await sites.createVariable({
      siteId: 'vars',
      variableId: 'site-var',
      key: 'SITE_TEST',
      value: 'one',
      secret: false,
    })
    expect(created.$id).toBe('site-var')
    expect(created.resourceType).toBe('site')
    expect(created.resourceId).toBe('vars')

    const listed = await sites.listVariables({ siteId: 'vars' })
    expect(listed.variables.some((v) => v.$id === 'site-var')).toBe(true)

    const updated = await sites.updateVariable({
      siteId: 'vars',
      variableId: 'site-var',
      value: 'two',
    })
    expect(updated.value).toBe('two')

    await sites.deleteVariable({ siteId: 'vars', variableId: 'site-var' })
    const after = await sites.listVariables({ siteId: 'vars' })
    expect(after.variables.some((v) => v.$id === 'site-var')).toBe(false)
  })

  test('a site can be created with variables in its model', async () => {
    const fetched = await sites.get({ siteId: 'vars' })
    expect(Array.isArray(fetched.vars)).toBe(true)
  })
})

describe('runtime environment', () => {
  test('project variables apply, and a site variable wins', async () => {
    await project.createVariable({
      variableId: 'project-shared',
      key: 'SHARED_RUNTIME',
      value: 'project',
      secret: false,
    })
    await project.createVariable({
      variableId: 'project-only',
      key: 'PROJECT_ONLY',
      value: 'from-project',
      secret: false,
    })

    server.services.sites.create('env-site', siteSettings())
    await sites.createVariable({
      siteId: 'env-site',
      variableId: 'site-shared',
      key: 'SHARED_RUNTIME',
      value: 'site',
      secret: false,
    })
    await sites.createVariable({
      siteId: 'env-site',
      variableId: 'site-only',
      key: 'SITE_ONLY',
      value: 'from-site',
      secret: false,
    })

    const deployment = await deploy('env-site', {
      'server.js': `Bun.serve({
  hostname: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT),
  fetch() {
    return Response.json({
      shared: process.env.SHARED_RUNTIME,
      project: process.env.PROJECT_ONLY,
      site: process.env.SITE_ONLY,
    })
  },
})
`,
    })
    expect(deployment.status).toBe('ready')

    const response = await visit('env-site')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      shared: 'site',
      project: 'from-project',
      site: 'from-site',
    })
  })
})
