/**
 * Tesseract OCR for scanned pages and images.
 *
 * The CLI is used instead of a JavaScript OCR runtime: it is fast, has no model
 * download at request time, and is available in most self-hosted environments.
 * TSV output gives word positions, so tables can be reconstructed with the same
 * layout heuristics as born-digital PDFs.
 */
import { layoutToMarkdown, type LayoutItem } from './layout'
import { invalid } from './validate'

export interface OcrOptions {
  languages: string
  minConfidence: number
  tableExtraction: boolean
}

export interface OcrResult {
  text: string
  tables: number
}

const COMMAND = 'tesseract'

/** Whether the OCR binary is available on this host. */
export function ocrAvailable(): boolean {
  return Bun.which(COMMAND) !== null
}

function parseTsv(output: string, minConfidence: number): LayoutItem[] {
  const items: LayoutItem[] = []
  for (const line of output.split(/\r?\n/).slice(1)) {
    const fields = line.split('\t')
    if (fields.length < 12) continue
    const level = Number(fields[0])
    if (level !== 5) continue
    const text = fields.slice(11).join('\t').trim()
    if (!text) continue
    const confidence = Number(fields[10])
    if (!Number.isFinite(confidence) || confidence < minConfidence) continue
    const left = Number(fields[6])
    const top = Number(fields[7])
    const width = Number(fields[8])
    const height = Number(fields[9])
    if (![left, top, width, height].every(Number.isFinite)) continue
    items.push({
      text,
      left,
      top,
      width,
      height,
      lineGroup: `${fields[1]}:${fields[2]}:${fields[3]}:${fields[4]}`,
    })
  }
  return items
}

/** OCR one PNG/JPEG/TIFF image and return Markdown-ish text. */
export async function ocrImage(bytes: Uint8Array, options: OcrOptions): Promise<OcrResult> {
  const command = Bun.which(COMMAND)
  if (!command) {
    throw invalid('OCR is enabled, but the tesseract executable was not found. Install Tesseract or turn OCR off.')
  }
  if (!/^[A-Za-z0-9_+-]+$/.test(options.languages)) {
    throw invalid('OCR languages may contain letters, numbers, underscores, hyphens and + only (for example eng+ind).')
  }
  const minConfidence = Number.isFinite(options.minConfidence) ? Math.max(0, Math.min(100, Math.round(options.minConfidence))) : 30
  const proc = Bun.spawn([command, 'stdin', 'stdout', '-l', options.languages, '--psm', '6', 'tsv'], {
    stdin: bytes,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [output, error, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (status !== 0) {
    throw invalid(`OCR failed: ${error.trim().slice(0, 300) || `tesseract exited with status ${status}`}`)
  }
  const items = parseTsv(output, minConfidence)
  if (items.length === 0) return { text: '', tables: 0 }
  return layoutToMarkdown(items, { tableExtraction: options.tableExtraction, headingDetection: false })
}
