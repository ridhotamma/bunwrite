/**
 * Parse Appwrite queries (`{"method":"equal","attribute":"x","values":[..]}`)
 * and compile them to SQLite, matching what pesanle sees from Appwrite:
 * `equal` is exact, `contains`/`startsWith` ignore ASCII case, `search` matches
 * whole words with OR between words, and values must match the column type.
 */
import { q } from '../db/connection'
import { normalizeDate } from '../lib/datetime'
import { invalidQuery } from '../lib/errors'
import { ftsTableName, type Attribute, type Collection } from '../schema/types'
import type { SqlValue } from './codec'

export interface Query {
  method: string
  attribute?: string
  values?: unknown[]
}

export interface Order {
  column: string
  desc: boolean
  /** Compare case-insensitively, like the PostgreSQL locale collation Appwrite sorts text with. */
  nocase?: boolean
}

const orderExpr = (o: Order) => `t.${q(o.column)}${o.nocase ? ' COLLATE NOCASE' : ''}`
export { orderExpr }

export interface Compiled {
  where: string[]
  params: SqlValue[]
  orders: Order[]
  random: boolean
  limit: number
  offset: number
  cursor: { id: string; before: boolean } | null
  select: Set<string> | null
}

const FILTERS = new Set([
  'equal', 'notEqual', 'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual',
  'between', 'notBetween', 'isNull', 'isNotNull', 'startsWith', 'notStartsWith',
  'endsWith', 'notEndsWith', 'contains', 'containsAny', 'containsAll', 'notContains',
  'search', 'notSearch', 'and', 'or',
])
const OTHERS = new Set(['select', 'limit', 'offset', 'cursorAfter', 'cursorBefore', 'orderAsc', 'orderDesc', 'orderRandom'])

/** System attributes and the columns behind them. */
const SYSTEM: Record<string, { column: string; type: 'string' | 'integer' | 'datetime' }> = {
  $id: { column: '_id', type: 'string' },
  $sequence: { column: '_seq', type: 'integer' },
  $createdAt: { column: '_createdAt', type: 'datetime' },
  $updatedAt: { column: '_updatedAt', type: 'datetime' },
}

export const DEFAULT_LIMIT = 25

export function parseQueries(raw: unknown[]): Query[] {
  return raw.map((item) => {
    let value: unknown = item
    if (typeof item === 'string') {
      try {
        value = JSON.parse(item)
      } catch {
        throw invalidQuery('Syntax error')
      }
    }
    if (!value || typeof value !== 'object' || typeof (value as Query).method !== 'string') {
      throw invalidQuery('Syntax error')
    }
    const query = value as Query
    if (!FILTERS.has(query.method) && !OTHERS.has(query.method)) {
      throw invalidQuery(`Invalid query method: ${query.method}`)
    }
    return query
  })
}

interface Target {
  column: string
  type: Attribute['type']
  array: boolean
  key: string
}

function target(collection: Collection, key: string | undefined): Target {
  if (!key) throw invalidQuery('Attribute not found in schema: ')
  const system = SYSTEM[key]
  if (system) return { column: system.column, type: system.type, array: false, key }
  const a = collection.attributeMap.get(key)
  if (!a) throw invalidQuery(`Attribute not found in schema: ${key}`)
  return { column: a.key, type: a.type, array: a.array, key }
}

function castValue(t: Target, value: unknown): SqlValue {
  const bad = () => invalidQuery(`Query value is invalid for attribute "${t.key}"`)
  switch (t.type) {
    case 'string':
      if (typeof value !== 'string') throw bad()
      return value
    case 'integer':
      if (t.key === '$sequence' && typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
      if (typeof value !== 'number' || !Number.isInteger(value)) throw bad()
      return value
    case 'double':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad()
      return value
    case 'boolean':
      if (typeof value !== 'boolean') throw bad()
      return value ? 1 : 0
    case 'datetime': {
      const date = normalizeDate(value)
      if (!date) throw bad()
      return date
    }
  }
}

const like = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c)
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ')

/** FTS5 match expression: every word quoted, OR between words. */
function ftsExpression(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}]+/gu)
  if (!words || words.length === 0) return null
  return words.map((w) => `"${w}"`).join(' OR ')
}

function compileFilter(collection: Collection, query: Query, params: SqlValue[]): string {
  const values = query.values ?? []
  const m = query.method

  if (m === 'and' || m === 'or') {
    if (values.length === 0) throw invalidQuery(`${m === 'and' ? 'And' : 'Or'} queries require at least one query.`)
    const parts = parseQueries(values).map((nested) => {
      if (!FILTERS.has(nested.method)) throw invalidQuery(`Nested queries can only be filters, got ${nested.method}.`)
      return compileFilter(collection, nested, params)
    })
    return `(${parts.join(m === 'and' ? ' AND ' : ' OR ')})`
  }

  const t = target(collection, query.attribute)
  const col = `t.${q(t.column)}`
  const one = () => {
    if (values.length === 0) throw invalidQuery(`${m} queries require at least one value.`)
    return castValue(t, values[0])
  }

  switch (m) {
    case 'equal':
    case 'notEqual': {
      if (values.length === 0) throw invalidQuery(`${m === 'equal' ? 'Equal' : 'NotEqual'} queries require at least one value.`)
      const cast = values.map((v) => castValue(t, v))
      params.push(...cast)
      if (t.array) {
        const sql = `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value IN (${placeholders(cast.length)}))`
        return m === 'equal' ? sql : `NOT ${sql}`
      }
      if (cast.length === 1) return `${col} ${m === 'equal' ? '=' : '!='} ?`
      return `${col} ${m === 'equal' ? 'IN' : 'NOT IN'} (${placeholders(cast.length)})`
    }
    case 'lessThan':
    case 'lessThanEqual':
    case 'greaterThan':
    case 'greaterThanEqual': {
      const op = { lessThan: '<', lessThanEqual: '<=', greaterThan: '>', greaterThanEqual: '>=' }[m]
      params.push(one())
      return `${col} ${op} ?`
    }
    case 'between':
    case 'notBetween': {
      if (values.length < 2) throw invalidQuery(`${m} queries require exactly two values.`)
      params.push(castValue(t, values[0]), castValue(t, values[1]))
      return `${col} ${m === 'between' ? 'BETWEEN' : 'NOT BETWEEN'} ? AND ?`
    }
    case 'isNull':
      return `${col} IS NULL`
    case 'isNotNull':
      return `${col} IS NOT NULL`
    case 'startsWith':
    case 'notStartsWith':
    case 'endsWith':
    case 'notEndsWith': {
      if (t.type !== 'string') throw invalidQuery(`Cannot query ${m} on attribute "${t.key}" because it is not a string.`)
      const v = one() as string
      params.push(m.toLowerCase().includes('startswith') ? `${like(v)}%` : `%${like(v)}`)
      return `${col} ${m.startsWith('not') ? 'NOT LIKE' : 'LIKE'} ? ESCAPE '\\'`
    }
    case 'contains':
    case 'containsAny':
    case 'containsAll':
    case 'notContains': {
      if (values.length === 0) throw invalidQuery(`${m} queries require at least one value.`)
      if (t.array) {
        const cast = values.map((v) => castValue(t, v))
        if (m === 'containsAll') {
          params.push(...cast)
          return `(${cast.map(() => `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ?)`).join(' AND ')})`
        }
        params.push(...cast)
        const sql = `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value IN (${placeholders(cast.length)}))`
        return m === 'notContains' ? `NOT ${sql}` : sql
      }
      if (t.type !== 'string') {
        throw invalidQuery(`Cannot query contains on attribute "${t.key}" because it is not an array or string.`)
      }
      const parts = values.map((v) => {
        params.push(`%${like(castValue(t, v) as string)}%`)
        return `${col} LIKE ? ESCAPE '\\'`
      })
      const joined = `(${parts.join(m === 'containsAll' ? ' AND ' : ' OR ')})`
      return m === 'notContains' ? `NOT ${joined}` : joined
    }
    case 'search':
    case 'notSearch': {
      const index = collection.indexes.find((i) => i.type === 'fulltext' && i.attributes.includes(t.key))
      if (!index) throw invalidQuery(`Searching by attribute "${t.key}" requires a fulltext index.`)
      const expr = ftsExpression(String(one()))
      if (!expr) return m === 'search' ? '0' : '1'
      const fts = q(ftsTableName(collection.table, index.key))
      params.push(index.attributes.length > 1 ? `{${t.key}} : (${expr})` : expr)
      return `t._seq ${m === 'search' ? 'IN' : 'NOT IN'} (SELECT rowid FROM ${fts} WHERE ${fts} MATCH ?)`
    }
  }
  throw invalidQuery(`Invalid query method: ${m}`)
}

/** Compile queries. Filters land in `where`/`params`; the rest is returned as settings. */
export function compileQueries(collection: Collection, queries: Query[]): Compiled {
  const out: Compiled = {
    where: [],
    params: [],
    orders: [],
    random: false,
    limit: DEFAULT_LIMIT,
    offset: 0,
    cursor: null,
    select: null,
  }
  for (const query of queries) {
    const values = query.values ?? []
    switch (query.method) {
      case 'select': {
        if (values.length === 0) throw invalidQuery('Select queries require at least one attribute.')
        const keys = new Set<string>()
        for (const v of values) {
          if (typeof v !== 'string') throw invalidQuery('Select queries must contain attribute names.')
          if (v === '*') {
            out.select = null
            break
          }
          if (!SYSTEM[v] && v !== '$permissions' && v !== '$collectionId' && v !== '$databaseId' && !collection.attributeMap.has(v)) {
            throw invalidQuery(`Attribute not found in schema: ${v}`)
          }
          keys.add(v)
        }
        if (!values.includes('*')) out.select = keys
        break
      }
      case 'limit': {
        const n = values[0]
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
          throw invalidQuery('Invalid limit: Value must be a valid range between 1 and 9,223,372,036,854,775,807')
        }
        out.limit = n
        break
      }
      case 'offset': {
        const n = values[0]
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
          throw invalidQuery('Invalid offset: Value must be a valid range between 0 and 9,223,372,036,854,775,807')
        }
        out.offset = n
        break
      }
      case 'cursorAfter':
      case 'cursorBefore': {
        const id = values[0]
        if (typeof id !== 'string' || !id) throw invalidQuery('Invalid cursor: Cursor must be a document ID.')
        out.cursor = { id, before: query.method === 'cursorBefore' }
        break
      }
      case 'orderAsc':
      case 'orderDesc': {
        const t = query.attribute ? target(collection, query.attribute) : { column: '_seq', array: false, key: '$sequence', type: 'integer' as const }
        if (t.array) throw invalidQuery(`Cannot order by array attribute "${t.key}".`)
        out.orders.push({ column: t.column, desc: query.method === 'orderDesc', nocase: t.type === 'string' && t.column !== '_id' })
        break
      }
      case 'orderRandom':
        out.random = true
        break
      default:
        out.where.push(compileFilter(collection, query, out.params))
    }
  }
  if (out.random && out.cursor) throw invalidQuery('Random order cannot be combined with cursors.')
  return out
}

/**
 * Keyset condition for rows strictly after `row` in `orders` (already flipped
 * for cursorBefore). SQLite sorts NULL first ascending, as MariaDB does.
 */
export function cursorCondition(orders: Order[], row: Record<string, unknown>, params: SqlValue[]): string {
  const ors: string[] = []
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i]!
    const v = row[o.column] as SqlValue
    // Nothing sorts after NULL when descending.
    if ((v === null || v === undefined) && o.desc) continue
    const ands: string[] = []
    const groupParams: SqlValue[] = []
    for (let j = 0; j < i; j++) {
      const prev = orders[j]!
      const pv = row[prev.column] as SqlValue
      if (pv === null || pv === undefined) ands.push(`t.${q(prev.column)} IS NULL`)
      else {
        ands.push(`${orderExpr(prev)} = ?`)
        groupParams.push(pv)
      }
    }
    const col = orderExpr(o)
    if (v === null || v === undefined) {
      ands.push(`t.${q(o.column)} IS NOT NULL`)
    } else if (o.desc) {
      ands.push(`(${col} < ? OR t.${q(o.column)} IS NULL)`)
      groupParams.push(v)
    } else {
      ands.push(`${col} > ?`)
      groupParams.push(v)
    }
    ors.push(`(${ands.join(' AND ')})`)
    params.push(...groupParams)
  }
  return ors.length ? `(${ors.join(' OR ')})` : '0'
}
