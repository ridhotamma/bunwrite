import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'

import { hexColor, previewKey, previewOptions, renderPreview, rgba } from '~/storage/transform'

const opts = (query: string, mime = 'image/png') => previewOptions(new URLSearchParams(query), mime)

async function image(width: number, height: number, color = { r: 200, g: 30, b: 30, alpha: 1 }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer()
}

async function pixel(buf: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * 4
  return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]!, a: data[i + 3]! }
}

describe('preview options', () => {
  test('defaults follow the source format', () => {
    expect(opts('', 'image/jpeg')).toMatchObject({ width: 0, height: 0, gravity: 'center', quality: -1, opacity: 1, rotation: 0, background: '', format: 'jpg' })
    expect(opts('', 'image/bmp').format).toBe('jpg')
    expect(opts('output=jpeg').format).toBe('jpg')
  })

  test('values are clamped like Appwrite ranges', () => {
    const o = opts('width=9000&height=-5&quality=150&borderWidth=500&opacity=3&rotation=-90&gravity=nope')
    expect([o.width, o.height, o.quality, o.borderWidth, o.opacity, o.rotation, o.gravity]).toEqual([4000, 0, 100, 100, 1, 270, 'center'])
  })

  test('colours and unsupported outputs', () => {
    expect([hexColor('#FFF'), hexColor('00ff0080'), hexColor('red')]).toEqual(['fff', '00ff0080', ''])
    expect(rgba('00ff0080')).toEqual({ r: 0, g: 255, b: 0, alpha: 128 / 255 })
    expect(() => opts('output=heic')).toThrow()
    expect(() => opts('output=tiff')).toThrow()
  })

  test('cache keys differ per option', () => {
    expect(previewKey(opts('width=10'))).not.toBe(previewKey(opts('width=10&borderRadius=2')))
  })
})

describe('preview rendering', () => {
  test('cover crop with gravity', async () => {
    const out = await renderPreview(sharp, await image(800, 400), opts('width=100&height=100&gravity=top-left&output=webp'))
    const meta = await sharp(out).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 100, 100])
  })

  test('border, radius, opacity and background', async () => {
    const src = await image(100, 100)
    const bordered = await renderPreview(sharp, src, opts('borderWidth=10&borderColor=00ff00'))
    expect((await sharp(bordered).metadata()).width).toBe(120)
    expect(await pixel(bordered, 2, 60)).toMatchObject({ r: 0, g: 255, b: 0 })

    const rounded = await renderPreview(sharp, src, opts('borderRadius=50'))
    expect((await pixel(rounded, 0, 0)).a).toBe(0)
    expect((await pixel(rounded, 50, 50)).a).toBe(255)

    const faded = await renderPreview(sharp, src, opts('opacity=0.5'))
    expect(Math.abs((await pixel(faded, 50, 50)).a - 128)).toBeLessThanOrEqual(1)

    const onBlue = await renderPreview(sharp, await renderPreview(sharp, src, opts('borderRadius=50')), opts('background=0000ff'))
    expect(await pixel(onBlue, 0, 0)).toMatchObject({ r: 0, g: 0, b: 255, a: 255 })
  })

  test('rotation and JPEG flattening', async () => {
    const rotated = await renderPreview(sharp, await image(200, 100), opts('rotation=90'))
    const meta = await sharp(rotated).metadata()
    expect([meta.width, meta.height]).toEqual([100, 200])

    const jpg = await renderPreview(sharp, await image(100, 100), opts('borderRadius=50&output=jpg&quality=90'))
    expect((await sharp(jpg).metadata()).format).toBe('jpeg')
    const corner = await pixel(jpg, 0, 0)
    expect(Math.min(corner.r, corner.g, corner.b)).toBeGreaterThan(240) // white, give or take JPEG noise
  })
})

describe('previews from S3', () => {
  test('reads the original from S3 and caches the preview locally', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { PROJECT, KEY, startServer, testSchema } = await import('./helpers')

    // A tiny S3 stand-in: PUT stores, GET returns, DELETE removes.
    const objects = new Map<string, Uint8Array>()
    let gets = 0
    const s3 = Bun.serve({
      port: 0,
      async fetch(req) {
        const key = new URL(req.url).pathname
        if (req.method === 'PUT') objects.set(key, new Uint8Array(await req.arrayBuffer()))
        else if (req.method === 'DELETE') objects.delete(key)
        else if (req.method === 'GET' || req.method === 'HEAD') {
          const body = objects.get(key)
          if (!body) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
          gets++
          return new Response(req.method === 'HEAD' ? null : body, { headers: { 'content-length': String(body.length) } })
        }
        return new Response('')
      },
    })
    const dir = mkdtempSync(join(tmpdir(), 'bunwrite-s3-preview-'))
    const config = { enabled: true, bucket: 'files', region: 'us-east-1', endpoint: `http://127.0.0.1:${s3.port}`, accessKey: 'a', secret: 's', forcePathStyle: true }
    const schema = { ...testSchema, buckets: [{ $id: 'photos', name: 'Photos', fileSecurity: false, $permissions: ['read("any")'], maximumFileSize: 10_000_000, allowedFileExtensions: [] }] }
    const server = startServer(schema, { storagePath: join(dir, 'storage'), s3: config }, dir)
    try {
      const body = new FormData()
      body.append('fileId', 'pic')
      body.append('file', new File([await image(400, 200)], 'pic.png', { type: 'image/png' }))
      const headers = { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY }
      const up = await fetch(`${server.endpoint}/storage/buckets/photos/files`, { method: 'POST', headers, body })
      expect(up.status).toBe(201)
      expect(objects.size).toBe(1)

      const url = `${server.endpoint}/storage/buckets/photos/files/pic/preview?project=${PROJECT}&width=100&height=100&borderRadius=50&output=png`
      const first = await fetch(url)
      expect(first.status).toBe(200)
      const meta = await sharp(Buffer.from(await first.arrayBuffer())).metadata()
      expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual(['png', 100, 100, true])
      const readsAfterFirst = gets
      expect(readsAfterFirst).toBeGreaterThan(0)
      expect((await fetch(url)).status).toBe(200)
      expect(gets).toBe(readsAfterFirst) // second request served from the local cache
    } finally {
      server.stop()
      s3.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('AVIF limit', () => {
  test('large AVIF previews are refused before encoding', async () => {
    const { previewSize, maxAvifPixels } = await import('~/storage/transform')
    const src = await image(3000, 2000)
    expect(await previewSize(sharp, src, opts('width=300'))).toEqual({ width: 300, height: 200 })
    expect(await previewSize(sharp, src, opts('width=100&height=100&borderWidth=5'))).toEqual({ width: 110, height: 110 })
    expect(await previewSize(sharp, src, opts('width=300&rotation=90'))).toEqual({ width: 200, height: 300 })
    expect(maxAvifPixels()).toBe(4_000_000)
    await expect(renderPreview(sharp, src, opts('output=avif'))).rejects.toThrow(/AVIF output is limited/)
    const small = await renderPreview(sharp, src, opts('width=600&output=avif'))
    expect((await sharp(small).metadata()).format).toBe('heif')
  })
})
