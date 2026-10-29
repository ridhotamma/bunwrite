import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

import { findChrome } from '~/render/service'
import { KEY, PROJECT, startServer, testSchema, type TestServer } from './helpers'

let dir: string
let server: TestServer
const chrome = findChrome()
const withChrome = chrome ? test : test.skip

const post = (path: string, body: unknown, key: string | null = KEY) =>
  fetch(`${server.endpoint}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-appwrite-project': PROJECT, ...(key ? { 'x-appwrite-key': key } : {}) },
    body: JSON.stringify(body),
  })
const errorType = async (res: Response) => ((await res.json()) as { type: string }).type
const waitForJob = async (id: string, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await fetch(`${server.endpoint}/render/jobs/${id}`, { headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY } })
    const job = (await res.json()) as { status: string; attempts: number; errors: string }
    if (job.status === 'completed' || job.status === 'failed' || Date.now() > deadline) return job
    await Bun.sleep(50)
  }
}
const on = (allowRemote = false) => server.services.settings.set('render', { enabled: true, allowRemote })

// A 400×300 card on a transparent page, then a tall block for full-page captures.
const CARD = `<html><body style="margin:0;background:transparent">
  <div id="card" style="width:400px;height:300px;background:#ff0000"></div>
  <div style="height:1500px"></div>
</body></html>`

beforeAll(() => {
  // Chromium refuses localhost requests from pages on its own (Local Network Access).
  // Turn that off here so the test checks Bunwrite's own URL blocking.
  process.env.CHROME_ARGS = '--disable-features=LocalNetworkAccessChecks'
  dir = mkdtempSync(join(tmpdir(), 'bunwrite-render-'))
  const schema = { ...testSchema, buckets: [{ $id: 'invoices', name: 'Invoices', fileSecurity: false, $permissions: [], maximumFileSize: 10_000_000, allowedFileExtensions: ['pdf', 'png', 'webp'] }] }
  server = startServer(schema, { storagePath: join(dir, 'storage') }, dir)
})
afterAll(() => {
  server.services.render.shutdown()
  delete process.env.CHROME_ARGS
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('html rendering', () => {
  test('off by default, needs an API key, validates params', async () => {
    for (const path of ['/pdf', '/image']) {
      const off = await post(path, { html: '<p>hi</p>' })
      expect([off.status, await errorType(off)]).toEqual([403, 'general_service_disabled'])
    }
    on()
    expect((await post('/pdf', { html: '<p>hi</p>' }, null)).status).toBe(401)
    expect((await post('/image', { html: '<p>hi</p>' }, null)).status).toBe(401)
    const missing = await post('/image', {})
    expect([missing.status, await errorType(missing)]).toEqual([400, 'general_argument_invalid'])
    expect((await post('/pdf', { html: '<p>x</p>', format: 'B9' })).status).toBe(400)
    expect((await post('/image', { html: '<p>x</p>', output: 'tiff' })).status).toBe(400)
    expect((await post('/image', { html: '<p>x</p>', scale: 5 })).status).toBe(400)
    expect((await post('/image', { html: '<p>x</p>', scale: 0.05 })).status).toBe(400)
    expect((await post('/image', { html: '<p>x</p>', width: 4000, height: 4000, scale: 2 })).status).toBe(400) // 64 MP
  })

  withChrome('PDF: renders HTML and blocks remote URLs by default', async () => {
    let hits = 0
    const assets = Bun.serve({ port: 0, fetch: () => (hits++, new Response('', { status: 404 })) })
    try {
      on()
      const html = `<h1>Invoice</h1><img src="http://127.0.0.1:${assets.port}/logo.png"><script>document.title = 'ran'</script>`
      const res = await post('/pdf', { html, fileName: 'inv-1', format: 'letter', landscape: true, margin: 5, download: true })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/pdf')
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="inv-1.pdf"')
      expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')
      expect(hits).toBe(0)

      on(true)
      expect((await post('/image', { html })).status).toBe(200)
      expect(hits).toBeGreaterThan(0)
    } finally {
      assets.stop(true)
    }
  }, 60_000)

  withChrome('image: viewport, full page, selector and scale', async () => {
    on()
    const viewport = await post('/image', { html: CARD, width: 600, height: 400, fullPage: false })
    expect(viewport.headers.get('content-type')).toBe('image/png')
    expect(viewport.headers.get('content-disposition')).toBe('inline; filename="image.png"')
    const v = await sharp(Buffer.from(await viewport.arrayBuffer())).metadata()
    expect([v.format, v.width, v.height]).toEqual(['png', 600, 400])

    const full = await sharp(Buffer.from(await (await post('/image', { html: CARD, width: 600, height: 400 })).arrayBuffer())).metadata()
    expect([full.width, full.height]).toEqual([600, 1800])

    const el = await post('/image', { html: CARD, selector: '#card', scale: 2, output: 'webp', quality: 90 })
    const e = await sharp(Buffer.from(await el.arrayBuffer())).metadata()
    expect([e.format, e.width, e.height]).toEqual(['webp', 800, 600])

    // Below 1: the same 600×400 layout, a smaller bitmap (thumbnails).
    const thumb = await sharp(Buffer.from(await (await post('/image', { html: CARD, width: 600, height: 400, fullPage: false, scale: 0.5, output: 'jpg' })).arrayBuffer())).metadata()
    expect([thumb.format, thumb.width, thumb.height]).toEqual(['jpeg', 300, 200])

    const none = await post('/image', { html: CARD, selector: '#nope' })
    expect([none.status, await errorType(none)]).toEqual([400, 'general_argument_invalid'])
  }, 60_000)

  withChrome('image: every output format, and transparency', async () => {
    on()
    for (const [output, format] of [['png', 'png'], ['jpg', 'jpeg'], ['jpeg', 'jpeg'], ['webp', 'webp'], ['avif', 'heif'], ['gif', 'gif']] as const) {
      const res = await post('/image', { html: CARD, selector: '#card', output })
      expect(res.status).toBe(200)
      const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata()
      expect([output, meta.format, meta.width, meta.height]).toEqual([output, format, 400, 300])
    }
    const pixel = async (body: Record<string, unknown>) => {
      const buf = Buffer.from(await (await post('/image', { html: CARD, width: 600, height: 400, fullPage: false, ...body })).arrayBuffer())
      const { data } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const i = (100 * 600 + 500) * 4 // x=500, y=100: outside the red card
      return [data[i], data[i + 1], data[i + 2], data[i + 3]]
    }
    expect(await pixel({})).toEqual([255, 255, 255, 255]) // white page by default
    expect((await pixel({ transparent: true }))[3]).toBe(0)
  }, 60_000)

  withChrome('saves PDFs and images to a bucket', async () => {
    on()
    const pdf = await post('/pdf', { html: '<p>Receipt</p>', bucketId: 'invoices', fileId: 'receipt-1', fileName: 'receipt' })
    expect(pdf.status).toBe(201)
    const file = (await pdf.json()) as { $id: string; name: string; mimeType: string }
    expect([file.$id, file.name, file.mimeType]).toEqual(['receipt-1', 'receipt.pdf', 'application/pdf'])
    const view = await fetch(`${server.endpoint}/storage/buckets/invoices/files/receipt-1/view?project=${PROJECT}`, { headers: { 'x-appwrite-key': KEY } })
    expect(Buffer.from(await view.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')

    const img = await post('/image', { html: CARD, selector: '#card', output: 'webp', bucketId: 'invoices', fileId: 'card-1', fileName: 'card' })
    expect(img.status).toBe(201)
    const saved = (await img.json()) as { name: string; mimeType: string }
    expect([saved.name, saved.mimeType]).toEqual(['card.webp', 'image/webp'])
  }, 60_000)

  withChrome('async: queued renders are saved to the bucket', async () => {
    on()
    const missing = await post('/pdf', { html: '<p>x</p>', async: true })
    expect([missing.status, await errorType(missing)]).toEqual([400, 'general_argument_invalid'])
    expect((await post('/pdf', { html: '<p>x</p>', async: true, bucketId: 'nope' })).status).toBe(404)

    const res = await post('/pdf', { html: '<p>Queued receipt</p>', async: true, bucketId: 'invoices', fileId: 'queued-1', fileName: 'queued' })
    expect(res.status).toBe(202)
    const job = (await res.json()) as { $id: string; status: string; fileId: string; bucketId: string; fileName: string }
    expect(job).toMatchObject({ type: 'pdf', status: 'waiting', fileId: 'queued-1', bucketId: 'invoices', fileName: 'queued.pdf' })
    expect(job).not.toHaveProperty('html')

    const done = await waitForJob(job.$id)
    expect(done).toMatchObject({ status: 'completed', attempts: 1, errors: '' })
    const view = await fetch(`${server.endpoint}/storage/buckets/invoices/files/queued-1/view?project=${PROJECT}`, { headers: { 'x-appwrite-key': KEY } })
    expect(Buffer.from(await view.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')
    // The finished job no longer stores its HTML.
    const row = server.db.sqlite.query<{ data: string }, [string]>('SELECT data FROM _queue_messages WHERE id = ?').get(job.$id)!
    expect(JSON.parse(row.data)).not.toHaveProperty('html')

    // The file ID is fixed up front, so a taken one is refused right away.
    const taken = await post('/pdf', { html: '<p>x</p>', async: true, bucketId: 'invoices', fileId: 'queued-1' })
    expect([taken.status, await errorType(taken)]).toEqual([409, 'storage_file_already_exists'])

    // An error a retry cannot fix fails the job on the first attempt.
    const bad = (await (await post('/image', { html: CARD, selector: '#nope', async: true, bucketId: 'invoices' })).json()) as { $id: string }
    expect(await waitForJob(bad.$id)).toMatchObject({ status: 'failed', attempts: 1 })

    const unknown = await fetch(`${server.endpoint}/render/jobs/nope`, { headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY } })
    expect(unknown.status).toBe(404)
  }, 60_000)

  withChrome('a burst: direct requests over the limit get 429, queued ones all finish', async () => {
    on()
    const html = '<p>burst</p>'
    const direct = await Promise.all(Array.from({ length: 26 }, () => post('/pdf', { html })))
    const statuses = direct.map((r) => r.status)
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0)
    expect(statuses.every((s) => s === 200 || s === 429)).toBe(true)
    // 20 wait in line; the rest are refused instead of piling up.
    const limited = direct.find((r) => r.status === 429)!
    expect(limited).toBeDefined()
    expect(((await limited.json()) as { message: string }).message).toContain('async: true')

    const queued = await Promise.all(Array.from({ length: 30 }, (_, i) => post('/pdf', { html, async: true, bucketId: 'invoices', fileId: `burst-${i}` })))
    expect(queued.every((r) => r.status === 202)).toBe(true)
    const jobs = (await Promise.all(queued.map((r) => r.json()))) as { $id: string }[]
    const results = await Promise.all(jobs.map((j) => waitForJob(j.$id, 120_000)))
    expect(results.every((r) => r.status === 'completed')).toBe(true)
  }, 180_000)

  test('turning it off stops renders', async () => {
    server.services.settings.set('render', { enabled: false, allowRemote: false })
    expect((await post('/pdf', { html: '<p>hi</p>' })).status).toBe(403)
    expect((await post('/image', { html: '<p>hi</p>' })).status).toBe(403)
    expect(server.services.render.status().running).toBe(false)
  })
})
