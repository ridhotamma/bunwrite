/**
 * Creating functions and deploying their code from the console: starter
 * templates, uploaded .zip and .tar.gz folders, code typed in the browser,
 * and managing deployments.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import { ConsoleAuth } from '~/console/auth'
import { Deployments } from '~/functions/deployments'
import { extractZip } from '~/functions/zip'
import { PROJECT, startServer, type TestServer } from './helpers'

let server: TestServer
let base: string
let cookie = ''
let work: string

beforeAll(async () => {
  server = startServer()
  base = server.endpoint.replace(/\/v1$/, '')
  const auth = new ConsoleAuth(server.db)
  await auth.upsert('admin@example.com', 'console-password')
  cookie = `bunwrite_console=${(await auth.login('admin@example.com', 'console-password'))!}; console_project=${PROJECT}`
  work = mkdtempSync(join(tmpdir(), 'bunwrite-fn-console-'))
})
afterAll(() => {
  server.stop()
  rmSync(work, { recursive: true, force: true })
})

const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' })

function post(path: string, fields: Record<string, string | Blob>) {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.append(key, value)
  return fetch(`${base}${path}`, { method: 'POST', body, redirect: 'manual', headers: { cookie } })
}

const flash = (res: Response) => new URL(res.headers.get('location') ?? '/', base).searchParams
const deployments = () => new Deployments(server.db, server.config, server.services.functions)

/** Wait until the function's newest deployment has finished building. */
async function settled(functionId: string) {
  for (let i = 0; i < 200; i++) {
    const latest = deployments().latest(functionId)
    if (latest && !['waiting', 'processing', 'building'].includes(latest.status)) return latest
    await Bun.sleep(25)
  }
  throw new Error(`deployment for ${functionId} did not finish`)
}

async function run(functionId: string, path = '/') {
  const f = server.services.functions.fn(functionId)
  const { result } = await server.services.functions.execute(f, { trigger: 'http', method: 'GET', path }, 'sync')
  return result!
}

/** A minimal .zip writer: one stored entry and one deflated, as zip tools write them. */
function zip(files: Record<string, string>, deflate = true): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const packed = deflate ? deflateRawSync(data) : data
    const nameBytes = Buffer.from(name)
    const crc = Bun.hash.crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, packed)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + packed.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, cd, end]))
}

const nodeFn = (message: string) => `export default async ({ res }) => res.json({ message: ${JSON.stringify(message)} })\n`

describe('console function creation', () => {
  test('the functions page offers a Create function dialog', async () => {
    const page = await (await get('/console/functions')).text()
    expect(page).toContain('data-dialog-open="#create-function"')
    expect(page).toContain('id="create-function-form"')
    expect(page).toContain('enctype="multipart/form-data"')
    expect(page).toContain('value="node-22"')
    const open = await (await get('/console/functions?create=1')).text()
    expect(open).toMatch(/<dialog id="create-function" class="dialog" open data-open/)
  })

  test('creates a function from the starter template, live and runnable', async () => {
    const res = await post('/console/functions', { name: 'Hello', id: 'hello', runtime: 'node-22', entrypoint: 'src/main.js', schedule: '', source: 'template' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toStartWith('/console/functions/hello')
    expect(flash(res).get('ok')).toBe('Function created')
    const d = await settled('hello')
    expect(d.status).toBe('ready')
    expect(server.services.functions.fn('hello').deployment_id).toBe(d.id)
    const result = await run('hello')
    expect(result.statusCode).toBe(200)
    expect(JSON.parse(result.body).message).toBe('Hello from your new function')
    expect((await run('hello', '/ping')).body).toBe('pong')

    const page = await (await get('/console/functions/hello')).text()
    expect(page).toContain('id="deployments"')
    expect(page).toContain('Live deployment')
    // An existing function's deploy dialog opens on its own code, not the template.
    expect(page).toMatch(/value="paste" data-show-by checked/)
    expect(page).toContain('Hello from your new function')
  })

  test('refuses bad input before creating anything', async () => {
    const badId = await post('/console/functions', { name: 'Bad', id: '-bad id', runtime: 'node-22', entrypoint: 'src/main.js', source: 'template' })
    expect(flash(badId).get('err')).toContain('Function ID')
    const noFile = await post('/console/functions', { name: 'No file', id: 'no-file', runtime: 'node-22', entrypoint: 'src/main.js', source: 'upload' })
    expect(flash(noFile).get('err')).toContain('Choose a .zip or .tar.gz file')
    const noCode = await post('/console/functions', { name: 'No code', id: 'no-code', runtime: 'node-22', entrypoint: 'src/main.js', source: 'paste', code_text: '  ' })
    expect(flash(noCode).get('err')).toContain('Add the code')
    const runtime = await post('/console/functions', { name: 'Ruby', id: 'ruby', runtime: 'ruby-3.3', entrypoint: 'main.rb', source: 'template' })
    expect(flash(runtime).get('err')).toContain('Choose a runtime')
    const escape = await post('/console/functions', { name: 'Escape', id: 'escape', runtime: 'node-22', entrypoint: '../main.js', source: 'template' })
    expect(flash(escape).get('err')).toContain('entry file')
    for (const id of ['no-file', 'no-code', 'ruby', 'escape']) expect(() => server.services.functions.fn(id)).toThrow()
  })

  test('creates a function from an uploaded .zip whose code sits in one folder', async () => {
    const archive = zip({ 'my-fn/src/main.js': nodeFn('from a zip'), 'my-fn/package.json': '{"type":"module"}', '__MACOSX/my-fn/._main.js': 'junk' })
    const res = await post('/console/functions', {
      name: 'Zipped',
      id: 'zipped',
      runtime: 'node-22',
      entrypoint: 'src/main.js',
      source: 'upload',
      code: new File([archive], 'my-fn.zip', { type: 'application/zip' }),
      commands: '',
    })
    expect(flash(res).get('ok')).toBe('Function created')
    const d = await settled('zipped')
    expect(d.status).toBe('ready')
    expect(d.build_logs).toContain('Using the "my-fn" folder')
    expect(JSON.parse((await run('zipped')).body).message).toBe('from a zip')
  })

  test('deploys an uploaded .tar.gz', async () => {
    const dir = join(work, 'tar-fn')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'main.js'), nodeFn('from a tarball'))
    const tarball = join(work, 'code.tar.gz')
    expect(Bun.spawnSync(['tar', '-czf', tarball, '-C', dir, '.']).exitCode).toBe(0)
    const res = await post('/console/functions/hello/deployments', {
      entrypoint: 'src/main.js',
      source: 'upload',
      code: new File([await Bun.file(tarball).arrayBuffer()], 'code.tar.gz'),
      activate: 'on',
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('/console/functions/hello/deployments/')
    expect((await settled('hello')).status).toBe('ready')
    expect(JSON.parse((await run('hello')).body).message).toBe('from a tarball')
  })

  test('deploys typed code with a build command, then activates and deletes deployments', async () => {
    const before = server.services.functions.fn('hello').deployment_id
    const res = await post('/console/functions/hello/deployments', {
      entrypoint: 'src/main.js',
      source: 'paste',
      code_text: nodeFn('typed in the console'),
      commands: 'echo built > built.txt',
    })
    expect(res.status).toBe(303)
    const d = await settled('hello')
    expect(d.status).toBe('ready')
    expect(d.build_logs).toContain('$ echo built > built.txt')
    // Not ticked "make it live": the old code keeps running.
    expect(server.services.functions.fn('hello').deployment_id).toBe(before)
    expect(JSON.parse((await run('hello')).body).message).toBe('from a tarball')

    const logs = await (await get(`/console/functions/hello/deployments/${d.id}`)).text()
    expect(logs).toContain('Build logs')
    expect(logs).toContain('Make live')

    const activate = await post(`/console/functions/hello/deployments/${d.id}/activate`, {})
    expect(flash(activate).get('ok')).toBe('Deployment is live')
    expect(JSON.parse((await run('hello')).body).message).toBe('typed in the console')

    const activeDelete = await post(`/console/functions/hello/deployments/${d.id}/delete`, {})
    expect(flash(activeDelete).get('err')).toContain('active deployment cannot be deleted')
    const removed = await post(`/console/functions/hello/deployments/${before}/delete`, {})
    expect(flash(removed).get('ok')).toBe('Deployment deleted')
    expect(deployments().list('hello').map((row) => row.id)).not.toContain(before)
  })

  test('a failed build shows on the function page with a link to its logs', async () => {
    await post('/console/functions/zipped/deployments', { entrypoint: 'src/missing.js', source: 'paste', code_text: nodeFn('x'), commands: 'exit 3', activate: 'on' })
    const d = await settled('zipped')
    expect(d.status).toBe('failed')
    expect(d.build_logs).toContain('exited with code 3')
    // The previous code is still live.
    expect(JSON.parse((await run('zipped')).body).message).toBe('from a zip')
  })

  test('deletes a function with its deployments', async () => {
    const res = await post('/console/functions/zipped/delete', {})
    expect(res.headers.get('location')).toStartWith('/console/functions?')
    expect(flash(res).get('ok')).toBe('Zipped deleted')
    expect(() => server.services.functions.fn('zipped')).toThrow()
    expect(deployments().list('zipped')).toEqual([])
  })
})

describe('zip reader', () => {
  test('unpacks stored and deflated entries', () => {
    const dest = join(work, 'unzip-ok')
    expect(extractZip(zip({ 'a.txt': 'stored' }, false), dest)).toBe(1)
    expect(extractZip(zip({ 'dir/b.txt': 'deflated '.repeat(50) }), dest)).toBe(1)
    expect(Bun.file(join(dest, 'a.txt')).size).toBe(6)
  })

  test('refuses paths outside the destination and non-zip data', () => {
    expect(() => extractZip(zip({ '../evil.txt': 'x' }), join(work, 'unzip-bad'))).toThrow('Unsafe path')
    expect(() => extractZip(new Uint8Array([1, 2, 3, 4]), join(work, 'unzip-bad'))).toThrow('not a valid .zip')
  })
})
