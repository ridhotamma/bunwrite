/**
 * Convert between Appwrite documents and SQLite rows, validating writes the
 * way Appwrite's Structure validator does.
 */
import { normalizeDate } from '../lib/datetime'
import { invalidStructure } from '../lib/errors'
import type { Attribute, Collection } from '../schema/types'

export type SqlValue = string | number | null

export type Doc = Record<string, unknown> & {
  $id: string
  $permissions?: string[]
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const fmt = (n: number) => n.toLocaleString('en-US')

function invalidType(a: Attribute, detail: string) {
  return invalidStructure(`Attribute "${a.key}" has invalid type. ${detail}`)
}

function invalidFormat(a: Attribute, detail: string) {
  return invalidStructure(`Attribute "${a.key}" has invalid format. ${detail}`)
}

function checkScalar(a: Attribute, value: unknown): SqlValue {
  switch (a.type) {
    case 'string': {
      if (typeof value !== 'string') {
        throw invalidType(a, `Value must be a valid string and no longer than ${a.size} chars`)
      }
      if (a.size !== undefined && value.length > a.size) {
        throw invalidType(a, `Value must be a valid string and no longer than ${a.size} chars`)
      }
      if (a.format === 'enum' && a.elements && !a.elements.includes(value)) {
        throw invalidFormat(a, `Value must be one of (${a.elements.join(', ')})`)
      }
      if (a.format === 'email' && value !== '' && !EMAIL.test(value)) {
        throw invalidFormat(a, 'Value must be a valid email address')
      }
      if (a.format === 'url' && value !== '' && !URL.canParse(value)) {
        throw invalidFormat(a, 'Value must be a valid URL')
      }
      return value
    }
    case 'integer':
    case 'double': {
      const ok = typeof value === 'number' && Number.isFinite(value) && (a.type === 'double' || Number.isInteger(value))
      if (!ok) throw invalidType(a, a.type === 'integer' ? 'Value must be a valid integer' : 'Value must be a valid float')
      const min = a.min ?? (a.type === 'integer' ? Number.MIN_SAFE_INTEGER : -Number.MAX_VALUE)
      const max = a.max ?? (a.type === 'integer' ? Number.MAX_SAFE_INTEGER : Number.MAX_VALUE)
      if (value < min || value > max) {
        throw invalidType(a, `Value must be a valid range between ${fmt(min)} and ${fmt(max)}`)
      }
      return value
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw invalidType(a, 'Value must be a valid boolean')
      return value ? 1 : 0
    case 'datetime': {
      const date = normalizeDate(value)
      if (!date) throw invalidFormat(a, 'Value must be valid date between 0000-01-01 and 9999-12-31.')
      return date
    }
  }
}

/** Validate and encode one attribute value for storage. */
export function encodeValue(a: Attribute, value: unknown): SqlValue {
  if (value === null || value === undefined) {
    if (a.required) throw invalidStructure(`Missing required attribute "${a.key}"`)
    return null
  }
  if (a.array) {
    if (!Array.isArray(value)) throw invalidStructure(`Attribute "${a.key}" must be an array`)
    const items = value.map((v) => {
      if (v === null) return null
      const encoded = checkScalar(a, v)
      return a.type === 'boolean' ? Boolean(encoded) : encoded
    })
    return JSON.stringify(items)
  }
  return checkScalar(a, value)
}

/**
 * Encode the user attributes of `data`. On create every attribute gets a value
 * (its default when absent); on update only the keys present are touched.
 * Keys starting with `$` are left to the caller.
 */
export function encodeAttributes(collection: Collection, data: Record<string, unknown>, mode: 'create' | 'update'): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {}
  for (const key of Object.keys(data)) {
    if (key.startsWith('$')) continue
    if (!collection.attributeMap.has(key)) throw invalidStructure(`Unknown attribute: "${key}"`)
  }
  for (const a of collection.attributes) {
    if (key_in(data, a.key)) out[a.key] = encodeValue(a, data[a.key])
    else if (mode === 'create') out[a.key] = encodeValue(a, a.default ?? null)
  }
  return out
}

const key_in = (data: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined

export function decodeValue(a: Attribute, value: unknown): unknown {
  if (a.array) {
    if (value === null || value === undefined) return []
    try {
      return JSON.parse(value as string)
    } catch {
      return []
    }
  }
  if (value === null || value === undefined) return null
  if (a.type === 'boolean') return Boolean(value)
  return value
}

/** Turn a stored row into an Appwrite document, optionally keeping only `select` attributes. */
export function decodeRow(collection: Collection, row: Record<string, unknown>, select?: Set<string> | null): Doc {
  const doc: Doc = {
    $id: row._id as string,
    $sequence: String(row._seq),
    $collectionId: collection.id,
    $databaseId: collection.databaseId,
    $createdAt: row._createdAt as string,
    $updatedAt: row._updatedAt as string,
    $permissions: JSON.parse((row._permissions as string) || '[]'),
  }
  for (const a of collection.attributes) {
    if (select && !select.has(a.key)) continue
    doc[a.key] = decodeValue(a, row[a.key])
  }
  return doc
}
