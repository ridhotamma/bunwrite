/**
 * Turn an uploaded document into the plain text that gets chunked and
 * embedded. Text formats are read directly; PDF, DOCX, ODT and EPUB use small
 * pure-JavaScript extractors, so ingestion works on the same Bun process
 * without an external converter.
 *
 * The extraction is deliberately conservative: a scanned PDF with no text
 * layer is refused with a message asking for OCR instead of storing an empty
 * document. Size and page limits are checked before work starts, because PDFs
 * and ZIP containers are attacker-controlled input.
 */
import { strFromU8, unzipSync } from 'fflate'
import { BunwriteError } from '~/lib/errors'
import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ENTRIES, MAX_FILE_BYTES, MAX_PDF_PAGES } from './limits'
import { invalid } from './validate'

export type DocumentFormat = 'pdf' | 'docx' | 'odt' | 'epub' | 'html' | 'markdown' | 'json' | 'csv' | 'xml' | 'rtf' | 'text'

export interface ExtractedDocument {
  /** Original file name, when the upload had one. */
  name: string
  /** MIME type reported by the browser, or inferred from the extension. */
  mimeType: string
  format: DocumentFormat
  /** Size of the uploaded bytes. */
  size: number
  /** Extracted plain text, normalised but not chunked. */
  text: string
  characters: number
  /** PDF page count, when the document is a PDF. */
  pages?: number
}

const TEXT_EXTENSIONS = new Set(['txt', 'text', 'log', 'yaml', 'yml', 'toml', 'ini', 'conf', 'env'])
const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml'])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd'])
const JSON_EXTENSIONS = new Set(['json', 'jsonl', 'ndjson'])
const CSV_EXTENSIONS = new Set(['csv', 'tsv'])
const XML_EXTENSIONS = new Set(['xml', 'xsl', 'xsd', 'svg'])
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

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(value: string): string {
  const codePoint = (number: number) => (number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '')
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number: string) => codePoint(Number(number)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
}

function normalize(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replaceAll('\u0000', '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function htmlToText(source: string): string {
  return decodeEntities(
    source
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|head|nav|footer|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  )
}

function markdownToText(source: string): string {
  return decodeEntities(
    source
      .replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '')
      .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
      .replace(/~~~[^\n]*\n([\s\S]*?)~~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
      .replace(/[*_~]{1,3}/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/^\s*\|?[\s:-]+\|[\s|:-]*$/gm, '')
      .replace(/\|/g, ' '),
  )
}

/** Word `.docx` stores paragraphs in `word/document.xml`. */
function docxToText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<w:tab[^>]*\/>/gi, '\t')
      .replace(/<w:br[^>]*\/>/gi, '\n')
      .replace(/<\/w:p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  )
}

/** OpenDocument text stores paragraphs and headings in `content.xml`. */
function odtToText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<text:tab[^>]*\/>/gi, '\t')
      .replace(/<text:line-break[^>]*\/>/gi, '\n')
      .replace(/<\/(text:p|text:h|text:list-item)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  )
}

/** EPUB is a ZIP of XHTML documents; read the reading order from the container when possible. */
function epubToText(files: Record<string, Uint8Array>): string {
  const html = Object.entries(files)
    .filter(([name]) => /\.(x?html?|xml)$/i.test(name) && !/META-INF|container\.xml/i.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, bytes]) => htmlToText(strFromU8(bytes)))
    .filter(Boolean)
  return html.join('\n\n')
}

function rtfToText(source: string): string {
  return normalize(
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
  return decodeEntities(
    source
      .replace(/<\?xml[^>]*\?>/gi, '')
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, ' '),
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

async function pdfToText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
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
  try {
    const { text } = await pdfjs.extractText(pdf, { mergePages: true })
    return { text, pages: pdf.numPages }
  } catch {
    throw invalid('Could not extract text from the PDF.')
  }
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
export async function extractDocument(value: unknown, fallbackName = 'upload'): Promise<ExtractedDocument> {
  const upload = await readUpload(value, fallbackName)
  const extension = extensionOf(upload.name)
  const mime = upload.mimeType.toLowerCase().split(';')[0]!.trim()
  const { bytes } = upload

  let format: DocumentFormat
  let text: string
  let pages: number | undefined

  if (startsWith(bytes, PDF) || extension === 'pdf' || mime === 'application/pdf') {
    format = 'pdf'
    const extracted = await pdfToText(bytes)
    text = extracted.text
    pages = extracted.pages
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
    if (kind === 'docx') {
      const document = files['word/document.xml']
      if (!document) throw invalid('The .docx file does not contain word/document.xml.')
      text = docxToText(strFromU8(document))
    } else if (kind === 'odt') {
      const content = files['content.xml']
      if (!content) throw invalid('The .odt file does not contain content.xml.')
      text = odtToText(strFromU8(content))
    } else text = epubToText(files)
  } else if (startsWith(bytes, RTF) || extension === 'rtf' || mime === 'application/rtf' || mime === 'text/rtf') {
    format = 'rtf'
    text = rtfToText(strFromU8(bytes))
  } else if (HTML_EXTENSIONS.has(extension) || mime === 'text/html' || mime === 'application/xhtml+xml') {
    format = 'html'
    text = htmlToText(strFromU8(bytes))
  } else if (MARKDOWN_EXTENSIONS.has(extension) || mime === 'text/markdown') {
    format = 'markdown'
    text = markdownToText(strFromU8(bytes))
  } else if (JSON_EXTENSIONS.has(extension) || mime === 'application/json' || mime.endsWith('+json')) {
    format = 'json'
    text = jsonToText(strFromU8(bytes))
  } else if (CSV_EXTENSIONS.has(extension) || mime === 'text/csv' || mime === 'text/tab-separated-values') {
    format = 'csv'
    text = strFromU8(bytes)
  } else if (XML_EXTENSIONS.has(extension) || mime === 'application/xml' || mime.endsWith('+xml')) {
    format = 'xml'
    text = xmlToText(strFromU8(bytes))
  } else if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(extension) || decodesAsText(bytes)) {
    format = 'text'
    text = strFromU8(bytes)
  } else {
    throw invalid('That file type is not supported. Use PDF, Markdown, HTML, DOCX, ODT, EPUB, RTF, JSON, CSV, XML or plain text.')
  }

  const cleaned = normalize(text)
  if (!cleaned) {
    throw invalid(
      format === 'pdf'
        ? 'No text was found in the PDF. Scanned pages need OCR first; export a PDF with a text layer or upload the source text.'
        : 'No readable text was found in the file.',
    )
  }
  return { name: upload.name, mimeType: upload.mimeType, format, size: upload.size, text: cleaned, characters: cleaned.length, pages }
}
