/**
 * The real Appwrite CLI (appwrite-cli 22, the devDependency) against Bunwrite:
 * client, login/whoami/logout, init project, and pull/push for settings,
 * tables, functions, buckets, teams, webhooks and topics.
 *
 * Each workspace gets its own HOME (the CLI's global config) and folder (its
 * appwrite.config.json). `git` is stubbed out so `init project` does not
 * clone Appwrite's agent skills from GitHub.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, Databases, Functions, Storage, TablesDB, Teams } from 'node-appwrite'

import { ConsoleAuth } from '~/console/auth'
import { webhookSignature } from '~/webhooks/service'
import { DB, failure, KEY, makeUser, PROJECT, sessionClient, startServer, type TestServer } from './helpers'

setDefaultTimeout(60_000)

const CLI = join(import.meta.dir, '..', 'node_modules', 'appwrite-cli', 'dist', 'cli.cjs')
const ADMIN = { email: 'admin@example.com', password: 'admin-password' }
const ORG = 'org_test'

let server: TestServer
let root: string
let stubs: string
let receiver: ReturnType<typeof Bun.serve>
const deliveries: { headers: Headers; body: string }[] = []

beforeAll(async () => {
  server = startServer()
  await new ConsoleAuth(server.db).upsert(ADMIN.email, ADMIN.password)
  root = mkdtempSync(join(tmpdir(), 'bunwrite-cli-'))
  stubs = join(root, 'bin')
  mkdirSync(stubs)
  writeFileSync(join(stubs, 'git'), '#!/bin/sh\necho "git is stubbed out in tests" >&2\nexit 1\n')
  chmodSync(join(stubs, 'git'), 0o755)
  receiver = Bun.serve({
    port: 0,
    async fetch(request) {
      deliveries.push({ headers: request.headers, body: await request.text() })
      return new Response('ok')
    },
  })
})

afterAll(() => {
  receiver.stop(true)
  server.stop()
  rmSync(root, { recursive: true, force: true })
})

/** One developer machine: its CLI login and its project folder. */
class Workspace {
  readonly home: string
  readonly dir: string

  constructor(name: string) {
    this.home = join(root, name, 'home')
    this.dir = join(root, name, 'project')
    mkdirSync(join(this.home, '.config', 'appwrite'), { recursive: true })
    mkdirSync(this.dir, { recursive: true })
    // Skip the CLI's npm update check.
    const stamp = new Date().toISOString()
    writeFileSync(join(this.home, '.config', 'appwrite', 'update-check.json'), JSON.stringify({ checkedAt: stamp, latest: '22.0.0', notifiedAt: stamp }))
  }

  async run(args: string[], stdin = ''): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(['bun', CLI, ...args], {
      cwd: this.dir,
      env: {
        ...process.env,
        HOME: this.home,
        XDG_CONFIG_HOME: join(this.home, '.config'),
        PATH: `${stubs}:${process.env.PATH}`,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      stdin: new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // A command waiting on a question it never gets would hang the test; stop it and show what it printed.
    const timer = setTimeout(() => proc.kill(), 45_000)
    const [out, errOut, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    clearTimeout(timer)
    return { code, out: out + errOut }
  }

  /** Run and expect success; returns the output. `stdin` answers the CLI's questions. */
  async ok(...args: string[]): Promise<string> {
    return this.okWith('', ...args)
  }

  async okWith(stdin: string, ...args: string[]): Promise<string> {
    const result = await this.run(args, stdin)
    if (result.code !== 0 || /✗ Error/.test(result.out)) throw new Error(`appwrite ${args.join(' ')} failed (${result.code}):\n${result.out}`)
    return result.out
  }

  get config(): any {
    return JSON.parse(readFileSync(join(this.dir, 'appwrite.config.json'), 'utf8'))
  }

  set config(value: any) {
    writeFileSync(join(this.dir, 'appwrite.config.json'), JSON.stringify(value, null, 4))
  }

  /** Point the CLI at the server with an API key (`appwrite client`). */
  withKey() {
    return this.ok('client', '--endpoint', server.endpoint, '--project-id', PROJECT, '--key', KEY)
  }

  /** Sign in as the console admin and link the project (`appwrite login` + `init project`). */
  async signedIn() {
    await this.ok('login', '--email', ADMIN.email, '--password', ADMIN.password, '--endpoint', server.endpoint)
    const init = await this.run(['init', 'project', '--organization-id', ORG, '--project-id', PROJECT, '--project-name', 'ignored'], 'n\n')
    if (init.code !== 0) throw new Error(`init project failed:\n${init.out}`)
  }
}

const admin = () => new Client().setEndpoint(server.endpoint).setProject(PROJECT).setKey(KEY)
const consoleSessions = () => server.db.sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM _console_sessions').get()!.n

describe('appwrite client', () => {
  test('sets the endpoint, project and key; project commands then use the key', async () => {
    const ws = new Workspace('client')
    expect(await ws.withKey()).toContain('Setting client')
    expect(await ws.ok('pull', 'tables')).toContain('Successfully pulled 3 tables from 1 tableDBs')
    expect(ws.config).toMatchObject({ projectId: PROJECT, tablesDB: [{ $id: DB, name: 'Main', enabled: true }] })
  })

  test('an endpoint that does not answer /health/version is refused', async () => {
    const ws = new Workspace('client-bad-endpoint')
    const result = await ws.run(['client', '--endpoint', `${server.endpoint}/nope`])
    expect(result.code).not.toBe(0)
    expect(result.out).toContain('Invalid endpoint')
  })

  test('a wrong API key is refused by the server', async () => {
    const ws = new Workspace('client-bad-key')
    await ws.ok('client', '--endpoint', server.endpoint, '--project-id', PROJECT, '--key', 'standard_wrong')
    const result = await ws.run(['pull', 'teams'])
    expect(result.code).not.toBe(0)
    expect(result.out).toContain('Invalid API key')
  })
})

describe('appwrite login, whoami, logout', () => {
  test('a wrong password is refused', async () => {
    const ws = new Workspace('login-wrong')
    const result = await ws.run(['login', '--email', ADMIN.email, '--password', 'not-the-password', '--endpoint', server.endpoint])
    expect(result.code).not.toBe(0)
    expect(result.out).toContain('Invalid credentials')
    expect((await ws.run(['whoami'])).out).toContain('No user is signed in')
  })

  test('project users cannot sign in to the console', async () => {
    const user = makeUser(server.db)
    const ws = new Workspace('login-user')
    const result = await ws.run(['login', '--email', `${user.id}@example.com`, '--password', 'password1', '--endpoint', server.endpoint])
    expect(result.code).not.toBe(0)
    expect(result.out).toContain('Invalid credentials')
  })

  test('signs in, shows who is signed in, and signs out on the server too', async () => {
    const ws = new Workspace('login')
    const before = consoleSessions()
    expect(await ws.ok('login', '--email', ADMIN.email, '--password', ADMIN.password, '--endpoint', server.endpoint)).toContain(`Successfully signed in as ${ADMIN.email}`)
    expect(consoleSessions()).toBe(before + 1)

    const whoami = await ws.ok('whoami')
    expect(whoami).toContain(ADMIN.email)
    expect(whoami).toContain(server.endpoint)

    expect(await ws.ok('logout')).toContain('Logged out')
    expect(consoleSessions()).toBe(before)
    expect((await ws.run(['whoami'])).out).toContain('No user is signed in')
  })

  test('the session cookie acts on a project only in admin mode', async () => {
    const ws = new Workspace('login-cookie')
    await ws.ok('login', '--email', ADMIN.email, '--password', ADMIN.password, '--endpoint', server.endpoint)
    const prefs = JSON.parse(readFileSync(join(ws.home, '.appwrite', 'prefs.json'), 'utf8'))
    const session = prefs[prefs.current]
    expect(session.cookie).toStartWith('a_session_console=')
    const cookie = session.cookie.split(';')[0]

    const call = (headers: Record<string, string>) => fetch(`${server.endpoint}/storage/buckets`, { headers: { 'x-appwrite-project': PROJECT, cookie, ...headers } })
    expect((await call({})).status).toBe(401)
    expect((await call({ 'x-appwrite-mode': 'admin' })).status).toBe(200)
    expect((await call({ 'x-appwrite-mode': 'admin', cookie: 'a_session_console=forged' })).status).toBe(401)
  })
})

describe('appwrite init project', () => {
  test('links the folder to an existing project', async () => {
    const ws = new Workspace('init')
    await ws.signedIn()
    expect(ws.config).toEqual({ organizationId: ORG, projectId: PROJECT, projectName: 'Test Project' })
  })

  test('an unknown organization is refused', async () => {
    const ws = new Workspace('init-org')
    await ws.ok('login', '--email', ADMIN.email, '--password', ADMIN.password, '--endpoint', server.endpoint)
    const result = await ws.run(['init', 'project', '--organization-id', 'someone-else', '--project-id', PROJECT, '--project-name', 'x'], 'n\n')
    expect(result.out).toContain('does not exist on this server')
    // The CLI empties appwrite.config.json before asking; no project gets linked.
    expect(existsSync(join(ws.dir, 'appwrite.config.json')) ? ws.config.projectId : undefined).toBeUndefined()
  })
})

describe('pull and push settings', () => {
  let ws: Workspace

  beforeAll(async () => {
    ws = new Workspace('settings')
    await ws.signedIn()
  })

  test('pull settings writes the project name, services, sign-in methods and security', async () => {
    expect(await ws.ok('pull', 'settings')).toContain('Successfully pulled all project settings')
    const config = ws.config
    expect(config.projectName).toBe('Test Project')
    expect(config.settings.services).toMatchObject({ account: true, databases: true, storage: true, teams: true, users: true, functions: true })
    expect(config.settings.protocols).toEqual({ rest: true, graphql: true, websocket: true })
    expect(config.settings.auth.methods).toMatchObject({ 'email-password': true, 'email-otp': true, jwt: true, invites: true })
    expect(config.settings.auth.security).toEqual({
      duration: 31536000,
      limit: 0,
      sessionsLimit: 10,
      passwordHistory: 0,
      passwordDictionary: false,
      personalDataCheck: false,
      sessionAlerts: false,
      mockNumbers: [],
    })
  })

  test('push settings applies them, and clients feel it', async () => {
    const config = ws.config
    config.projectName = 'Renamed Project'
    config.settings.services.storage = false
    config.settings.auth.methods.jwt = false
    config.settings.auth.methods['email-otp'] = false
    Object.assign(config.settings.auth.security, {
      duration: 3600,
      limit: 1000,
      sessionsLimit: 3,
      passwordHistory: 5,
      passwordDictionary: true,
      personalDataCheck: true,
      sessionAlerts: true,
      mockNumbers: [{ phone: '+15555550100', otp: '123456' }],
    })
    ws.config = config
    expect(await ws.ok('push', 'settings', '--force')).toContain('Successfully pushed all project settings')

    expect(server.config).toMatchObject({ projectName: 'Renamed Project', sessionDuration: 3600, sessionsLimit: 3 })
    const access = server.services.access
    expect(access.serviceEnabled('storage')).toBe(false)
    expect(access.authMethodEnabled('jwt')).toBe(false)
    expect(access.policy('password-history')).toEqual({ $id: 'password-history', total: 5 })
    expect(access.mockPhones().map((m) => [m.number, m.otp])).toEqual([['+15555550100', '123456']])

    // A signed-in user meets the switches; the API key does not.
    const user = makeUser(server.db)
    const client = sessionClient(server.endpoint, user.secret)
    expect(await failure(client.storage.listFiles({ bucketId: 'any' }))).toMatchObject({ code: 403, type: 'general_service_disabled' })
    const jwt = await fetch(`${server.endpoint}/account/jwts`, { method: 'POST', headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-session': user.secret } })
    expect([jwt.status, ((await jwt.json()) as any).type]).toEqual([501, 'user_auth_method_unsupported'])
    expect((await new Storage(admin()).listBuckets()).total).toBeGreaterThanOrEqual(0)
  })

  test('pull settings reads back exactly what was pushed', async () => {
    const pushed = ws.config
    await ws.ok('pull', 'settings')
    expect(ws.config.settings).toEqual(pushed.settings)
    expect(ws.config.projectName).toBe('Renamed Project')
  })

  test('mock numbers are reconciled: changed, added and removed', async () => {
    const config = ws.config
    config.settings.auth.security.mockNumbers = [
      { phone: '+15555550100', otp: '654321' },
      { phone: '+15555550101', otp: '111111' },
    ]
    ws.config = config
    await ws.ok('push', 'settings', '--force')
    expect(server.services.access.mockPhones().map((m) => [m.number, m.otp])).toEqual([
      ['+15555550100', '654321'],
      ['+15555550101', '111111'],
    ])
    config.settings.auth.security.mockNumbers = [{ phone: '+15555550101', otp: '111111' }]
    ws.config = config
    await ws.ok('push', 'settings', '--force')
    expect(server.services.access.mockPhones().map((m) => m.number)).toEqual(['+15555550101'])
  })

  test('settings need a console sign-in; an API key is not enough', async () => {
    const keyOnly = new Workspace('settings-key')
    await keyOnly.withKey()
    const result = await keyOnly.run(['pull', 'settings'])
    expect(result.code).not.toBe(0)
    expect(result.out).toContain('appwrite login')
  })
})

describe('push and pull tables', () => {
  test('a new table is created, pulled back, and a second push changes nothing', async () => {
    const ws = new Workspace('tables')
    await ws.withKey()
    await ws.ok('pull', 'tables')
    const config = ws.config
    config.tablesDB.push({ $id: 'crm', name: 'CRM', enabled: true })
    config.tables.push({
      $id: 'leads',
      $permissions: ['read("any")'],
      databaseId: 'crm',
      name: 'Leads',
      enabled: true,
      rowSecurity: false,
      columns: [
        { key: 'name', type: 'string', required: true, array: false, size: 100, default: null, encrypt: false },
        { key: 'stage', type: 'string', required: false, array: false, format: 'enum', elements: ['new', 'won'], default: 'new' },
        { key: 'score', type: 'integer', required: false, array: false, min: 0, max: 10, default: 0 },
      ],
      indexes: [{ key: 'idx_stage', type: 'key', status: 'available', columns: ['stage'], orders: ['ASC'] }],
    })
    ws.config = config
    expect(await ws.ok('push', 'tables', '--all', '--force')).toContain('Successfully pushed')

    const tables = new TablesDB(admin())
    const leads = await tables.getTable({ databaseId: 'crm', tableId: 'leads' })
    expect(leads.columns.map((c: any) => c.key)).toEqual(['name', 'stage', 'score'])
    expect(leads.indexes.map((i: any) => i.key)).toEqual(['idx_stage'])

    const fresh = new Workspace('tables-pull')
    await fresh.withKey()
    await fresh.ok('pull', 'tables')
    expect(fresh.config.tables.find((t: any) => t.$id === 'leads')).toMatchObject({ databaseId: 'crm', name: 'Leads', rowSecurity: false, $permissions: ['read("any")'] })
    expect(await fresh.ok('push', 'tables', '--all', '--force')).toContain('No tables were pushed')
  })

  test('a column added to the config is added to the table', async () => {
    const ws = new Workspace('tables-alter')
    await ws.withKey()
    await ws.ok('pull', 'tables')
    const config = ws.config
    config.tables.find((t: any) => t.$id === 'leads').columns.push({ key: 'notes', type: 'string', required: false, array: false, size: 500, default: null, encrypt: false })
    ws.config = config
    await ws.ok('push', 'tables', '--all', '--force')
    const column = await new TablesDB(admin()).getColumn({ databaseId: 'crm', tableId: 'leads', key: 'notes' })
    expect(column).toMatchObject({ key: 'notes', type: 'string', size: 500 })
  })
})

const MAIN = `module.exports = async (context) => context.res.json({
  greeting: 'hello from the cli',
  built: require('node:fs').existsSync('built.txt'),
})`

describe('push and pull functions', () => {
  test('push deploys and activates the code; pull brings back the source, not the build', async () => {
    const ws = new Workspace('functions')
    await ws.withKey()
    mkdirSync(join(ws.dir, 'functions', 'hello', 'src'), { recursive: true })
    writeFileSync(join(ws.dir, 'functions', 'hello', 'src', 'main.js'), MAIN)
    writeFileSync(join(ws.dir, 'functions', 'hello', 'package.json'), '{"name":"hello"}')
    ws.config = {
      projectId: PROJECT,
      functions: [
        {
          $id: 'hello',
          name: 'Hello',
          runtime: 'node-22',
          path: 'functions/hello',
          entrypoint: 'src/main.js',
          commands: 'echo built > built.txt',
          execute: ['any'],
          events: [],
          schedule: '',
          timeout: 15,
          enabled: true,
          logging: true,
          scopes: ['users.read'],
        },
      ],
    }
    const out = await ws.ok('push', 'functions', '--function-id', 'hello', '--force', '--activate', 'true')
    expect(out).toContain('Successfully deployed 1 function')

    const functions = new Functions(admin())
    const fn = await functions.get({ functionId: 'hello' })
    expect(fn).toMatchObject({ name: 'Hello', runtime: 'node-22', entrypoint: 'src/main.js', commands: 'echo built > built.txt', scopes: ['users.read'], latestDeploymentStatus: 'ready' })
    expect(fn.deploymentId).toBe(fn.latestDeploymentId)
    const run = await functions.createExecution({ functionId: 'hello' })
    expect(JSON.parse(run.responseBody)).toEqual({ greeting: 'hello from the cli', built: true })

    const fresh = new Workspace('functions-pull')
    await fresh.withKey()
    // --all picks every function; "y" answers "pull the source code?".
    expect(await fresh.okWith('y\n', 'pull', 'functions', '--all')).toContain('Successfully pulled 1 functions')
    const pulled = fresh.config.functions[0]
    expect(pulled).toMatchObject({ $id: 'hello', name: 'Hello', runtime: 'node-22', entrypoint: 'src/main.js', commands: 'echo built > built.txt', execute: ['any'], timeout: 15 })
    const folder = join(fresh.dir, pulled.path)
    expect(readFileSync(join(folder, 'src', 'main.js'), 'utf8')).toBe(MAIN)
    expect(readFileSync(join(folder, 'package.json'), 'utf8')).toBe('{"name":"hello"}')
    expect(existsSync(join(folder, 'built.txt'))).toBe(false)
  })

  test('a failing build is reported with its logs and keeps the active code', async () => {
    const ws = new Workspace('functions-fail')
    await ws.withKey()
    await ws.ok('pull', 'functions', '--all', '--no-code')
    const before = (await new Functions(admin()).get({ functionId: 'hello' })).deploymentId
    mkdirSync(join(ws.dir, 'functions', 'hello', 'src'), { recursive: true })
    writeFileSync(join(ws.dir, 'functions', 'hello', 'src', 'main.js'), MAIN)
    const config = ws.config
    config.functions[0].path = 'functions/hello'
    config.functions[0].commands = 'echo broken >&2; exit 3'
    ws.config = config
    const started = Date.now()
    const result = await ws.run(['push', 'functions', '--function-id', 'hello', '--force', '--activate', 'true'])
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(result.out).toContain('Failed to deploy')
    expect(result.out).toContain('broken')
    expect((await new Functions(admin()).get({ functionId: 'hello' })).deploymentId).toBe(before)
    // Put the working build command back for the next tests.
    await new Functions(admin()).update({ functionId: 'hello', name: 'Hello', commands: 'echo built > built.txt' })
  })

  test('settings changed in the config are pushed without new code', async () => {
    const ws = new Workspace('functions-update')
    await ws.withKey()
    await ws.ok('pull', 'functions', '--all', '--no-code')
    const config = ws.config
    config.functions[0].timeout = 30
    config.functions[0].execute = ['users']
    ws.config = config
    await ws.ok('push', 'functions', '--function-id', 'hello', '--force', '--no-code')
    expect(await new Functions(admin()).get({ functionId: 'hello' })).toMatchObject({ timeout: 30, execute: ['users'] })
  })

  test('the download endpoint serves the built folder when asked for the output', async () => {
    const functions = new Functions(admin())
    const { deployments } = await functions.listDeployments({ functionId: 'hello' })
    const ready = deployments.find((d: any) => d.status === 'ready')!
    const download = (type: string) =>
      fetch(`${server.endpoint}/functions/hello/deployments/${ready.$id}/download?type=${type}`, { headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY } })
    const list = async (type: string) => {
      const file = join(root, `${type}.tar.gz`)
      writeFileSync(file, new Uint8Array(await (await download(type)).arrayBuffer()))
      return Bun.spawnSync(['tar', '-tzf', file]).stdout.toString()
    }
    expect(await list('source')).not.toContain('built.txt')
    expect(await list('output')).toContain('built.txt')
  })
})

describe('push and pull buckets', () => {
  const bucket = {
    $id: 'avatars',
    $permissions: ['read("any")'],
    fileSecurity: false,
    name: 'Avatars',
    enabled: true,
    maximumFileSize: 1_000_000,
    allowedFileExtensions: ['png', 'jpg'],
    compression: 'gzip',
    encryption: false,
    antivirus: false,
  }

  test('push creates, then updates; pull reads it back unchanged', async () => {
    const ws = new Workspace('buckets')
    await ws.withKey()
    ws.config = { projectId: PROJECT, buckets: [bucket] }
    expect(await ws.ok('push', 'buckets', '--all', '--force')).toContain('Successfully pushed 1 buckets')
    expect(await new Storage(admin()).getBucket({ bucketId: 'avatars' })).toMatchObject(bucket)

    ws.config = { projectId: PROJECT, buckets: [{ ...bucket, name: 'Profile pictures', maximumFileSize: 2_000_000, fileSecurity: true }] }
    await ws.ok('push', 'buckets', '--all', '--force')
    expect(await new Storage(admin()).getBucket({ bucketId: 'avatars' })).toMatchObject({ name: 'Profile pictures', maximumFileSize: 2_000_000, fileSecurity: true })

    const fresh = new Workspace('buckets-pull')
    await fresh.withKey()
    await fresh.ok('pull', 'buckets')
    expect(fresh.config.buckets).toEqual([{ ...bucket, name: 'Profile pictures', maximumFileSize: 2_000_000, fileSecurity: true }])
    // Nothing to change; the CLI reports that as "No buckets were pushed".
    expect((await fresh.run(['push', 'buckets', '--all', '--force'])).out).toContain('No changes detected for bucket')
  })
})

describe('push and pull teams', () => {
  test('push creates and renames teams; pull reads them back', async () => {
    const ws = new Workspace('teams')
    await ws.withKey()
    ws.config = { projectId: PROJECT, teams: [{ $id: 'staff', name: 'Staff' }, { $id: 'editors', name: 'Editors' }] }
    expect(await ws.ok('push', 'teams', '--all', '--force')).toContain('Successfully pushed 2 teams')
    ws.config = { projectId: PROJECT, teams: [{ $id: 'staff', name: 'Crew' }] }
    await ws.ok('push', 'teams', '--all', '--force')

    const teams = new Teams(admin())
    expect((await teams.get({ teamId: 'staff' })).name).toBe('Crew')
    expect((await teams.get({ teamId: 'editors' })).name).toBe('Editors')

    const fresh = new Workspace('teams-pull')
    await fresh.withKey()
    await fresh.ok('pull', 'teams')
    expect(fresh.config.teams.map((t: any) => [t.$id, t.name])).toEqual([
      ['staff', 'Crew'],
      ['editors', 'Editors'],
    ])
  })
})

describe('push and pull webhooks', () => {
  test('push creates and updates; matching document changes are delivered and signed', async () => {
    const url = `http://localhost:${receiver.port}/hook`
    const ws = new Workspace('webhooks')
    await ws.withKey()
    ws.config = {
      projectId: PROJECT,
      webhooks: [{ $id: 'notes-hook', name: 'Notes', url, events: ['databases.main.collections.notes.documents.*.create'], enabled: true, tls: true }],
    }
    expect(await ws.ok('push', 'webhooks', '--all', '--force')).toContain('Successfully pushed 1 webhooks')
    const hook = server.services.webhooks.get('notes-hook')
    expect(hook).toMatchObject({ name: 'Notes', url, enabled: 1 })

    deliveries.length = 0
    const databases = new Databases(admin())
    await databases.createDocument({ databaseId: DB, collectionId: 'notes', documentId: 'n1', data: { text: 'hi' } })
    await databases.updateDocument({ databaseId: DB, collectionId: 'notes', documentId: 'n1', data: { text: 'changed' } })
    await server.services.webhooks.idle()
    expect(deliveries).toHaveLength(1)
    const [delivery] = deliveries
    expect(JSON.parse(delivery!.body)).toMatchObject({ $id: 'n1', text: 'hi' })
    expect(delivery!.headers.get('x-appwrite-webhook-id')).toBe('notes-hook')
    expect(delivery!.headers.get('x-appwrite-webhook-project-id')).toBe(PROJECT)
    expect(delivery!.headers.get('x-appwrite-webhook-events')!.split(',')).toContain('databases.main.collections.notes.documents.n1.create')
    expect(delivery!.headers.get('x-appwrite-webhook-signature')).toBe(webhookSignature(url, delivery!.body, hook.secret))

    // Now every change to notes, and a new name.
    ws.config = {
      projectId: PROJECT,
      webhooks: [{ $id: 'notes-hook', name: 'All notes', url, events: ['databases.main.collections.notes.documents.*'], enabled: true, tls: true }],
    }
    await ws.ok('push', 'webhooks', '--all', '--force')
    deliveries.length = 0
    await databases.deleteDocument({ databaseId: DB, collectionId: 'notes', documentId: 'n1' })
    await server.services.webhooks.idle()
    expect(deliveries.map((d) => d.headers.get('x-appwrite-webhook-name'))).toEqual(['All notes'])

    const fresh = new Workspace('webhooks-pull')
    await fresh.withKey()
    await fresh.ok('pull', 'webhooks')
    expect(fresh.config.webhooks).toEqual([{ $id: 'notes-hook', name: 'All notes', url, events: ['databases.main.collections.notes.documents.*'], enabled: true, tls: true }])
  })
})

describe('push and pull topics', () => {
  test('push creates and updates topics; pull reads them back', async () => {
    const ws = new Workspace('topics')
    await ws.withKey()
    ws.config = { projectId: PROJECT, topics: [{ $id: 'news', name: 'News', subscribe: ['users'] }] }
    expect(await ws.ok('push', 'topics', '--all', '--force')).toContain('Pushed News ( news )')
    ws.config = { projectId: PROJECT, topics: [{ $id: 'news', name: 'Newsletter', subscribe: ['team:staff'] }] }
    await ws.ok('push', 'topics', '--all', '--force')

    const fresh = new Workspace('topics-pull')
    await fresh.withKey()
    await fresh.ok('pull', 'topics')
    expect(fresh.config.topics).toEqual([{ $id: 'news', name: 'Newsletter', subscribe: ['team:staff'] }])
  })
})

describe('pull all and push all', () => {
  test('a signed-in admin pulls everything, and pushing it straight back succeeds', async () => {
    const ws = new Workspace('everything')
    await ws.signedIn()
    const out = await ws.okWith('y\n', 'pull', 'all')
    for (const line of ['all project settings', '1 functions', '0 sites', 'tables from', '1 buckets', 'teams', '1 webhooks', '1 topics']) expect(out).toContain(line)
    const config = ws.config
    expect(Object.keys(config)).toEqual(expect.arrayContaining(['settings', 'functions', 'tablesDB', 'tables', 'buckets', 'teams', 'webhooks', 'topics']))

    // CLI 22 bug, same against Appwrite: `pull teams` saves whole Team objects, which its own
    // config check then refuses on push. Keep the two fields a team config has.
    config.teams = config.teams.map(({ $id, name }: any) => ({ $id, name }))
    ws.config = config

    const pushed = await ws.run(['push', 'all', '--all', '--force'])
    expect(pushed.out).not.toContain('✗ Error')
    expect(pushed.code).toBe(0)
    expect(await new Storage(admin()).getBucket({ bucketId: 'avatars' })).toMatchObject({ name: 'Profile pictures' })
  })
})
