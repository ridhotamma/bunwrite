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
  score: number
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
}

export interface IngestInput {
  collectionId?: unknown
  documentId?: unknown
  text?: unknown
  metadata?: unknown
  chunkSize?: unknown
  chunkOverlap?: unknown
}

export interface QueryInput extends IngestInput {
  query?: unknown
  topK?: unknown
  filter?: unknown
  generate?: unknown
}
