/**
 * The Bunwrite CLI (packages/cli) against a real server: client, login,
 * whoami, logout, init project, pull/push of every config section, function
 * deploys and the generic service commands.
 *
 * Each workspace gets its own BUNWRITE_HOME (the global prefs) and folder (its
 * bunwrite.config.json).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BuildRuntime, Client, Databases, Framework, Functions, Sites, Storage, TablesDB, Teams } from '../packages/sdk/src'
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
