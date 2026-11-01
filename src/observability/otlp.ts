/**
 * OTLP/HTTP JSON payloads. Every collector that speaks OTLP/HTTP accepts this
 * shape, so one exporter covers Grafana, Honeycomb, Datadog's OTLP intake and a
 * local OpenTelemetry Collector.
 */
import type { ObservabilityConfig } from './config'
import type { MetricPoint } from './metrics'

export type AttributeValue = string | number | boolean | undefined | null

export interface SpanData {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startUnixNano: string
  endUnixNano: string
  attributes: Record<string, AttributeValue>
  error?: string
}

export interface LogData {
  timeUnixNano: string
  severity: number
  severityText: string
  message: string
  attributes: Record<string, AttributeValue>
  traceId?: string
  spanId?: string
}

const attribute = (key: string, value: AttributeValue): Record<string, unknown> | null => {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  if (typeof value === 'number') {
    return { key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } }
  }
  return { key, value: { stringValue: String(value) } }
}

const attributes = (values: Record<string, AttributeValue>): Array<Record<string, unknown>> =>
  Object.entries(values)
    .map(([key, value]) => attribute(key, value))
    .filter((entry): entry is Record<string, unknown> => entry !== null)

export function resourceAttributes(config: ObservabilityConfig): Array<Record<string, unknown>> {
  return attributes({
    'service.name': config.serviceName,
    'service.version': config.serviceVersion,
    'service.instance.id': config.instanceId,
    'deployment.environment': config.environment,
    'telemetry.sdk.name': 'bunwrite',
    'telemetry.sdk.language': 'js',
  })
}

function resource(config: ObservabilityConfig): Record<string, unknown> {
  return { attributes: resourceAttributes(config) }
}

const scope = { name: 'bunwrite', version: '1.0.0' }

export function tracesPayload(spans: SpanData[], config: ObservabilityConfig): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: resource(config),
        scopeSpans: [
          {
            scope,
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: 2,
              startTimeUnixNano: span.startUnixNano,
              endTimeUnixNano: span.endUnixNano,
              attributes: attributes(span.attributes),
              status: span.error ? { code: 2, message: span.error.slice(0, 500) } : { code: 1 },
            })),
          },
        ],
      },
    ],
  }
}

export function logsPayload(logs: LogData[], config: ObservabilityConfig): Record<string, unknown> {
  return {
    resourceLogs: [
      {
        resource: resource(config),
        scopeLogs: [
          {
            scope,
            logRecords: logs.map((log) => ({
              timeUnixNano: log.timeUnixNano,
              severityNumber: log.severity,
              severityText: log.severityText,
              body: { stringValue: log.message },
              attributes: attributes(log.attributes),
              ...(log.traceId ? { traceId: log.traceId } : {}),
              ...(log.spanId ? { spanId: log.spanId } : {}),
            })),
          },
        ],
      },
    ],
  }
}

function pointAttributes(point: MetricPoint): Array<Record<string, unknown>> {
  return attributes(Object.fromEntries(Object.entries(point.tags).filter(([key]) => key !== 'unit')))
}

export function metricsPayload(points: MetricPoint[], config: ObservabilityConfig, window: { startMs: number; endMs: number }): Record<string, unknown> {
  const startTimeUnixNano = String(BigInt(window.startMs) * 1_000_000n)
  const timeUnixNano = String(BigInt(window.endMs) * 1_000_000n)
  const metrics: Array<Record<string, unknown>> = []

  for (const point of points) {
    if (point.type === 'counter') {
      metrics.push({
        name: point.name,
        unit: '1',
        sum: {
          dataPoints: [
            {
              attributes: pointAttributes(point),
              startTimeUnixNano,
              timeUnixNano,
              asDouble: point.value,
            },
          ],
          aggregationTemporality: 1,
          isMonotonic: true,
        },
      })
    } else if (point.type === 'gauge') {
      metrics.push({
        name: point.name,
        unit: point.tags.unit ?? '1',
        gauge: {
          dataPoints: [
            {
              attributes: pointAttributes(point),
              timeUnixNano,
              asDouble: point.value,
            },
          ],
        },
      })
    } else {
      metrics.push({
        name: point.name,
        unit: point.tags.unit ?? 'ms',
        histogram: {
          dataPoints: [
            {
              attributes: pointAttributes(point),
              startTimeUnixNano,
              timeUnixNano,
              count: String(point.count),
              sum: point.sum,
              min: point.min,
              max: point.max,
              bucketCounts: point.buckets.map((count) => String(count)),
              explicitBounds: point.bounds,
            },
          ],
          aggregationTemporality: 1,
        },
      })
    }
  }

  return {
    resourceMetrics: [
      {
        resource: resource(config),
        scopeMetrics: [{ scope, metrics }],
      },
    ],
  }
}
