/**
 * Appwrite list queries over small in-memory lists (buckets, webhooks, topics,
 * projects, policies). Supports what the SDKs and the CLI's paginator send:
 * limit, offset, cursorAfter/cursorBefore, equal/notEqual on a top-level field,
 * and orderAsc/orderDesc.
 */
import { err } from './errors'

interface Query {
  method: string
  attribute?: string
  values?: unknown[]
}

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 5000

function parse(raw: unknown): Query {
  try {
    const query = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Query
    if (!query || typeof query.method !== 'string') throw new Error()
    return query
  } catch {
    throw err('general_argument_invalid', `Invalid \`queries\` param: ${String(raw)}`)
  }
}

const field = (item: Record<string, unknown>, key: string) => item[key]

/** One page of `items` and the total that matched before limit and offset. */
export function page<T extends { $id: string }>(
  items: T[],
  rawQueries: unknown[],
  options: { search?: string; searchFields?: (keyof T & string)[] } = {},
): { total: number; items: T[] } {
  let rows = [...items]
  let limit = DEFAULT_LIMIT
  let offset = 0
  let after: string | undefined
  let before: string | undefined

  const term = options.search?.trim().toLowerCase()
  if (term) {
    const fields = options.searchFields ?? ['$id' as keyof T & string]
    rows = rows.filter((row) => fields.some((f) => String(field(row, f) ?? '').toLowerCase().includes(term)))
  }

  for (const query of rawQueries.map(parse)) {
    const value = query.values?.[0]
    switch (query.method) {
      case 'limit':
        limit = Math.min(MAX_LIMIT, Math.max(0, Number(value) || 0))
        break
      case 'offset':
        offset = Math.max(0, Number(value) || 0)
        break
      case 'cursorAfter':
        after = String(value)
        break
      case 'cursorBefore':
        before = String(value)
        break
      case 'equal':
        rows = rows.filter((row) => (query.values ?? []).some((v) => field(row, query.attribute!) === v))
        break
      case 'notEqual':
        rows = rows.filter((row) => !(query.values ?? []).some((v) => field(row, query.attribute!) === v))
        break
      case 'orderAsc':
      case 'orderDesc': {
        const key = query.attribute || '$id'
        const sign = query.method === 'orderAsc' ? 1 : -1
        rows.sort((a, b) => sign * String(field(a, key) ?? '').localeCompare(String(field(b, key) ?? ''), 'en', { numeric: true }))
        break
      }
      default:
        throw err('general_argument_invalid', `Invalid \`queries\` param: the ${query.method} query is not supported here.`)
    }
  }

  const total = rows.length
  if (after !== undefined) {
    const at = rows.findIndex((r) => r.$id === after)
    if (at < 0) throw err('general_cursor_not_found')
    rows = rows.slice(at + 1)
  }
  if (before !== undefined) {
    const at = rows.findIndex((r) => r.$id === before)
    if (at < 0) throw err('general_cursor_not_found')
    rows = rows.slice(Math.max(0, at - limit), at)
    return { total, items: rows }
  }
  return { total, items: rows.slice(offset, offset + limit) }
}
