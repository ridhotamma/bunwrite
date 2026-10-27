import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, Databases, Users } from 'node-appwrite'

import { createApp, createServices } from '~/app'
import { ConsoleAuth } from '~/console/auth'
import { openDb, type Db } from '~/db/connection'
import { createProjectManager, type ProjectManager } from '~/projects/manager'
import { pushConfig } from '~/schema/push'
import { KEY, PROJECT, testConfig, testSchema } from './helpers'

describe('multiple projects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bunwrite-projects-'))
  let db: Db
  let manager: ProjectManager
  let endpoint: string
  let base: string
  let server: ReturnType<typeof Bun.serve>
  let projectKey = ''

  const client = (projectId: string, key: string) =>
    new Client().setEndpoint(endpoint).setProject(projectId).setKey(key)

  beforeAll(() => {
    db = openDb(join(dir, 'control.sqlite'))
    pushConfig(db, testSchema, { baseDir: dir })
    const config = testConfig({ databasePath: join(dir, 'control.sqlite'), logRequests: true })
    const services = createServices(config, db)
    manager = createProjectManager({ config, db, services, dataDir: dir })
    const created = manager.create({ id: 'project-b', name: 'Project B', orgId: 'org_test' })
    projectKey = created.apiKey!
    pushConfig(created.project.services.db, testSchema, { baseDir: dir })
    created.project.services.registry.reload()

    const app = createApp(manager)
    server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.websocket })
    endpoint = `http://localhost:${server.port}/v1`
    base = `http://localhost:${server.port}`
    config.publicEndpoint = endpoint
    manager.start()
  })

  afterAll(() => {
    server.stop(true)
    manager.control.requestLogs.flush()
    manager.get('project-b')?.services.requestLogs.flush()
    manager.close()
    db.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('the default project keeps its existing data', async () => {
    const databases = new Databases(client(PROJECT, KEY))
    expect((await databases.listDocuments({ databaseId: 'main', collectionId: 'products' })).total).toBe(0)
  })

  test('a second project has its own database, users and API key', async () => {
    const b = client('project-b', projectKey)
    const databases = new Databases(b)
    await databases.createDocument({ databaseId: 'main', collectionId: 'products', documentId: 'b-only', data: { tenantId: 't1', name: 'B only' } })
    expect((await databases.listDocuments({ databaseId: 'main', collectionId: 'products' })).total).toBe(1)

    expect((await new Databases(client(PROJECT, KEY)).listDocuments({ databaseId: 'main', collectionId: 'products' })).total).toBe(0)
    expect(await new Databases(client(PROJECT, projectKey)).listDocuments({ databaseId: 'main', collectionId: 'products' }).catch((e: any) => e.code)).toBe(401)
    expect(await new Databases(client('project-b', KEY)).listDocuments({ databaseId: 'main', collectionId: 'products' }).catch((e: any) => e.code)).toBe(401)

    const users = new Users(b)
    await users.create({ userId: 'b-user', email: 'b@example.com' })
    expect((await users.list()).total).toBe(1)
    expect((await new Users(client(PROJECT, KEY)).list()).total).toBe(0)
  })

  test('request logs are shared but filtered by project', async () => {
    const aLogs = manager.defaultProject().services.requestLogs.list({ page: 1, limit: 50, project: PROJECT })
    const bLogs = manager.get('project-b')!.services.requestLogs.list({ page: 1, limit: 50, project: 'project-b' })
    expect(aLogs.total).toBeGreaterThan(0)
    expect(bLogs.total).toBeGreaterThan(0)
    expect(aLogs.logs.every((log) => log.project === PROJECT)).toBe(true)
    expect(bLogs.logs.every((log) => log.project === 'project-b')).toBe(true)
  })

  test('the console can list, create and switch projects', async () => {
    const auth = new ConsoleAuth(db)
    await auth.upsert('admin@example.com', 'password-123')
    const secret = (await auth.login('admin@example.com', 'password-123'))!
    const cookie = `bunwrite_console=${secret}`

    const list = await fetch(`${base}/console`, { headers: { cookie } })
    expect(list.status).toBe(200)
    const listHtml = await list.text()
    expect(listHtml).toContain('Project B')
    expect(listHtml).toContain(PROJECT)
    expect(listHtml).toContain('class="org-head"')
    expect(listHtml).toContain('select-topbar')
    expect(listHtml).not.toContain('<nav class="nav">')
    expect(listHtml).toContain('Search projects...')
    expect(listHtml).toContain('class="project-grid"')
    expect(listHtml).toContain('/console/projects/project-b/open')
    expect(listHtml).toContain('Create project')

    const direct = await fetch(`${base}/console/overview`, { headers: { cookie }, redirect: 'manual' })
    expect(direct.status).toBe(303)
    expect(direct.headers.get('location')).toBe('/console')

    const createOpen = await (await fetch(`${base}/console?create=1`, { headers: { cookie } })).text()
    expect(createOpen).toMatch(/<dialog id="create-project" class="dialog" open data-open/)

    const listView = await fetch(`${base}/console?view=list`, { headers: { cookie } })
    expect(await listView.text()).toContain('<table>')
    const search = await fetch(`${base}/console?q=${encodeURIComponent('Project B')}`, { headers: { cookie } })
    expect(await search.text()).toContain('Project B')
    const emptySearch = await fetch(`${base}/console?q=does-not-exist`, { headers: { cookie } })
    expect(await emptySearch.text()).toContain('No matching projects')

    const created = await fetch(`${base}/console`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Project C', id: 'project-c' }),
    })
    expect(created.status).toBe(200)
    const createdHtml = await created.text()
    expect(createdHtml).toContain('id="project-key-dialog"')
    expect(createdHtml).toContain('standard_')
    expect(manager.get('project-c')).not.toBeNull()

    const select = await fetch(`${base}/console/projects/select`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ project: 'project-b', next: '/console/overview' }),
      redirect: 'manual',
    })
    expect(select.status).toBe(303)
    expect(select.headers.get('set-cookie')).toContain('console_project=project-b')

    const home = await fetch(`${base}/console/overview`, { headers: { cookie: `${cookie}; console_project=project-b` } })
    expect(home.status).toBe(200)
    const homeHtml = await home.text()
    expect(homeHtml).toContain('Project B')
    // The sidebar switcher lists every project and keeps you in the same section.
    expect(homeHtml).toContain('class="menu-root switcher"')
    expect(homeHtml).toContain('<input type="hidden" name="project" value="project-c">')
    expect(homeHtml).toContain('<input type="hidden" name="next" value="/console/overview">')

    const edit = await fetch(`${base}/console/projects/project-c/edit`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Project C updated' }),
      redirect: 'manual',
    })
    expect(edit.status).toBe(303)
    expect(manager.get('project-c')!.info.name).toBe('Project C updated')
    expect(manager.get('project-c')!.services.config.projectName).toBe('Project C updated')

    const remove = await fetch(`${base}/console/projects/project-c/delete`, {
      method: 'POST',
      headers: { cookie },
      redirect: 'manual',
    })
    expect(remove.status).toBe(303)
    expect(manager.get('project-c')).toBeNull()
    await expect(manager.delete(PROJECT)).rejects.toThrow('default project')
  })
})
