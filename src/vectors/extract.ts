/**
 * Turn an uploaded document into text that gets chunked and embedded.
 *
 * Text formats are read directly; PDF, DOCX, ODT and EPUB use small
 * pure-JavaScript extractors. PDF layout is reconstructed from positioned text
 * so headings and simple tables survive, and scanned pages can be OCR'd with
 * the optional Tesseract executable.
 *
 * The extraction is deliberately conservative: a scanned PDF with no text
 * layer is refused unless OCR is enabled, and size/page limits are checked
 * before work starts because PDFs and ZIP containers are attacker-controlled.
 */
import { strFromU8, unzipSync } from 'fflate'
import { BunwriteError } from '~/lib/errors'
import type { SharpModule } from '~/storage/sharp'
import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ENTRIES, MAX_FILE_BYTES, MAX_PDF_PAGES } from './limits'
import { layoutToMarkdown, type LayoutItem } from './layout'
import { csvToMarkdown, countMarkdownTables, docxToMarkdown, htmlToMarkdown, markdownToStructured, odtToMarkdown } from './markup'
import { ocrImage } from './ocr'
import { decodeEntities, normalizeText } from './text'
import { invalid } from './validate'

export type DocumentFormat = 'pdf' | 'docx' | 'odt' | 'epub' | 'html' | 'markdown' | 'json' | 'csv' | 'xml' | 'rtf' | 'text' | 'image'

export interface ExtractionOptions {
  /** OCR scanned PDF pages and image uploads with Tesseract. */
  ocr: boolean
  /** Tesseract language list, for example `eng` or `eng+ind`. */
  ocrLanguages: string
  /** Maximum scanned pages to OCR per document. */
  ocrMaxPages: number
  /** Drop OCR words below this confidence (0-100). */
  ocrMinConfidence: number
  /** Reconstruct headings and aligned tables from PDF/OCR positions. */
  tableExtraction: boolean
  /** Lazy sharp loader; compiled builds extract the embedded native runtime. */
  loadSharp?: () => Promise<SharpModule>
}

export const DEFAULT_EXTRACTION: ExtractionOptions = {
  ocr: false,
  ocrLanguages: 'eng',
  ocrMaxPages: 20,
  ocrMinConfidence: 30,
  tableExtraction: true,
}

export interface ExtractedDocument {
  /** Original file name, when the upload had one. */
  name: string
  /** MIME type reported by the browser, or inferred from the extension. */
  mimeType: string
  format: DocumentFormat
  /** Size of the uploaded bytes. */
  size: number
  /** Extracted text, normalised but not chunked. */
  text: string
  characters: number
  /** PDF page count, when the document is a PDF. */
  pages?: number
  /** 1-based PDF pages that were OCR'd. */
  ocrPages?: number[]
  /** Markdown tables found during extraction. */
  tables?: number
  /** Whether the text carries headings/tables for structure-aware chunking. */
  structured?: boolean
}

const TEXT_EXTENSIONS = new Set(['txt', 'text', 'log', 'yaml', 'yml', 'toml', 'ini', 'conf', 'env'])
const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml'])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd'])
const JSON_EXTENSIONS = new Set(['json', 'jsonl', 'ndjson'])
const CSV_EXTENSIONS = new Set(['csv', 'tsv'])
const XML_EXTENSIONS = new Set(['xml', 'xsl', 'xsd', 'svg'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp', 'gif'])
const ZIP_EXTENSIONS = new Set(['docx', 'odt', 'epub', 'zip'])

function extensionOf(name: string): string {
  const clean = name.split(/[?#]/)[0] ?? name
  const dot = clean.lastIndexOf('.')
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : ''
}

function decodesAsText(bytes: Uint8Array): boolean {
  // NUL bytes are the cheapest signal that this is not a text document. A few
  // UTF-16 files contain them, so allow a small amount and let TextDecoder
  // decide the rest.
  let nul = 0
  const sample = Math.min(bytes.length, 8192)
  for (let i = 0; i < sample; i++) if (bytes[i] === 0) nul++
  return sample === 0 || nul / sample < 0.01
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((value, index) => bytes[index] === value)
}

const ZIP = [0x50, 0x4b, 0x03, 0x04]
const PDF = [0x25, 0x50, 0x44, 0x46] // %PDF
const RTF = [0x7b, 0x5c, 0x72, 0x74, 0x66] // {\rtf

function epubToMarkdown(files: Record<string, Uint8Array>): string {
  return Object.entries(files)
    .filter(([name]) => /\.(x?html?|xml)$/i.test(name) && !/META-INF|container\.xml/i.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, bytes]) => htmlToMarkdown(strFromU8(bytes)))
    .filter(Boolean)
    .join('\n\n')
}

function rtfToText(source: string): string {
  return normalizeText(
    decodeEntities(
      source
        .replace(/\\'([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/\\u(-?\d+)\??/g, (_, code: string) => String.fromCharCode(Number(code) < 0 ? Number(code) + 65536 : Number(code)))
        .replace(/\\par[d]?/gi, '\n')
        .replace(/\\line/gi, '\n')
        .replace(/\\tab/gi, '\t')
        .replace(/\\[a-z]+-?\d*\s?/gi, '')
        .replace(/[{}]/g, ''),
    ),
  )
}

function xmlToText(source: string): string {
  return normalizeText(
    decodeEntities(
      source
        .replace(/<\?xml[^>]*\?>/gi, '')
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<[^>]+>/g, ' '),
    ),
  )
}

function jsonToText(source: string): string {
  try {
    return JSON.stringify(JSON.parse(source), null, 2)
  } catch {
    // JSONL and malformed-but-readable files are still better than nothing.
    return source
  }
}

const loadPdfjs = () => import('unpdf')

interface PdfExtraction {
  text: string
  pages: number
  ocrPages: number[]
  tables: number
  structured: boolean
}

function pdfItem(item: { str: string; x: number; y: number; width: number; height: number; fontSize: number }): LayoutItem {
  return {
    text: item.str,
    left: item.x,
    // PDF coordinates start at the bottom-left; negating y makes the sort
    // top-to-bottom, matching Tesseract's coordinates.
    top: -item.y,
    width: item.width,
    height: item.fontSize || item.height,
    fontSize: item.fontSize || item.height,
  }
}

function patchBrowserGlobals(): void {
  // Some test hosts and embedders define a partial `window`. PDF.js then takes
  // the browser path and expects animation-frame methods while rendering.
  const scope = globalThis as {
    window?: {
      requestAnimationFrame?: (callback: (time: number) => void) => number
      cancelAnimationFrame?: (id: number) => void
    }
  }
  if (scope.window && typeof scope.window.requestAnimationFrame !== 'function') {
    try {
      scope.window.requestAnimationFrame = (callback) => Number(setTimeout(() => callback(performance.now()), 16))
      scope.window.cancelAnimationFrame = (id) => clearTimeout(id)
    } catch {
      // A frozen or exotic window object is left alone; rendering reports its
      // own error with the page number.
    }
  }
}

async function pdfToText(bytes: Uint8Array, options: ExtractionOptions): Promise<PdfExtraction> {
  // PDF.js is only needed for PDF uploads; load it when the first one arrives
  // instead of on every server start.
  let pdfjs: Awaited<ReturnType<typeof loadPdfjs>>
  try {
    pdfjs = await loadPdfjs()
  } catch {
    throw invalid('PDF extraction is not available on this server.')
  }
  const pdf = await pdfjs.getDocumentProxy(bytes, { maxImageSize: 16_777_216 }).catch(() => {
    throw invalid('Could not read the PDF. It may be damaged or password-protected.')
  })
  if (pdf.numPages > MAX_PDF_PAGES) {
    throw invalid(`The PDF has ${pdf.numPages.toLocaleString('en-US')} pages; the limit is ${MAX_PDF_PAGES.toLocaleString('en-US')}.`)
  }

  let inspections: Awaited<ReturnType<typeof pdfjs.inspectPages>>
  let extracted: Awaited<ReturnType<typeof pdfjs.extractTextItems>>
  try {
    ;[inspections, extracted] = await Promise.all([pdfjs.inspectPages(pdf), pdfjs.extractTextItems(pdf)])
  } catch {
    throw invalid('Could not extract text from the PDF.')
  }

  const pageTexts: string[] = []
  const ocrPages: number[] = []
  let tables = 0
  let structured = false
  const scanned = new Set<number>()
  inspections.pages.forEach((inspection, index) => {
    if ((inspection.textLength ?? 0) < 20 && (inspection.imageCoverage ?? 0) > 0.15) scanned.add(index + 1)
  })
  const maxOcrPages = Number.isFinite(options.ocrMaxPages) ? Math.max(1, Math.round(options.ocrMaxPages)) : 20
  if (options.ocr && scanned.size > maxOcrPages) {
    throw invalid(`The PDF has ${scanned.size} scanned pages; the OCR limit is ${maxOcrPages}. Raise the OCR page limit or split the PDF before uploading.`)
  }
  for (let page = 0; page < pdf.numPages; page++) {
    const items = extracted.items[page] ?? []
    const isScanned = scanned.has(page + 1)
    if (isScanned && options.ocr) {
      let image: Uint8Array
      try {
        patchBrowserGlobals()
        const rendered = await pdfjs.renderPageAsImage(pdf, page + 1, {
          width: 2_000,
          height: 3_000,
          format: 'png',
          canvasImport: () => import('@napi-rs/canvas'),
        })
        image = typeof rendered === 'string' ? new TextEncoder().encode(rendered) : rendered
      } catch (error) {
        throw invalid(`Could not render PDF page ${page + 1} for OCR: ${error instanceof Error ? error.message : String(error)}`)
      }
      const result = await ocrImage(image, {
        languages: options.ocrLanguages,
        minConfidence: options.ocrMinConfidence,
        tableExtraction: options.tableExtraction,
      })
      pageTexts.push(result.text)
      tables += result.tables
      if (result.tables > 0) structured = true
      ocrPages.push(page + 1)
      continue
    }
    if (isScanned && !options.ocr) {
      pageTexts.push('')
      continue
    }
    const layout = layoutToMarkdown(items.map(pdfItem), {
      tableExtraction: options.tableExtraction,
      headingDetection: true,
    })
    pageTexts.push(layout.text)
    tables += layout.tables
    if (layout.tables > 0 || layout.headings > 0) structured = true
  }

  const text = normalizeText(pageTexts.join('\n\n'))
  if (!text && scanned.size > 0) {
    throw invalid(
      options.ocr
        ? 'No readable text was found in the PDF after OCR. Try a higher-resolution scan or a different OCR language.'
        : `No text was found in the PDF; ${scanned.size} page${scanned.size === 1 ? ' is' : 's are'} scanned. Enable OCR in Vectors & RAG settings or upload a PDF with a text layer.`,
    )
  }
  if (!text) throw invalid('Could not extract text from the PDF.')
  return { text, pages: pdf.numPages, ocrPages, tables, structured }
}

async function imageToText(
  bytes: Uint8Array,
  options: ExtractionOptions,
): Promise<{ text: string; tables: number; ocrPages: number[]; structured: boolean }> {
  if (!options.ocr) throw invalid('Image uploads need OCR. Enable OCR in Vectors & RAG settings first.')
  const sharp = options.loadSharp ? await options.loadSharp() : (await import('sharp')).default
  const metadata = await sharp(bytes, { limitInputPixels: false })
    .metadata()
    .catch(() => null)
  if (metadata?.width && metadata.height && metadata.width * metadata.height > 40_000_000) {
    throw invalid('The image is too large for OCR. Resize it below 40 megapixels and upload it again.')
  }
  const result = await ocrImage(bytes, {
    languages: options.ocrLanguages,
    minConfidence: options.ocrMinConfidence,
    tableExtraction: options.tableExtraction,
  })
  return { text: result.text, tables: result.tables, ocrPages: [1], structured: result.tables > 0 }
}

function zipKind(files: Record<string, Uint8Array>, extension: string, mimeType: string): DocumentFormat | null {
  if (files['word/document.xml'] || extension === 'docx' || mimeType.includes('wordprocessingml.document')) return 'docx'
  if (files['content.xml'] && files['mimetype'] && strFromU8(files['mimetype']).includes('opendocument.text')) return 'odt'
  if (files['META-INF/container.xml'] || extension === 'epub' || mimeType.includes('epub')) return 'epub'
  if (extension === 'odt' || mimeType.includes('opendocument.text')) return 'odt'
  return null
}

/** Read a ZIP container only when it cannot expand into an unreasonable amount of memory. */
function unzipLimited(bytes: Uint8Array): Record<string, Uint8Array> {
  let total = 0
  let entries = 0
  let limited = false
  const files = unzipSync(bytes, {
    filter(file) {
      entries++
      total += file.originalSize
      if (entries > MAX_ARCHIVE_ENTRIES || total > MAX_ARCHIVE_BYTES) {
        limited = true
        return false
      }
      return true
    },
  })
  if (limited) {
    throw invalid(`The archive expands to more than ${(MAX_ARCHIVE_BYTES / 1024 / 1024).toLocaleString('en-US')} MB; extract the document first.`)
  }
  return files
}

/** Validate an upload and read its bytes. */
export async function readUpload(value: unknown, fallbackName = 'upload'): Promise<{ name: string; mimeType: string; size: number; bytes: Uint8Array }> {
  if (!(value instanceof Blob)) throw invalid('Choose a document to ingest.')
  if (value.size === 0) throw invalid('The uploaded file is empty.')
  if (value.size > MAX_FILE_BYTES) {
    throw invalid(`The file is too large; the limit is ${(MAX_FILE_BYTES / 1024 / 1024).toLocaleString('en-US')} MB.`)
  }
  const name = typeof (value as File).name === 'string' && (value as File).name ? (value as File).name : fallbackName
  return { name, mimeType: value.type || '', size: value.size, bytes: new Uint8Array(await value.arrayBuffer()) }
}

/** Extract readable text from an uploaded file. */
export async function extractDocument(value: unknown, fallbackName = 'upload', options: ExtractionOptions = DEFAULT_EXTRACTION): Promise<ExtractedDocument> {
  const upload = await readUpload(value, fallbackName)
  const extension = extensionOf(upload.name)
  const mime = upload.mimeType.toLowerCase().split(';')[0]!.trim()
  const { bytes } = upload

  let format: DocumentFormat
  let text: string
  let pages: number | undefined
  let ocrPages: number[] | undefined
  let structured = false
  let tableCount = 0

  if (startsWith(bytes, PDF) || extension === 'pdf' || mime === 'application/pdf') {
    format = 'pdf'
    const extracted = await pdfToText(bytes, options)
    text = extracted.text
    pages = extracted.pages
    ocrPages = extracted.ocrPages.length > 0 ? extracted.ocrPages : undefined
    structured = extracted.structured
    tableCount = extracted.tables
  } else if (startsWith(bytes, ZIP) || ZIP_EXTENSIONS.has(extension)) {
    let files: Record<string, Uint8Array>
    try {
      files = unzipLimited(bytes)
    } catch (error) {
      if (error instanceof BunwriteError) throw error
      throw invalid('Could not read the ZIP container. It may be damaged or password-protected.')
    }
    const kind = zipKind(files, extension, mime)
    if (!kind) {
      throw invalid('ZIP archives are not supported directly. Upload a .docx, .odt or .epub file, or extract the text first.')
    }
    format = kind
    structured = true
    if (kind === 'docx') {
      const document = files['word/document.xml']
      if (!document) throw invalid('The .docx file does not contain word/document.xml.')
      text = docxToMarkdown(strFromU8(document))
    } else if (kind === 'odt') {
      const content = files['content.xml']
      if (!content) throw invalid('The .odt file does not contain content.xml.')
      text = odtToMarkdown(strFromU8(content))
    } else text = epubToMarkdown(files)
  } else if (IMAGE_EXTENSIONS.has(extension) || (mime.startsWith('image/') && mime !== 'image/svg+xml')) {
    format = 'image'
    const extracted = await imageToText(bytes, options)
    text = extracted.text
    pages = 1
    ocrPages = extracted.ocrPages
    structured = extracted.structured
    tableCount = extracted.tables
  } else if (startsWith(bytes, RTF) || extension === 'rtf' || mime === 'application/rtf' || mime === 'text/rtf') {
    format = 'rtf'
    text = rtfToText(strFromU8(bytes))
  } else if (HTML_EXTENSIONS.has(extension) || mime === 'text/html' || mime === 'application/xhtml+xml') {
    format = 'html'
    text = htmlToMarkdown(strFromU8(bytes))
    structured = true
  } else if (MARKDOWN_EXTENSIONS.has(extension) || mime === 'text/markdown') {
    format = 'markdown'
    text = markdownToStructured(strFromU8(bytes))
    structured = true
  } else if (JSON_EXTENSIONS.has(extension) || mime === 'application/json' || mime.endsWith('+json')) {
    format = 'json'
    text = jsonToText(strFromU8(bytes))
  } else if (CSV_EXTENSIONS.has(extension) || mime === 'text/csv' || mime === 'text/tab-separated-values') {
    format = 'csv'
    text = csvToMarkdown(strFromU8(bytes), extension)
    structured = true
  } else if (XML_EXTENSIONS.has(extension) || mime === 'application/xml' || mime.endsWith('+xml')) {
    format = 'xml'
    text = xmlToText(strFromU8(bytes))
  } else if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(extension) || decodesAsText(bytes)) {
    format = 'text'
    text = strFromU8(bytes)
  } else {
    throw invalid('That file type is not supported. Use PDF, image, Markdown, HTML, DOCX, ODT, EPUB, RTF, JSON, CSV, XML or plain text.')
  }

  const cleaned = normalizeText(text)
  if (!cleaned) {
    throw invalid(
      format === 'pdf'
        ? 'No text was found in the PDF. Enable OCR or upload a PDF with a text layer.'
        : format === 'image'
          ? 'No readable text was found in the image.'
          : 'No readable text was found in the file.',
    )
  }
  const tables = tableCount || countMarkdownTables(cleaned)
  return {
    name: upload.name,
    mimeType: upload.mimeType,
    format,
    size: upload.size,
    text: cleaned,
    characters: cleaned.length,
    ...(pages !== undefined ? { pages } : {}),
    ...(ocrPages ? { ocrPages } : {}),
    ...(tables > 0 ? { tables } : {}),
    ...(structured ? { structured } : {}),
  }
}
