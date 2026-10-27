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

/** Normalise an attribute definition from appwrite.config.json or the API. */
export function normalizeAttribute(raw: any): Attribute {
  let type: AttributeType
  switch (raw.type) {
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
      throw new Error(`Unsupported attribute type "${raw.type}" on "${raw.key}"`)
  }
  const format = raw.format || (['email', 'url', 'ip', 'enum'].includes(raw.type) ? raw.type : '')
  return {
    key: raw.key,
    type,
    format,
    required: Boolean(raw.required),
    array: Boolean(raw.array),
    size: raw.size ?? (type === 'string' ? 16384 : undefined),
    min: raw.min ?? undefined,
    max: raw.max ?? undefined,
    default: raw.default ?? null,
    elements: raw.elements ?? undefined,
  }
}

export function normalizeIndex(raw: any): Index {
  return {
    key: raw.key,
    type: raw.type,
    attributes: raw.columns ?? raw.attributes ?? [],
    orders: raw.orders ?? [],
  }
}
