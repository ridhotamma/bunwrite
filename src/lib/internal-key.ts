/**
 * Per-function internal API keys.
 *
 * The server used to hand every function one project-wide key with no scopes,
 * so a function configured with `scopes: ["users.read"]` could still delete
 * collections. A function key now carries its allowed scopes in a signed
 * payload: the function can read the key, but cannot widen its own access
 * without the server secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

const PREFIX = 'internal_fn_'

function signature(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`function-key:${payload}`).digest('base64url')
}

export function scopedFunctionKey(secret: string, functionId: string, scopes: string[]): string {
  const payload = Buffer.from(JSON.stringify({ f: functionId, s: [...new Set(scopes)].sort() })).toString('base64url')
  return `${PREFIX}${payload}.${signature(secret, payload)}`
}

/** The scopes carried by a function key, or null when it is not one of ours. */
export function parseScopedFunctionKey(secret: string, key: string): { functionId: string; scopes: string[] } | null {
  if (!secret || !key.startsWith(PREFIX)) return null
  const rest = key.slice(PREFIX.length)
  const dot = rest.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = rest.slice(0, dot)
  const provided = rest.slice(dot + 1)
  const expected = signature(secret, payload)
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { f?: unknown; s?: unknown }
    if (typeof parsed.f !== 'string' || !Array.isArray(parsed.s)) return null
    return { functionId: parsed.f, scopes: parsed.s.filter((scope): scope is string => typeof scope === 'string') }
  } catch {
    return null
  }
}
