import { AppwriteError, err } from './errors'

export type Params = Record<string, unknown>

/**
 * Parse PHP-style bracket query strings the SDKs send for GET requests:
 * `queries[0]=..&queries[1]=..` becomes `{ queries: [.., ..] }`.
 */
export function parseSearchParams(search: URLSearchParams): Params {
  const out: Params = {}
  for (const [rawKey, value] of search) {
    const isPush = rawKey.endsWith('[]')
    const parts = (isPush ? rawKey.slice(0, -2) : rawKey).split(/\]?\[/).map((p) => p.replace(/\]$/, ''))
    let target: any = out
    parts.forEach((key, i) => {
      if (i === parts.length - 1) {
        if (isPush) (target[key] ??= []).push(value)
        else target[key] = value
        return
      }
      target[key] ??= /^\d+$/.test(parts[i + 1]!) ? [] : {}
      target = target[key]
    })
  }
  return compactArrays(out) as Params
}

function compactArrays(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== undefined).map(compactArrays)
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) (value as any)[k] = compactArrays(v)
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
      const body = JSON.parse(text)
      return { ...query, ...(body && typeof body === 'object' ? body : {}) }
    } catch {
      throw err('general_argument_invalid', 'Invalid JSON body.')
    }
  }
  if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
    const form = await request.formData()
    const body: Params = {}
    for (const [key, value] of form) {
      if (key.endsWith('[]')) {
        const k = key.slice(0, -2)
        ;((body[k] as unknown[]) ??= []).push(value)
      } else body[key] = value
    }
    return { ...query, ...body }
  }
  return query
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8', ...headers },
  })
}

export function noContent(): Response {
  return new Response(null, { status: 204 })
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppwriteError) return json(error.toJSON(), error.code)
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
