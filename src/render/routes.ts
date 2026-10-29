/**
 * POST /v1/pdf and POST /v1/image — render HTML to a PDF or an image (Bunwrite
 * extensions, not part of Appwrite). Need an API key. Return the bytes, or save
 * them to a bucket when bucketId is set (local disk or S3, whichever file
 * storage uses) and return the file.
 *
 * With `async: true` (and a bucketId) the render is queued instead: the
 * response is a job (202) and GET /v1/render/jobs/:jobId reports when the
 * file is in the bucket. Use it for bursts, so callers never wait in line.
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { err } from '~/lib/errors'
import { bool, json, num, str } from '~/lib/http'
import type { Router } from '~/lib/router'
import { IMAGE_OUTPUTS, PAPER_SIZES, renderJobModel, type ImageOptions, type ImageOutput, type PaperSize, type PdfOptions, type RenderTarget } from './service'

function margin(value: unknown): PdfOptions['margin'] {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number' || typeof value === 'string') {
    const mm = Number(value)
    if (!Number.isFinite(mm) || mm < 0) throw err('general_argument_invalid', 'Param "margin" must be millimetres or { top, right, bottom, left }.')
    return { top: mm, right: mm, bottom: mm, left: mm }
  }
  if (typeof value !== 'object') throw err('general_argument_invalid', 'Param "margin" must be millimetres or { top, right, bottom, left }.')
  const out: Record<string, number> = {}
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const raw = (value as Record<string, unknown>)[side]
    if (raw === undefined) continue
    const mm = Number(raw)
    if (!Number.isFinite(mm) || mm < 0) throw err('general_argument_invalid', `Param "margin.${side}" must be zero or more millimetres.`)
    out[side] = mm
  }
  return out
}

export function pdfOptions(params: Record<string, unknown>): PdfOptions {
  const format = str(params.format)
  const size = format ? (Object.keys(PAPER_SIZES) as PaperSize[]).find((k) => k.toLowerCase() === format.toLowerCase()) : 'A4'
  if (!size) throw err('general_argument_invalid', `Param "format" must be one of ${Object.keys(PAPER_SIZES).join(', ')}.`)
  const scale = num(params.scale, 1)!
  if (!(scale >= 0.1 && scale <= 2)) throw err('general_argument_invalid', 'Param "scale" must be between 0.1 and 2.')
  return {
    format: size,
    landscape: bool(params.landscape, false),
    printBackground: bool(params.printBackground, true),
    margin: margin(params.margin),
    scale,
    pageRanges: str(params.pageRanges),
    headerTemplate: str(params.headerTemplate),
    footerTemplate: str(params.footerTemplate),
  }
}

/** A safe file name with the right extension. */
function fileName(name: string | undefined, fallback: string, ext: string): string {
  const base = (name || fallback).replace(/[\\/\0"]/g, '_').slice(0, 200)
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`
}

function int(params: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const raw = params[key]
  if (raw === undefined || raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw err('general_argument_invalid', `Param "${key}" must be a whole number from ${min} to ${max}.`)
  return n
}

export function imageOptions(params: Record<string, unknown>): ImageOptions {
  let output = (str(params.output) ?? 'png').toLowerCase()
  if (output === 'jpeg') output = 'jpg'
  if (!(IMAGE_OUTPUTS as readonly string[]).includes(output)) throw err('general_argument_invalid', `Param "output" must be one of ${IMAGE_OUTPUTS.join(', ')}.`)
  const scale = num(params.scale, 1)!
  // Below 1 the page still lays out at width × height and the bitmap shrinks: thumbnails without a second layout.
  if (!(scale >= 0.1 && scale <= 3)) throw err('general_argument_invalid', 'Param "scale" must be between 0.1 and 3.')
  return {
    output: output as ImageOutput,
    width: int(params, 'width', 16, 4000),
    height: int(params, 'height', 16, 16384),
    fullPage: bool(params.fullPage, true),
    selector: str(params.selector) || undefined,
    scale,
    quality: int(params, 'quality', 1, 100),
    transparent: bool(params.transparent, false),
  }
}

/** Save to a bucket when bucketId is given, otherwise return the bytes. */
async function respond(ctx: AppContext, params: Record<string, unknown>, bytes: Uint8Array, name: string, mime: string): Promise<Response> {
  const bucketId = str(params.bucketId)
  if (bucketId) {
    const file = await ctx.storage.createFile(ctx.caller, bucketId, {
      fileId: params.fileId ?? 'unique()',
      file: new File([bytes], name, { type: mime }),
      permissions: params.permissions ?? null,
      contentRange: null,
      uploadId: null,
    })
    return json(file, 201)
  }
  const disposition = bool(params.download, false) ? 'attachment' : 'inline'
  return new Response(bytes, {
    headers: {
      'content-type': mime,
      'content-length': String(bytes.byteLength),
      'content-disposition': `${disposition}; filename="${encodeURIComponent(name)}"`,
      'cache-control': 'no-store',
    },
  })
}

const html = (params: Record<string, unknown>): string => {
  if (typeof params.html !== 'string') throw err('general_argument_invalid', 'Param "html" is required.')
  return params.html
}

/** Where an async render goes: it has no response to carry the bytes, so a bucket is required. */
function target(params: Record<string, unknown>, name: string): RenderTarget {
  const bucketId = str(params.bucketId)
  if (!bucketId) throw err('general_argument_invalid', 'Param "bucketId" is required with async: true. The result is saved to that bucket.')
  return { bucketId, fileId: params.fileId, fileName: name, permissions: params.permissions ?? null }
}

export function renderRoutes(router: Router<AppContext>): void {
  router.post('/pdf', async ({ ctx, params }) => {
    requireKey(ctx, 'render.write')
    const options = pdfOptions(params)
    const name = fileName(str(params.fileName), 'document', 'pdf')
    if (bool(params.async, false)) return json(renderJobModel(ctx.render.enqueue('pdf', html(params), options, target(params, name))), 202)
    const bytes = await ctx.render.pdf(html(params), options)
    return respond(ctx, params, bytes, name, 'application/pdf')
  })

  router.post('/image', async ({ ctx, params }) => {
    requireKey(ctx, 'render.write')
    const options = imageOptions(params)
    const name = fileName(str(params.fileName), 'image', options.output!)
    if (bool(params.async, false)) return json(renderJobModel(ctx.render.enqueue('image', html(params), options, target(params, name))), 202)
    const { bytes, mime } = await ctx.render.image(html(params), options)
    return respond(ctx, params, bytes, name, mime)
  })

  router.get('/render/jobs/:jobId', ({ ctx, path }) => {
    requireKey(ctx, 'render.read')
    return json(renderJobModel(ctx.render.job(path.jobId!)))
  })
}
