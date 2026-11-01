/**
 * In-process counters, gauges and histograms.
 *
 * There is no third-party metrics SDK: the registry keeps a small bounded map
 * and hands OTLP/Datadog exporters a delta snapshot every flush interval. Tags
 * are normalised and truncated so a caller cannot blow up cardinality by
 * putting a document ID in a label by accident.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram'

export type Tags = Record<string, string | number | boolean | undefined>

export interface MetricPoint {
  name: string
  type: MetricType
  tags: Record<string, string>
  value: number
  count: number
  sum: number
  min: number
  max: number
  bounds: number[]
  buckets: number[]
}

/** Default latency buckets in milliseconds. */
export const DEFAULT_BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000]

const MAX_TAGS = 20
const MAX_TAG_LENGTH = 200

function normalize(tags: Tags): Record<string, string> {
  const entries = Object.entries(tags)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, MAX_TAGS)
    .map(([key, value]) => [key.slice(0, 64), String(value).slice(0, MAX_TAG_LENGTH)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(entries)
}

const keyOf = (type: MetricType, name: string, tags: Record<string, string>): string =>
  `${type}|${name}|${Object.entries(tags)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')}`

interface Entry {
  name: string
  type: MetricType
  tags: Record<string, string>
  value: number
  count: number
  sum: number
  min: number
  max: number
  bounds: number[]
  buckets: number[]
}

export class MetricRegistry {
  private readonly entries = new Map<string, Entry>()

  counter(name: string, value = 1, tags: Tags = {}): void {
    if (!Number.isFinite(value) || value <= 0) return
    const entry = this.entry('counter', name, tags)
    entry.value += value
  }

  gauge(name: string, value: number, tags: Tags = {}): void {
    if (!Number.isFinite(value)) return
    this.entry('gauge', name, tags).value = value
  }

  histogram(name: string, value: number, tags: Tags = {}, bounds: number[] = DEFAULT_BUCKETS): void {
    if (!Number.isFinite(value)) return
    const entry = this.entry('histogram', name, tags, bounds)
    entry.count++
    entry.sum += value
    entry.min = entry.count === 1 ? value : Math.min(entry.min, value)
    entry.max = entry.count === 1 ? value : Math.max(entry.max, value)
    const at = entry.bounds.findIndex((bound) => value <= bound)
    entry.buckets[at === -1 ? entry.buckets.length - 1 : at]!++
  }

  private entry(type: MetricType, name: string, tags: Tags, bounds = DEFAULT_BUCKETS): Entry {
    const normalized = normalize(tags)
    const key = keyOf(type, name, normalized)
    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        name,
        type,
        tags: normalized,
        value: 0,
        count: 0,
        sum: 0,
        min: 0,
        max: 0,
        bounds,
        buckets: new Array(bounds.length + 1).fill(0) as number[],
      }
      this.entries.set(key, entry)
    }
    return entry
  }

  /** Delta snapshot: counters and histograms reset, gauges keep their value. */
  snapshot(): MetricPoint[] {
    const points: MetricPoint[] = []
    for (const entry of this.entries.values()) {
      if (entry.type === 'counter') {
        if (entry.value === 0) continue
        points.push({ ...entry, value: entry.value })
        entry.value = 0
      } else if (entry.type === 'gauge') {
        points.push({ ...entry, value: entry.value })
      } else if (entry.count > 0) {
        points.push({ ...entry, value: entry.sum })
        entry.count = 0
        entry.sum = 0
        entry.min = 0
        entry.max = 0
        entry.buckets = new Array(entry.bounds.length + 1).fill(0) as number[]
      }
    }
    return points
  }

  /** Drop entries that have not reported anything; useful in long test runs. */
  reset(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

/** Process-level gauges, refreshed right before each metrics export. */
export function collectProcessMetrics(metrics: MetricRegistry): void {
  const memory = process.memoryUsage()
  metrics.gauge('bunwrite.process.memory.rss', memory.rss)
  metrics.gauge('bunwrite.process.memory.heap_used', memory.heapUsed)
  metrics.gauge('bunwrite.process.memory.heap_total', memory.heapTotal)
  metrics.gauge('bunwrite.process.memory.external', memory.external)
  metrics.gauge('bunwrite.process.uptime', process.uptime(), { unit: 's' })
}
