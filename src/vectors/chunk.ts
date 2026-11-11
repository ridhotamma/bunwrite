/**
 * Word-boundary chunking for RAG ingestion.
 *
 * The window is measured in characters because that is what the API exposes,
 * but it only cuts between words. A chunk therefore stays a little under the
 * requested size instead of slicing a word or a Unicode code point in half.
 */

export interface ChunkOptions {
  size: number
  overlap: number
}

export interface Chunk {
  text: string
  index: number
  /** Markdown/HTML heading path, when the document has structure. */
  section?: string
}

const DEFAULT_SIZE = 1000
const DEFAULT_OVERLAP = 200
const MAX_SIZE = 8000

/** A word, or a piece of one that was too long; `glued` pieces join without a space. */
interface Token {
  text: string
  glued: boolean
}

/**
 * Words, with any word longer than the window cut into pieces. Text with no
 * spaces (Chinese, Japanese, Thai) or a long URL, hash or minified line would
 * otherwise become one chunk of any size. Pieces are cut by code point, so a
 * surrogate pair is never split, and a quarter window keeps overlap possible.
 */
function tokensOf(text: string, size: number): Token[] {
  const piece = Math.max(16, Math.floor(size / 4))
  const tokens: Token[] = []
  for (const word of text.split(/\s+/)) {
    if (!word) continue
    if (word.length <= size) {
      tokens.push({ text: word, glued: false })
      continue
    }
    const points = Array.from(word)
    for (let i = 0; i < points.length; i += piece) tokens.push({ text: points.slice(i, i + piece).join(''), glued: i > 0 })
  }
  return tokens
}

function joinTokens(tokens: Token[]): string {
  let text = ''
  for (let i = 0; i < tokens.length; i++) text += (i > 0 && !tokens[i]!.glued ? ' ' : '') + tokens[i]!.text
  return text
}

export function chunkText(text: string, options: Partial<ChunkOptions> = {}): Chunk[] {
  const size = Math.max(64, Math.min(MAX_SIZE, Math.round(options.size ?? DEFAULT_SIZE)))
  const overlap = Math.max(0, Math.min(Math.floor(size / 2), Math.round(options.overlap ?? Math.min(DEFAULT_OVERLAP, Math.floor(size / 4)))))
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []

  const words = tokensOf(normalized, size)
  const gap = (index: number, length: number) => (length > 0 && !words[index]!.glued ? 1 : 0)
  const chunks: Chunk[] = []
  let start = 0
  while (start < words.length) {
    let end = start
    let length = 0
    while (end < words.length) {
      const next = words[end]!.text.length + gap(end, length)
      if (length > 0 && length + next > size) break
      length += next
      end++
    }
    // Every token fits the window, but keep the loop safe against a zero step.
    if (end === start) end = start + 1
    chunks.push({ text: joinTokens(words.slice(start, end)), index: chunks.length })

    if (end >= words.length) break
    // Step back by whole tokens until the tail is within the overlap budget.
    let next = end
    let tail = 0
    while (next > start && tail < overlap) {
      next--
      tail += (tail > 0 ? 1 : 0) + words[next]!.text.length
    }
    // Always move forward, even when one token is larger than the overlap.
    start = next > start ? next : end
  }
  return chunks
}

const tableLine = (line: string) => line.includes('|') && line.trim().split('|').length >= 2
const tableSeparator = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
const fenceStart = (line: string) => /^\s*(```|~~~)/.test(line)

/** Split a body into plain text and tables, so tables are never cut in half. */
function splitBlocks(body: string): { kind: 'text' | 'table'; lines: string[] }[] {
  const lines = body.split('\n')
  const blocks: { kind: 'text' | 'table'; lines: string[] }[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (tableLine(line) && index + 1 < lines.length && tableSeparator(lines[index + 1]!)) {
      const table: string[] = [line, lines[index + 1]!]
      index += 2
      while (index < lines.length && tableLine(lines[index]!)) table.push(lines[index++]!)
      blocks.push({ kind: 'table', lines: table })
      continue
    }
    if (fenceStart(line)) {
      const text: string[] = [line]
      index++
      while (index < lines.length) {
        text.push(lines[index]!)
        if (fenceStart(lines[index]!)) {
          index++
          break
        }
        index++
      }
      blocks.push({ kind: 'text', lines: text })
      continue
    }
    const text: string[] = []
    while (index < lines.length) {
      if (lines[index]!.trim() === '') {
        text.push(lines[index++]!)
        break
      }
      if (text.length > 0) {
        const next = lines[index]!
        if (next.trim() === '' || (tableLine(next) && index + 1 < lines.length && tableSeparator(lines[index + 1]!)) || fenceStart(next)) break
      }
      text.push(lines[index++]!)
    }
    if (text.length > 0) blocks.push({ kind: 'text', lines: text })
  }
  return blocks
}

/** Keep Markdown tables in one chunk; split large tables by rows and repeat the header. */
function chunkTable(lines: string[], options: Partial<ChunkOptions>): string[] {
  const size = Math.max(64, Math.min(MAX_SIZE, Math.round(options.size ?? DEFAULT_SIZE)))
  const whole = lines.join('\n').trim()
  if (whole.length <= size) return [whole]
  const header = [lines[0]!, lines[1]!]
  const rows = lines.slice(2)
  if (rows.length === 0) return [whole]

  const chunks: string[] = []
  let current = [...header]
  let length = header.join('\n').length
  for (const row of rows) {
    const rowLength = row.length + 1
    if (current.length > header.length && length + rowLength > size) {
      chunks.push(current.join('\n'))
      current = [...header]
      length = header.join('\n').length
    }
    current.push(row)
    length += rowLength
  }
  if (current.length > header.length) chunks.push(current.join('\n'))
  return chunks
}

/**
 * Heading-aware chunking for Markdown and extracted structure (HTML, PDF,
 * DOCX, ODT, EPUB, CSV). Headings become a section path on every chunk, and
 * tables are kept together (or split by rows with the header repeated).
 */
export function chunkMarkdown(text: string, options: Partial<ChunkOptions> = {}): Chunk[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  const sections: { heading: string; body: string }[] = []
  const stack: { level: number; title: string }[] = []
  let body: string[] = []
  let fence: string | null = null
  const flush = () => {
    const content = body.join('\n').trim()
    if (content) sections.push({ heading: stack.map((entry) => entry.title).join(' / '), body: content })
    body = []
  }
  for (const line of normalized.split('\n')) {
    const opening = /^\s*(```|~~~)/.exec(line)
    if (opening && fence === null) {
      fence = opening[1]!
      body.push(line)
      continue
    }
    if (fence !== null) {
      body.push(line)
      if (line.trimStart().startsWith(fence)) fence = null
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/.exec(line)
    if (!heading) {
      body.push(line)
      continue
    }
    flush()
    const level = heading[1]!.length
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop()
    stack.push({ level, title: heading[2]!.trim() })
  }
  flush()
  if (sections.length === 0) {
    sections.push({ heading: '', body: normalized.trim() })
  }

  const chunks: Chunk[] = []
  const push = (value: string, heading: string) => {
    const text = value.trim()
    if (!text) return
    chunks.push({
      text: heading ? `${heading}\n${text}` : text,
      index: chunks.length,
      ...(heading ? { section: heading } : {}),
    })
  }
  for (const section of sections) {
    const blocks = splitBlocks(section.body)
    const merged: { kind: 'text' | 'table'; lines: string[] }[] = []
    for (const block of blocks) {
      const previous = merged[merged.length - 1]
      if (block.kind === 'text' && previous?.kind === 'text') previous.lines.push(...block.lines)
      else merged.push({ kind: block.kind, lines: [...block.lines] })
    }
    for (const block of merged) {
      if (block.kind === 'table') {
        for (const table of chunkTable(block.lines, options)) push(table, section.heading)
      } else {
        for (const chunk of chunkText(block.lines.join('\n'), options)) push(chunk.text, section.heading)
      }
    }
  }
  return chunks
}
