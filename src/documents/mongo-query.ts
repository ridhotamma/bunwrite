/**
 * Appwrite queries → MongoDB filters.
 *
 * MongoDB cannot execute the SQL the query compiler produces, so this is a
 * separate compiler for the same query language. It validates against the
 * collection schema the same way (`equal`, ranges, `contains`, `search`, …)
 * and returns a filter plus sort/skip/limit/projection for the driver.
 *
 * Documents are stored natively: booleans as booleans, arrays as arrays,
 * `_permissions` as an array of permission strings. That is what makes `$in`
 * and text/regex queries possible; the SQL codec is not involved.
 */
import type { Caller } from '~/auth/caller'
import { grants } from '~/auth/permissions'
import { normalizeDate } from '~/lib/datetime'
import { err, invalidQuery } from '~/lib/errors'
import type { Attribute, Collection } from '~/schema/types'
import { DEFAULT_LIMIT, parseQueries, type Query } from './query'

export type MongoFilter = Record<string, unknown>

export interface MongoPlan {
  filter: MongoFilter
  sort?: Record<string, 1 | -1>
  skip: number
  limit: number
  projection?: Record<string, 0 | 1>
  cursor: { id: string; before: boolean } | null
  random: boolean
}

const SYSTEM: Record<string, string> = {
  $id: '_id',
  $sequence: '_seq',
  $createdAt: '_createdAt',
  $updatedAt: '_updatedAt',
}

interface Target {
  field: string
  attribute?: Attribute
}

function target(collection: Collection, key: string | undefined): Target {
  if (!key) throw invalidQuery('Attribute not found in schema: ')
  const field = SYSTEM[key]
  if (field) return { field }
  const attribute = collection.attributeMap.get(key)
  if (!attribute) throw invalidQuery(`Attribute not found in schema: ${key}`)
  return { field: attribute.key, attribute }
}

function castValue(t: Target, value: unknown): unknown {
  if (!t.attribute) {
    if (t.field === '_seq') {
      if (typeof value === 'number' && Number.isInteger(value)) return value
      if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
      throw invalidQuery('Query value is invalid for attribute "$sequence"')
    }
    if (typeof value !== 'string') throw invalidQuery(`Query value is invalid for attribute "${t.field}"`)
    return value
  }
  const a = t.attribute
  const bad = () => invalidQuery(`Query value is invalid for attribute "${a.key}"`)
  switch (a.type) {
    case 'string':
      if (typeof value !== 'string') throw bad()
      return value
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) throw bad()
      return value
    case 'double':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad()
      return value
    case 'boolean':
      if (typeof value !== 'boolean') throw bad()
      return value
    case 'datetime': {
      const date = normalizeDate(value)
      if (!date) throw bad()
      return date
    }
  }
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const words = (value: string) => value.match(/[\p{L}\p{N}]+/gu) ?? []

/** A filter that matches nothing, used for an empty search. */
const NONE: MongoFilter = { _id: { $exists: false } }

function compileFilter(collection: Collection, query: Query): MongoFilter {
  const values = query.values ?? []
  const m = query.method

  if (m === 'and' || m === 'or') {
    if (values.length === 0) throw invalidQuery(`${m === 'and' ? 'And' : 'Or'} queries require at least one query.`)
    const parts = parseQueries(values).map((nested) => {
      if (!nested.method || ['select', 'limit', 'offset', 'cursorAfter', 'cursorBefore', 'orderAsc', 'orderDesc', 'orderRandom'].includes(nested.method)) {
        throw invalidQuery(`Nested queries can only be filters, got ${nested.method}.`)
      }
      return compileFilter(collection, nested)
    })
    return { [m === 'and' ? '$and' : '$or']: parts }
  }

  const t = target(collection, query.attribute)
  const one = () => {
    if (values.length === 0) throw invalidQuery(`${m} queries require at least one value.`)
    return castValue(t, values[0])
  }
  const f = t.field

  switch (m) {
    case 'equal':
    case 'notEqual': {
      if (values.length === 0) throw invalidQuery(`${m === 'equal' ? 'Equal' : 'NotEqual'} queries require at least one value.`)
      const cast = values.map((value) => castValue(t, value))
      return { [f]: { [m === 'equal' ? '$in' : '$nin']: cast } }
    }
    case 'lessThan':
    case 'lessThanEqual':
    case 'greaterThan':
    case 'greaterThanEqual': {
      const op = { lessThan: '$lt', lessThanEqual: '$lte', greaterThan: '$gt', greaterThanEqual: '$gte' }[m]!
      return { [f]: { [op]: one() } }
    }
    case 'between':
    case 'notBetween': {
      if (values.length < 2) throw invalidQuery(`${m} queries require exactly two values.`)
      const [low, high] = [castValue(t, values[0]), castValue(t, values[1])]
      return m === 'between'
        ? { [f]: { $gte: low, $lte: high } }
        : { $or: [{ [f]: { $lt: low } }, { [f]: { $gt: high } }] }
    }
    case 'isNull':
      return { [f]: null }
    case 'isNotNull':
      return { [f]: { $ne: null } }
    case 'startsWith':
    case 'notStartsWith':
    case 'endsWith':
    case 'notEndsWith': {
      if (t.attribute && t.attribute.type !== 'string') throw invalidQuery(`Cannot query ${m} on attribute "${t.attribute.key}" because it is not a string.`)
      const value = String(one())
      const pattern = m.toLowerCase().includes('startswith') ? `^${escapeRegex(value)}` : `${escapeRegex(value)}$`
      return m.startsWith('not') ? { [f]: { $not: { $regex: pattern, $options: 'i' } } } : { [f]: { $regex: pattern, $options: 'i' } }
    }
    case 'contains':
    case 'containsAny':
    case 'containsAll':
    case 'notContains': {
      if (values.length === 0) throw invalidQuery(`${m} queries require at least one value.`)
      const cast = values.map((value) => castValue(t, value))
      if (t.attribute?.array) {
        if (m === 'containsAll') return { [f]: { $all: cast } }
        return { [f]: { [m === 'notContains' ? '$nin' : '$in']: cast } }
      }
      if (t.attribute && t.attribute.type !== 'string') {
        throw invalidQuery(`Cannot query contains on attribute "${t.attribute.key}" because it is not an array or string.`)
      }
      const patterns = cast.map((value) => ({ [f]: { $regex: escapeRegex(String(value)), $options: 'i' } }))
      const joined: MongoFilter = m === 'containsAll' ? { $and: patterns } : { $or: patterns }
      return m === 'notContains' ? { $nor: patterns } : joined
    }
    case 'search':
    case 'notSearch': {
      const index = collection.indexes.find((i) => i.type === 'fulltext' && t.attribute && i.attributes.includes(t.attribute.key))
      if (!index) throw invalidQuery(`Searching by attribute "${t.attribute?.key ?? t.field}" requires a fulltext index.`)
      const tokens = words(String(one()))
      if (tokens.length === 0) return m === 'search' ? NONE : {}
      if (m === 'search') return { $text: { $search: tokens.join(' ') } }
      // `$text` cannot appear under `$nor`; a word-boundary regex is the
      // portable approximation for "does not match any of these words".
      const pattern = tokens.map(escapeRegex).join('|')
      return { [f]: { $not: { $regex: pattern, $options: 'i' } } }
    }
  }
  throw invalidQuery(`Invalid query method: ${m}`)
}

/** Compile the filter/order/page parts of a list request. */
export function compileMongoQueries(collection: Collection, rawQueries: unknown[]): MongoPlan {
  const plan: MongoPlan = { filter: {}, skip: 0, limit: DEFAULT_LIMIT, cursor: null, random: false }
  for (const query of parseQueries(rawQueries)) {
    const values = query.values ?? []
    switch (query.method) {
      case 'select': {
        if (values.length === 0) throw invalidQuery('Select queries require at least one attribute.')
        const fields: Record<string, 0 | 1> = { _id: 1, _seq: 1, _createdAt: 1, _updatedAt: 1, _permissions: 1, _rev: 1 }
        for (const value of values) {
          if (value === '*') {
            plan.projection = undefined
            fields._id = 1
            break
          }
          if (typeof value !== 'string') throw invalidQuery('Select queries must contain attribute names.')
          const t = target(collection, value)
          fields[t.field] = 1
        }
        if (!values.includes('*')) plan.projection = fields
        break
      }
      case 'limit': {
        const n = values[0]
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw invalidQuery('Invalid limit: Value must be a valid range between 1 and 9,223,372,036,854,775,807')
        plan.limit = n
        break
      }
      case 'offset': {
        const n = values[0]
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw invalidQuery('Invalid offset: Value must be a valid range between 0 and 9,223,372,036,854,775,807')
        plan.skip = n
        break
      }
      case 'cursorAfter':
      case 'cursorBefore': {
        const id = values[0]
        if (typeof id !== 'string' || !id) throw invalidQuery('Invalid cursor: Cursor must be a document ID.')
        plan.cursor = { id, before: query.method === 'cursorBefore' }
        break
      }
      case 'orderAsc':
      case 'orderDesc': {
        const t = query.attribute ? target(collection, query.attribute) : { field: '_seq' }
        if (t.attribute?.array) throw invalidQuery(`Cannot order by array attribute "${t.attribute.key}".`)
        plan.sort = { ...(plan.sort ?? {}), [t.field]: query.method === 'orderAsc' ? 1 : -1 }
        break
      }
      case 'orderRandom':
        plan.random = true
        break
      default: {
        const filter = compileFilter(collection, query)
        plan.filter = Object.keys(plan.filter).length === 0 ? filter : { $and: [plan.filter, filter] }
      }
    }
  }
  if (plan.random && plan.cursor) throw invalidQuery('Random order cannot be combined with cursors.')
  return plan
}

/**
 * The permission filter for reads, or null when the collection grants read to
 * one of the caller's roles (or the caller is privileged).
 */
export function mongoReadFilter(caller: Caller, collection: Collection): MongoFilter | null {
  if (caller.privileged || grants(collection.permissions, 'read', caller.roles)) return null
  if (!collection.documentSecurity) throw err('user_unauthorized')
  return { _permissions: { $in: [...caller.roles].map((role) => `read("${role}")`) } }
}

/**
 * Keyset condition after `row` in `sort` order. Mirrors the SQL cursor
 * semantics: compare the tuple of preceding sort keys for equality and the
 * next key for a strict ordering, OR-ing the positions.
 */
export function mongoCursorFilter(sort: Record<string, 1 | -1>, row: Record<string, unknown>, before: boolean): MongoFilter | null {
  const keys = Object.keys(sort)
  if (keys.length === 0) return null
  const dir = (key: string) => (before ? -sort[key]! : sort[key]!) as 1 | -1
  const ors: MongoFilter[] = []
  for (let i = 0; i < keys.length; i++) {
    const ands: MongoFilter[] = []
    for (let j = 0; j < i; j++) ands.push({ [keys[j]!]: row[keys[j]!] })
    const value = row[keys[i]!]
    if (value === null || value === undefined) continue
    ands.push({ [keys[i]!]: { [dir(keys[i]!) === 1 ? '$gt' : '$lt']: value } })
    ors.push(ands.length === 1 ? ands[0]! : { $and: ands })
  }
  return ors.length ? { $or: ors } : null
}
