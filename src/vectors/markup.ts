/**
 * Structure-preserving converters for the text formats Bunwrite ingests.
 *
 * The output is Markdown-like: headings, lists and tables survive so the
 * chunker can keep sections and tables together. Formatting that has no value
 * for retrieval (inline emphasis, link targets, HTML wrappers) is removed.
 */
import { decodeEntities, markdownTable, normalizeText, tableCell } from './text'

function inline(value: string): string {
  return decodeEntities(
    value
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim()
}

function htmlTableToMarkdown(table: string): string {
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) =>
    [...match[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => tableCell(inline(cell[1]!))),
  )
  return markdownTable(rows)
}

/** HTML to headings, lists and Markdown tables. */
export function htmlToMarkdown(source: string): string {
  let text = source.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|head|nav|footer|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '')
  text = text.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => htmlTableToMarkdown(table))
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inline(inner)}\n\n`)
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<pre\b[^>]*>/gi, '\n\n')
    .replace(/<\/pre>/gi, '\n\n')
    .replace(/<\/(p|div|h[1-6]|li|section|article|blockquote|pre|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
  return normalizeText(decodeEntities(text))
}

/** Clearer Markdown for the embedding model without losing headings or tables. */
export function markdownToStructured(source: string): string {
  return normalizeText(
    decodeEntities(
      source
        .replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^(\s{0,3})>\s?/gm, '$1')
        .replace(/[*_~]{1,3}/g, ''),
    ),
  )
}

function headingLevel(style: string | undefined, outline: string | undefined): number {
  if (outline !== undefined) return Math.max(1, Math.min(6, Number(outline) + 1))
  if (!style) return 0
  if (/^title$/i.test(style)) return 1
  const match = /(?:heading|titre|ttulo|titulo|berschrift|titolo)\s*([1-6])/i.exec(style)
  return match ? Number(match[1]) : 0
}

function docxCellText(cell: string): string {
  const parts = [...cell.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)].map((match) => decodeEntities(match[1]!))
  return tableCell(parts.join(' '))
}

function docxTableToMarkdown(table: string): string {
  const rows = [...table.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/gi)].map((match) =>
    [...match[1]!.matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/gi)].map((cell) => docxCellText(cell[1]!)),
  )
  return markdownTable(rows)
}

function docxParagraphText(paragraph: string): string {
  const parts = [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)].map((match) => decodeEntities(match[1]!))
  return normalizeInline(parts.join(''))
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Word `.docx` to Markdown: heading styles, paragraphs and tables. */
export function docxToMarkdown(xml: string): string {
  const tables: string[] = []
  const withPlaceholders = xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/gi, (table) => {
    tables.push(docxTableToMarkdown(table))
    return `<w:p><w:r><w:t>@@BW_TABLE_${tables.length - 1}@@</w:t></w:r></w:p>`
  })
  const paragraphs: string[] = []
  for (const paragraph of withPlaceholders.split(/<\/w:p>/i)) {
    if (!paragraph.trim()) continue
    const style = /<w:pStyle[^>]*w:val="([^"]+)"/i.exec(paragraph)?.[1]
    const outline = /<w:outlineLvl[^>]*w:val="(\d+)"/i.exec(paragraph)?.[1]
    const text = docxParagraphText(paragraph)
    if (!text) continue
    const level = headingLevel(style, outline)
    paragraphs.push(level > 0 ? `${'#'.repeat(level)} ${text}` : text)
  }
  let text = paragraphs.join('\n\n')
  for (const [index, table] of tables.entries()) text = text.replace(`@@BW_TABLE_${index}@@`, table.trim())
  return normalizeText(text)
}

function odtCellText(cell: string): string {
  const parts = [...cell.matchAll(/<text:(?:p|h|span)\b[^>]*>([\s\S]*?)<\/text:(?:p|h|span)>/gi)].map((match) =>
    decodeEntities(
      match[1]!
        .replace(/<text:s\b[^>]*\/>/gi, ' ')
        .replace(/<text:tab[^>]*\/>/gi, '\t')
        .replace(/<text:line-break[^>]*\/>/gi, ' ')
        .replace(/<[^>]+>/g, ' '),
    ),
  )
  return tableCell(parts.join(' '))
}

function odtTableToMarkdown(table: string): string {
  const rows = [...table.matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/gi)].map((match) =>
    [...match[1]!.matchAll(/<table:table-cell\b[^>]*>([\s\S]*?)<\/table:table-cell>/gi)].map((cell) => odtCellText(cell[1]!)),
  )
  return markdownTable(rows)
}

/** OpenDocument text to Markdown: outline headings, paragraphs and tables. */
export function odtToMarkdown(xml: string): string {
  const tables: string[] = []
  let text = xml.replace(/<table:table\b[\s\S]*?<\/table:table>/gi, (table) => {
    tables.push(odtTableToMarkdown(table))
    return `<text:p>@@BW_TABLE_${tables.length - 1}@@</text:p>`
  })
  text = text.replace(/<text:h\b([^>]*)>([\s\S]*?)<\/text:h>/gi, (_, attributes: string, inner: string) => {
    const outline = /text:outline-level="(\d+)"/i.exec(attributes)?.[1]
    const level = Math.max(1, Math.min(6, Number(outline ?? 1)))
    return `\n\n${'#'.repeat(level)} ${normalizeInline(inner.replace(/<[^>]+>/g, ' '))}\n\n`
  })
  text = text
    .replace(/<text:s\b[^>]*\/>/gi, ' ')
    .replace(/<text:tab[^>]*\/>/gi, '\t')
    .replace(/<text:line-break[^>]*\/>/gi, '\n')
    .replace(/<text:list-item[^>]*>/gi, '\n- ')
    .replace(/<\/(text:p|text:list-item)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
  text = normalizeText(decodeEntities(text))
  for (const [index, table] of tables.entries()) text = text.replace(`@@BW_TABLE_${index}@@`, table.trim())
  return text
}

function detectDelimiter(source: string, extension?: string): string {
  if (extension === 'tsv') return '\t'
  const first = source.split(/\r?\n/, 1)[0] ?? ''
  return (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? '\t' : ','
}

function parseDelimited(source: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"'
        index++
      } else if (char === '"') {
        quoted = false
      } else field += char
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index++
      row.push(field)
      if (row.some((cell) => cell.trim() !== '')) rows.push(row)
      row = []
      field = ''
      continue
    }
    field += char
  }
  row.push(field)
  if (row.some((cell) => cell.trim() !== '')) rows.push(row)
  return rows
}

/** CSV/TSV to a Markdown table, preserving quoted fields and embedded newlines. */
export function csvToMarkdown(source: string, extension?: string): string {
  const delimiter = detectDelimiter(source, extension)
  const rows = parseDelimited(source, delimiter).map((row) => row.map((cell) => tableCell(cell)))
  if (rows.length === 0) return ''
  return normalizeText(markdownTable(rows))
}

/** Number of Markdown table separator lines, for ingestion metadata. */
export function countMarkdownTables(text: string): number {
  return (text.match(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm) ?? []).length
}
