/**
 * Lexical retrieval and local reranking.
 *
 * The vector store deliberately keeps one portable representation (points in
 * ordinary database tables), so hybrid search cannot depend on a database's
 * native full-text index. This module provides a small BM25 implementation and
 * a local lexical reranker that work identically on SQLite and Postgres.
 *
 * BM25 needs document frequency, so a hybrid search makes one statistics pass
 * over the filtered collection before the scoring pass. That is still bounded
 * by the collection point cap, and it avoids storing a second inverted index.
 */

const K1 = 1.2
const B = 0.75

/** Unicode word/number tokens, lower-cased and normalised. */
export function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize('NFKC')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
}

export function termCounts(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

export interface Bm25Accumulator {
  /** Query terms and their frequency in the query, used for document frequency and qtf. */
  terms: Map<string, number>
  documents: number
  totalLength: number
  documentFrequency: Map<string, number>
}

export interface Bm25Model {
  terms: Map<string, number>
  idf: Map<string, number>
  documents: number
  averageLength: number
}

export function createBm25(query: string): Bm25Accumulator | null {
  const terms = termCounts(tokenize(query))
  if (terms.size === 0) return null
  return {
    terms,
    documents: 0,
    totalLength: 0,
    documentFrequency: new Map([...terms.keys()].map((term) => [term, 0])),
  }
}

export function addBm25Document(state: Bm25Accumulator, content: string): void {
  const tokens = tokenize(content)
  state.documents++
  state.totalLength += tokens.length
  const seen = new Set<string>()
  for (const token of tokens) {
    if (!state.terms.has(token) || seen.has(token)) continue
    seen.add(token)
    state.documentFrequency.set(token, (state.documentFrequency.get(token) ?? 0) + 1)
  }
}

export function finalizeBm25(state: Bm25Accumulator): Bm25Model {
  const averageLength = state.documents > 0 ? state.totalLength / state.documents : 0
  const idf = new Map<string, number>()
  for (const [term, queryFrequency] of state.terms) {
    const frequency = state.documentFrequency.get(term) ?? 0
    // BM25's positive IDF variant; a term in every document contributes little.
    idf.set(term, Math.log(1 + (state.documents - frequency + 0.5) / (frequency + 0.5)))
    if (queryFrequency <= 0) idf.set(term, 0)
  }
  return { terms: state.terms, idf, documents: state.documents, averageLength }
}

/** BM25 score for one document. Higher is better; zero means no query term matched. */
export function bm25Score(model: Bm25Model, content: string): number {
  if (model.documents === 0) return 0
  const tokens = tokenize(content)
  if (tokens.length === 0) return 0
  const counts = new Map<string, number>()
  for (const token of tokens) {
    if (model.terms.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  if (counts.size === 0) return 0

  const averageLength = model.averageLength > 0 ? model.averageLength : tokens.length
  let score = 0
  for (const [term, queryFrequency] of model.terms) {
    const frequency = counts.get(term) ?? 0
    if (frequency === 0) continue
    const denominator = frequency + K1 * (1 - B + (B * tokens.length) / averageLength)
    if (denominator === 0) continue
    score += (queryFrequency * (model.idf.get(term) ?? 0) * frequency * (K1 + 1)) / denominator
  }
  return score
}

/** Lower-case, punctuation-light text used for exact phrase checks. */
function phraseText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * A local, deterministic reranker for the hybrid candidate pool. It rewards
 * exact phrases, query-term coverage, adjacent query terms and repeated term
 * matches. It is not a neural cross-encoder, but it needs no second service and
 * catches many cases where cosine similarity only finds a topical neighbour.
 */
export function localRerankScore(query: string, content: string): number {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return 0
  const contentTokens = tokenize(content)
  if (contentTokens.length === 0) return 0

  const querySet = new Set(queryTokens)
  const contentSet = new Set(contentTokens)
  let covered = 0
  for (const term of querySet) if (contentSet.has(term)) covered++
  const coverage = covered / querySet.size

  const queryPhrase = phraseText(query)
  const contentPhrase = phraseText(content)
  const phrase = queryPhrase.length > 2 && contentPhrase.includes(queryPhrase) ? 1 : 0

  let pairs = 0
  let pairMatches = 0
  for (let i = 0; i + 1 < queryTokens.length; i++) {
    pairs++
    const left = queryTokens[i]!
    const right = queryTokens[i + 1]!
    for (let j = 0; j + 1 < contentTokens.length; j++) {
      if (contentTokens[j] === left && contentTokens[j + 1] === right) {
        pairMatches++
        break
      }
    }
  }
  const proximity = pairs > 0 ? pairMatches / pairs : 0

  const counts = termCounts(contentTokens)
  let repetitions = 0
  for (const term of querySet) repetitions += Math.min(counts.get(term) ?? 0, 3)
  const frequency = repetitions / (querySet.size * 3)

  return 0.55 * coverage + 0.2 * proximity + 0.15 * phrase + 0.1 * frequency
}
