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
