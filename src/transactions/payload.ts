/**
 * Narrowing helpers for transaction payloads.
 *
 * `StageInput.data` is `Record<string, unknown>`: the route hands over request
 * data and each action reads only the fields it defines. These helpers keep
 * that narrowing in one place instead of casting at every access.
 */

export const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export const documentsOf = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.map(recordOf) : [])

export const queriesOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

export const numberOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export const stringOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)
