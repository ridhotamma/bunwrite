import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ID, Permission, Role } from 'node-appwrite'
import sharp from 'sharp'

import { parseTrustedProxies, resolveClientIp } from '~/lib/client-ip'
import { renderPreview, previewOptions, sniffImage } from '~/storage/transform'
import { adminClient, PROJECT, startServer, testSchema, type TestServer } from './helpers'

const req = (headers: Record<string, string>) => new Request('http://localhost/v1/health', { headers })

describe('client IP', () => {
  const defaults = parseTrustedProxies(undefined)

  test('a client that connects directly cannot choose its own address', () => {
    const spoofed = req({ 'x-forwarded-for': '1.1.1.1', 'cf-connecting-ip': '2.2.2.2', 'x-real-ip': '3.3.3.3' })
    expect(resolveClientIp(spoofed, '203.0.113.7', defaults)).toBe('203.0.113.7')
  })

  test('behind a private proxy, the rightmost address the proxy did not add wins', () => {
    // Caddy replaces the header; nginx and Cloudflare Tunnel append to what the client sent.
    expect(resolveClientIp(req({ 'x-forwarded-for': '198.51.100.4' }), '172.18.0.3', defaults)).toBe('198.51.100.4')
    expect(resolveClientIp(req({ 'x-forwarded-for': '9.9.9.9, 198.51.100.4' }), '127.0.0.1', defaults)).toBe('198.51.100.4')
    expect(resolveClientIp(req({ 'x-forwarded-for': '198.51.100.4, 10.0.0.2' }), '::ffff:127.0.0.1', defaults)).toBe('198.51.100.4')
  })

  test('CF-Connecting-IP counts only when Cloudflare is trusted', () => {
    const headers = { 'cf-connecting-ip': '2.2.2.2', 'x-forwarded-for': '198.51.100.4' }
    expect(resolveClientIp(req(headers), '127.0.0.1', defaults)).toBe('198.51.100.4')
    expect(resolveClientIp(req(headers), '127.0.0.1', parseTrustedProxies('private,cloudflare'))).toBe('2.2.2.2')
    expect(resolveClientIp(req(headers), '104.16.1.1', parseTrustedProxies('cloudflare'))).toBe('2.2.2.2')
    expect(resolveClientIp(req(headers), '203.0.113.7', parseTrustedProxies('cloudflare'))).toBe('203.0.113.7')
  })

  test('none and explicit ranges', () => {
    expect(resolveClientIp(req({ 'x-forwarded-for': '1.1.1.1' }), '127.0.0.1', parseTrustedProxies('none'))).toBe('127.0.0.1')
    expect(resolveClientIp(req({ 'x-forwarded-for': '1.1.1.1' }), '203.0.113.7', parseTrustedProxies('203.0.113.0/24'))).toBe('1.1.1.1')
    expect(() => parseTrustedProxies('not-an-ip')).toThrow()
    expect(() => parseTrustedProxies('10.0.0.0/40')).toThrow()
  })

  test('garbage in the header is ignored', () => {
    expect(resolveClientIp(req({ 'x-forwarded-for': '<script>' }), '127.0.0.1', defaults)).toBe('127.0.0.1')
  })
})

describe('login limits', () => {
  const attempt = (server: TestServer, headers: Record<string, string>) =>
    fetch(`${server.endpoint}/account/sessions/email`, {
      method: 'POST',
      headers: { 'x-appwrite-project': PROJECT, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ email: 'spoof@example.com', password: 'wrong password' }),
    })

  test('a new CF-Connecting-IP on every request does not reset the limit', async () => {
    const server = startServer()
    try {
      const statuses: number[] = []
      for (let i = 0; i < 11; i++) statuses.push((await attempt(server, { 'cf-connecting-ip': `198.51.100.${i}` })).status)
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true)
      expect(statuses[10]).toBe(429)
    } finally {
      server.stop()
    }
  })

  test('with TRUSTED_PROXIES=none, X-Forwarded-For does not reset it either', async () => {
    const server = startServer(undefined, { trustedProxies: 'none' })
    try {
      const statuses: number[] = []
      for (let i = 0; i < 11; i++) statuses.push((await attempt(server, { 'x-forwarded-for': `198.51.100.${i}` })).status)
      expect(statuses[10]).toBe(429)
    } finally {
      server.stop()
    }
  })
})

describe('uploaded files', () => {
  const MEDIA = 'media'
  let dir: string
  let server: TestServer
  let admin: ReturnType<typeof adminClient>
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(document.domain)</script><rect width="10" height="10"/></svg>'

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bunwrite-security-'))
    const schema = {
      ...testSchema,
      buckets: [{ $id: MEDIA, name: 'Media', fileSecurity: true, $permissions: [], maximumFileSize: 10_000_000, allowedFileExtensions: [] }],
    }
    server = startServer(schema, { storagePath: join(dir, 'storage') }, dir)
    admin = adminClient(server.endpoint)
  })

  afterAll(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  const upload = (name: string, body: string | Uint8Array, type: string) =>
    admin.storage.createFile({ bucketId: MEDIA, fileId: ID.unique(), file: new File([body], name, { type }), permissions: [Permission.read(Role.any())] })

  test('HTML and SVG are served sandboxed, so their scripts cannot run on this origin', async () => {
    for (const [name, body, type] of [
      ['page.html', '<script>fetch("/console")</script>', 'text/html'],
      ['logo.svg', svg, 'image/svg+xml'],
    ] as const) {
      const file = await upload(name, body, type)
      const view = await fetch(`${server.endpoint}/storage/buckets/${MEDIA}/files/${file.$id}/view?project=${PROJECT}`)
      expect(view.headers.get('content-security-policy')).toStartWith('sandbox;')
      expect(view.headers.get('content-security-policy')).toContain("default-src 'none'")
      // A preview of a non-image falls back to the file itself, with the same policy.
      const preview = await fetch(`${server.endpoint}/storage/buckets/${MEDIA}/files/${file.$id}/preview?project=${PROJECT}`)
      expect(preview.headers.get('content-security-policy')).toStartWith('sandbox;')
    }
  })

  test('PDFs open in the browser viewer, without the sandbox', async () => {
    const file = await upload('doc.pdf', '%PDF-1.4\n%%EOF\n', 'application/pdf')
    const view = await fetch(`${server.endpoint}/storage/buckets/${MEDIA}/files/${file.$id}/view?project=${PROJECT}`)
    expect(view.headers.get('content-security-policy')).toBeNull()
  })

  test('an SVG uploaded as image/png is not handed to the image decoder', async () => {
    const file = await upload('fake.png', svg, 'image/png')
    const preview = await fetch(`${server.endpoint}/storage/buckets/${MEDIA}/files/${file.$id}/preview?project=${PROJECT}&width=5`)
    expect(preview.status).toBe(400)
    expect(((await preview.json()) as any).type).toBe('storage_file_type_unsupported')
  })

  test('real images still preview', async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#c33' } }).png().toBuffer()
    const file = await upload('real.png', png, 'image/png')
    const preview = await fetch(`${server.endpoint}/storage/buckets/${MEDIA}/files/${file.$id}/preview?project=${PROJECT}&width=10&output=webp`)
    expect(preview.status).toBe(200)
    expect(preview.headers.get('content-type')).toBe('image/webp')
  })
})

describe('preview input formats', () => {
  test('known formats by their first bytes', async () => {
    const make = (f: 'jpeg' | 'png' | 'gif' | 'webp') => sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } })[f]().toBuffer()
    for (const f of ['jpeg', 'png', 'gif', 'webp'] as const) expect(sniffImage(await make(f))).toBe(f)
    expect(sniffImage(new Uint8Array([0, 0, 0, 0x1c, ...Buffer.from('ftypavif')]))).toBe('avif')
    expect(sniffImage(new Uint8Array([0, 0, 0, 0x18, ...Buffer.from('ftypheic')]))).toBe('heif')
  })

  test('SVG, PDF, TIFF and text are refused', async () => {
    for (const body of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '%PDF-1.4', 'II*\0', 'hello']) {
      expect(sniffImage(Buffer.from(body))).toBeNull()
      expect(renderPreview(sharp, Buffer.from(body), previewOptions(new URLSearchParams('width=5'), 'image/png'))).rejects.toThrow()
    }
  })
})
