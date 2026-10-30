/** Response compression, file cache headers with ETags, and the preview cache. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import sharp from 'sharp'

import { keyCaller } from '~/auth/caller'
import { ConsoleAuth } from '~/console/auth'
import { pickEncoding } from '~/lib/compress'
import { KEY, PROJECT, startServer, type TestServer } from './helpers'

let server: TestServer
let base: string
let storage: string
let cookie = ''

const api = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${server.endpoint}${path}`, { headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, ...headers }, decompress: false } as RequestInit)

async function form(path: string, fields: Record<string, string>) {
  return fetch(`${base}${path}`, { method: 'POST', body: new URLSearchParams(fields), redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } })
}

beforeAll(async () => {
  storage = mkdtempSync(join(tmpdir(), 'bunwrite-cache-'))
  server = startServer(undefined, { storagePath: storage })
  base = server.endpoint.replace(/\/v1$/, '')
  await new ConsoleAuth(server.db).upsert('admin@example.com', 'console-password')
  const login = await form('/console/login', { email: 'admin@example.com', password: 'console-password' })
  cookie = `${login.headers.get('set-cookie')!.split(';')[0]}; console_project=${PROJECT}`

  const s = server.services.storage
  s.saveBucket({ id: 'cache', name: 'Cache', enabled: true, fileSecurity: false, permissions: [], maximumFileSize: 10_000_000, allowedFileExtensions: [], transformations: true }, true)
  const text = 'hello compression '.repeat(500)
  await s.createFile(keyCaller(), 'cache', { fileId: 'notes', file: new File([text], 'notes.txt', { type: 'text/plain' }), permissions: [], contentRange: null, uploadId: null })
  const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 1 } } }).png().toBuffer()
  await s.createFile(keyCaller(), 'cache', { fileId: 'logo', file: new File([png], 'logo.png', { type: 'image/png' }), permissions: [], contentRange: null, uploadId: null })
})

afterAll(() => {
  server.stop()
  rmSync(storage, { recursive: true, force: true })
})

describe('compression', () => {
  test('picks the client-preferred encoding, honours q=0 and breaks ties with Brotli', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br')
    expect(pickEncoding('gzip')).toBe('gzip')
    expect(pickEncoding('br;q=0, gzip;q=0.5')).toBe('gzip')
    expect(pickEncoding('br;q=0.1, gzip;q=1')).toBe('gzip')
    expect(pickEncoding('gzip;q=0.5, br;q=0.5')).toBe('br')
    expect(pickEncoding('*')).toBe('br')
    expect(pickEncoding('identity')).toBeNull()
    expect(pickEncoding(null)).toBeNull()
  })

  test('JSON is sent with Brotli or gzip and decodes to the same body', async () => {
    const plain = await api('/databases/main/collections')
    const body = await plain.text()
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(plain.headers.get('vary')).toContain('Accept-Encoding')

    const br = await api('/databases/main/collections', { 'accept-encoding': 'gzip, br' })
    expect(br.headers.get('content-encoding')).toBe('br')
    const brBytes = new Uint8Array(await br.arrayBuffer())
    expect(Number(br.headers.get('content-length'))).toBe(brBytes.length)
    expect(brotliDecompressSync(brBytes).toString()).toBe(body)

    const gz = await api('/databases/main/collections', { 'accept-encoding': 'gzip' })
    expect(gz.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(new Uint8Array(await gz.arrayBuffer())).toString()).toBe(body)
  })

  test('console pages and scripts are compressed', async () => {
    const page = await fetch(`${base}/console/login`, { headers: { 'accept-encoding': 'br' }, decompress: false } as RequestInit)
    expect(page.headers.get('content-encoding')).toBe('br')
    const html = brotliDecompressSync(new Uint8Array(await page.arrayBuffer())).toString()
    expect(html).toContain('<form')
    const script = await fetch(`${base}/console/assets/htmx.min.js`, { headers: { 'accept-encoding': 'gzip, br' }, decompress: false } as RequestInit)
    expect(script.headers.get('content-encoding')).toBe('br')
  })

  test('small bodies, images and HEAD requests go out as they are', async () => {
    const health = await api('/health', { 'accept-encoding': 'br' })
    expect(health.headers.get('content-encoding')).toBeNull()
    const image = await api('/storage/buckets/cache/files/logo/view', { 'accept-encoding': 'gzip, br' })
    expect(image.headers.get('content-encoding')).toBeNull()
    expect(image.headers.get('accept-ranges')).toBe('bytes')
    const head = await fetch(`${server.endpoint}/storage/buckets/cache/files/notes/view`, {
      method: 'HEAD',
      headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, 'accept-encoding': 'br' },
    })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-encoding')).toBeNull()
    expect(head.headers.get('content-length')).toBe('9000')
  })

  test('a text file is compressed with a weak ETag and no byte ranges', async () => {
    const res = await api('/storage/buckets/cache/files/notes/view', { 'accept-encoding': 'br' })
    expect(res.headers.get('content-encoding')).toBe('br')
    expect(res.headers.get('etag')).toStartWith('W/"')
    expect(res.headers.get('accept-ranges')).toBeNull()
    expect(brotliDecompressSync(new Uint8Array(await res.arrayBuffer())).toString()).toBe('hello compression '.repeat(500))
    // Ranges still work on the plain file.
    const part = await api('/storage/buckets/cache/files/notes/view', { 'accept-encoding': 'br', range: 'bytes=0-4' })
    expect(part.status).toBe(206)
    expect(await part.text()).toBe('hello')
  })

  test('COMPRESSION=false sends everything plain', async () => {
    server.config.compression = false
    try {
      const res = await api('/databases/main/collections', { 'accept-encoding': 'br' })
      expect(res.headers.get('content-encoding')).toBeNull()
    } finally {
      server.config.compression = true
    }
  })
})

describe('file cache', () => {
  test('files carry the configured lifetime and answer 304 for a known ETag', async () => {
    const first = await api('/storage/buckets/cache/files/notes/view')
    expect(first.headers.get('cache-control')).toBe('private, max-age=3888000')
    const etag = first.headers.get('etag')!
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/)
    const again = await api('/storage/buckets/cache/files/notes/view', { 'if-none-match': `W/${etag}` })
    expect(again.status).toBe(304)
    expect(again.headers.get('vary')).toBe('Accept-Encoding')
    expect(await again.text()).toBe('')
    const cors = await api('/storage/buckets/cache/files/notes/view', { 'if-none-match': `W/${etag}`, origin: 'https://shop.example.com' })
    expect(cors.status).toBe(304)
    expect(cors.headers.get('vary')).toContain('Accept-Encoding')
    expect(cors.headers.get('vary')).toContain('Origin')
    expect(cors.headers.get('access-control-allow-origin')).toBe('https://shop.example.com')
    const other = await api('/storage/buckets/cache/files/notes/download', { 'if-none-match': '"something-else"' })
    expect(other.status).toBe(200)
  })

  test('previews have their own lifetime and ETag per size', async () => {
    const small = await api('/storage/buckets/cache/files/logo/preview?width=16')
    expect(small.status).toBe(200)
    expect(small.headers.get('cache-control')).toBe('private, max-age=2592000')
    const large = await api('/storage/buckets/cache/files/logo/preview?width=32')
    expect(large.headers.get('etag')).not.toBe(small.headers.get('etag'))
    const cached = await api('/storage/buckets/cache/files/logo/preview?width=16', { 'if-none-match': small.headers.get('etag')! })
    expect(cached.status).toBe(304)
  })

  test('saving the Caching tab changes the headers; reset goes back to the defaults', async () => {
    const page = await (await fetch(`${base}/console/settings/cache`, { headers: { cookie } })).text()
    expect(page).toContain('Cache lifetimes')
    expect(page).toContain('Generated previews')
    expect(page).toContain('Brotli, else gzip')

    const saved = await form('/console/settings/cache', { fileMaxAge: '0', previewMaxAge: '86400', previewRetentionDays: '7' })
    expect(saved.status).toBe(303)
    expect(server.config.cache).toEqual({ fileMaxAge: 0, previewMaxAge: 86400, previewRetentionDays: 7, publicMaxAge: 0 })
    expect((await api('/storage/buckets/cache/files/notes/view')).headers.get('cache-control')).toBe('private, no-cache')
    expect((await api('/storage/buckets/cache/files/logo/preview?width=16')).headers.get('cache-control')).toBe('private, max-age=86400')

    const bad = await form('/console/settings/cache', { fileMaxAge: '-1', previewMaxAge: '0', previewRetentionDays: '1' })
    expect(new URL(bad.headers.get('location')!, base).searchParams.get('err')).toContain('zero or more')

    await form('/console/settings/cache/reset', {})
    expect(server.config.cache).toEqual({ fileMaxAge: 3888000, previewMaxAge: 2592000, previewRetentionDays: 30, publicMaxAge: 0 })
  })
})

describe('preview cache on disk', () => {
  const previewDir = () => join(storage, '.previews', 'cache', 'logo')

  test('previews older than the retention are deleted; newer ones stay', async () => {
    await api('/storage/buckets/cache/files/logo/preview?width=20')
    await api('/storage/buckets/cache/files/logo/preview?width=24')
    const names = readdirSync(previewDir())
    expect(names.length).toBeGreaterThanOrEqual(2)
    const old = new Date(Date.now() - 40 * 86400 * 1000)
    utimesSync(join(previewDir(), names[0]!), old, old)

    const before = server.services.storage.previewCacheStats().files
    expect(server.services.storage.prunePreviews(true)).toBe(1)
    expect(server.services.storage.previewCacheStats().files).toBe(before - 1)

    server.config.cache.previewRetentionDays = 0
    utimesSync(join(previewDir(), readdirSync(previewDir())[0]!), old, old)
    expect(server.services.storage.prunePreviews(true)).toBe(0)
    server.config.cache.previewRetentionDays = 30
  })

  test('clearing from the console removes every preview', async () => {
    expect(server.services.storage.previewCacheStats().files).toBeGreaterThan(0)
    const res = await form('/console/settings/cache/previews/clear', {})
    expect(res.status).toBe(303)
    expect(server.services.storage.previewCacheStats()).toEqual({ files: 0, bytes: 0 })
    // The next request makes it again.
    expect((await api('/storage/buckets/cache/files/logo/preview?width=16')).status).toBe(200)
    expect(server.services.storage.previewCacheStats().files).toBe(1)
  })
})
