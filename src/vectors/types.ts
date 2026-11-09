import type { VectorMetric } from './similarity'

export interface VectorCollectionRow {
  seq: number
  id: string
  name: string
  dimension: number
  metric: string
  embedder: string
  created_at: string
  updated_at: string
}

export interface VectorPointRow {
  seq: number
  collection_id: string
  id: string
  document_id: string
  chunk_index: number
  content: string
  metadata: string
  embedding: string
  norm: number
  dimension: number
  permissions: string
  created_at: string
  updated_at: string
}

export interface VectorCollection {
  $id: string
  name: string
  dimension: number
  metric: VectorMetric
  embedder: string
  points: number
  $createdAt: string
  $updatedAt: string
}

export interface VectorPoint {
  $id: string
  $createdAt: string
  $updatedAt: string
  documentId: string
  chunkIndex: number
  content: string
  metadata: Record<string, unknown>
  /** Appwrite-style permissions such as `read("users")` or `read("team:acme")`. */
  permissions: string[]
}

export interface VectorMatch extends VectorPoint {
  /** Final ranking score; higher is better. Hybrid/rerank queries return the fused/reranked score. */
  score: number
}

/** One ingested document, grouped from its chunks. */
export interface VectorDocument {
  documentId: string
  chunks: number
  /** Metadata of the document's first chunk, including source/filename/format for uploads. */
  metadata: Record<string, unknown>
  $createdAt: string
  $updatedAt: string
}

/** A point after validation and embedding, ready for the store. */
export interface StoredPoint {
  id: string
  documentId: string
  chunkIndex: number
  content: string
  metadata: Record<string, unknown>
  permissions: string[]
  vector: number[]
}

export interface CreateCollectionInput {
  id?: unknown
  name?: unknown
  dimension?: unknown
  metric?: unknown
}

export interface PointInput {
  id?: unknown
  vector?: unknown
  content?: unknown
  metadata?: unknown
  documentId?: unknown
  chunkIndex?: unknown
  /** Appwrite-style permissions; omitted points are API-key-only. */
  permissions?: unknown
}

export interface SearchInput {
  text?: unknown
  query?: unknown
  vector?: unknown
  topK?: unknown
  filter?: unknown
  /** Override the project's hybrid-search setting for this query. */
  hybrid?: unknown
  /** Override the project's rerank setting for this query. */
  rerank?: unknown
  /** Vector share of the hybrid score, 0..1. */
  alpha?: unknown
}

/** A non-privileged reader. Omit it for API keys and console admins, which bypass ACLs. */
export interface VectorReadAccess {
  roles: Set<string>
  /** Used for audit rows when auditing is enabled. */
  userId?: string
}

export interface VectorQuerySecurity {
  /** PII values replaced before the context reached the chat model. */
  redactions: number
  redactionKinds: string[]
  /** Source document IDs that contain instruction-like text. */
  suspiciousSources: string[]
}

export interface VectorAuditEntry {
  $id: string
  collectionId: string
  userId: string | null
  callerKind: string
  query: string
  answer: string
  sourceIds: string[]
  security: VectorQuerySecurity
  latencyMs: number
  $createdAt: string
}

export interface IngestInput {
  collectionId?: unknown
  documentId?: unknown
  text?: unknown
  /** A File/Blob upload; the server extracts text before chunking. */
  file?: unknown
  metadata?: unknown
  /** Appwrite-style permissions applied to every chunk; omitted means API-key-only. */
  permissions?: unknown
  chunkSize?: unknown
  chunkOverlap?: unknown
}

export interface IngestResult {
  collectionId: string
  documentId: string
  chunks: number
  characters: number
  format: string
  pages?: number
  $createdAt: string
}

export interface ReindexResult {
  collectionId: string
  points: number
  embedder: string
  dimension: number
}

export interface QueryInput extends IngestInput {
  query?: unknown
  topK?: unknown
  filter?: unknown
  generate?: unknown
  hybrid?: unknown
  rerank?: unknown
  alpha?: unknown
  /** Ask the chat model to plan multiple retrieval queries (requires generation). */
  multiHop?: unknown
}

export interface EvalCaseInput {
  id?: unknown
  query?: unknown
  expectedDocuments?: unknown
  expectedKeywords?: unknown
  expectRefusal?: unknown
}

export interface EvaluateInput {
  collectionId?: unknown
  cases?: unknown
  topK?: unknown
  filter?: unknown
  generate?: unknown
  hybrid?: unknown
  rerank?: unknown
  alpha?: unknown
  /** Ask the chat model to plan multiple retrieval queries per case. */
  multiHop?: unknown
  /** Display name for a saved evaluation run. */
  name?: unknown
  /** Store the run; defaults to true. */
  save?: unknown
  /** Compare against an earlier run in the same collection. */
  baselineId?: unknown
  /** Mark the result when metrics regress against the baseline. */
  failOnRegression?: unknown
}

export interface EvalCaseResult {
  id: string
  query: string
  passed: boolean
  expectedRefusal: boolean
  /** Fraction of expected documents present in the top-k results; null when none were given. */
  recallAtK: number | null
  /** Reciprocal rank of the first expected document; null when none were given. */
  reciprocalRank: number | null
  /** Binary-relevance nDCG at k; null when no expected documents were given. */
  ndcgAtK: number | null
  /** Fraction of expected keywords present in the retrieved context. */
  contextKeywordCoverage: number | null
  /** Fraction of expected keywords present in the generated answer, when one exists. */
  answerKeywordCoverage: number | null
  /** Whether the answer looks like a refusal; null without a generated answer. */
  refused: boolean | null
  answer: string | null
  sources: VectorMatch[]
  latencyMs: number
  error?: string
}

export interface EvaluationRegression {
  baselineId: string
  baselineName: string
  /** Metric name to current-minus-baseline delta. */
  deltas: Record<string, number | null>
  /** Metrics that fell beyond the tolerance. */
  failures: string[]
  passed: boolean
}

export interface EvaluateResult {
  $id?: string
  collectionId: string
  name?: string
  saved?: boolean
  total: number
  passed: number
  failed: number
  metrics: {
    recallAtK: number | null
    mrr: number | null
    ndcgAtK: number | null
    contextKeywordCoverage: number | null
    answerKeywordCoverage: number | null
    refusalAccuracy: number | null
    averageLatencyMs: number
  }
  regression?: EvaluationRegression
  cases: EvalCaseResult[]
}

/** A saved evaluation without the full case/source payload. */
export interface EvaluationRunSummary {
  $id: string
  collectionId: string
  name: string
  total: number
  passed: number
  failed: number
  metrics: EvaluateResult['metrics']
  $createdAt: string
  $updatedAt: string
}

export interface EvaluationRun extends EvaluationRunSummary {
  dataset: unknown
  result: EvaluateResult
}
