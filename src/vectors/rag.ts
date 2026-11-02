/** Prompt assembly for retrieval-augmented answers. */
import type { VectorMatch } from './types'

export interface RagContext {
  context: string
  sources: VectorMatch[]
}

/** Build the context string, truncated on a character boundary. */
export function buildContext(matches: VectorMatch[], maxChars: number): RagContext {
  const context = matches.map((source, index) => `[${index + 1}] ${source.content}`).join('\n\n')
  return { context: context.length > maxChars ? context.slice(0, maxChars) : context, sources: matches }
}

export function answerPrompt(context: string, question: string): string {
  return `Context:\n${context}\n\nQuestion: ${question}`
}
