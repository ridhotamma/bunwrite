export type AttributeType = 'string' | 'integer' | 'double' | 'boolean' | 'datetime'

export interface Attribute {
  key: string
  type: AttributeType
  /** '', 'email', 'url', 'ip', 'enum' */
  format: string
  required: boolean
  array: boolean
  size?: number
  min?: number
  max?: number
  default: unknown
  elements?: string[]
  /**
   * Kept only so the API can return a column the way it was defined:
   * `appwrite push` recreates (drops) a column whose definition reads back
   * differently. `declaredType` is varchar/text/mediumtext/longtext/bigint.
   */
  encrypt?: boolean
  declaredType?: string
}

export interface Index {
  key: string
  type: 'key' | 'unique' | 'fulltext'
  attributes: string[]
  orders: string[]
}

export interface Collection {
  seq: number
  databaseId: string
  databaseSeq: number
  id: string
  name: string
  enabled: boolean
  documentSecurity: boolean
  permissions: string[]
  attributes: Attribute[]
  indexes: Index[]
  createdAt: string
  updatedAt: string
  /** Physical SQLite table holding the documents. */
  table: string
  /** Side table of (document, permission type, role) rows. */
  permsTable: string
  attributeMap: Map<string, Attribute>
}

export const tableName = (databaseSeq: number, collectionId: string) => `d${databaseSeq}_${collectionId}`
export const permsTableName = (table: string) => `${table}__perms`
export const ftsTableName = (table: string, indexKey: string) => `${table}__fts_${indexKey}`

/** Normalise an attribute definition from a project config file or the API. */
export function normalizeAttribute(raw: unknown): Attribute {
  if (!raw || typeof raw !== 'object') throw new Error('Attribute definitions must be objects.')
  const value = raw as Record<string, unknown>
  const rawType = typeof value.type === 'string' ? value.type : ''
  const key = typeof value.key === 'string' ? value.key : ''
  if (!key) throw new Error('Attribute definitions need a key.')
  let type: AttributeType
  switch (rawType) {
    case 'string':
    case 'varchar':
    case 'text':
    case 'mediumtext':
    case 'longtext':
    case 'email':
    case 'url':
    case 'ip':
    case 'enum':
      type = 'string'
      break
    case 'integer':
    case 'bigint':
      type = 'integer'
      break
    case 'double':
    case 'float':
      type = 'double'
      break
    case 'boolean':
      type = 'boolean'
      break
    case 'datetime':
      type = 'datetime'
      break
    default:
      throw new Error(`Unsupported attribute type "${rawType}" on "${key}"`)
  }
  const format = typeof value.format === 'string' && value.format ? value.format : ['email', 'url', 'ip', 'enum'].includes(rawType) ? rawType : ''
  const declaredType = typeof value.declaredType === 'string' ? value.declaredType : DECLARED_TYPES.includes(rawType) ? rawType : undefined
  return {
    key,
    type,
    format,
    required: Boolean(value.required),
    array: Boolean(value.array),
    size: typeof value.size === 'number' ? value.size : type === 'string' ? DEFAULT_STRING_SIZE : undefined,
    min: typeof value.min === 'number' ? value.min : undefined,
    max: typeof value.max === 'number' ? value.max : undefined,
    default: value.default ?? null,
    elements: Array.isArray(value.elements) ? (value.elements as string[]) : undefined,
    // Stored only when set, so definitions saved before this field compare equal.
    ...(value.encrypt === true ? { encrypt: true } : {}),
    ...(declaredType ? { declaredType } : {}),
  }
}

/**
 * An attribute as the project config file writes it, which is also what the API
 * returns. `appwrite push` compares type, size, format and encrypt with the
 * config and drops and recreates the column when they differ, so this mirrors
 * the definition: email, url, ip, enum and text columns show a size (and
 * encrypt) only when one was set.
 */
export function attributeDefinition(a: Attribute): Record<string, unknown> {
  const type = a.declaredType ?? a.type
  const out: Record<string, unknown> = { key: a.key, type, required: a.required, array: a.array }
  if (a.type === 'string') {
    const formatted = FORMATTED_STRINGS.includes(a.format)
    const sized = (!formatted && (type === 'string' || type === 'varchar')) || (a.size !== undefined && a.size !== DEFAULT_STRING_SIZE)
    if (formatted) out.format = a.format
    if (a.format === 'enum') out.elements = a.elements ?? []
    if (sized) out.size = a.size
    out.default = a.default ?? null
    if (sized || a.encrypt !== undefined) out.encrypt = a.encrypt ?? false
  } else if (a.type === 'integer' || a.type === 'double') {
    out.min = a.min ?? null
    out.max = a.max ?? null
    out.default = a.default ?? null
  } else if (a.type === 'datetime') {
    out.format = a.format
    out.default = a.default ?? null
  } else {
    out.default = a.default ?? null
  }
  return out
}

export const FORMATTED_STRINGS = ['email', 'url', 'ip', 'enum']

/** Size given to a string column defined without one (email, url, ip and enum columns). */
export const DEFAULT_STRING_SIZE = 16384
const DECLARED_TYPES = ['varchar', 'text', 'mediumtext', 'longtext', 'bigint']

export function normalizeIndex(raw: unknown): Index {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const type = value.type === 'unique' || value.type === 'fulltext' ? value.type : 'key'
  const attributes = Array.isArray(value.columns) ? value.columns : Array.isArray(value.attributes) ? value.attributes : []
  return {
    key: typeof value.key === 'string' ? value.key : '',
    type,
    attributes: attributes.map(String),
    orders: Array.isArray(value.orders) ? value.orders.map(String) : [],
  }
}
