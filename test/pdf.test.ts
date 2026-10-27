import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findChrome } from '~/pdf/service'
import { KEY, PROJECT, startServer, testSchema, type TestServer } from './helpers'

let dir: string
let server: TestServer
const chrome = findChrome()
const withChrome = chrome ? test : test.skip

const post = (body: unknown, key: string | null = KEY) =>
  fetch(`${server.endpoint}/pdf`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-appwrite-project': PROJECT, ...(key ? { 'x-appwrite-key': key } : {}) },
    body: JSON.stringify(body),
  })

beforeAll(() => {
  // Chromium refuses localhost requests from pages on its own (Local Network Access).
  // Turn that off here so the test checks Bunwrite's own URL blocking.
  process.env.CHROME_ARGS = '--disable-features=LocalNetworkAccessChecks'
  dir = mkdtempSync(join(tmpdir(), 'bunwrite-pdf-'))
  const schema = { ...testSchema, buckets: [{ $id: 'invoices', name: 'Invoices', fileSecurity: false, $permissions: [], maximumFileSize: 10_000_000, allowedFileExtensions: ['pdf'] }] }
  server = startServer(schema, { storagePath: join(dir, 'storage') }, dir)
})
afterAll(() => {
  server.services.pdf.shutdown()
  delete process.env.CHROME_ARGS
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('pdf', () => {
  test('off by default, and needs an API key', async () => {
    const off = await post({ html: '<p>hi</p>' })
    expect([off.status, ((await off.json()) as { type: string }).type]).toEqual([403, 'general_service_disabled'])

    server.services.settings.set('pdf', { enabled: true, allowRemote: false })
    expect((await post({ html: '<p>hi</p>' }, null)).status).toBe(401)
    const missing = await post({})
    expect([missing.status, ((await missing.json()) as { type: string }).type]).toEqual([400, 'general_argument_invalid'])
    expect((await post({ html: '<p>x</p>', format: 'B9' })).status).toBe(400)
  })

  withChrome('renders HTML and blocks remote URLs by default', async () => {
    let hits = 0
    const assets = Bun.serve({ port: 0, fetch: () => (hits++, new Response('', { status: 404 })) })
    try {
      server.services.settings.set('pdf', { enabled: true, allowRemote: false })
      const html = `<h1>Invoice</h1><img src="http://127.0.0.1:${assets.port}/logo.png"><script>document.title = 'ran'</script>`
      const res = await post({ html, fileName: 'inv-1', format: 'letter', landscape: true, margin: 5, download: true })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/pdf')
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="inv-1.pdf"')
      const bytes = Buffer.from(await res.arrayBuffer())
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
      expect(hits).toBe(0)

      server.services.settings.set('pdf', { enabled: true, allowRemote: true })
      expect((await post({ html })).status).toBe(200)
      expect(hits).toBeGreaterThan(0)
    } finally {
      assets.stop(true)
    }
  }, 60_000)

  withChrome('saves to a bucket', async () => {
    server.services.settings.set('pdf', { enabled: true, allowRemote: false })
    const res = await post({ html: '<p>Receipt</p>', bucketId: 'invoices', fileId: 'receipt-1', fileName: 'receipt' })
    expect(res.status).toBe(201)
    const file = (await res.json()) as { $id: string; name: string; mimeType: string }
    expect([file.$id, file.name, file.mimeType]).toEqual(['receipt-1', 'receipt.pdf', 'application/pdf'])
    const view = await fetch(`${server.endpoint}/storage/buckets/invoices/files/receipt-1/view?project=${PROJECT}`, { headers: { 'x-appwrite-key': KEY } })
    expect(Buffer.from(await view.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')
  }, 60_000)

  test('turning it off stops renders', async () => {
    server.services.settings.set('pdf', { enabled: false, allowRemote: false })
    expect((await post({ html: '<p>hi</p>' })).status).toBe(403)
    expect(server.services.pdf.status().running).toBe(false)
  })
})
