/** Database rows mapped to the JSON models the API returns. */
import { parseMetric, type VectorMetric } from './similarity'
import type { VectorCollection, VectorCollectionRow, VectorPoint, VectorPointRow } from './types'

export function parseRowMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function collectionModel(row: VectorCollectionRow, points = 0): VectorCollection {
  let metric: VectorMetric = 'cosine'
  try {
    metric = parseMetric(row.metric)
  } catch {
    // A malformed stored value keeps the default; search does the same.
  }
  return {
    $id: row.id,
    name: row.name,
    dimension: Number(row.dimension),
    metric,
    embedder: row.embedder,
    points,
    $createdAt: row.created_at,
    $updatedAt: row.updated_at,
  }
}

export function parseRowPermissions(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

export function pointModel(row: VectorPointRow): VectorPoint {
  return {
    $id: row.id,
    $createdAt: row.created_at,
    $updatedAt: row.updated_at,
    documentId: row.document_id,
    chunkIndex: Number(row.chunk_index),
    content: row.content,
    metadata: parseRowMetadata(row.metadata),
    permissions: parseRowPermissions(row.permissions),
  }
}
