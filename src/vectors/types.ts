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

export interface IngestInput {
  collectionId?: unknown
  documentId?: unknown
  text?: unknown
  /** A File/Blob upload; the server extracts text before chunking. */
  file?: unknown
  metadata?: unknown
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

export interface QueryInput extends IngestInput {
  query?: unknown
  topK?: unknown
  filter?: unknown
  generate?: unknown
  hybrid?: unknown
  rerank?: unknown
  alpha?: unknown
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

export interface EvaluateResult {
  collectionId: string
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
  cases: EvalCaseResult[]
}
