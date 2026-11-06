/**
 * Deployment retention and bulk deletion for sites and functions.
 *
 * Retention is a per-resource number of days. Only deployments that are
 * neither live nor in progress may be removed, whether by the automatic
 * cleanup or by the checkbox bulk action in the console.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ConsoleAuth } from '~/console/auth'
import { Deployments, deploymentDir } from '~/functions/deployments'
import type { FunctionSettings } from '~/functions/service'
import { PROJECT, startServer, type TestServer } from './helpers'
import { sitesDir } from '~/sites/paths'
import type { SiteSettings } from '~/sites/service'

let server: TestServer
let base: string
let cookie = ''

const OLD = '2020-01-01T00:00:00.000+00:00'
const NEW = '2999-01-01T00:00:00.000+00:00'

const siteSettings = (over: Partial<SiteSettings> = {}): SiteSettings => ({
  name: 'Retention site',
  enabled: true,
  framework: 'other',
  outputDirectory: '',
  fallbackFile: '',
  domains: [],
  apiFunctionId: '',
  installCommand: '',
  buildCommand: '',
  startCommand: '',
  buildRuntime: '',
  adapter: 'static',
  pruneMode: 'auto',
  deploymentRetention: 1,
  ...over,
})

const functionSettings = (over: Partial<FunctionSettings> = {}): FunctionSettings => ({
  name: 'Retention function',
  runtime: 'node-22',
  execute: [],
  events: [],
  schedule: '',
  timeout: 15,
  enabled: true,
  logging: true,
  entrypoint: 'src/main.js',
  commands: '',
  scopes: [],
  buildSpecification: 's-1vcpu-512mb',
  runtimeSpecification: 's-1vcpu-512mb',
  deploymentRetention: 1,
  ...over,
})

/** A deployment row without running a real upload or build. */
function addSiteDeployment(siteId: string, id: string, createdAt: string, status = 'ready') {
  server.db.sqlite
    .query('INSERT INTO _site_deployments (id, site_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, siteId, status, createdAt, createdAt)
}

function addFunctionDeployment(functionId: string, id: string, createdAt: string, status = 'ready') {
  server.db.sqlite
    .query('INSERT INTO _deployments (id, function_id, entrypoint, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, functionId, 'src/main.js', status, createdAt, createdAt)
}

function makeLiveSite(siteId: string, deploymentId: string) {
  server.db.sqlite.query('UPDATE _sites SET deployment_id = ? WHERE id = ?').run(deploymentId, siteId)
  server.services.sites.reload()
}

function makeLiveFunction(functionId: string, deploymentId: string) {
  server.db.sqlite.query('UPDATE _functions SET deployment_id = ? WHERE id = ?').run(deploymentId, functionId)
}

async function post(path: string, fields: Record<string, string | string[]>) {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) body.append(key, one)
  }
  return fetch(`${base}${path}`, {
    method: 'POST',
    body,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
  })
}

beforeAll(async () => {
  server = startServer()
  base = server.endpoint.replace(/\/v1$/, '')
  const auth = new ConsoleAuth(server.db)
  await auth.upsert('retention@example.com', 'console-password')
  cookie = `bunwrite_console=${(await auth.login('retention@example.com', 'console-password'))!}; console_project=${PROJECT}`
})

afterAll(() => server.stop())

describe('deployment retention', () => {
  test('sites delete old non-live deployments only', async () => {
    const sites = server.services.sites
    const site = await sites.create('retention-site', siteSettings({ deploymentRetention: 1 }))
    addSiteDeployment(site.id, 'site-live', OLD)
    addSiteDeployment(site.id, 'site-old', OLD)
    addSiteDeployment(site.id, 'site-building', OLD, 'building')
    makeLiveSite(site.id, 'site-live')

    expect(await sites.pruneDeployments()).toBe(1)
    expect((await sites.deployment(site.id, 'site-live')).id).toBe('site-live')
    expect((await sites.deployment(site.id, 'site-building')).status).toBe('building')
    await expect(sites.deployment(site.id, 'site-old')).rejects.toThrow()

    await sites.remove(site.id)
  })

  test('a site keeps every deployment when retention is 0', async () => {
    const sites = server.services.sites
    const site = await sites.create('keep-site', siteSettings({ deploymentRetention: 0 }))
    addSiteDeployment(site.id, 'keep-old', OLD)

    expect(await sites.pruneDeployments()).toBe(0)
    expect((await sites.deployment(site.id, 'keep-old')).id).toBe('keep-old')

    await sites.remove(site.id)
  })

  test('functions delete old non-active deployments only', async () => {
    const functions = server.services.functions
    const f = await functions.create('retention-fn', functionSettings({ deploymentRetention: 1 }))
    addFunctionDeployment(f.id, 'fn-active', OLD)
    addFunctionDeployment(f.id, 'fn-old', OLD)
    addFunctionDeployment(f.id, 'fn-building', OLD, 'building')
    makeLiveFunction(f.id, 'fn-active')

    expect(await functions.pruneDeployments()).toBe(1)
    const remaining = server.db.sqlite
      .query<{ id: string }, [string]>('SELECT id FROM _deployments WHERE function_id = ? ORDER BY id')
      .all(f.id)
      .map((row) => row.id)
    expect(remaining).toEqual(['fn-active', 'fn-building'])

    await functions.remove(f.id)
  })

  test('retention 0 keeps every deployment after a new one goes live', async () => {
    const sites = server.services.sites
    const functions = server.services.functions
    const deployments = new Deployments(server.services.db, server.config, functions)

    const site = await sites.create('keep-live-site', siteSettings({ deploymentRetention: 0 }))
    const f = await functions.create('keep-live-fn', functionSettings({ deploymentRetention: 0 }))
    for (let i = 0; i < 8; i++) {
      addSiteDeployment(site.id, `keep-live-site-${i}`, NEW)
      addFunctionDeployment(f.id, `keep-live-fn-${i}`, NEW)
    }

    await sites.activate(site.id, 'keep-live-site-7')
    await deployments.activate(f.id, 'keep-live-fn-7')

    expect(await sites.deployments(site.id)).toHaveLength(8)
    expect(await deployments.list(f.id)).toHaveLength(8)

    await sites.remove(site.id)
    await functions.remove(f.id)
  })

  test('a worker with a stale site cache cannot prune the deployment another worker made live', async () => {
    const sites = server.services.sites
    const site = await sites.create('stale-cache-site', siteSettings({ deploymentRetention: 1 }))
    addSiteDeployment(site.id, 'stale-cache-old', OLD)
    addSiteDeployment(site.id, 'stale-cache-live', OLD)
    const liveCode = join(sitesDir(server.config, site.id, 'stale-cache-live'), 'index.html')
    mkdirSync(join(sitesDir(server.config, site.id, 'stale-cache-live')), { recursive: true })
    writeFileSync(liveCode, '<h1>live</h1>')
    // This worker's cache names stale-cache-old as live.
    makeLiveSite(site.id, 'stale-cache-old')
    // Another worker activates stale-cache-live; do not reload this worker's cache.
    server.db.sqlite.query('UPDATE _sites SET deployment_id = ? WHERE id = ?').run('stale-cache-live', site.id)

    expect(await sites.pruneDeployments()).toBe(1)
    expect((await sites.deployment(site.id, 'stale-cache-live')).id).toBe('stale-cache-live')
    expect(existsSync(liveCode)).toBe(true)
    await expect(sites.deployment(site.id, 'stale-cache-old')).rejects.toThrow()

    await sites.remove(site.id)
  })

  test('deleting through a stale site cache never removes the live deployment', async () => {
    const sites = server.services.sites
    const site = await sites.create('stale-delete-site', siteSettings({ deploymentRetention: 0 }))
    addSiteDeployment(site.id, 'stale-delete-old', NEW)
    addSiteDeployment(site.id, 'stale-delete-live', NEW)
    makeLiveSite(site.id, 'stale-delete-old')
    server.db.sqlite.query('UPDATE _sites SET deployment_id = ? WHERE id = ?').run('stale-delete-live', site.id)

    await expect(sites.removeDeployment(site.id, 'stale-delete-live')).rejects.toThrow(/live/i)
    expect((await sites.deployment(site.id, 'stale-delete-live')).id).toBe('stale-delete-live')

    await sites.remove(site.id)
  })

  test('a deployment that a branch preview is serving is not pruned', async () => {
    const sites = server.services.sites
    const site = await sites.create('branch-preview-site', siteSettings({ deploymentRetention: 1 }))
    addSiteDeployment(site.id, 'branch-preview-live', OLD)
    addSiteDeployment(site.id, 'branch-preview-build', OLD)
    makeLiveSite(site.id, 'branch-preview-live')
    server.db.sqlite
      .query('INSERT INTO _site_branches (site_id, branch, slug, deployment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(site.id, 'feature/login', 'feature-login', 'branch-preview-build', OLD, OLD)

    expect(await sites.pruneDeployments()).toBe(0)
    expect((await sites.deployment(site.id, 'branch-preview-build')).id).toBe('branch-preview-build')

    await sites.remove(site.id)
  })

  test('a stale function read cannot prune the active deployment', async () => {
    const functions = server.services.functions
    const deployments = new Deployments(server.services.db, server.config, functions)
    const f = await functions.create('stale-active-fn', functionSettings({ deploymentRetention: 1 }))
    for (let i = 0; i < 5; i++) addFunctionDeployment(f.id, `stale-active-fn-${i}`, NEW)
    const liveCode = join(deploymentDir(server.config, f.id, 'stale-active-fn-0'), 'src/main.js')
    mkdirSync(join(deploymentDir(server.config, f.id, 'stale-active-fn-0'), 'src'), { recursive: true })
    writeFileSync(liveCode, 'export default () => new Response("live")')
    makeLiveFunction(f.id, 'stale-active-fn-0')

    // Simulate another worker's pre-activation view: this process thinks
    // stale-active-fn-4 is active while the database says ...-0 is.
    const original = functions.fn.bind(functions)
    ;(functions as any).fn = async (id: string) => {
      const row = await original(id)
      return id === f.id ? { ...row, deployment_id: 'stale-active-fn-4' } : row
    }
    try {
      await deployments.prune(f.id)
    } finally {
      delete (functions as any).fn
    }

    expect((await deployments.get(f.id, 'stale-active-fn-0')).id).toBe('stale-active-fn-0')
    expect(existsSync(liveCode)).toBe(true)

    await functions.remove(f.id)
  })
})

describe('list bulk delete', () => {
  test('the sites list deletes the selected sites', async () => {
    const sites = server.services.sites
    await sites.create('list-site-one', siteSettings())
    await sites.create('list-site-two', siteSettings())
    await sites.create('list-site-three', siteSettings())

    const page = await (await fetch(`${base}/console/sites`, { headers: { cookie } })).text()
    expect(page).toContain('data-bulk-select-all')
    expect(page).toContain('value="list-site-one"')

    const res = await post('/console/sites/bulk-delete', { ids: ['list-site-one', 'list-site-two'] })
    expect(res.status).toBe(303)
    expect(sites.list().map((site) => site.id)).toEqual(['list-site-three'])

    await sites.remove('list-site-three')
  })

  test('the functions list deletes the selected functions', async () => {
    const functions = server.services.functions
    functions.create('list-fn-one', functionSettings())
    functions.create('list-fn-two', functionSettings())
    functions.create('list-fn-three', functionSettings())

    const page = await (await fetch(`${base}/console/functions`, { headers: { cookie } })).text()
    expect(page).toContain('data-bulk-select-all')
    expect(page).toContain('value="list-fn-one"')

    const res = await post('/console/functions/bulk-delete', { ids: ['list-fn-one', 'list-fn-two'] })
    expect(res.status).toBe(303)
    expect((await functions.list()).map((f) => f.id)).toEqual(['list-fn-three'])

    await functions.remove('list-fn-three')
  })
})

describe('deployment bulk delete', () => {
  test('the sites deployments table has checkboxes and deletes the selected rows', async () => {
    const sites = server.services.sites
    const site = await sites.create('bulk-site', siteSettings())
    addSiteDeployment(site.id, 'bulk-one', NEW)
    addSiteDeployment(site.id, 'bulk-two', NEW)
    addSiteDeployment(site.id, 'bulk-live', NEW)
    makeLiveSite(site.id, 'bulk-live')

    const page = await (await fetch(`${base}/console/sites/${site.id}`, { headers: { cookie } })).text()
    expect(page).toContain('data-bulk-select-all')
    expect(page).toContain('name="ids"')
    expect(page).toContain('value="bulk-one"')

    const res = await post(`/console/sites/${site.id}/deployments/bulk-delete`, { ids: ['bulk-one', 'bulk-two', 'bulk-live'] })
    expect(res.status).toBe(303)
    expect((await sites.deployments(site.id)).map((d) => d.id)).toEqual(['bulk-live'])

    await sites.remove(site.id)
  })

  test('the functions deployments table has checkboxes and deletes the selected rows', async () => {
    const functions = server.services.functions
    const f = await functions.create('bulk-fn', functionSettings())
    addFunctionDeployment(f.id, 'bulk-fn-one', NEW)
    addFunctionDeployment(f.id, 'bulk-fn-two', NEW)
    addFunctionDeployment(f.id, 'bulk-fn-active', NEW)
    makeLiveFunction(f.id, 'bulk-fn-active')

    const page = await (await fetch(`${base}/console/functions/${f.id}/deployments`, { headers: { cookie } })).text()
    expect(page).toContain('data-bulk-select-all')
    expect(page).toContain('name="ids"')
    expect(page).toContain('value="bulk-fn-one"')

    const res = await post(`/console/functions/${f.id}/deployments/bulk-delete`, { ids: ['bulk-fn-one', 'bulk-fn-two', 'bulk-fn-active'] })
    expect(res.status).toBe(303)
    const remaining = server.db.sqlite
      .query<{ id: string }, [string]>('SELECT id FROM _deployments WHERE function_id = ?')
      .all(f.id)
      .map((row) => row.id)
    expect(remaining).toEqual(['bulk-fn-active'])

    await functions.remove(f.id)
  })
})
