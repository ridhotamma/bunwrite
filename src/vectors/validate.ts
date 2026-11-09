/** Input validation shared by the service and the HTTP layer. */
import { aggregatePermissions, grants } from '~/auth/permissions'
import { err } from '~/lib/errors'
import { MAX_CONTENT, MAX_METADATA, MAX_POINT_ID } from './limits'

const PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const invalid = (message: string) => err('general_argument_invalid', message)

/** A path parameter ID. Collection creation uses `resolveId`; reads accept longer point IDs. */
export function pathId(value: string | undefined, label: string): string {
  const id = (value ?? '').trim()
  if (!id || id.length > MAX_POINT_ID || !PATH_ID.test(id)) throw invalid(`${label} is invalid.`)
  return id
}

export function textOf(value: unknown, label: string, max = MAX_CONTENT): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`Param "${label}" is required.`)
  if (value.length > max) throw invalid(`Param "${label}" must be at most ${max} characters.`)
  return value
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

export function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw invalid(`Param "${label}" must be an integer between ${min} and ${max}.`)
  }
  return parsed
}

/** A boolean from JSON or a query string (`"true"`, `"1"`, `"false"`, `"0"`). */
export function booleanParam(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1' || value === 1) return true
  if (value === 'false' || value === '0' || value === 0) return false
  throw invalid(`Param "${label}" must be a boolean.`)
}

/** A finite number between `min` and `max`, inclusive. */
export function ratio(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw invalid(`Param "${label}" must be a number between ${min} and ${max}.`)
  }
  return parsed
}

export function metadataOf(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('Param "metadata" must be an object.')
  const text = JSON.stringify(value)
  if (text.length > MAX_METADATA) throw invalid(`Param "metadata" must be at most ${MAX_METADATA} bytes of JSON.`)
  return value as Record<string, unknown>
}

/** Validate and normalise Appwrite-style point/document permissions. */
export function permissionsOf(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return []
  try {
    return aggregatePermissions(value, ['read', 'update', 'delete']) ?? []
  } catch {
    throw invalid('Param "permissions" must be an array of Appwrite-style permission strings.')
  }
}

/** A point is readable by a non-privileged caller only when a read grant matches its roles. */
export function canReadPoint(permissions: readonly string[], access: { roles: Set<string> } | undefined): boolean {
  if (!access) return true
  return grants([...permissions], 'read', access.roles)
}

function lookup(metadata: Record<string, unknown>, key: string): unknown {
  if (!key.includes('.')) return metadata[key]
  let current: unknown = metadata
  for (const part of key.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Metadata equality filters, including dotted paths and array values (match any). */
export function matchesFilter(metadata: Record<string, unknown>, filter: unknown): boolean {
  if (filter === undefined || filter === null) return true
  if (typeof filter !== 'object' || Array.isArray(filter)) throw invalid('Param "filter" must be an object.')
  for (const [key, expected] of Object.entries(filter as Record<string, unknown>)) {
    const value = lookup(metadata, key)
    if (Array.isArray(expected)) {
      if (!expected.some((item) => same(value, item))) return false
    } else if (!same(value, expected)) return false
  }
  return true
}
