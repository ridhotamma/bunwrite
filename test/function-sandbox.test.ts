/**
 * Function isolation (functions/sandbox.ts). The first part runs anywhere.
 * The second needs Linux and the setpriv helper with setuid/setgid
 * capabilities, as in the Docker image; CI prepares one and sets
 * BUNWRITE_TEST_SANDBOX=1 (see .github/workflows/test.yml).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deploymentDir, Deployments } from '~/functions/deployments'
import { allowPassThrough, DEFAULT_HELPER, lockDown, removeTree, setupSandbox, type FunctionSandbox } from '~/functions/sandbox'
import { adminClient, PROJECT, startServer, testSchema, type TestServer } from './helpers'

describe('turning isolation on', () => {
  test('off, or no usable helper, means no sandbox', () => {
    expect(setupSandbox('/tmp/x/bunwrite.sqlite', { FUNCTIONS_SANDBOX: 'off' })).toBeNull()
    expect(setupSandbox('/tmp/x/bunwrite.sqlite', { FUNCTIONS_SANDBOX_HELPER: '/nonexistent/helper' })).toBeNull()
    expect(setupSandbox(':memory:', {})).toBeNull()
  })

  test('FUNCTIONS_SANDBOX=on refuses to start without it, and says why', () => {
    expect(() => setupSandbox('/tmp/x/bunwrite.sqlite', { FUNCTIONS_SANDBOX: 'on', FUNCTIONS_SANDBOX_HELPER: '/nonexistent/helper' })).toThrow(
      process.platform === 'linux' ? 'helper /nonexistent/helper is missing' : 'needs Linux',
    )
  })

  test('the Docker image path is the default helper', () => {
    expect(DEFAULT_HELPER).toBe('/usr/local/libexec/bunwrite-sandbox')
  })

  test('folders on the way to code let others pass through, and nothing above the data folder changes', () => {
    const top = mkdtempSync(join(tmpdir(), 'bunwrite-pass-'))
    const root = join(top, 'data')
    const deep = join(root, 'deployments', 'fn')
    mkdirSync(deep, { recursive: true, mode: 0o700 })
    for (const dir of [top, root, join(root, 'deployments'), deep]) chmodSync(dir, 0o700)
    allowPassThrough(root, deep)
    const mode = (path: string) => statSync(path).mode & 0o777
    expect([mode(root), mode(join(root, 'deployments')), mode(deep)]).toEqual([0o711, 0o711, 0o711])
    expect(mode(top)).toBe(0o700)
    removeTree(null, top)
    expect(existsSync(top)).toBe(false)
  })

  test('a restart leaves the way open to each site deployment, default and project databases', () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-lock-'))
    try {
      const sites = join(root, 'sites', 'site-1')
      const deployment = join(sites, 'deployment-1')
      const home = join(sites, '.home')
      const project = join(root, 'projects', 'project-b')
      const projectSites = join(project, 'sites', 'site-2')
      const projectDeployment = join(projectSites, 'deployment-2')
      const dirs = [
        join(root, 'sites'),
        sites,
        deployment,
        home,
        join(root, 'projects'),
        project,
        join(project, 'sites'),
        projectSites,
        projectDeployment,
      ]
      for (const dir of dirs) mkdirSync(dir, { recursive: true, mode: 0o700 })
      for (const dir of [root, ...dirs]) chmodSync(dir, 0o700)

      // What setupSandbox does at every start.
      lockDown(root)

      const mode = (path: string) => statSync(path).mode & 0o777
      // The site's user must be able to walk in...
      expect([mode(join(root, 'sites')), mode(sites)]).toEqual([0o711, 0o711])
      expect([mode(join(root, 'projects')), mode(project), mode(join(project, 'sites')), mode(projectSites)]).toEqual([0o711, 0o711, 0o711, 0o711])
      // ...but the deployment and home folders stay private to it.
      expect([mode(deployment), mode(home), mode(projectDeployment)]).toEqual([0o700, 0o700, 0o700])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

const enabled = process.platform === 'linux' && process.env.BUNWRITE_TEST_SANDBOX === '1'

describe.skipIf(!enabled)('isolated functions (Linux, with the helper)', () => {
  let dir: string
  let server: TestServer
  let sandbox: FunctionSandbox
  let functions: any
  let previousUmask: number

  beforeAll(() => {
    previousUmask = process.umask()
    dir = mkdtempSync(join(tmpdir(), 'bunwrite-sandbox-'))
    const databasePath = join(dir, 'bunwrite.sqlite')
    sandbox = setupSandbox(databasePath, { FUNCTIONS_SANDBOX: 'on', FUNCTIONS_SANDBOX_HELPER: process.env.FUNCTIONS_SANDBOX_HELPER })!
    writeFileSync(join(dir, 'server-secret.txt'), 'only the server may read this')
    mkdirSync(join(dir, 'storage'))
    server = startServer(testSchema, { databasePath, storagePath: join(dir, 'storage'), functionsSandbox: sandbox })
    functions = adminClient(server.endpoint).functions
  })

  afterAll(() => {
    server?.stop()
    if (sandbox && existsSync(join(dir, 'deployments'))) sandbox.remove(join(dir, 'deployments'))
    rmSync(dir, { recursive: true, force: true })
    process.umask(previousUmask)
  })

  async function deploy(id: string, files: Record<string, string>, commands = '') {
    await functions.create({ functionId: id, name: id, runtime: 'node-22', execute: ['any'] })
    const src = join(dir, `src-${id}`)
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(src, path, '..'), { recursive: true })
      writeFileSync(join(src, path), content)
    }
    Bun.spawnSync(['tar', '-czf', `${src}.tar.gz`, '-C', src, '.'])
    const created = await functions.createDeployment({ functionId: id, code: new File([readFileSync(`${src}.tar.gz`)], 'code.tar.gz'), activate: true, entrypoint: 'index.js', commands })
    for (let i = 0; i < 300; i++) {
      const d = await functions.getDeployment({ functionId: id, deploymentId: created.$id })
      if (d.status === 'ready' || d.status === 'failed') return d
      await Bun.sleep(50)
    }
    throw new Error('deployment did not settle')
  }

  const call = async (id: string) => JSON.parse((await functions.createExecution({ functionId: id })).responseBody)

  test('each function builds and runs as its own user, with its own writable home', async () => {
    const one = await deploy('one', { 'index.js': `module.exports = async ({ res }) => res.json({ uid: process.getuid(), home: process.env.HOME, wrote: (require('fs').writeFileSync('x.txt', '1'), true) })` }, 'echo "build-uid=$(id -u)"')
    const two = await deploy('two', { 'index.js': `module.exports = async ({ res }) => res.json({ uid: process.getuid() })`, 'secret.txt': 'two only' })
    expect([one.status, two.status]).toEqual(['ready', 'ready'])
    const first = await call('one')
    const second = await call('two')
    expect(first.uid).toBeGreaterThanOrEqual(20000)
    expect(second.uid).toBeGreaterThanOrEqual(20000)
    expect(first.uid).not.toBe(second.uid)
    expect(first.uid).not.toBe(process.getuid!())
    expect(one.buildLogs).toContain(`build-uid=${first.uid}`)
    expect(first.home).toBe(join(deploymentDir(server.config, 'one'), '.home'))
    expect(first.wrote).toBe(true)
  })

  test('a function cannot read the server files or another function', async () => {
    const two = (await functions.listDeployments({ functionId: 'two' })).deployments[0]
    const twoDir = deploymentDir(server.config, 'two', two.$id)
    const probe = `const fs = require('fs')
const t = (f) => { try { f(); return 'read' } catch (e) { return e.code } }
module.exports = async ({ res }) => res.json({
  secret: t(() => fs.readFileSync(${JSON.stringify(join(dir, 'server-secret.txt'))})),
  listData: t(() => fs.readdirSync(${JSON.stringify(dir)})),
  storage: t(() => fs.readdirSync(${JSON.stringify(join(dir, 'storage'))})),
  otherCode: t(() => fs.readFileSync(${JSON.stringify(join(twoDir, 'secret.txt'))})),
  otherSource: t(() => fs.readFileSync(${JSON.stringify(`${twoDir}.source.tar.gz`)})),
  helper: t(() => require('child_process').execFileSync(${JSON.stringify(process.env.FUNCTIONS_SANDBOX_HELPER ?? DEFAULT_HELPER)}, ['--reuid=0', '--', 'true'])),
})`
    await deploy('spy', { 'index.js': probe })
    expect(await call('spy')).toEqual({ secret: 'EACCES', listData: 'EACCES', storage: 'EACCES', otherCode: 'EACCES', otherSource: 'EACCES', helper: 'EACCES' })
  })

  test('the server still reads code for the console, downloads the build and deletes functions', async () => {
    const fn = server.services.functions.fn('two')
    expect(server.services.functions.readEntry(fn, 10_000)).toContain('process.getuid()')
    const d = (await functions.listDeployments({ functionId: 'two' })).deployments[0]
    const archive = await new Deployments(server.db, server.config, server.services.functions).download('two', d.$id, 'output')
    writeFileSync(join(dir, 'out.tar.gz'), new Uint8Array(await archive.arrayBuffer()))
    expect(Bun.spawnSync(['tar', '-tzf', join(dir, 'out.tar.gz')]).stdout.toString()).toContain('secret.txt')

    await functions.delete({ functionId: 'two' })
    expect(existsSync(deploymentDir(server.config, 'two'))).toBe(false)
  })

  test('a restart keeps the way open to each site deployment', () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-sites-'))
    try {
      const siteDir = join(root, 'sites', 'site-1')
      const deployment = join(siteDir, 'deployment-1')
      const home = join(siteDir, '.home')
      mkdirSync(deployment, { recursive: true, mode: 0o700 })
      mkdirSync(home, { recursive: true, mode: 0o700 })
      for (const path of [root, join(root, 'sites'), siteDir, deployment, home]) chmodSync(path, 0o700)
      // What the next container start does to the data folder.
      setupSandbox(join(root, 'bunwrite.sqlite'), { FUNCTIONS_SANDBOX: 'on', FUNCTIONS_SANDBOX_HELPER: process.env.FUNCTIONS_SANDBOX_HELPER })
      const mode = (path: string) => statSync(path).mode & 0o777
      // The app runs as another user, so it must be able to walk this path.
      expect([mode(root), mode(join(root, 'sites')), mode(siteDir)]).toEqual([0o711, 0o711, 0o711])
      // But its own folders stay private.
      expect([mode(deployment), mode(home)]).toEqual([0o700, 0o700])
    } finally {
      removeTree(null, root)
    }
  })

  test('a deployment made before isolation was on is handed over on its next run', async () => {
    const d = (await functions.listDeployments({ functionId: 'one' })).deployments[0]
    const folder = deploymentDir(server.config, 'one', d.$id)
    const uid = sandbox.uidFor(PROJECT, 'one')
    // Give it back to the server, as an older server would have left it.
    Bun.spawnSync([process.env.FUNCTIONS_SANDBOX_HELPER ?? DEFAULT_HELPER, '--reuid=0', '--regid=0', '--clear-groups', '--', 'chown', '-R', `${process.getuid!()}:${process.getgid!()}`, folder])
    expect(statSync(folder).uid).toBe(process.getuid!())
    expect((await call('one')).uid).toBe(uid)
    expect(statSync(folder).uid).toBe(uid)
  })
})
