import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, Databases, Users } from 'node-appwrite'

import { createApp, createServices } from '~/app'
import { ConsoleAuth } from '~/console/auth'
import { openDb, type Db } from '~/db/connection'
import { MemoryMailer } from '~/mail/mailer'
import { OrganizationService } from '~/organizations/service'
import { initialiseControlStore } from '~/projects/control'
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
  let app: ReturnType<typeof createApp>
  let projectKey = ''

  const client = (projectId: string, key: string) => new Client().setEndpoint(endpoint).setProject(projectId).setKey(key)

  beforeAll(async () => {
    const legacyPath = join(dir, 'bunwrite.sqlite')
    const controlPath = join(dir, 'control', 'bunwrite.sqlite')
    db = openDb(controlPath)
    const config = testConfig({ databasePath: legacyPath, controlDatabasePath: controlPath, logRequests: true })
    await initialiseControlStore({
      config,
      databaseOptions: { backend: 'sqlite', path: legacyPath },
      control: db,
      env: { ORG_ID: 'org_test', PROJECT_ID: PROJECT, SECRET: config.secret },
      log: () => {},
    })
    const controlConfig = {
      ...config,
      databasePath: controlPath,
      legacyDatabasePath: legacyPath,
      projectId: 'console',
      orgId: 'org_test',
      projectName: 'Test Project',
      secret: config.secret,
    }
    const services = createServices(controlConfig, db)
    manager = createProjectManager({
      config,
      db,
      services,
      dataDir: dir,
      database: { backend: 'sqlite', path: legacyPath },
    })
    await manager.ready()
    const first = manager.defaultProject()
    pushConfig(first.services.db as Db, testSchema, { baseDir: dir })
    first.services.registry.reload()
    const created = await manager.create({ id: 'project-b', name: 'Project B', orgId: 'org_test' })
    projectKey = created.apiKey!
    pushConfig(created.project.services.db as Db, testSchema, { baseDir: dir })
    created.project.services.registry.reload()
    // An installation from before installations moved to the control database.
    const stamp = new Date().toISOString()
    created.project.services.db
      .sqlite!.query(
        `INSERT INTO _vcs_installations (id, provider, provider_installation_id, organization, account_type, created_at, updated_at)
         VALUES ('legacy-installation', 'github', '999', 'legacy-org', 'Organization', ?, ?)`,
      )
      .run(stamp, stamp)

    app = createApp(manager)
    await app.hub.ready()
    server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.websocket })
    endpoint = `http://localhost:${server.port}/v1`
    base = `http://localhost:${server.port}`
    config.publicEndpoint = endpoint
    manager.start()
  })

  afterAll(async () => {
    server.stop(true)
    await manager.control.requestLogs.flush()
    await manager.get('project-b')?.services.requestLogs.flush()
    await manager.close()
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

  test('preflight finds a project by its allowed origin', async () => {
    const other = manager.get('project-b')!
    const origin = 'https://app.project-b.test'
    await other.services.settings.set('project', {
      projectName: 'Project B',
      allowedOrigins: [origin],
      sessionDuration: 31_536_000,
      sessionsLimit: 10,
    })

    const preflight = await fetch(`${endpoint}/account`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-appwrite-project, x-appwrite-key',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true')

    // An origin no project allows still gets no CORS headers.
    const denied = await fetch(`${endpoint}/account`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.test', 'access-control-request-method': 'GET' },
    })
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('preflight trusts a project site host without listing it', async () => {
    const other = manager.get('project-b')!
    await other.services.settings.set('project', {
      projectName: 'Project B',
      allowedOrigins: [],
      sessionDuration: 31_536_000,
      sessionsLimit: 10,
    })
    await other.services.sites.create('app', {
      name: 'App',
      enabled: true,
      framework: 'other',
      outputDirectory: '',
      fallbackFile: '',
      domains: [],
      apiFunctionId: '',
      installCommand: '',
      buildCommand: '',
      startCommand: '',
      buildRuntime: 'static-1',
      adapter: 'static',
      pruneMode: 'none',
    })
    const origin = 'https://app.sites.localhost'
    const preflight = await fetch(`${endpoint}/account`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'GET' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)

    const actual = await fetch(`${endpoint}/account`, {
      headers: { origin, 'x-appwrite-project': 'project-b' },
    })
    expect(actual.headers.get('access-control-allow-origin')).toBe(origin)
  })

  test('observability settings and feature flags are per project', async () => {
    const other = manager.get('project-b')!
    const control = manager.defaultProject()
    const controlBefore = control.services.observability.config
    await other.services.observabilitySettings.save({
      ...other.services.observabilitySettings.settings,
      serviceName: 'project-b-observability',
      sampleRate: 0.5,
      localFlags: { 'project-b-flag': true },
    })

    expect(other.services.observability.config).toMatchObject({
      serviceName: 'project-b-observability',
      sampleRate: 0.5,
      localFlags: { 'project-b-flag': true },
    })
    expect(control.services.observability.config.serviceName).toBe(controlBefore.serviceName)
    expect(control.services.observability.config.localFlags).not.toHaveProperty('project-b-flag')

    const projectFlags = await fetch(`${endpoint}/flags`, { headers: { 'x-appwrite-project': 'project-b' } })
    expect(((await projectFlags.json()) as { flags: Record<string, unknown> }).flags).toMatchObject({ 'project-b-flag': true })
    const controlFlags = await fetch(`${endpoint}/flags`, { headers: { 'x-appwrite-project': PROJECT } })
    expect(((await controlFlags.json()) as { flags: Record<string, unknown> }).flags).not.toHaveProperty('project-b-flag')
  })

  test('health checks credentials against the project in the header', async () => {
    for (const [project, key] of [
      [PROJECT, KEY],
      ['project-b', projectKey],
    ] as const) {
      const res = await fetch(`${endpoint}/health`, { headers: { 'x-appwrite-project': project, 'x-appwrite-key': key } })
      expect(res.status).toBe(200)
    }

    const wrong = await fetch(`${endpoint}/health`, { headers: { 'x-appwrite-project': 'project-b', 'x-appwrite-key': KEY } })
    expect(wrong.status).toBe(401)

    const unknown = await fetch(`${endpoint}/health`, { headers: { 'x-appwrite-project': 'nope' } })
    expect(unknown.status).toBe(404)

    const noProject = await fetch(`${endpoint}/health`)
    expect(noProject.status).toBe(200)

    const consoleProbe = await fetch(`${endpoint}/health/version`, { headers: { 'x-appwrite-project': 'console' } })
    expect(consoleProbe.status).toBe(200)
  })

  test('GitHub installations are server-wide, and old per-project rows are adopted', async () => {
    // The row written into project-b's database before the hub started is now
    // in the control database, under one ID both projects can use.
    const adopted = await app.hub.installations.byProvider('999')
    expect(adopted).toMatchObject({ organization: 'legacy-org', account_type: 'Organization' })
    const count = db.sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM _vcs_installations WHERE provider_installation_id = '999'").get()!
    expect(count.n).toBe(1)

    for (const [project, key] of [
      [PROJECT, KEY],
      ['project-b', projectKey],
    ] as const) {
      const res = await fetch(`${endpoint}/vcs/installations`, { headers: { 'x-appwrite-project': project, 'x-appwrite-key': key } })
      expect(res.status).toBe(200)
      const list = (await res.json()) as any
      expect(list.installations.map((i: any) => i.$id)).toContain(adopted!.id)
    }
  })

  test('request logs are shared but filtered by project', async () => {
    const aLogs = await manager.defaultProject().services.requestLogs.list({ page: 1, limit: 50, project: PROJECT })
    const bLogs = await manager.get('project-b')!.services.requestLogs.list({ page: 1, limit: 50, project: 'project-b' })
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
    expect(select.headers.get('set-cookie')).toContain('SameSite=Lax')

    const home = await fetch(`${base}/console/overview`, { headers: { cookie: `${cookie}; console_project=project-b` } })
    expect(home.status).toBe(200)
    const homeHtml = await home.text()
    expect(homeHtml).toContain('Project B')
    // The sidebar switcher lists every project and keeps you in the same section.
    expect(homeHtml).toContain('class="menu-root switcher"')
    expect(homeHtml).toContain('<input type="hidden" name="project" value="project-c">')
    expect(homeHtml).toContain('<input type="hidden" name="next" value="/console/overview">')

    // Observability settings follow the selected project, not the control project.
    const projectCookie = `${cookie}; console_project=project-b`
    const settingsPage = await fetch(`${base}/console/observability/settings`, { headers: { cookie: projectCookie } })
    expect(settingsPage.status).toBe(200)
    const savedSettings = await fetch(`${base}/console/observability/settings/local`, {
      method: 'POST',
      headers: { cookie: projectCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ consoleSampleRate: '12', spanLimit: '500', eventLimit: '500', consoleRetentionDays: '3', flushMs: '1000' }),
      redirect: 'manual',
    })
    expect(savedSettings.status).toBe(303)
    expect(manager.get('project-b')!.services.observabilitySettings.settings.consoleSampleRate).toBeCloseTo(0.12)
    expect(manager.defaultProject().services.observabilitySettings.settings.consoleSampleRate).not.toBeCloseTo(0.12)

    // Request log settings are per project too.
    const savedLogs = await fetch(`${base}/console/settings/logs`, {
      method: 'POST',
      headers: { cookie: projectCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ logRequests: 'on', retentionDays: '3', logSampleRate: '25', logFormat: 'json', logIp: 'on' }),
      redirect: 'manual',
    })
    expect(savedLogs.status).toBe(303)
    expect(manager.get('project-b')!.services.config).toMatchObject({
      logRequests: true,
      logRetentionDays: 3,
      logSampleRate: 0.25,
      logFormat: 'json',
      logIp: true,
    })
    expect(manager.defaultProject().services.config.logRetentionDays).not.toBe(3)
    expect(manager.defaultProject().services.config.logFormat).not.toBe('json')

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
  })

  test('only an organization owner can create, edit or delete a project', async () => {
    const organizations = new OrganizationService(db)
    const org = await organizations.ensure('org_test', 'Test Project')
    const auth = new ConsoleAuth(db)
    await auth.upsert('developer@example.com', 'password-456')
    await organizations.ensureAdmin(org.id, 'developer@example.com')
    db.sqlite!.query("UPDATE _organization_members SET role = 'developer' WHERE organization_id = ? AND email = ?").run(org.id, 'developer@example.com')
    const secret = (await auth.login('developer@example.com', 'password-456'))!
    const cookie = `bunwrite_console=${secret}`

    const page = await (await fetch(`${base}/console`, { headers: { cookie } })).text()
    expect(page).not.toContain('/console/projects/project-b/delete')
    expect(page).not.toContain('data-dialog-open="#rename-project')
    expect(page).not.toContain('data-dialog-open="#create-project"')

    const home = await (await fetch(`${base}/console/overview`, { headers: { cookie: `${cookie}; console_project=project-b` } })).text()
    expect(home).not.toContain('/console?create=1')

    const create = await fetch(`${base}/console`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Developer Project', id: 'developer-project' }),
      redirect: 'manual',
    })
    expect(create.status).toBe(303)
    expect(new URL(create.headers.get('location')!, base).searchParams.get('err')).toContain('Only an organization owner')
    expect(manager.get('developer-project')).toBeNull()

    const editPage = await fetch(`${base}/console/projects/project-b/edit`, { headers: { cookie }, redirect: 'manual' })
    expect(editPage.status).toBe(303)
    expect(editPage.headers.get('location')).toBe('/console')

    const edit = await fetch(`${base}/console/projects/project-b/edit`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Developer Renamed' }),
      redirect: 'manual',
    })
    expect(edit.status).toBe(303)
    expect(new URL(edit.headers.get('location')!, base).searchParams.get('err')).toContain('Only an organization owner')
    expect(manager.get('project-b')!.info.name).toBe('Project B')

    const remove = await fetch(`${base}/console/projects/project-b/delete`, {
      method: 'POST',
      headers: { cookie },
      redirect: 'manual',
    })
    expect(remove.status).toBe(303)
    expect(new URL(remove.headers.get('location')!, base).searchParams.get('err')).toContain('Only an organization owner')
    expect(manager.get('project-b')).not.toBeNull()
  })

  test('deleting a project asks for an emailed code when MFA is on', async () => {
    const control = manager.control
    const original = control.consoleMailer
    const mailer = new MemoryMailer()
    control.consoleMailer = mailer
    const auth = new ConsoleAuth(db)
    await auth.upsert('mfa-admin@example.com', 'password-789')
    const secret = (await auth.login('mfa-admin@example.com', 'password-789'))!
    const admin = (await auth.find('mfa-admin@example.com'))!
    await auth.setMfa(admin.seq, true)
    const cookie = `bunwrite_console=${secret}`
    const post = (fields: Record<string, string>) =>
      fetch(`${base}/console/projects/project-mfa/delete`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
        redirect: 'manual',
      })

    try {
      await manager.create({ id: 'project-mfa', name: 'MFA Project', orgId: 'org_test' })

      // The first POST only sends a code; the project still exists.
      const started = await post({})
      expect(started.status).toBe(303)
      const location = new URL(started.headers.get('location')!, base)
      expect(location.searchParams.get('delete')).toBe('project-mfa')
      expect(location.searchParams.get('ok')).toContain('emailed')
      expect(manager.get('project-mfa')).not.toBeNull()
      const mail = mailer.last('mfa-admin@example.com')!
      const code = /(\d{6})/.exec(mail.text)?.[1]
      expect(code).toBeTruthy()

      const page = await (await fetch(`${base}${location.pathname}${location.search}`, { headers: { cookie } })).text()
      expect(page).toContain('id="delete-project-otp"')

      const wrong = await post({ otp: '000000' })
      expect(wrong.status).toBe(303)
      expect(new URL(wrong.headers.get('location')!, base).searchParams.get('err')).toContain('not valid')
      expect(manager.get('project-mfa')).not.toBeNull()

      const removed = await post({ otp: code! })
      expect(removed.status).toBe(303)
      expect(manager.get('project-mfa')).toBeNull()
    } finally {
      control.consoleMailer = original
      await auth.setMfa(admin.seq, false)
      if (manager.get('project-mfa')) await manager.delete('project-mfa').catch(() => {})
    }
  })

  test('projects do not inherit the console SMTP, and keep their own', async () => {
    const control = manager.control
    const server = manager.defaultProject().services
    const other = manager.get('project-b')!.services
    const smtp = (host: string) => ({
      host,
      port: 587,
      user: 'mailer',
      password: 'secret',
      secure: false,
      senderEmail: `hi@${host}`,
      senderName: 'Mailer',
    })

    expect(other.config.smtp).toBeNull()
    expect(other.mailer.enabled).toBe(false)

    await control.settings.set('smtp', smtp('smtp.server.test'))
    expect(control.config.smtp).toMatchObject({ host: 'smtp.server.test' })
    expect(server.config.smtp).toBeNull()
    expect(other.config.smtp).toBeNull()
    expect(other.mailer.enabled).toBe(false)

    await server.settings.set('smtp', smtp('smtp.project.test'))
    await other.settings.set('smtp', smtp('smtp.project2.test'))
    expect(server.config.smtp).toMatchObject({ host: 'smtp.project.test' })
    expect(other.config.smtp).toMatchObject({ host: 'smtp.project2.test' })

    await server.settings.reset('smtp')
    expect(server.config.smtp).toBeNull()
    expect(server.mailer.enabled).toBe(false)
  })

  test('each project keeps its own database durability setting', async () => {
    const control = manager.control
    const project = manager.defaultProject().services
    const other = manager.get('project-b')!.services
    const synchronous = (db: { sqlite?: Db['sqlite'] }) => (db.sqlite!.query('PRAGMA synchronous').get() as { synchronous: number }).synchronous

    expect(synchronous(project.db)).toBe(1)
    expect(synchronous(other.db)).toBe(1)

    await project.settings.set('database', { synchronous: 'FULL' })
    expect(project.config.sqliteSynchronous).toBe('FULL')
    expect(synchronous(project.db)).toBe(2)
    // The default project's setting must not leak into another project.
    expect(other.config.sqliteSynchronous).toBe('NORMAL')
    expect(synchronous(other.db)).toBe(1)

    // A project created while the default project is FULL still starts from
    // the environment default.
    const created = await manager.create({ id: 'project-sync', name: 'Sync', orgId: 'org_test' })
    expect(created.project.services.config.sqliteSynchronous).toBe('NORMAL')
    expect(synchronous(created.project.services.db)).toBe(1)
    await manager.delete('project-sync')

    await other.settings.set('database', { synchronous: 'FULL' })
    expect(other.config.sqliteSynchronous).toBe('FULL')
    expect(synchronous(other.db)).toBe(2)

    await project.settings.reset('database')
    await other.settings.reset('database')
    expect(synchronous(project.db)).toBe(1)
    expect(synchronous(other.db)).toBe(1)
    expect(control.config.sqliteSynchronous).toBe('NORMAL')
  })

  test('the first project can be deleted like any other project', async () => {
    const auth = new ConsoleAuth(db)
    await auth.upsert('delete-default@example.com', 'delete-password')
    const secret = (await auth.login('delete-default@example.com', 'delete-password'))!
    const cookie = `bunwrite_console=${secret}`

    // The console offers Delete for the default project when another one exists.
    const list = await (await fetch(`${base}/console`, { headers: { cookie } })).text()
    expect(list).toContain(`/console/projects/${PROJECT}/delete`)

    const removed = await fetch(`${base}/console/projects/${PROJECT}/delete`, { method: 'POST', headers: { cookie }, redirect: 'manual' })
    expect(removed.status).toBe(303)
    expect(manager.get(PROJECT)).toBeNull()
    expect(manager.defaultProjectId()).toBe('project-b')
    const row = db.sqlite.query<{ is_default: number }, [string]>('SELECT is_default FROM _projects WHERE id = ?').get('project-b')!
    expect(row.is_default).toBe(1)

    // The console keeps working with an empty project list.
    const removedLast = await fetch(`${base}/console/projects/project-b/delete`, { method: 'POST', headers: { cookie }, redirect: 'manual' })
    expect(removedLast.status).toBe(303)
    expect(manager.list()).toEqual([])
    const empty = await (await fetch(`${base}/console`, { headers: { cookie } })).text()
    expect(empty).toContain('No projects yet')
    expect(empty).toContain('Create project')

    // Container health checks must keep passing while the instance has no
    // projects; otherwise Docker and Caddy mark a perfectly healthy server down.
    const health = await fetch(`${endpoint}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'pass' })
    expect((await fetch(`${endpoint}/health/version`)).status).toBe(200)
    expect((await fetch(`${base}/v1/health`)).status).toBe(200)

    // A stale project ID still reports the project as missing.
    expect((await fetch(`${endpoint}/health`, { headers: { 'x-appwrite-project': PROJECT } })).status).toBe(404)
  })
})
