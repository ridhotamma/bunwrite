/**
 * Candidate reranking for hybrid search.
 *
 * The local reranker is deterministic and dependency-free. A Cohere/Jina-style
 * HTTP reranker can be configured for a neural cross-encoder; if it fails, the
 * service falls back to the local reranker instead of failing the whole query.
 */
import { localRerankScore } from './lexical'

export interface RerankResult {
  /** Index into the documents passed to `rerank`. */
  index: number
  score: number
}

export interface RerankProvider {
  readonly name: string
  rerank(query: string, documents: string[]): Promise<RerankResult[]>
}

export class LocalReranker implements RerankProvider {
  readonly name = 'local:lexical'

  async rerank(query: string, documents: string[]): Promise<RerankResult[]> {
    return documents
      .map((content, index) => ({ index, score: localRerankScore(query, content) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
  }
}

export interface HttpRerankerOptions {
  url: string
  apiKey: string
  model: string
  timeoutMs: number
}

export function rerankEndpoint(url: string): string {
  const base = url.trim().replace(/\/+$/, '')
  if (!base) throw new Error('A rerank URL is required for the HTTP reranker.')
  if (/\/rerank$/i.test(base)) return base
  if (/\/v\d+$/i.test(base)) return `${base}/rerank`
  return `${base}/v1/rerank`
}

interface RerankResponse {
  results?: unknown
  data?: unknown
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Cohere and Jina both return `results: [{ index, relevance_score }]`. */
export class HttpReranker implements RerankProvider {
  readonly name: string
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly model: string
  private readonly timeoutMs: number

  constructor(options: HttpRerankerOptions) {
    this.endpoint = rerankEndpoint(options.url)
    this.apiKey = options.apiKey
    this.model = options.model
    this.timeoutMs = Math.max(1_000, Math.round(options.timeoutMs))
    this.name = options.model ? `http:${options.model}` : 'http:rerank'
  }

  async rerank(query: string, documents: string[]): Promise<RerankResult[]> {
    if (documents.length === 0) return []
    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          ...(this.model ? { model: this.model } : {}),
          query,
          documents,
          top_n: documents.length,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new Error(`Rerank request failed: ${messageOf(error)}`, { cause: error })
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`Rerank provider returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    let body: RerankResponse
    try {
      body = (await response.json()) as RerankResponse
    } catch (error) {
      throw new Error('Rerank provider returned a non-JSON response.', { cause: error })
    }
    const rows = Array.isArray(body.results) ? body.results : Array.isArray(body.data) ? body.data : null
    if (!rows) throw new Error('Rerank provider returned an unexpected response shape.')
    const results: RerankResult[] = []
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue
      const entry = raw as Record<string, unknown>
      const index = Number(entry.index)
      const score = Number(entry.relevance_score ?? entry.score)
      if (!Number.isInteger(index) || index < 0 || index >= documents.length || !Number.isFinite(score)) continue
      results.push({ index, score })
    }
    if (results.length === 0) throw new Error('Rerank provider returned no usable results.')
    return results.sort((a, b) => b.score - a.score || a.index - b.index)
  }
}
