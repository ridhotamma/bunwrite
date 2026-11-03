/**
 * Embedding providers.
 *
 * `LocalEmbedding` is a deterministic feature-hash embedder: tokens and token
 * bigrams are hashed into a fixed number of dimensions with signed accumulators
 * and the result is L2-normalised. It is lexical rather than semantic, but it
 * needs no key, no model download and no network, which is what keeps vector
 * search lightweight on a small VPS.
 *
 * `HttpEmbedding` talks to any OpenAI-compatible `/embeddings` endpoint
 * (OpenAI, Azure-compatible gateways, Ollama, LocalAI, ...). Requests are
 * batched and every response is checked against the configured dimension.
 */
import { norm } from './similarity'

export interface EmbeddingProvider {
  /** Stored on a collection; a change means the collection must be re-indexed. */
  readonly name: string
  /** Fixed width of the vectors this provider returns, or null when it must be inferred. */
  readonly dimension: number | null
  embed(texts: string[]): Promise<number[][]>
}

const FNV_OFFSET = 2166136261
const FNV_PRIME = 16777619

function hash(text: string): number {
  let value = FNV_OFFSET
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, FNV_PRIME)
  }
  return value >>> 0
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .match(/[\p{L}\p{N}]+/gu) ?? []
}

/** Hash one text into `dimension` signed buckets and normalise it. */
export function localVector(text: string, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0)
  const tokens = tokenize(text)
  const add = (feature: string, weight: number) => {
    const value = hash(feature)
    const index = value % dimension
    vector[index] = vector[index]! + (value & 0x80000000 ? -weight : weight)
  }
  for (let i = 0; i < tokens.length; i++) {
    add(tokens[i]!, 1)
    if (i + 1 < tokens.length) add(`${tokens[i]} ${tokens[i + 1]}`, 0.5)
  }
  const length = norm(vector)
  if (length > 0) for (let i = 0; i < vector.length; i++) vector[i] = vector[i]! / length
  return vector
}

export class LocalEmbedding implements EmbeddingProvider {
  readonly dimension: number
  readonly name: string

  constructor(dimension: number) {
    this.dimension = dimension
    this.name = `local:${dimension}`
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => localVector(text, this.dimension))
  }
}

export interface HttpEmbeddingOptions {
  url: string
  apiKey: string
  model: string
  dimension: number | null
  sendDimensions: boolean
  batchSize: number
  timeoutMs: number
}

/** Append the standard path to a base URL, leaving a complete endpoint alone. */
export function embeddingEndpoint(url: string): string {
  const base = url.trim().replace(/\/+$/, '')
  if (!base) throw new Error('An embeddings URL is required for the HTTP embedder.')
  if (/\/embeddings$/i.test(base)) return base
  if (/\/v\d+$/i.test(base)) return `${base}/embeddings`
  return `${base}/v1/embeddings`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class HttpEmbedding implements EmbeddingProvider {
  readonly dimension: number | null
  readonly name: string
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly model: string
  private readonly sendDimensions: boolean
  private readonly batchSize: number
  private readonly timeoutMs: number

  constructor(options: HttpEmbeddingOptions) {
    this.endpoint = embeddingEndpoint(options.url)
    this.apiKey = options.apiKey
    this.model = options.model
    this.dimension = options.dimension
    this.sendDimensions = options.sendDimensions
    this.batchSize = Math.max(1, Math.round(options.batchSize))
    this.timeoutMs = Math.max(1_000, Math.round(options.timeoutMs))
    this.name = `http:${options.model}`
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = []
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize)
      vectors.push(...(await this.request(batch)))
    }
    return vectors
  }

  private async request(texts: string[]): Promise<number[][]> {
    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          ...(this.sendDimensions && this.dimension ? { dimensions: this.dimension } : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new Error(`Embedding request failed: ${messageOf(error)}`, { cause: error })
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`Embedding provider returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      throw new Error('Embedding provider returned a non-JSON response.', { cause: error })
    }
    const data = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const rows = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.embeddings)
        ? data.embeddings
        : null
    if (!rows || rows.length !== texts.length) {
      throw new Error('Embedding provider returned an unexpected response shape.')
    }
    return rows.map((row) => {
      const raw = row && typeof row === 'object' && !Array.isArray(row) ? (row as { embedding?: unknown }).embedding : row
      if (!Array.isArray(raw) || raw.length === 0) throw new Error('Embedding provider returned an empty vector.')
      const vector = raw.map((value) => Number(value))
      if (vector.some((value) => !Number.isFinite(value))) throw new Error('Embedding provider returned a non-numeric vector.')
      if (this.dimension !== null && vector.length !== this.dimension) {
        throw new Error(
          `Embedding dimension mismatch: provider returned ${vector.length}, but the configured dimension is ${this.dimension}. Re-index or set the right dimension.`,
        )
      }
      return vector
    })
  }
}
