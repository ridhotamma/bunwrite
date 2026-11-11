/**
 * Vector math for the built-in store.
 *
 * Points are compared in JS after a bounded scan, so the same code runs on
 * SQLite and Postgres without a native extension. Scores are always
 * "higher is better": cosine similarity, the raw dot product, and
 * `1 / (1 + euclideanDistance)`.
 */

export type VectorMetric = 'cosine' | 'dot' | 'euclidean'

export const VECTOR_METRICS: readonly VectorMetric[] = ['cosine', 'dot', 'euclidean']

export function parseMetric(value: unknown, fallback: VectorMetric = 'cosine'): VectorMetric {
  if (value === undefined || value === null || value === '') return fallback
  const text = String(value).toLowerCase()
  if ((VECTOR_METRICS as readonly string[]).includes(text)) return text as VectorMetric
  throw new Error(`Unknown vector metric "${String(value)}". Use cosine, dot or euclidean.`)
}

/** A finite, non-empty vector. Throws a plain Error so callers can add the API error. */
export function parseVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('A vector must be a non-empty array of numbers.')
  const vector = new Array<number>(value.length)
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error('Vector values must be finite numbers.')
    vector[i] = item
  }
  return vector
}

/** L2 norm. A zero norm means every similarity against this vector is zero. */
export function norm(vector: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!
  return Math.sqrt(sum)
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const length = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < length; i++) sum += a[i]! * b[i]!
  return sum
}

export function score(metric: VectorMetric, query: ArrayLike<number>, point: ArrayLike<number>, pointNorm: number, queryNorm: number): number {
  if (query.length !== point.length) return Number.NEGATIVE_INFINITY
  switch (metric) {
    case 'dot':
      return dot(query, point)
    case 'euclidean': {
      let sum = 0
      for (let i = 0; i < query.length; i++) {
        const delta = query[i]! - point[i]!
        sum += delta * delta
      }
      return 1 / (1 + Math.sqrt(sum))
    }
    default: {
      if (queryNorm === 0 || pointNorm === 0) return 0
      return dot(query, point) / (queryNorm * pointNorm)
    }
  }
}

/** Round a vector for storage; full float precision is unnecessary and doubles the text size. */
export function compact(vector: readonly number[]): number[] {
  return vector.map((value) => Math.round(value * 1e6) / 1e6)
}
