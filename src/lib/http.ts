import { BunwriteError, err } from './errors'
import { sha256 } from './ids'

export type Params = Record<string, unknown>

/**
 * Keys that reach a prototype instead of a normal property. A query such as
 * `?__proto__[polluted]=1` would otherwise write to `Object.prototype` and
 * corrupt every later request in the process.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_DEPTH = 32

export const isUnsafeKey = (key: string): boolean => UNSAFE_KEYS.has(key)

/** A container that has no prototype chain for a `__proto__` write to corrupt. */
const bareObject = (): Params => Object.create(null) as Params

/**
 * Parse PHP-style bracket query strings the SDKs send for GET requests:
 * `queries[0]=..&queries[1]=..` becomes `{ queries: [.., ..] }`.
 */
export function parseSearchParams(search: URLSearchParams): Params {
  const out = bareObject()
  for (const [rawKey, value] of search) {
    const isPush = rawKey.endsWith('[]')
    const parts = (isPush ? rawKey.slice(0, -2) : rawKey).split(/\]?\[/).map((p) => p.replace(/\]$/, ''))
    // Refuse dangerous keys and pathologically deep input before building a tree.
    if (parts.length === 0 || parts.length > MAX_DEPTH || parts.some((part) => !part || isUnsafeKey(part))) continue
    let target: Record<string, unknown> = out
    parts.forEach((key, i) => {
      if (i === parts.length - 1) {
        if (isPush) {
          const list = Object.hasOwn(target, key) ? target[key] : undefined
          if (Array.isArray(list)) list.push(value)
          else target[key] = [value]
        } else target[key] = value
        return
      }
      const next = Object.hasOwn(target, key) ? target[key] : undefined
      if (next && typeof next === 'object') target = next as Record<string, unknown>
      else {
        target[key] = /^\d+$/.test(parts[i + 1]!) ? [] : bareObject()
        target = target[key] as Record<string, unknown>
      }
    })
  }
  return compactArrays(out) as Params
}

function compactArrays(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== undefined).map(compactArrays)
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      if (isUnsafeKey(k)) {
        delete (value as Record<string, unknown>)[k]
        continue
      }
      ;(value as Record<string, unknown>)[k] = compactArrays((value as Record<string, unknown>)[k])
    }
  }
  return value
}

/** Read the request's parameters: query string for GET, JSON or form body otherwise. */
export async function readParams(request: Request, url: URL): Promise<Params> {
  const query = parseSearchParams(url.searchParams)
  if (request.method === 'GET' || request.method === 'HEAD') return query
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    const text = await request.text()
    if (!text) return query
    try {
      const body = JSON.parse(text) as unknown
      if (!body || typeof body !== 'object' || Array.isArray(body)) return query
      // Keep `__proto__`/`constructor` from becoming request parameters.
      const safe = bareObject()
      for (const [key, value] of Object.entries(body)) if (!isUnsafeKey(key)) safe[key] = value
      return { ...query, ...safe }
    } catch {
      throw err('general_argument_invalid', 'Invalid JSON body.')
    }
  }
  if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
    const form = await request.formData()
    const body = bareObject()
    for (const [key, value] of form) {
      const k = key.endsWith('[]') ? key.slice(0, -2) : key
      if (!k || isUnsafeKey(k)) continue
      if (key.endsWith('[]')) {
        ;((body[k] as unknown[]) ??= []).push(value)
      } else body[k] = value
    }
    return { ...query, ...body }
  }
  return query
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const body = JSON.stringify(data)
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8', 'content-length': String(Buffer.byteLength(body)), ...headers },
  })
}

/** A weak validator: the tag names the collection version, caller and query that produced the body. */
export const etagFor = (tag: string): string => `W/"${sha256(tag)}"`

const opaqueTag = (value: string) => value.trim().replace(/^W\//, '')

/** Does the request's If-None-Match accept this ETag? `*` is ignored: a point read may not exist. */
export function ifNoneMatch(request: Request, etag: string): boolean {
  const header = request.headers.get('if-none-match')
  if (!header) return false
  const wanted = opaqueTag(etag)
  return header.split(',').some((part) => opaqueTag(part) === wanted)
}

export function notModified(etag: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 304, headers: { ...headers, etag } })
}

export function noContent(): Response {
  return new Response(null, { status: 204 })
}

export function errorResponse(error: unknown): Response {
  if (error instanceof BunwriteError) return json(error.toJSON(), error.code)
  console.error(error)
  return json(err('general_unknown', 'Server Error').toJSON(), 500)
}

/** SDKs send booleans in query strings as "true"/"false". */
export function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return value === 'true' || value === '1'
}

export function num(value: unknown, fallback?: number): number | undefined {
  if (value === undefined || value === null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** `queries` may arrive as an array of JSON strings, or already parsed. */
export function list(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'object') return Object.values(value)
  return [value]
}
