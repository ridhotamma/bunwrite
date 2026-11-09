/**
 * Built-in vector search and RAG settings.
 *
 * These are the defaults. The console's Vectors & RAG settings store the
 * project's values and apply them without a restart; there are no environment
 * variables for them.
 *
 * The defaults need no network and no extra dependency: a deterministic local
 * embedder turns text into a fixed-size feature-hashed vector. Set an
 * OpenAI-compatible embedding URL in the console to use that provider instead,
 * and a chat URL to enable the answer-generation step.
 */

export type VectorEmbedderKind = 'local' | 'http'

export interface VectorsConfig {
  /** `local` runs offline; `http` calls an OpenAI-compatible embeddings API. */
  embedder: VectorEmbedderKind
  /** Collection vectors have this many dimensions unless a collection says otherwise. */
  dimension: number
  /** Full endpoint or base URL. `/v1/embeddings` is appended when the path is a base. */
  embeddingUrl: string
  embeddingApiKey: string
  embeddingModel: string
  /** Send `dimensions` in the request (OpenAI v3 models); some gateways reject unknown fields. */
  sendDimensions: boolean
  /** Texts per embeddings request. */
  embeddingBatchSize: number
  /** Outbound embeddings/chat request timeout. */
  timeoutMs: number
  /** OpenAI-compatible chat endpoint; empty disables generated answers. */
  chatUrl: string
  chatApiKey: string
  chatModel: string
  chatSystemPrompt: string
  chatTemperature: number
  chatMaxTokens: number
  /** Context characters sent to the chat model. */
  contextChars: number
  /** Refuse new points beyond this per collection. */
  maxPoints: number
  /** Default chunk size for `POST /rag/ingest`. */
  chunkSize: number
  /** Default overlap between chunks. */
  chunkOverlap: number
}

const DEFAULT_SYSTEM_PROMPT =
  'You answer questions using only the supplied context. If the context does not explicitly state something, say that it is not stated. Do not infer safety, eligibility, prices, availability, or other facts from missing information. For medical, legal, or financial questions, recommend consulting a qualified professional. Cite sources as [1], [2], and so on.'

export const DEFAULT_VECTORS: VectorsConfig = {
  embedder: 'local',
  dimension: 384,
  embeddingUrl: '',
  embeddingApiKey: '',
  embeddingModel: 'text-embedding-3-small',
  sendDimensions: false,
  embeddingBatchSize: 64,
  timeoutMs: 30_000,
  chatUrl: '',
  chatApiKey: '',
  chatModel: 'gpt-4o-mini',
  chatSystemPrompt: DEFAULT_SYSTEM_PROMPT,
  chatTemperature: 0.2,
  chatMaxTokens: 800,
  contextChars: 12_000,
  maxPoints: 50_000,
  chunkSize: 1000,
  chunkOverlap: 200,
}

export function defaultVectorsConfig(overrides: Partial<VectorsConfig> = {}): VectorsConfig {
  return { ...DEFAULT_VECTORS, ...overrides }
}
