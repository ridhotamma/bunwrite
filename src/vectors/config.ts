/**
 * Built-in vector search and RAG settings.
 *
 * These values are the environment defaults. The console's Vectors & RAG
 * settings store an override in the project database and apply it without a
 * restart.
 *
 * The defaults need no network and no extra dependency: a deterministic local
 * embedder turns text into a fixed-size feature-hashed vector. Setting
 * `EMBEDDING_URL` (or `OPENAI_API_KEY`) switches to any OpenAI-compatible
 * `/embeddings` endpoint, and `RAG_CHAT_URL` (or `OPENAI_API_KEY`) enables the
 * answer-generation step.
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
  'You answer questions using only the supplied context. If the context does not contain the answer, say that you do not know. Cite sources as [1], [2], and so on.'

function whole(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function decimal(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

export function vectorConfigFromEnv(env: Record<string, string | undefined> = process.env): VectorsConfig {
  const configured = (env.VECTORS_EMBEDDER ?? '').trim().toLowerCase()
  const openaiKey = (env.OPENAI_API_KEY ?? '').trim()
  const embeddingUrl = (env.EMBEDDING_URL ?? '').trim() || (openaiKey ? 'https://api.openai.com/v1' : '')
  const http = configured === 'http' || configured === 'openai' || configured === 'remote' || (configured === '' && Boolean(embeddingUrl))
  const dimension = whole(env.EMBEDDING_DIMENSION, http ? 1536 : 384, 8, 8192)
  const chunkSize = whole(env.RAG_CHUNK_SIZE, 1000, 64, 8000)
  const chunkOverlap = whole(env.RAG_CHUNK_OVERLAP, Math.min(200, Math.floor(chunkSize / 4)), 0, Math.floor(chunkSize / 2))
  return {
    embedder: http ? 'http' : 'local',
    dimension,
    embeddingUrl,
    embeddingApiKey: (env.EMBEDDING_API_KEY ?? '').trim() || openaiKey,
    embeddingModel: (env.EMBEDDING_MODEL ?? '').trim() || 'text-embedding-3-small',
    sendDimensions: env.EMBEDDING_SEND_DIMENSIONS === 'true' || env.EMBEDDING_SEND_DIMENSIONS === '1',
    embeddingBatchSize: whole(env.EMBEDDING_BATCH_SIZE, 64, 1, 256),
    timeoutMs: whole(env.VECTORS_TIMEOUT_MS, 30_000, 1_000, 120_000),
    chatUrl:
      (env.RAG_CHAT_URL ?? '').trim() ||
      (env.OPENAI_CHAT_URL ?? '').trim() ||
      (openaiKey ? 'https://api.openai.com/v1/chat/completions' : ''),
    chatApiKey: (env.RAG_CHAT_API_KEY ?? '').trim() || openaiKey,
    chatModel: (env.RAG_CHAT_MODEL ?? '').trim() || (env.OPENAI_CHAT_MODEL ?? '').trim() || 'gpt-4o-mini',
    chatSystemPrompt: (env.RAG_SYSTEM_PROMPT ?? '').trim() || DEFAULT_SYSTEM_PROMPT,
    chatTemperature: decimal(env.RAG_TEMPERATURE, 0.2, 0, 2),
    chatMaxTokens: whole(env.RAG_MAX_TOKENS, 800, 1, 32_000),
    contextChars: whole(env.RAG_CONTEXT_CHARS, 12_000, 256, 200_000),
    maxPoints: whole(env.VECTORS_MAX_POINTS, 50_000, 1, 1_000_000),
    chunkSize,
    chunkOverlap,
  }
}
