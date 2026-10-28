/**
 * Functions that bring their own code and libraries: Python imports from the
 * function's folders and from packages pip installed during the build, and
 * build commands that use bun/npm on a server (like the Docker image) that
 * has neither. Everything here runs offline.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { adminClient, startServer, type TestServer } from './helpers'

let server: TestServer
let functions: any
let work: string

beforeAll(() => {
  server = startServer()
  functions = adminClient(server.endpoint).functions
  work = mkdtempSync(join(tmpdir(), 'bunwrite-deps-'))
})
afterAll(() => {
  server.stop()
  rmSync(work, { recursive: true, force: true })
})

function pack(name: string, files: Record<string, string>): File {
  const dir = join(work, name)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const archive = join(work, `${name}.tar.gz`)
  expect(Bun.spawnSync(['tar', '-czf', archive, '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } }).exitCode).toBe(0)
  return new File([readFileSync(archive)], 'code.tar.gz')
}

/** Create, deploy and build a function; returns the finished deployment. */
async function deploy(id: string, runtime: string, entrypoint: string, commands: string, files: Record<string, string>) {
  await functions.create({ functionId: id, name: id, runtime, execute: ['any'] })
  const created = await functions.createDeployment({ functionId: id, code: pack(id, files), activate: true, entrypoint, commands })
  for (let i = 0; i < 300; i++) {
    const d = await functions.getDeployment({ functionId: id, deploymentId: created.$id })
    if (d.status === 'ready' || d.status === 'failed') return d
    await Bun.sleep(50)
  }
  throw new Error('deployment did not settle')
}

async function run(id: string) {
  const execution = await functions.createExecution({ functionId: id })
  return { ...execution, json: execution.responseBody ? JSON.parse(execution.responseBody) : null }
}

/** The last PATH entry during a build is Bunwrite's own bun/npm folder; calling it directly skips any real npm. */
const SHIMS = '"${PATH##*:}"'

describe('Python imports', () => {
  test("an entrypoint in a subfolder imports files beside it and at the function's top", async () => {
    const d = await deploy('py-local', 'python-3.12', 'src/main.py', '', {
      'src/main.py': 'import helper, util\ndef main(context):\n    return context.res.json({"helper": helper.v, "util": util.v})',
      'src/helper.py': 'v = "beside the entrypoint"',
      'util.py': 'v = "function folder"',
    })
    expect(d.status).toBe('ready')
    expect((await run('py-local')).json).toEqual({ helper: 'beside the entrypoint', util: 'function folder' })
  })

  test('packages installed into PIP_TARGET during the build are importable; own files win over them', async () => {
    const install = [
      'case "$PIP_TARGET" in */.python_packages) ;; *) echo "unexpected PIP_TARGET $PIP_TARGET" >&2; exit 1 ;; esac',
      // Stand in for `pip install`, which writes packages to $PIP_TARGET.
      'mkdir -p "$PIP_TARGET/greet" && echo "msg = \'hi from a package\'" > "$PIP_TARGET/greet/__init__.py"',
      'echo "v = \'package\'" > "$PIP_TARGET/helper.py"',
    ].join(' && ')
    const d = await deploy('py-packages', 'python-3.12', 'main.py', install, {
      'main.py': 'import greet, helper\ndef main(context):\n    return context.res.json({"greet": greet.msg, "helper": helper.v})',
      'helper.py': 'v = "own file"',
    })
    expect(d.status).toBe('ready')
    expect((await run('py-packages')).json).toEqual({ greet: 'hi from a package', helper: 'own file' })
  })
})

describe('build commands without npm or bun installed', () => {
  const nodeMain = `const greet = require('greet'); module.exports = async ({ res }) => res.json({ greet: greet(), built: require('node:fs').existsSync('built.txt') })`
  const files = {
    'index.js': nodeMain,
    'package.json': JSON.stringify({ name: 'fn', dependencies: { greet: 'file:./vendor/greet' }, devDependencies: {}, scripts: { build: 'echo yes > built.txt' } }),
    'vendor/greet/package.json': JSON.stringify({ name: 'greet', version: '1.0.0', main: 'index.js' }),
    'vendor/greet/index.js': "module.exports = () => 'hello from node_modules'",
  }

  test('npm install and npm run go through Bun', async () => {
    const d = await deploy('npm-shim', 'node-22', 'index.js', `${SHIMS}/npm install --omit=dev --no-audit && ${SHIMS}/npm run build`, files)
    expect(d.status).toBe('ready')
    expect(d.buildLogs).toContain('bun install')
    expect((await run('npm-shim')).json).toEqual({ greet: 'hello from node_modules', built: true })
  })

  test('bun itself is available', async () => {
    const d = await deploy('bun-shim', 'node-22', 'index.js', `${SHIMS}/bun install && ${SHIMS}/bun --version`, files)
    expect(d.status).toBe('ready')
    expect(d.buildLogs).toMatch(/\n\d+\.\d+\.\d+/)
    expect((await run('bun-shim')).json).toMatchObject({ greet: 'hello from node_modules' })
  })

  test('an npm command the fallback does not cover fails with a clear message', async () => {
    const d = await deploy('npm-other', 'node-22', 'index.js', `${SHIMS}/npm publish`, files)
    expect(d.status).toBe('failed')
    expect(d.buildLogs).toContain('npm is not installed on this server')
  })

  test('the fallback comes last on PATH, so a real npm or bun on the server is used first', async () => {
    const d = await deploy('path-order', 'node-22', 'index.js', 'echo "$PATH" | tr ":" "\\n" | tail -1 | grep -q "/.runtimes/bin$" && echo last-is-fallback', files)
    expect(d.buildLogs).toContain('last-is-fallback')
  })
})
