/** Retrieval and answer metrics for RAG evaluation. Pure helpers; no I/O. */
import type { VectorPoint } from './types'

/** Unique document IDs in result order; a document with several chunks counts once. */
export function documentIds(sources: readonly VectorPoint[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const source of sources) {
    const id = source.documentId || source.$id
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

export function recallAtK(expected: readonly string[], sources: readonly VectorPoint[], topK: number): number | null {
  const wanted = [...new Set(expected.filter(Boolean))]
  if (wanted.length === 0) return null
  const found = new Set(documentIds(sources).slice(0, topK))
  return wanted.filter((id) => found.has(id)).length / wanted.length
}

export function reciprocalRank(expected: readonly string[], sources: readonly VectorPoint[]): number | null {
  const wanted = new Set(expected.filter(Boolean))
  if (wanted.size === 0) return null
  const rank = documentIds(sources).findIndex((id) => wanted.has(id))
  return rank >= 0 ? 1 / (rank + 1) : 0
}

export function ndcgAtK(expected: readonly string[], sources: readonly VectorPoint[], topK: number): number | null {
  const wanted = new Set(expected.filter(Boolean))
  if (wanted.size === 0) return null
  const ranked = documentIds(sources).slice(0, topK)
  let dcg = 0
  for (let i = 0; i < ranked.length; i++) if (wanted.has(ranked[i]!)) dcg += 1 / Math.log2(i + 2)
  const idealCount = Math.min(wanted.size, topK)
  let idcg = 0
  for (let i = 0; i < idealCount; i++) idcg += 1 / Math.log2(i + 2)
  return idcg > 0 ? dcg / idcg : 0
}

/** Fraction of expected keywords present in `text`, case-insensitively. */
export function keywordCoverage(text: string, expected: readonly string[]): number | null {
  const keywords = [...new Set(expected.map((value) => value.trim().toLowerCase()).filter(Boolean))]
  if (keywords.length === 0) return null
  const haystack = text.toLowerCase()
  return keywords.filter((keyword) => haystack.includes(keyword)).length / keywords.length
}

const REFUSAL_PATTERNS = [
  /\b(not stated|not specified|not mentioned|no information|does not (say|mention|contain)|don't know|do not know|cannot find|could not find|unable to (find|answer)|insufficient (information|context))\b/i,
  /\b(tidak (disebutkan|dinyatakan|disebut|tersedia|menemukan|tahu|ada informasi)|informasi (tersebut )?tidak|tidak cukup (informasi|konteks)|tidak dapat (menemukan|menjawab)|maaf, informasi)\b/i,
]

/** Whether an answer looks like a grounded refusal. Null without an answer. */
export function looksLikeRefusal(answer: string | null): boolean | null {
  if (answer === null || answer.trim() === '') return null
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(answer))
}

/** Average of the non-null values; null when none. */
export function average(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value))
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) / present.length : null
}
