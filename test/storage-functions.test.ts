import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ID, Permission, Query, Role } from 'node-appwrite'
import sharp from 'sharp'

import { adminClient, addMembership, DB, failure, makeUser, PROJECT, sessionClient, startServer, testSchema, type TestServer } from './helpers'

const MEDIA = 'media'
const VIDEOS = 'videos'
let dir: string
let server: TestServer
let admin: ReturnType<typeof adminClient>

/** Write a function's code into the temp folder the schema points at. */
function fn(id: string, source: string, file = 'src/main.js') {
  mkdirSync(join(dir, 'functions', id, 'src'), { recursive: true })
  writeFileSync(join(dir, 'functions', id, file), source)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pesanle-backend-'))
  fn(
    'echo',
    `module.exports = async (context) => {
      context.log('hello from', context.req.method, context.req.path)
      const res = await fetch(process.env.APPWRITE_FUNCTION_API_ENDPOINT + '/databases', {
        headers: { 'x-appwrite-project': process.env.APPWRITE_FUNCTION_PROJECT_ID, 'x-appwrite-key': process.env.APPWRITE_API_KEY },
      })
      const dbs = await res.json()
      return context.res.json({ ok: true, body: context.req.body, query: context.req.query, databases: dbs.total, trigger: process.env.APPWRITE_FUNCTION_TRIGGER, secretLeaked: Boolean(process.env.SECRET) })
    }`,
  )
  fn('boom', `module.exports = async (context) => { throw new Error('kaboom') }`)
  fn('slow', `module.exports = async (context) => { await new Promise((r) => setTimeout(r, 5000)); return context.res.json({}) }`)
  fn('cron', `module.exports = async (context) => context.res.json({ ran: true })`)
  fn('public', `module.exports = async (context) => context.res.json({ method: context.req.method, path: context.req.path, key: context.req.headers['x-render-key'] ?? null, body: context.req.bodyJson })`)
  fn(
    'py',
    `async def main(context):
    context.log("python says hi")
    body = context.req.body
    return context.res.json({"ok": True, "got": body, "method": context.req.method})
`,
    'src/main.py',
  )

  const schema = {
    ...testSchema,
    buckets: [
      { $id: MEDIA, name: 'Media', fileSecurity: true, $permissions: [], maximumFileSize: 10_000_000, allowedFileExtensions: ['jpg', 'jpeg', 'png', 'webp'] },
      { $id: VIDEOS, name: 'Videos', fileSecurity: true, $permissions: [], maximumFileSize: 50_000_000, allowedFileExtensions: [] },
    ],
    functions: [
      { $id: 'echo', name: 'Echo', runtime: 'node-22', entrypoint: 'src/main.js', path: 'functions/echo', execute: [], timeout: 15 },
      { $id: 'boom', name: 'Boom', runtime: 'node-22', entrypoint: 'src/main.js', path: 'functions/boom', execute: [], timeout: 15 },
      { $id: 'slow', name: 'Slow', runtime: 'node-22', entrypoint: 'src/main.js', path: 'functions/slow', execute: [], timeout: 1 },
      { $id: 'cron', name: 'Cron', runtime: 'node-22', entrypoint: 'src/main.js', path: 'functions/cron', execute: [], schedule: '*/5 * * * *', timeout: 15 },
      { $id: 'public', name: 'Public', runtime: 'node-22', entrypoint: 'src/main.js', path: 'functions/public', execute: ['any'], timeout: 15 },
      { $id: 'py', name: 'Py', runtime: 'python-3.9', entrypoint: 'src/main.py', path: 'functions/py', execute: [], timeout: 15 },
    ],
  }
  server = startServer(schema, { storagePath: join(dir, 'storage') }, dir)
  admin = adminClient(server.endpoint)
})
afterAll(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function png(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width, height, channels: 3, background: '#3366ff' } }).png().toBuffer())
}

describe('storage', () => {
  test('upload like media.ts, then read it back as JSON, view, download and preview', async () => {
    const bytes = await png(800, 400)
    const created = await admin.storage.createFile({
      bucketId: MEDIA,
      fileId: ID.unique(),
      file: new File([bytes], 'photo.png', { type: 'image/png' }),
      permissions: [Permission.read(Role.any()), Permission.update(Role.team('shop1', 'owner'))],
    })
    expect(Object.keys(created)).toEqual([
      '$id', 'bucketId', '$createdAt', '$updatedAt', '$permissions', 'name', 'folder', 'key', 'signature', 'mimeType',
      'sizeOriginal', 'sizeActual', 'chunksTotal', 'chunksUploaded', 'encryption', 'compression',
    ])
    expect([created.name, created.mimeType, created.sizeOriginal, created.chunksUploaded]).toEqual(['photo.png', 'image/png', bytes.length, 1])
    expect(created.signature).toMatch(/^[0-9a-f]{32}$/)

    const got = await admin.storage.getFile({ bucketId: MEDIA, fileId: created.$id })
    expect(got.$id).toBe(created.$id)

    // buildFileViewUrl: a plain <img src> with only ?project=
    const view = await fetch(`${server.endpoint}/storage/buckets/${MEDIA}/files/${created.$id}/view?project=${PROJECT}`)
    expect(view.status).toBe(200)
    expect(view.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await view.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true)

    const download = await admin.storage.getFileDownload({ bucketId: MEDIA, fileId: created.$id })
    expect(Buffer.from(download).equals(Buffer.from(bytes))).toBe(true)

    // buildFilePreviewUrl: width + webp + quality
    const preview = await fetch(`${server.endpoint}/storage/buckets/${MEDIA}/files/${created.$id}/preview?project=${PROJECT}&output=webp&width=200&quality=80`)
    expect(preview.headers.get('content-type')).toBe('image/webp')
    const meta = await sharp(Buffer.from(await preview.arrayBuffer())).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 200, 100])
    const cropped = await sharp(Buffer.from(await admin.storage.getFilePreview({ bucketId: MEDIA, fileId: created.$id, width: 100, height: 100 }))).metadata()
    expect([cropped.width, cropped.height]).toEqual([100, 100])
  })

  test('bucket rules: extension and size', async () => {
    const ext = await failure(admin.storage.createFile({ bucketId: MEDIA, fileId: ID.unique(), file: new File(['x'], 'notes.txt') }))
    expect([ext.code, ext.type]).toEqual([400, 'storage_file_type_unsupported'])
    const big = await failure(admin.storage.createFile({ bucketId: MEDIA, fileId: ID.unique(), file: new File([new Uint8Array(10_000_001)], 'big.jpg') }))
    expect(big.type).toBe('storage_invalid_file_size')
    expect((await failure(admin.storage.getFile({ bucketId: 'nope', fileId: 'x' }))).type).toBe('storage_bucket_not_found')
  })

  test('private files: team members only; others see 404', async () => {
    const file = await admin.storage.createFile({ bucketId: MEDIA, fileId: 'private1', file: new File([await png(10, 10)], 'p.png'), permissions: [Permission.read(Role.team('shopX'))] })
    const member = makeUser(server.db, 'member-x')
    addMembership(server.db, 'shopX', 'member-x', ['staff'])
    const stranger = makeUser(server.db, 'stranger-x')
    expect((await sessionClient(server.endpoint, member.secret).storage.getFile({ bucketId: MEDIA, fileId: file.$id })).$id).toBe('private1')
    expect((await failure(sessionClient(server.endpoint, stranger.secret).storage.getFile({ bucketId: MEDIA, fileId: file.$id }))).code).toBe(404)
    const guestView = await fetch(`${server.endpoint}/storage/buckets/${MEDIA}/files/private1/view?project=${PROJECT}`)
    expect(guestView.status).toBe(404)
    const del = await failure(sessionClient(server.endpoint, member.secret).storage.deleteFile({ bucketId: MEDIA, fileId: file.$id }))
    expect(del.code).toBe(401)
  })

  test('SDK chunked upload (over 5 MB) reassembles the file', async () => {
    const bytes = new Uint8Array(12 * 1024 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    const created = await admin.storage.createFile({ bucketId: VIDEOS, fileId: ID.unique(), file: new File([bytes], 'clip.mp4', { type: 'video/mp4' }) })
    expect([created.chunksTotal, created.chunksUploaded, created.sizeOriginal]).toEqual([3, 3, bytes.length])
    const back = new Uint8Array(await admin.storage.getFileView({ bucketId: VIDEOS, fileId: created.$id }))
    expect(back.length).toBe(bytes.length)
    expect(Buffer.compare(Buffer.from(back), Buffer.from(bytes))).toBe(0)

    // Video players ask for byte ranges.
    const ranged = await fetch(`${server.endpoint}/storage/buckets/${VIDEOS}/files/${created.$id}/view?project=${PROJECT}`, {
      headers: { range: 'bytes=10-19', 'x-appwrite-key': 'standard_testkey' },
    })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe(`bytes 10-19/${bytes.length}`)
    expect([...new Uint8Array(await ranged.arrayBuffer())]).toEqual([...bytes.slice(10, 20)])
  })

  test('manual chunks with Content-Range + x-appwrite-id (online-store/server/videos.ts)', async () => {
    const total = 9
    const parts = [new Uint8Array([1, 2, 3, 4, 5]), new Uint8Array([6, 7, 8, 9])]
    let start = 0
    const fileId = ID.unique()
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!
      const body = new FormData()
      body.set('fileId', fileId)
      body.set('file', new File([part], 'v.webm', { type: 'video/webm' }))
      body.append('permissions[]', Permission.read(Role.team('shopV')))
      const res = await fetch(`${server.endpoint}/storage/buckets/${VIDEOS}/files`, {
        method: 'POST',
        headers: {
          'X-Appwrite-Project': PROJECT,
          'X-Appwrite-Key': 'standard_testkey',
          'Content-Range': `bytes ${start}-${start + part.length - 1}/${total}`,
          ...(index > 0 ? { 'x-appwrite-id': fileId } : {}),
        },
        body,
      })
      expect(res.status).toBe(201)
      start += part.length
    }
    const file = await admin.storage.getFile({ bucketId: VIDEOS, fileId })
    expect(file.$permissions).toEqual(['read("team:shopV")'])
    expect([...new Uint8Array(await admin.storage.getFileDownload({ bucketId: VIDEOS, fileId }))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test('list, rename, delete (prune-orphaned-media flow)', async () => {
    const buckets = await admin.storage.listBuckets()
    expect(buckets.buckets.map((b: any) => b.$id)).toEqual([MEDIA, VIDEOS])
    const listed = await admin.storage.listFiles({ bucketId: MEDIA, queries: [Query.orderDesc('$createdAt'), Query.limit(1)] })
    expect(listed.total).toBe(2)
    expect(listed.files).toHaveLength(1)
    const renamed = await admin.storage.updateFile({ bucketId: MEDIA, fileId: 'private1', name: 'renamed.png' })
    expect(renamed.name).toBe('renamed.png')
    await admin.storage.deleteFile({ bucketId: MEDIA, fileId: 'private1' })
    expect((await failure(admin.storage.getFile({ bucketId: MEDIA, fileId: 'private1' }))).type).toBe('storage_file_not_found')
  })
})

describe('database metadata', () => {
  test('databases and collections list with attributes (backup flow)', async () => {
    const dbs = await admin.databases.list()
    expect(dbs.databases.map((d: any) => d.$id)).toEqual([DB])
    const cols = await admin.databases.listCollections({ databaseId: DB, queries: [Query.limit(2)] })
    expect(cols.total).toBe(3)
    expect(cols.collections).toHaveLength(2)
    const products = await admin.databases.getCollection({ databaseId: DB, collectionId: 'products' })
    expect(products.attributes.map((a: any) => a.key)).toContain('tags')
    expect(products.attributes.find((a: any) => a.key === 'status')).toMatchObject({ type: 'string', format: 'enum', elements: ['active', 'draft'] })
    expect(products.indexes.find((i: any) => i.key === 'idx_tenant_slug')).toMatchObject({ type: 'unique', attributes: ['tenantId', 'slug'] })
  })
})

describe('functions', () => {
  test('sync execution runs the code with Appwrite env vars and the server\'s key', async () => {
    const execution = await admin.functions.createExecution({ functionId: 'echo', body: JSON.stringify({ hi: 1 }), xpath: '/run?dry=1', method: 'POST', headers: { 'content-type': 'application/json' } })
    if (execution.status !== 'completed') console.error('echo execution', execution.status, execution.errors, execution.logs)
    expect(execution.status).toBe('completed')
    expect(execution.responseStatusCode).toBe(200)
    const out = JSON.parse(execution.responseBody)
    expect(out).toEqual({ ok: true, body: { hi: 1 }, query: { dry: '1' }, databases: 1, trigger: 'http', secretLeaked: false })
    expect(execution.logs).toContain('hello from POST /run')
  })

  test('async execution (backups screen): waiting, then completed; listed newest first', async () => {
    const queued = await admin.functions.createExecution({ functionId: 'echo', async: true })
    expect(['waiting', 'processing']).toContain(queued.status)
    for (let i = 0; i < 50; i++) {
      const e = await admin.functions.getExecution({ functionId: 'echo', executionId: queued.$id })
      if (e.status === 'completed') break
      await Bun.sleep(100)
    }
    const latest = await admin.functions.listExecutions({ functionId: 'echo', queries: [Query.orderDesc('$createdAt'), Query.limit(1)] })
    expect(latest.total).toBe(2)
    expect(latest.executions[0].$id).toBe(queued.$id)
    expect(latest.executions[0].status).toBe('completed')
    const f = await admin.functions.get({ functionId: 'echo' })
    expect([f.$id, f.enabled, f.runtime]).toEqual(['echo', true, 'node-22'])
  }, 15_000)

  test('a thrown error and a timeout both end as failed', async () => {
    const boom = await admin.functions.createExecution({ functionId: 'boom' })
    expect([boom.status, boom.responseStatusCode]).toEqual(['failed', 500])
    expect(boom.errors).toContain('kaboom')
    const slow = await admin.functions.createExecution({ functionId: 'slow' })
    expect(slow.status).toBe('failed')
    expect(slow.errors).toContain('timed out')
  })

  test('only roles in `execute` may run a function', async () => {
    const e = await failure(sessionClient(server.endpoint).functions.createExecution({ functionId: 'echo' }))
    expect(e.code).toBe(401)
    expect((await failure(admin.functions.get({ functionId: 'nope' }))).type).toBe('function_not_found')
  })

  test('the HTTP endpoint passes requests through (RENDER_FUNCTION_URL)', async () => {
    const res = await fetch(`${server.endpoint}/functions/public/http`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-render-key': 'k1' },
      body: JSON.stringify({ html: '<p>x</p>' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ method: 'POST', path: '/', key: 'k1', body: { html: '<p>x</p>' } })
    const blocked = await fetch(`${server.endpoint}/functions/echo/http`, { method: 'POST' })
    expect(blocked.status).toBe(401)
  })

  test('python functions run through python3', async () => {
    const e = await admin.functions.createExecution({ functionId: 'py', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } })
    expect(e.status).toBe('completed')
    expect(JSON.parse(e.responseBody)).toEqual({ ok: true, got: { a: 1 }, method: 'POST' })
    expect(e.logs).toContain('python says hi')
  })

  test('code is found through the code folder, even when the stored path is wrong', async () => {
    const setPath = (path: string) => server.db.sqlite.query("UPDATE _functions SET path = ? WHERE id = 'echo'").run(path)
    const run = () => admin.functions.createExecution({ functionId: 'echo' })
    const original = server.config.functionsDir
    try {
      server.config.functionsDir = dir
      // Stored against the wrong folder, as an uploaded import used to do.
      setPath('/nowhere/pesanle-backend/functions/echo')
      expect((await run()).status).toBe('completed')
      // Stored as written in appwrite.config.json.
      setPath('functions/echo')
      expect((await run()).status).toBe('completed')
      // Genuinely missing: a failed run that says where it looked and how to fix it.
      server.config.functionsDir = '/nowhere'
      const failed = await run()
      expect(failed.status).toBe('failed')
      expect(failed.errors).toContain('Function code not found. Looked for /nowhere/functions/echo/src/main.js')
      expect(failed.errors).toContain('Settings > Functions')
    } finally {
      server.config.functionsDir = original
      setPath(join(dir, 'functions', 'echo'))
    }
  })

  test('an uploaded import keeps relative function paths', () => {
    const { pushConfig } = require('../src/schema/push') as typeof import('../src/schema/push')
    pushConfig(server.db, { functions: [{ $id: 'uploaded', name: 'Uploaded', runtime: 'node-22', entrypoint: 'src/main.js', path: 'functions/cron' }] })
    const row = server.services.functions.fn('uploaded')
    expect(row.path).toBe('functions/cron')
    const original = server.config.functionsDir
    server.config.functionsDir = dir
    expect(server.services.functions.codeDir(row).dir).toBe(join(dir, 'functions', 'cron'))
    server.config.functionsDir = original
  })

  test('the scheduler fires due functions once per minute', async () => {
    const at = new Date(Date.UTC(2026, 9, 27, 10, 5))
    expect(server.services.functions.tick(at)).toEqual(['cron'])
    expect(server.services.functions.tick(at)).toEqual([])
    expect(server.services.functions.tick(new Date(Date.UTC(2026, 9, 27, 10, 6)))).toEqual([])
    await Bun.sleep(800)
    const runs = await admin.functions.listExecutions({ functionId: 'cron' })
    expect(runs.executions.map((e: any) => [e.trigger, e.status])).toEqual([['schedule', 'completed']])
  })
})
