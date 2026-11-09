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

export function chunkText(text: string, options: Partial<ChunkOptions> = {}): Chunk[] {
  const size = Math.max(64, Math.min(MAX_SIZE, Math.round(options.size ?? DEFAULT_SIZE)))
  const overlap = Math.max(0, Math.min(Math.floor(size / 2), Math.round(options.overlap ?? Math.min(DEFAULT_OVERLAP, Math.floor(size / 4)))))
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []

  const words = normalized.split(/\s+/)
  const chunks: Chunk[] = []
  let start = 0
  while (start < words.length) {
    let end = start
    let length = 0
    while (end < words.length) {
      const next = words[end]!.length + (length > 0 ? 1 : 0)
      if (length > 0 && length + next > size) break
      length += next
      end++
    }
    // A single word longer than the window still has to make progress.
    if (end === start) end = start + 1
    chunks.push({ text: words.slice(start, end).join(' '), index: chunks.length })

    if (end >= words.length) break
    // Step back by whole words until the tail is within the overlap budget.
    let next = end
    let tail = 0
    while (next > start && tail < overlap) {
      next--
      tail += (tail > 0 ? 1 : 0) + words[next]!.length
    }
    // Always move forward, even when one word is larger than the overlap.
    start = next > start ? next : end
  }
  return chunks
}

/**
 * Heading-aware chunking for Markdown. Each chunk carries its heading path so
 * retrieved chunks remain self-describing and a section does not lose context
 * when it is split.
 */
export function chunkMarkdown(text: string, options: Partial<ChunkOptions> = {}): Chunk[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  const sections: { heading: string; body: string }[] = []
  const stack: { level: number; title: string }[] = []
  let body: string[] = []
  const flush = () => {
    const content = body.join('\n').trim()
    if (content) sections.push({ heading: stack.map((entry) => entry.title).join(' / '), body: content })
    body = []
  }
  for (const line of normalized.split('\n')) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line)
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
  if (sections.length === 0) return chunkText(text, options)

  const chunks: Chunk[] = []
  for (const section of sections) {
    for (const chunk of chunkText(section.body, options)) {
      chunks.push({
        text: section.heading ? `${section.heading}\n${chunk.text}` : chunk.text,
        index: chunks.length,
        ...(section.heading ? { section: section.heading } : {}),
      })
    }
  }
  return chunks
}
