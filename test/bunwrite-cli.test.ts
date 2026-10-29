/**
 * The Bunwrite CLI (packages/cli) against a real server: client, login,
 * whoami, logout, init project, pull/push of every config section, function
 * deploys and the generic service commands.
 *
 * Each workspace gets its own BUNWRITE_HOME (the global prefs) and folder (its
 * bunwrite.config.json).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BuildRuntime, Client, Databases, Framework, Functions, Project, Sites, Storage, TablesDB, Teams } from '../packages/sdk/src'
import { pack, unpack } from '../packages/cli/src/tar'
import { collect } from '../packages/cli/src/files'
import { ConsoleAuth } from '~/console/auth'
import { DB, KEY, PROJECT, startServer, type TestServer } from './helpers'

setDefaultTimeout(60_000)

const CLI = join(import.meta.dir, '..', 'packages', 'cli', 'src', 'cli.ts')
// Its own admin: console sign-ins are rate limited per email, across test files.
const ADMIN = { email: 'cli-admin@example.com', password: 'admin-password' }
const ORG = 'org_test'

let server: TestServer
let root: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'bunwrite-own-cli-'))
  server = startServer(undefined, { storagePath: join(root, 'storage'), apiCompat: 'bunwrite' })
  await new ConsoleAuth(server.db).upsert(ADMIN.email, ADMIN.password)
})

afterAll(() => {
  server.stop()
  rmSync(root, { recursive: true, force: true })
})

const admin = () => new Client().setEndpoint(server.endpoint).setProject(PROJECT).setKey(KEY)
const consoleSessions = () => server.db.sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM _console_sessions').get()!.n

class Workspace {
  readonly home: string
  readonly dir: string

  constructor(name: string) {
    this.home = join(root, name, 'home')
    this.dir = join(root, name, 'project')
    mkdirSync(this.home, { recursive: true })
    mkdirSync(this.dir, { recursive: true })
  }

  async run(args: string[], stdin = '', env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(['bun', CLI, ...args], {
      cwd: this.dir,
      env: { ...process.env, BUNWRITE_HOME: this.home, NO_COLOR: '1', ...env },
      stdin: new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => proc.kill(), 45_000)
    const [out, errOut, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    clearTimeout(timer)
    return { code, out: out + errOut }
  }

  async ok(...args: string[]): Promise<string> {
    const result = await this.run(args)
    if (result.code !== 0) throw new Error(`bunwrite ${args.join(' ')} failed (${result.code}):\n${result.out}`)
    return result.out
  }

  get config(): any {
    return JSON.parse(readFileSync(join(this.dir, 'bunwrite.config.json'), 'utf8'))
  }

  set config(value: any) {
    writeFileSync(join(this.dir, 'bunwrite.config.json'), JSON.stringify(value, null, 4))
  }

  get prefs(): any {
    return JSON.parse(readFileSync(join(this.home, 'prefs.json'), 'utf8'))
  }

  withKey() {
    return this.ok('client', '--endpoint', server.endpoint, '--project-id', PROJECT, '--key', KEY)
  }

  async signedIn() {
    await this.ok('login', '--endpoint', server.endpoint, '--email', ADMIN.email, '--password', ADMIN.password)
    await this.ok('init', 'project', '--project-id', PROJECT)
  }
}

describe('tar', () => {
  test('packs and unpacks long names, and refuses unsafe paths', () => {
    const long = `${'deep/'.repeat(40)}file.txt`
    const back = unpack(pack([{ path: 'a.txt', data: new TextEncoder().encode('hi') }, { path: long, data: new Uint8Array([1, 2, 3]) }, { path: '../evil', data: new Uint8Array() }]))
    expect(back.map((e) => e.path)).toEqual(['a.txt', long])
    expect(new TextDecoder().decode(back[0]!.data)).toBe('hi')
  })

  test('reads archives made by the system tar', () => {
    const dir = join(root, 'tar-src')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'main.js'), 'x')
    const archive = Bun.spawnSync(['tar', '-cf', '-', '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } }).stdout
    expect(unpack(new Uint8Array(archive)).map((e) => e.path)).toEqual(['src/main.js'])
  })

  test('function folders skip .git and what .gitignore or `ignore` lists', () => {
    const dir = join(root, 'collect')
    for (const f of ['src/main.js', 'node_modules/x/index.js', '.git/HEAD', 'notes.log', 'keep.log']) {
      mkdirSync(join(dir, f, '..'), { recursive: true })
      writeFileSync(join(dir, f), f)
    }
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n*.log\n')
    expect(collect(dir).map((e) => e.path)).toEqual(['.gitignore', 'src/main.js'])
    expect(collect(dir, ['notes.log']).map((e) => e.path)).toEqual(['.gitignore', 'keep.log', 'node_modules/x/index.js', 'src/main.js'])
  })
})

describe('client', () => {
  test('saves the endpoint, project and key; project commands then use the key', async () => {
    const ws = new Workspace('client')
    expect(await ws.withKey()).toContain('Client settings saved')
    expect(ws.prefs.sessions.default).toMatchObject({ endpoint: server.endpoint, projectId: PROJECT, key: KEY })
    expect(await ws.ok('client')).toContain(PROJECT)
    expect(await ws.ok('pull', 'tables')).toContain('Pulled 3 tables from 1 databases')
    expect(ws.config).toMatchObject({ projectId: PROJECT, tablesDB: [{ $id: DB, name: 'Main', enabled: true }] })
  })

  test('an endpoint that does not answer /health/version is refused', async () => {
    const result = await new Workspace('client-bad').run(['client', '--endpoint', `${server.endpoint}/nope`])
    expect(result.code).toBe(1)
    expect(result.out).toContain('Invalid endpoint')
  })

  test('a wrong API key is refused by the server', async () => {
    const ws = new Workspace('client-bad-key')
    await ws.ok('client', '--endpoint', server.endpoint, '--project-id', PROJECT, '--key', 'standard_wrong')
    const result = await ws.run(['pull', 'teams'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('Invalid API key')
  })

  test('without a sign-in or key, commands say what to run', async () => {
    const ws = new Workspace('client-none')
    const result = await ws.run(['pull', 'teams'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('bunwrite client')
  })
})

describe('login, whoami, logout', () => {
  test('a wrong password is refused', async () => {
    const ws = new Workspace('login-wrong')
    const result = await ws.run(['login', '--endpoint', server.endpoint, '--email', ADMIN.email, '--password', 'nope-nope'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('Invalid credentials')
    expect(await ws.ok('whoami')).toContain('No user is signed in')
  })

  test('signs in, shows who, and signs out on the server too', async () => {
    const ws = new Workspace('login')
    const before = consoleSessions()
    expect(await ws.ok('login', '--endpoint', server.endpoint, '--email', ADMIN.email, '--password', ADMIN.password)).toContain(`Signed in as ${ADMIN.email}`)
    expect(consoleSessions()).toBe(before + 1)
    expect(ws.prefs.sessions.default.cookie).toStartWith('bw_session_console=')
    expect(await ws.ok('whoami')).toContain(ADMIN.email)
    expect(await ws.ok('logout')).toContain('Logged out')
    expect(consoleSessions()).toBe(before)
    expect(await ws.ok('whoami')).toContain('No user is signed in')
  })

  test('reads the password from stdin without echoing it', async () => {
    const ws = new Workspace('login-stdin')
    const result = await ws.run(['login', '--endpoint', server.endpoint, '--email', ADMIN.email], `${ADMIN.password}\n`)
    expect(result.code).toBe(0)
    expect(result.out).toContain(`Signed in as ${ADMIN.email}`)
    expect(result.out).not.toContain(ADMIN.password)
  })
})

describe('init project', () => {
  test('a signed-in admin links the folder, with the organization', async () => {
    const ws = new Workspace('init')
    await ws.signedIn()
    expect(ws.config).toEqual({ organizationId: ORG, projectId: PROJECT, projectName: 'Test Project' })
  })

  test('an API key links the folder too', async () => {
    const ws = new Workspace('init-key')
    await ws.withKey()
    await ws.ok('init', 'project', '--project-id', PROJECT)
    expect(ws.config).toEqual({ projectId: PROJECT, projectName: 'Test Project' })
  })

  test('another organization is refused with the right ID', async () => {
    const ws = new Workspace('init-org')
    await ws.ok('login', '--endpoint', server.endpoint, '--email', ADMIN.email, '--password', ADMIN.password)
    const result = await ws.run(['init', 'project', '--project-id', PROJECT, '--organization-id', 'someone-else'])
    expect(result.code).toBe(1)
    expect(result.out).toContain(`belongs to organization "${ORG}"`)
    expect(existsSync(join(ws.dir, 'bunwrite.config.json'))).toBe(false)
  })

  test('bunwrite.json is read and written too', async () => {
    const ws = new Workspace('init-bunwrite-json')
    await ws.withKey()
    writeFileSync(join(ws.dir, 'bunwrite.json'), JSON.stringify({ projectId: PROJECT }))
    await ws.ok('pull', 'teams')
    expect(existsSync(join(ws.dir, 'bunwrite.config.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(ws.dir, 'bunwrite.json'), 'utf8')).teams).toBeArray()
  })

  test('an existing appwrite.config.json is used and kept', async () => {
    const ws = new Workspace('init-appwrite')
    await ws.withKey()
    writeFileSync(join(ws.dir, 'appwrite.config.json'), JSON.stringify({ projectId: PROJECT, teams: [] }))
    await ws.ok('pull', 'teams')
    expect(existsSync(join(ws.dir, 'bunwrite.config.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(ws.dir, 'appwrite.config.json'), 'utf8')).teams).toBeArray()
  })

  test('points to the npx installer without asking when there is no terminal', async () => {
    const ws = new Workspace('init-skills')
    await ws.withKey()
    expect(await ws.ok('init', 'project', '--project-id', PROJECT)).toContain('npx skills add ridhotamma/bunwrite')
  })

  test('--no-skills skips the install hint', async () => {
    const ws = new Workspace('init-no-skills')
    await ws.withKey()
    expect(await ws.ok('init', 'project', '--project-id', PROJECT, '--no-skills')).not.toContain('npx skills add')
  })
})

describe('agent skills', () => {
  test('skills --print shows the npx command and forwards the choices', async () => {
    const ws = new Workspace('skills')
    const out = await ws.ok('skills', '--print', '--skill', 'bunwrite', '--skill', 'bunwrite-cli', '--agent', 'claude-code', '--global', '--yes')
    expect(out).toContain('npx -y skills add ridhotamma/bunwrite')
    expect(out).toContain('--skill bunwrite --skill bunwrite-cli')
    expect(out).toContain('--agent claude-code')
    expect(out).toContain('--global')
    expect(out).toContain('--yes')
  })

  test('init skill is an alias', async () => {
    const ws = new Workspace('skills-init')
    expect(await ws.ok('init', 'skill', '--print', '--list')).toContain('npx -y skills add ridhotamma/bunwrite --list')
  })

  test('runs npx with the forwarded flags', async () => {
    const ws = new Workspace('skills-run')
    const bin = join(ws.home, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\necho "stub npx $@"\n')
    chmodSync(join(bin, 'npx'), 0o755)
    const result = await ws.run(['skills', '--skill', 'bunwrite', '--agent', 'claude-code', '--yes'], '', { PATH: `${bin}:${process.env.PATH}` })
    expect(result.code).toBe(0)
    expect(result.out).toContain('stub npx -y skills add ridhotamma/bunwrite --skill bunwrite --agent claude-code --yes')
    expect(result.out).toContain('Bunwrite agent skills installed')
  })
})

describe('settings', () => {
  test('pull, change, push, and pull back the same', async () => {
    const ws = new Workspace('settings')
    await ws.signedIn()
    expect(await ws.ok('pull', 'settings')).toContain('Pulled all project settings')
    const config = ws.config
    expect(config.settings.services).toMatchObject({ account: true, databases: true, storage: true })
    expect(config.settings.auth.security).toMatchObject({ duration: 31536000, sessionsLimit: 10, mockNumbers: [] })

    config.projectName = 'Renamed by CLI'
    config.settings.services.storage = false
    config.settings.auth.methods.jwt = false
    Object.assign(config.settings.auth.security, { duration: 3600, passwordHistory: 5, sessionAlerts: true, mockNumbers: [{ phone: '+15555550100', otp: '123456' }] })
    ws.config = config
    expect(await ws.ok('push', 'settings')).toContain('Pushed all project settings')

    const access = server.services.access
    expect(server.config).toMatchObject({ projectName: 'Renamed by CLI', sessionDuration: 3600 })
    expect(access.serviceEnabled('storage')).toBe(false)
    expect(access.authMethodEnabled('jwt')).toBe(false)
    expect(access.mockPhones().map((m) => [m.number, m.otp])).toEqual([['+15555550100', '123456']])

    await ws.ok('pull', 'settings')
    expect(ws.config.settings).toEqual(config.settings)
    expect(await ws.ok('push', 'settings')).toContain('No settings were pushed')

    // Put things back for the other tests.
    config.settings.services.storage = true
    config.settings.auth.methods.jwt = true
    config.settings.auth.security.mockNumbers = []
    config.settings.auth.security.duration = 31536000
    ws.config = config
    await ws.ok('push', 'settings')
    expect(access.mockPhones()).toEqual([])
  })
})

describe('tables and collections', () => {
  test('a new table is created, altered, pulled back, and pruned', async () => {
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
        { key: 'name', type: 'string', required: true, array: false, size: 100, default: null },
        { key: 'stage', type: 'string', required: false, array: false, format: 'enum', elements: ['new', 'won'], default: 'new' },
        { key: 'score', type: 'integer', required: false, array: false, min: 0, max: 10, default: 0 },
      ],
      indexes: [{ key: 'idx_stage', type: 'key', columns: ['stage'], orders: ['ASC'] }],
    })
    ws.config = config
    expect(await ws.ok('push', 'tables')).toContain('Pushed 1 tables')
    const tables = new TablesDB(admin())
    const leads = await tables.getTable({ databaseId: 'crm', tableId: 'leads' })
    expect(leads.columns.map((c: any) => c.key)).toEqual(['name', 'stage', 'score'])

    // A pulled config pushes back with no changes.
    const fresh = new Workspace('tables-pull')
    await fresh.withKey()
    await fresh.ok('pull', 'tables')
    expect(fresh.config.tables.find((t: any) => t.$id === 'leads')).toMatchObject({ databaseId: 'crm', name: 'Leads', rowSecurity: false, $permissions: ['read("any")'] })
    expect(await fresh.ok('push', 'tables')).toContain('No tables were pushed')

    // Add a column, widen another, rename the table.
    const next = fresh.config
    const lead = next.tables.find((t: any) => t.$id === 'leads')
    lead.name = 'Sales leads'
    lead.columns.push({ key: 'notes', type: 'string', required: false, array: false, size: 500, default: null })
    lead.columns.find((c: any) => c.key === 'score').max = 100
    fresh.config = next
    expect(await fresh.ok('push', 'tables', '--table-id', 'leads')).toContain('Pushed 1 tables')
    const after = await tables.getTable({ databaseId: 'crm', tableId: 'leads' })
    expect(after.name).toBe('Sales leads')
    expect(after.columns.find((c: any) => c.key === 'score')).toMatchObject({ max: 100 })
    expect(after.columns.find((c: any) => c.key === 'notes')).toMatchObject({ size: 500 })

    // Prune drops what the config no longer has.
    lead.columns = lead.columns.filter((c: any) => c.key !== 'notes')
    fresh.config = next
    await fresh.ok('push', 'tables', '--prune', '--force')
    expect((await tables.getTable({ databaseId: 'crm', tableId: 'leads' })).columns.map((c: any) => c.key)).not.toContain('notes')
  })

  test('collections pull and push the same schema as attributes', async () => {
    const ws = new Workspace('collections')
    await ws.withKey()
    await ws.ok('pull', 'collections')
    const config = ws.config
    expect(config.collections.find((c: any) => c.$id === 'products').attributes.map((a: any) => a.key)).toContain('price')
    config.collections.push({ $id: 'orders', databaseId: DB, name: 'Orders', documentSecurity: true, $permissions: [], attributes: [{ key: 'total', type: 'double', required: false, array: false }], indexes: [] })
    ws.config = config
    await ws.ok('push', 'collections')
    const orders = await new Databases(admin()).getCollection({ databaseId: DB, collectionId: 'orders' })
    expect(orders).toMatchObject({ name: 'Orders', documentSecurity: true })
    expect(orders.attributes.map((a: any) => [a.key, a.type])).toEqual([['total', 'double']])
  })
})

const MAIN = `module.exports = async (context) => context.res.json({
  greeting: 'hello from bunwrite cli',
  built: require('node:fs').existsSync('built.txt'),
})`

describe('functions', () => {
  test('push creates and deploys; pull brings back the source', async () => {
    const ws = new Workspace('functions')
    await ws.withKey()
    mkdirSync(join(ws.dir, 'functions', 'hello', 'src'), { recursive: true })
    writeFileSync(join(ws.dir, 'functions', 'hello', 'src', 'main.js'), MAIN)
    writeFileSync(join(ws.dir, 'functions', 'hello', 'package.json'), '{"name":"hello"}')
    // Secrets for `bunwrite env` stay on this machine.
    writeFileSync(join(ws.dir, 'functions', 'hello', '.env.production.local'), 'SECRET=never-uploaded\n')
    writeFileSync(join(ws.dir, 'functions', 'hello', '.env.local'), 'SECRET=never-uploaded\n')
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
          timeout: 15,
          enabled: true,
          logging: true,
        },
      ],
    }
    expect(await ws.ok('push', 'functions')).toContain('Deployed 1 function')
    const functions = new Functions(admin())
    const fn = await functions.get({ functionId: 'hello' })
    expect(fn).toMatchObject({ name: 'Hello', runtime: 'node-22', latestDeploymentStatus: 'ready' })
    const run = await functions.createExecution({ functionId: 'hello' })
    expect(JSON.parse(run.responseBody)).toEqual({ greeting: 'hello from bunwrite cli', built: true })

    const fresh = new Workspace('functions-pull')
    await fresh.withKey()
    expect(await fresh.ok('pull', 'functions')).toContain('Pulled 1 functions')
    const pulled = fresh.config.functions[0]
    expect(pulled).toMatchObject({ $id: 'hello', name: 'Hello', entrypoint: 'src/main.js', execute: ['any'], timeout: 15, path: 'functions/hello' })
    expect(readFileSync(join(fresh.dir, 'functions/hello/src/main.js'), 'utf8')).toBe(MAIN)
    expect(existsSync(join(fresh.dir, 'functions/hello/built.txt'))).toBe(false)
    expect(existsSync(join(fresh.dir, 'functions/hello/package.json'))).toBe(true)
    expect(existsSync(join(fresh.dir, 'functions/hello/.env.production.local'))).toBe(false)
    expect(existsSync(join(fresh.dir, 'functions/hello/.env.local'))).toBe(false)
  })

  test('a failing build is reported with its logs and keeps the active code', async () => {
    const ws = new Workspace('functions-fail')
    await ws.withKey()
    await ws.ok('pull', 'functions', '--no-code')
    const before = (await new Functions(admin()).get({ functionId: 'hello' })).deploymentId
    mkdirSync(join(ws.dir, 'functions', 'hello', 'src'), { recursive: true })
    writeFileSync(join(ws.dir, 'functions', 'hello', 'src', 'main.js'), MAIN)
    const config = ws.config
    config.functions[0].commands = 'echo broken >&2; exit 3'
    ws.config = config
    const result = await ws.run(['push', 'functions', '--function-id', 'hello'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('Failed to deploy')
    expect(result.out).toContain('broken')
    expect((await new Functions(admin()).get({ functionId: 'hello' })).deploymentId).toBe(before)
    await new Functions(admin()).update({ functionId: 'hello', name: 'Hello', commands: 'echo built > built.txt' })
  })

  test('settings alone with --no-code', async () => {
    const ws = new Workspace('functions-settings')
    await ws.withKey()
    await ws.ok('pull', 'functions', '--no-code')
    const config = ws.config
    config.functions[0].timeout = 30
    config.functions[0].execute = ['users']
    ws.config = config
    expect(await ws.ok('push', 'functions', '--no-code')).toContain('Pushed 1 functions')
    expect(await new Functions(admin()).get({ functionId: 'hello' })).toMatchObject({ timeout: 30, execute: ['users'] })
  })
})

describe('buckets, teams, webhooks and topics', () => {
  test('push creates then updates; pull reads back; a second push changes nothing', async () => {
    const ws = new Workspace('resources')
    await ws.withKey()
    const bucket = { $id: 'avatars', $permissions: ['read("any")'], fileSecurity: false, name: 'Avatars', enabled: true, maximumFileSize: 1_000_000, allowedFileExtensions: ['png'], compression: 'gzip', encryption: false, antivirus: false }
    ws.config = {
      projectId: PROJECT,
      buckets: [bucket],
      teams: [{ $id: 'staff', name: 'Staff' }],
      webhooks: [{ $id: 'hook', name: 'Hook', url: 'https://example.com/hook', events: ['databases.*'], enabled: true, tls: true }],
      topics: [{ $id: 'news', name: 'News', subscribe: ['users'] }],
    }
    expect(await ws.ok('push', 'all')).toContain('Pushed 1 buckets')
    expect(await new Storage(admin()).getBucket({ bucketId: 'avatars' })).toMatchObject(bucket)
    expect((await new Teams(admin()).get({ teamId: 'staff' })).name).toBe('Staff')

    const config = ws.config
    config.buckets[0].name = 'Profile pictures'
    config.teams[0].name = 'Crew'
    config.topics[0].subscribe = ['team:staff']
    ws.config = config
    await ws.ok('push', 'all')
    expect((await new Storage(admin()).getBucket({ bucketId: 'avatars' })).name).toBe('Profile pictures')
    expect((await new Teams(admin()).get({ teamId: 'staff' })).name).toBe('Crew')

    const fresh = new Workspace('resources-pull')
    await fresh.withKey()
    for (const kind of ['buckets', 'teams', 'webhooks', 'topics']) await fresh.ok('pull', kind)
    expect(fresh.config.buckets).toEqual([{ ...bucket, name: 'Profile pictures' }])
    expect(fresh.config.webhooks).toEqual(config.webhooks)
    expect(fresh.config.topics).toEqual([{ $id: 'news', name: 'News', subscribe: ['team:staff'] }])
    expect(await fresh.ok('push', 'buckets')).toContain('No buckets were pushed')
  })
})

describe('sites', () => {
  test('push uploads only the output folder, even when .gitignore lists it', async () => {
    const ws = new Workspace('sites')
    await ws.withKey()
    const site = join(ws.dir, 'sites', 'landing')
    mkdirSync(join(site, 'dist', 'assets'), { recursive: true })
    writeFileSync(join(site, '.gitignore'), 'dist/\nnode_modules/\n')
    writeFileSync(join(site, 'package.json'), '{"name":"landing"}')
    writeFileSync(join(site, 'dist', 'index.html'), '<h1>Landing from the CLI</h1>')
    writeFileSync(join(site, 'dist', 'assets', 'app.js'), 'console.log(1)')
    ws.config = {
      projectId: PROJECT,
      sites: [{ $id: 'landing', name: 'Landing', framework: 'vite', path: 'sites/landing', outputDirectory: 'dist', fallbackFile: 'index.html' }],
    }
    const out = await ws.ok('push', 'sites')
    expect(out).toContain('Deployed 1 site')
    expect(out).toContain(`http://landing.sites.localhost:${server.config.port}`)

    const page = (path: string) => fetch(`http://127.0.0.1:${server.config.port}${path}`, { headers: { host: `landing.sites.localhost:${server.config.port}` } })
    expect(await (await page('/')).text()).toContain('Landing from the CLI')
    expect((await page('/assets/app.js')).status).toBe(200)
    expect((await page('/package.json')).status).toBe(404)

    const fresh = new Workspace('sites-pull')
    await fresh.withKey()
    expect(await fresh.ok('pull', 'sites')).toContain('Pulled 1 sites')
    expect(fresh.config.sites[0]).toMatchObject({ $id: 'landing', outputDirectory: 'dist', fallbackFile: 'index.html', path: 'sites/landing' })
    expect(readFileSync(join(fresh.dir, 'sites/landing/dist/index.html'), 'utf8')).toContain('Landing from the CLI')
  })

  test('push --with-variables syncs the site .env and keeps only what is there', async () => {
    const ws = new Workspace('sites-variables')
    await ws.withKey()
    const site = join(ws.dir, 'sites', 'vars')
    mkdirSync(join(site, 'dist'), { recursive: true })
    writeFileSync(join(site, 'dist', 'index.html'), '<h1>Vars</h1>')
    writeFileSync(join(site, '.env'), 'APPWRITE_API_KEY=secret-value\nPUBLIC_NAME=Vars\n')
    ws.config = {
      projectId: PROJECT,
      sites: [{ $id: 'vars', name: 'Vars', framework: 'other', path: 'sites/vars', outputDirectory: 'dist' }],
    }

    await ws.ok('push', 'sites', '--with-variables')
    const sites = new Sites(admin())
    const first = await sites.listVariables({ siteId: 'vars' })
    expect(first.total).toBe(2)
    expect(first.variables.find((v) => v.key === 'APPWRITE_API_KEY')?.secret).toBe(true)
    expect(first.variables.find((v) => v.key === 'PUBLIC_NAME')?.secret).toBe(false)

    writeFileSync(join(site, '.env'), 'PUBLIC_NAME=Changed\n')
    await ws.ok('push', 'sites', '--with-variables')
    const second = await sites.listVariables({ siteId: 'vars' })
    expect(second.total).toBe(1)
    expect(second.variables[0]?.key).toBe('PUBLIC_NAME')
    expect(second.variables[0]?.value).toBe('Changed')
  })

  test('a missing output folder says to build first', async () => {
    const ws = new Workspace('sites-unbuilt')
    await ws.withKey()
    mkdirSync(join(ws.dir, 'web'), { recursive: true })
    ws.config = { projectId: PROJECT, sites: [{ $id: 'unbuilt', name: 'Unbuilt', path: 'web', outputDirectory: 'dist' }] }
    const result = await ws.run(['push', 'sites'])
    expect(result.code).not.toBe(0)
    expect(result.out).toContain('Run the build first')
  })

  test('push and pull keep every custom domain', async () => {
    const ws = new Workspace('sites-domains')
    await ws.withKey()
    ws.config = {
      projectId: PROJECT,
      sites: [{ $id: 'domains-site', name: 'Domains', framework: 'other', path: 'sites/domains-site', domains: ['one.example.org', 'two.example.org'] }],
    }
    await ws.ok('push', 'sites', '--no-code')
    const site = (await new Sites(admin()).get({ siteId: 'domains-site' })) as any
    expect(site.domains).toEqual(['one.example.org', 'two.example.org'])

    const fresh = new Workspace('sites-domains-pull')
    await fresh.withKey()
    await fresh.ok('pull', 'sites', '--no-code')
    expect(fresh.config.sites.find((s: any) => s.$id === 'domains-site').domains).toEqual(['one.example.org', 'two.example.org'])
  })

  test('the SDK sets the API function and domain on create', async () => {
    const sites = new Sites(admin())
    const created = (await sites.create({ siteId: 'sdk-site', name: 'SDK site', framework: Framework.Other, buildRuntime: BuildRuntime.Static1, domain: 'sdk.example.org' })) as any
    expect(created.domain).toBe('sdk.example.org')
    const updated = (await sites.update({ siteId: 'sdk-site', name: 'SDK site', framework: Framework.Other, domain: '' })) as any
    expect(updated.domain).toBe('')
    await sites.delete({ siteId: 'sdk-site' })
  })
})

describe('pull all', () => {
  test('a signed-in admin pulls everything, and pushing it straight back succeeds', async () => {
    const ws = new Workspace('everything')
    await ws.signedIn()
    const out = await ws.ok('pull', 'all', '--no-code')
    for (const line of ['all project settings', 'tables from', 'functions', 'buckets', 'teams', 'webhooks', 'topics']) expect(out).toContain(line)
    expect(Object.keys(ws.config)).toEqual(expect.arrayContaining(['settings', 'functions', 'tablesDB', 'tables', 'buckets', 'teams', 'webhooks', 'topics']))
    const back = await ws.ok('push', 'all', '--no-code')
    expect(back).toContain('No tables were pushed')
    expect(back).toContain('No settings were pushed')
  })
})

describe('service commands', () => {
  test('call SDK methods with kebab-case flags; JSON values and files', async () => {
    const ws = new Workspace('services')
    await ws.withKey()
    const created = JSON.parse(
      await ws.ok('databases', 'create-document', '--database-id', DB, '--collection-id', 'products', '--document-id', 'cli-doc', '--data', '{"tenantId":"cli","name":"From CLI","price":4}', '--json'),
    )
    expect(created).toMatchObject({ $id: 'cli-doc', name: 'From CLI', price: 4 })
    const list = JSON.parse(await ws.ok('databases', 'list-documents', '--database-id', DB, '--collection-id', 'products', '--queries', '{"method":"equal","attribute":"tenantId","values":["cli"]}'))
    expect(list.documents.map((d: any) => d.$id)).toEqual(['cli-doc'])

    writeFileSync(join(ws.dir, 'note.txt'), 'uploaded by the cli')
    await ws.ok('storage', 'create-bucket', '--bucket-id', 'cli-files', '--name', 'CLI')
    await ws.ok('storage', 'create-file', '--bucket-id', 'cli-files', '--file-id', 'note', '--file', 'note.txt')
    await ws.ok('storage', 'get-file-download-bytes', '--bucket-id', 'cli-files', '--file-id', 'note', '--output', 'back.txt')
    expect(readFileSync(join(ws.dir, 'back.txt'), 'utf8')).toBe('uploaded by the cli')

    const unknown = await ws.run(['databases', 'nope'])
    expect(unknown.code).toBe(1)
    expect(unknown.out).toContain('has no command "nope"')
    expect(await ws.ok('databases', '--help')).toContain('list-documents')
  })
})

describe('environments', () => {
  const project = () => new Project(admin())
  const variables = async () => Object.fromEntries((await project().listVariables()).variables.map((v) => [v.key, v]))
  const clearVariables = async () => {
    for (const v of (await project().listVariables()).variables) await project().deleteVariable({ variableId: v.$id })
  }
  const environments = (extra: Record<string, unknown> = {}) => ({
    endpoint: server.endpoint,
    projectId: PROJECT,
    environments: {
      staging: { projectId: PROJECT },
      production: { extends: 'staging', protected: true },
      other: { projectId: 'other-project' },
    },
    ...extra,
  })

  test('list, use, --env and BUNWRITE_ENV pick the environment', async () => {
    const ws = new Workspace('env-select')
    await ws.withKey()
    ws.config = environments()

    const listed = await ws.ok('env')
    expect(listed).toContain('staging')
    expect(listed).toContain('No environment active')
    expect(await ws.ok('env', 'use', 'staging')).toContain('Using staging')
    expect(await ws.ok('env', 'list')).toContain('Active: staging (from env use)')
    expect((await ws.run(['env', 'list'], '', { BUNWRITE_ENV: 'production' })).out).toContain('Active: production (from BUNWRITE_ENV)')
    expect(await ws.ok('env', 'list', '--env', 'other')).toContain('Active: other (from --env)')

    const unknown = await ws.run(['env', 'diff', '--env', 'nope'])
    expect(unknown.code).toBe(1)
    expect(unknown.out).toContain('Unknown environment "nope". Defined: staging, production, other.')

    // The saved key belongs to PROJECT, so another environment's project does not get it.
    const other = await ws.run(['env', 'diff', '--env', 'other'])
    expect(other.code).toBe(1)
    expect(other.out).toContain('bunwrite login --env other')
    expect(await ws.ok('client', '--env', 'other', '--key', 'other-key')).toContain('API key saved for other ( other-project )')
    expect(ws.prefs.sessions.default.keys).toEqual({ 'other-project': 'other-key' })

    expect(await ws.ok('env', 'use', '--clear')).toContain('no longer has a chosen environment')
    expect(await ws.ok('env', 'list')).toContain('No environment active')
  })

  test('push, then pull into a fresh folder, then push back with no changes', async () => {
    await clearVariables()
    const ws = new Workspace('env-push')
    await ws.withKey()
    ws.config = environments()
    writeFileSync(join(ws.dir, '.env'), 'SHARED=everywhere\n')
    writeFileSync(join(ws.dir, '.env.staging'), '# staging\nAPI_URL=https://staging.example.com\n')
    writeFileSync(join(ws.dir, '.env.staging.local'), 'STRIPE_SECRET=sk_test_123\nNOT_SET_YET=\n')

    const diff = await ws.ok('env', 'diff', '--env', 'staging')
    expect(diff).toContain('→ staging')
    expect(diff).toMatch(/\+ API_URL\s+new/)
    expect(diff).toMatch(/\+ STRIPE_SECRET\s+new, secret/)
    expect(diff).toMatch(/! NOT_SET_YET\s+no value: set it in \.env\.staging\.local/)
    expect(await variables()).toEqual({})

    const declined = await ws.run(['env', 'push', '--env', 'staging'], 'n\n')
    expect(declined.out).toContain('Nothing was changed.')
    expect(await variables()).toEqual({})

    expect((await ws.run(['env', 'push', '--env', 'staging'], 'y\n')).out).toContain('Pushed 3 changes to staging')
    const pushed = await variables()
    expect(Object.keys(pushed).sort()).toEqual(['API_URL', 'SHARED', 'STRIPE_SECRET'])
    expect(pushed.STRIPE_SECRET).toMatchObject({ secret: true, value: '' })
    expect(pushed.API_URL).toMatchObject({ secret: false, value: 'https://staging.example.com' })

    // A secret with a value is sent again each time: the server cannot show it to compare.
    expect(await ws.ok('env', 'diff', '--env', 'staging')).toContain('↻ STRIPE_SECRET')

    const fresh = new Workspace('env-pull')
    await fresh.withKey()
    fresh.config = environments()
    const pulled = await fresh.ok('env', 'pull', '--env', 'staging')
    expect(pulled).toContain('Pulled staging into .env.staging and .env.staging.local')
    expect(readFileSync(join(fresh.dir, '.env.staging'), 'utf8')).toContain('API_URL=https://staging.example.com')
    expect(readFileSync(join(fresh.dir, '.env.staging.local'), 'utf8')).toBe('STRIPE_SECRET=  # secret: set on the server\n')
    expect(statSync(join(fresh.dir, '.env.staging.local')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(fresh.dir, '.gitignore'), 'utf8')).toContain('.env*.local')

    expect(await fresh.ok('env', 'push', '--env', 'staging')).toContain('No changes to push to staging')
    expect(await fresh.ok('env', 'pull', '--env', 'staging')).toContain('Your files already match staging')
    expect((await variables()).STRIPE_SECRET?.secret).toBe(true)
  })

  test('pull asks before replacing local values; --prune removes on both sides', async () => {
    await clearVariables()
    await project().createVariable({ variableId: 'unique()', key: 'MODE', value: 'server' })
    await project().createVariable({ variableId: 'unique()', key: 'OLD_FLAG', value: '1' })
    const ws = new Workspace('env-prune')
    await ws.withKey()
    ws.config = environments()
    writeFileSync(join(ws.dir, '.env.staging'), '# keep this comment\nMODE=local\nLOCAL_ONLY=yes\n')

    const kept = await ws.run(['env', 'pull', '--env', 'staging'], 'n\n')
    expect(kept.out).toContain('your value in .env.staging is replaced')
    expect(kept.out).toContain('Nothing was written.')
    expect(readFileSync(join(ws.dir, '.env.staging'), 'utf8')).toContain('MODE=local')

    await ws.run(['env', 'pull', '--env', 'staging'], 'y\n')
    expect(readFileSync(join(ws.dir, '.env.staging'), 'utf8')).toBe('# keep this comment\nMODE=server\nLOCAL_ONLY=yes\nOLD_FLAG=1\n')

    writeFileSync(join(ws.dir, '.env.staging'), 'MODE=server\nLOCAL_ONLY=yes\n')
    const plan = await ws.ok('env', 'diff', '--env', 'staging')
    expect(plan).toContain('only on the server (removed with --prune)')
    expect(await ws.ok('env', 'push', '--env', 'staging', '--prune', '--yes')).toContain('Pushed 2 changes to staging')
    expect(Object.keys(await variables()).sort()).toEqual(['LOCAL_ONLY', 'MODE'])

    await project().deleteVariable({ variableId: (await variables()).LOCAL_ONLY!.$id })
    await ws.ok('env', 'pull', '--env', 'staging', '--prune', '--yes')
    expect(readFileSync(join(ws.dir, '.env.staging'), 'utf8')).toBe('MODE=server\n')
  })

  test('a protected environment needs its name typed before a push', async () => {
    await clearVariables()
    const ws = new Workspace('env-protected')
    await ws.withKey()
    ws.config = environments()
    writeFileSync(join(ws.dir, '.env.production'), 'RELEASE=1\n')

    const wrong = await ws.run(['env', 'push', '--env', 'production'], 'yes\n')
    expect(wrong.code).toBe(1)
    expect(wrong.out).toContain('production (protected)')
    expect(wrong.out).toContain('Stopped: nothing was changed in production.')
    expect(await variables()).toEqual({})

    expect((await ws.run(['env', 'push', '--env', 'production'], 'production\n')).out).toContain('Pushed 1 change to production')
    expect((await variables()).RELEASE?.value).toBe('1')

    // Config push to a protected environment asks too.
    ws.config = { ...environments(), buckets: [] }
    const config = await ws.run(['push', 'buckets', '--env', 'production'], 'no\n')
    expect(config.code).toBe(1)
    expect(config.out).toContain('Stopped: nothing was changed in production.')
    await clearVariables()
  })

  test('functions and sites keep their own files; check finds what an environment misses', async () => {
    await clearVariables()
    const functions = new Functions(admin())
    const sites = new Sites(admin())
    await functions.create({ functionId: 'env-fn', name: 'Env fn', runtime: 'node-22' as any })
    await sites.create({ siteId: 'env-site', name: 'Env site', framework: Framework.Other, buildRuntime: BuildRuntime.Static1 })
    try {
      const ws = new Workspace('env-scopes')
      await ws.withKey()
      const config = environments({
        functions: [
          { $id: 'env-fn', name: 'Env fn', path: 'functions/env-fn' },
          { $id: 'ghost', name: 'Ghost', path: 'functions/ghost' },
        ],
        sites: [{ $id: 'env-site', name: 'Env site', path: 'sites/env-site' }],
      })
      ws.config = config
      for (const dir of ['functions/env-fn', 'functions/ghost', 'sites/env-site']) mkdirSync(join(ws.dir, dir), { recursive: true })
      writeFileSync(join(ws.dir, '.env.staging'), 'ROOT=1\n')
      writeFileSync(join(ws.dir, 'functions/env-fn/.env.staging'), 'FN_ONLY=1\n')
      writeFileSync(join(ws.dir, 'functions/env-fn/.env.staging.local'), 'FN_SECRET=s3cret\n')
      writeFileSync(join(ws.dir, 'functions/ghost/.env.staging'), 'GHOST=1\n')
      writeFileSync(join(ws.dir, 'sites/env-site/.env.staging'), 'SITE_URL=https://web.example.com\n')

      const plan = await ws.ok('env', 'diff', '--env', 'staging')
      expect(plan).toContain('function ghost is not on the server yet')
      expect(plan).toMatch(/project\n\s+\+ ROOT/)
      expect(plan).toMatch(/function env-fn\n\s+\+ FN_ONLY\s+new\n\s+\+ FN_SECRET\s+new, secret/)
      expect(plan).toMatch(/site env-site\n\s+\+ SITE_URL/)
      const onlySites = await ws.ok('env', 'diff', '--env', 'staging', '--scope', 'sites')
      expect(onlySites).toContain('SITE_URL')
      expect(onlySites).not.toContain('FN_ONLY')
      expect(onlySites).not.toContain('ROOT')

      expect(await ws.ok('env', 'push', '--env', 'staging', '--yes')).toContain('Pushed 4 changes to staging')
      const fnVars = (await functions.listVariables({ functionId: 'env-fn' })).variables
      expect(fnVars.map((v) => [v.key, v.secret]).sort()).toEqual([['FN_ONLY', false], ['FN_SECRET', true]])
      expect((await sites.listVariables({ siteId: 'env-site' })).variables.map((v) => v.key)).toEqual(['SITE_URL'])
      expect(Object.keys(await variables())).toEqual(['ROOT'])

      const fresh = new Workspace('env-scopes-pull')
      await fresh.withKey()
      fresh.config = config
      for (const dir of ['functions/env-fn', 'sites/env-site']) mkdirSync(join(fresh.dir, dir), { recursive: true })
      expect(await fresh.ok('env', 'pull', '--env', 'staging')).toContain(
        'Pulled staging into .env.staging, functions/env-fn/.env.staging, functions/env-fn/.env.staging.local and sites/env-site/.env.staging',
      )
      expect(readFileSync(join(fresh.dir, 'functions/env-fn/.env.staging'), 'utf8')).toBe('FN_ONLY=1\n')
      expect(readFileSync(join(fresh.dir, 'functions/env-fn/.env.staging.local'), 'utf8')).toBe('FN_SECRET=  # secret: set on the server\n')
      expect(await fresh.ok('env', 'push', '--env', 'staging')).toContain('No changes to push to staging')

      writeFileSync(join(ws.dir, '.env.production'), 'ROOT=2\n')
      const checked = await ws.run(['env', 'check'])
      expect(checked.code).toBe(1)
      expect(checked.out).toContain('✓ staging sets every variable')
      expect(checked.out).toContain('✗ production is missing FN_ONLY (function env-fn), FN_SECRET (function env-fn), GHOST (function ghost), SITE_URL (site env-site)')
      expect(checked.out).toContain('2 environments are missing variables')
      expect(await ws.ok('env', 'check', '--env', 'staging')).toContain('✓ staging sets every variable')
    } finally {
      await functions.delete({ functionId: 'env-fn' })
      await sites.delete({ siteId: 'env-site' })
      await clearVariables()
    }
  })

  test('env add writes the environment, its files, and labels the project', async () => {
    const ws = new Workspace('env-add')
    await ws.signedIn()
    try {
      const added = await ws.ok('env', 'add', 'production', '--yes')
      expect(added).toContain(`Added production → ${PROJECT} @ ${new URL(server.endpoint).host} (protected), labelled production in the console`)
      expect(added).toContain('Created .env.production and .env.production.local')
      expect(ws.config.environments.production).toEqual({ endpoint: server.endpoint, projectId: PROJECT, protected: true })
      expect(server.services.config.environmentLabel).toBe('production')
      expect(statSync(join(ws.dir, '.env.production.local')).mode & 0o777).toBe(0o600)
      expect(readFileSync(join(ws.dir, '.gitignore'), 'utf8')).toContain('.env*.local')

      const again = await ws.run(['env', 'add', 'production', '--yes'])
      expect(again.code).toBe(1)
      expect(again.out).toContain('production is already in bunwrite.config.json')

      // Answers come from stdin: endpoint (default), project, protect.
      const asked = await ws.run(['env', 'add', 'qa'], `\n${PROJECT}\nn\n`)
      expect(asked.code).toBe(0)
      expect(ws.config.environments.qa).toEqual({ endpoint: server.endpoint, projectId: PROJECT })
      expect(server.services.config.environmentLabel).toBe('qa')

      const missing = await ws.run(['env', 'add', 'staging', '--yes'])
      expect(missing.code).toBe(1)
      expect(missing.out).toContain(`Project ${PROJECT}-staging does not exist`)
      expect(ws.config.environments.staging).toBeUndefined()

      const bad = await ws.run(['env', 'add', 'Bad Name', '--yes'])
      expect(bad.out).toContain('is not a valid environment name')
    } finally {
      server.services.settings.reset('environment')
    }
  })

  test('run starts a command with the merged variables and passes its exit code on', async () => {
    const ws = new Workspace('env-run')
    ws.config = environments({ functions: [{ $id: 'runner', name: 'Runner', path: 'functions/runner' }] })
    mkdirSync(join(ws.dir, 'functions/runner'), { recursive: true })
    writeFileSync(join(ws.dir, '.env'), 'SHARED=all\nOVERRIDE=shared\n')
    writeFileSync(join(ws.dir, '.env.staging'), 'OVERRIDE=staging\n')
    writeFileSync(join(ws.dir, '.env.staging.local'), 'TOKEN=t0k3n\nPLACEHOLDER=  # secret: set on the server\n')
    writeFileSync(join(ws.dir, 'functions/runner/.env.staging'), 'OVERRIDE=function\nFN=1\n')
    const show = 'console.log(JSON.stringify(["SHARED","OVERRIDE","TOKEN","PLACEHOLDER","FN"].map((k) => process.env[k] ?? null)))'

    const project = await ws.run(['run', '--env', 'staging', '--', 'bun', '-e', show])
    expect(project.code).toBe(0)
    expect(project.out).toContain('["all","staging","t0k3n",null,null]')
    expect(project.out).toContain('→ staging: 3 variables from .env, .env.staging, .env.staging.local')
    expect(project.out).toContain('PLACEHOLDER is a secret set only on the server')

    const fn = await ws.run(['run', '--env', 'staging', '--function-id', 'runner', '--', 'bun', '-e', show])
    expect(fn.out).toContain('["all","function","t0k3n",null,"1"]')

    expect((await ws.run(['run', '--', 'bun', '-e', 'process.exit(7)'])).code).toBe(7)
    const missing = await ws.run(['run', '--', 'definitely-not-a-command-xyz'])
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('Command not found: definitely-not-a-command-xyz')
  })

  test('.preview and .live files hold values for one deploy context', async () => {
    await clearVariables()
    const ws = new Workspace('env-contexts')
    await ws.withKey()
    ws.config = environments()
    writeFileSync(join(ws.dir, '.env.staging'), 'API_URL=https://api.example.com\n')
    writeFileSync(join(ws.dir, '.env.staging.preview'), 'API_URL=https://preview.example.com\n')
    writeFileSync(join(ws.dir, '.env.staging.preview.local'), 'STRIPE_KEY=sk_test\n')
    writeFileSync(join(ws.dir, '.env.staging.live.local'), 'STRIPE_KEY=sk_live\n')

    const plan = await ws.ok('env', 'diff', '--env', 'staging')
    expect(plan).toMatch(/\+ API_URL\s+new/)
    expect(plan).toMatch(/\+ STRIPE_KEY \(live only\)\s+new, secret/)
    expect(plan).toMatch(/\+ API_URL \(previews only\)\s+new/)
    expect(plan).toMatch(/\+ STRIPE_KEY \(previews only\)\s+new, secret/)
    expect(await ws.ok('env', 'push', '--env', 'staging', '--yes')).toContain('Pushed 4 changes to staging')
    const listed = (await project().listVariables()).variables as any[]
    expect(listed.map((v) => [v.key, v.context, v.secret]).sort()).toEqual([
      ['API_URL', '', false],
      ['API_URL', 'preview', false],
      ['STRIPE_KEY', 'live', true],
      ['STRIPE_KEY', 'preview', true],
    ])
    expect(server.services.variables.projectEnvironment('preview')).toMatchObject({ API_URL: 'https://preview.example.com', STRIPE_KEY: 'sk_test' })
    expect(server.services.variables.projectEnvironment('live')).toMatchObject({ API_URL: 'https://api.example.com', STRIPE_KEY: 'sk_live' })

    const show = 'console.log(JSON.stringify([process.env.API_URL, process.env.STRIPE_KEY]))'
    expect((await ws.run(['run', '--env', 'staging', '--', 'bun', '-e', show])).out).toContain('["https://api.example.com","sk_live"]')
    const preview = await ws.run(['run', '--env', 'staging', '--preview', '--', 'bun', '-e', show])
    expect(preview.out).toContain('["https://preview.example.com","sk_test"]')
    expect(preview.out).toContain('→ staging (preview): 2 variables from .env.staging, .env.staging.preview, .env.staging.preview.local')

    const fresh = new Workspace('env-contexts-pull')
    await fresh.withKey()
    fresh.config = environments()
    expect(await fresh.ok('env', 'pull', '--env', 'staging')).toContain(
      'Pulled staging into .env.staging, .env.staging.live.local, .env.staging.preview and .env.staging.preview.local',
    )
    expect(readFileSync(join(fresh.dir, '.env.staging.preview'), 'utf8')).toBe('API_URL=https://preview.example.com\n')
    expect(readFileSync(join(fresh.dir, '.env.staging.live.local'), 'utf8')).toBe('STRIPE_KEY=  # secret: set on the server\n')
    expect(await fresh.ok('env', 'push', '--env', 'staging')).toContain('No changes to push to staging')
    await clearVariables()
  })

  test('without environments, env uses .env and .env.local for the linked project', async () => {
    await clearVariables()
    const ws = new Workspace('env-none')
    await ws.withKey()
    ws.config = { projectId: PROJECT }
    writeFileSync(join(ws.dir, '.env'), 'PLAIN=1\nAPI_TOKEN=oops\n')
    writeFileSync(join(ws.dir, '.env.local'), 'REAL_SECRET=s\n')
    const pushed = await ws.ok('env', 'push', '--yes')
    expect(pushed).toContain('API_TOKEN looks like a secret but is in .env. Move it to .env.local')
    expect(pushed).toContain('Pushed 3 changes to the project')
    expect(pushed).not.toContain('→')
    expect((await variables()).REAL_SECRET?.secret).toBe(true)
    await clearVariables()
  })
})
