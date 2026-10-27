/**
 * POST /v1/pdf — render HTML to a PDF (Bunwrite extension, not part of Appwrite).
 * Needs an API key. Returns the PDF, or saves it to a bucket when bucketId is set
 * (local disk or S3, whichever file storage uses) and returns the file.
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { err } from '~/lib/errors'
import { bool, json, num, str } from '~/lib/http'
import type { Router } from '~/lib/router'
import { PAPER_SIZES, type PaperSize, type PdfOptions } from './service'

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

const pdfName = (name: string | undefined) => {
  const base = (name || 'document').replace(/[\\/\0]/g, '_').slice(0, 200)
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`
}

export function pdfRoutes(router: Router<AppContext>): void {
  router.post('/pdf', async ({ ctx, params }) => {
    requireKey(ctx, 'pdf.write')
    const html = params.html
    if (typeof html !== 'string') throw err('general_argument_invalid', 'Param "html" is required.')
    const bytes = await ctx.pdf.render(html, pdfOptions(params))
    const fileName = pdfName(str(params.fileName))

    const bucketId = str(params.bucketId)
    if (bucketId) {
      const file = await ctx.storage.createFile(ctx.caller, bucketId, {
        fileId: params.fileId ?? 'unique()',
        file: new File([bytes], fileName, { type: 'application/pdf' }),
        permissions: params.permissions ?? null,
        contentRange: null,
        uploadId: null,
      })
      return json(file, 201)
    }

    const disposition = bool(params.download, false) ? 'attachment' : 'inline'
    return new Response(bytes, {
      headers: {
        'content-type': 'application/pdf',
        'content-length': String(bytes.byteLength),
        'content-disposition': `${disposition}; filename="${encodeURIComponent(fileName)}"`,
        'cache-control': 'no-store',
      },
    })
  })
}
