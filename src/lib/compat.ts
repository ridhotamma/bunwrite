/**
 * Bunwrite's names on the wire, and the Appwrite adapter.
 *
 * The server always reads both families: `X-Bunwrite-*` and `X-Appwrite-*`
 * headers, `bw_session_<project>` and `a_session_<project>` cookies, so the
 * Bunwrite SDK and CLI and the Appwrite SDKs and CLI all work. The families may
 * be mixed in one request; the same header in both must carry the same value,
 * and an empty one counts as absent. A session cookie is named after the
 * request's own naming (its project header).
 * `API_COMPAT` picks the rest: webhook headers, the variables functions get,
 * and cookies for requests without a project header. Bunwrite's names are the
 * default; `appwrite` sends Appwrite's (and gives functions both sets of
 * variables).
 */
import type { Config } from '~/config'
import { err } from '~/lib/errors'

export type ApiCompat = 'bunwrite' | 'appwrite'

export const API_COMPATS: readonly ApiCompat[] = ['bunwrite', 'appwrite']

export function parseApiCompat(value: string | undefined): ApiCompat {
  const v = (value ?? '').trim().toLowerCase()
  if (!v) return 'bunwrite'
  if ((API_COMPATS as readonly string[]).includes(v)) return v as ApiCompat
  throw new Error(`API_COMPAT must be one of ${API_COMPATS.join(', ')}, not "${value}"`)
}

const compatOf = (config: Pick<Config, 'apiCompat'>): ApiCompat => config.apiCompat ?? 'bunwrite'

// ---- Requests: both families ----

/** A request header by its short name (`project`, `key`, ...): `X-Bunwrite-<name>`, else `X-Appwrite-<name>`; empty counts as absent. */
export function apiHeader(request: Request, name: string): string | null {
  return request.headers.get(`x-bunwrite-${name}`) || request.headers.get(`x-appwrite-${name}`)
}

/** Short names read through `apiHeader` that both families may carry. */
const COMPAT_HEADER_NAMES = ['project', 'key', 'session', 'jwt', 'organization', 'mode', 'id']

/** Refuse a request that gives one header two different values, so it cannot mean two things at once. */
export function assertCompatHeaders(request: Request): void {
  for (const name of COMPAT_HEADER_NAMES) {
    const bunwrite = request.headers.get(`x-bunwrite-${name}`) || null
    const appwrite = request.headers.get(`x-appwrite-${name}`) || null
    if (bunwrite && appwrite && bunwrite !== appwrite) {
      throw err('general_bad_request', `X-Bunwrite-${name} and X-Appwrite-${name} carry different values. Send one family, or the same value in both.`)
    }
  }
}

/** Headers carrying credentials, in both families; never handed on (function requests, logs). */
export const CREDENTIAL_HEADERS = ['key', 'session', 'jwt'].flatMap((n) => [`x-bunwrite-${n}`, `x-appwrite-${n}`])

/** Headers browsers may send cross-origin, for CORS: each short name in both families. */
export function corsHeaderNames(names: string[]): string {
  return names.flatMap((n) => [`X-Bunwrite-${n}`, `X-Appwrite-${n}`]).join(', ')
}

const SESSION_PREFIXES = ['bw_session_', 'a_session_']

/** The session secret for `scope` (a project ID, or `console`) from cookies or X-Fallback-Cookies, under either name. */
export function sessionFromCookies(cookies: Record<string, string>, fallbackHeader: string | null, scope: string): string | null {
  const names = SESSION_PREFIXES.map((p) => `${p}${scope.toLowerCase()}`)
  for (const name of names) if (cookies[name]) return cookies[name]!
  if (fallbackHeader) {
    try {
      const parsed = JSON.parse(fallbackHeader) as Record<string, string>
      for (const name of names) if (parsed[name]) return parsed[name]!
    } catch {
      /* ignore malformed fallback cookies */
    }
  }
  return null
}

// ---- Responses ----

/** The naming a request uses, from its project header; null when it sends none (e.g. `?project=`). */
export function requestNaming(request: Request): ApiCompat | null {
  if (request.headers.get('x-bunwrite-project')) return 'bunwrite'
  if (request.headers.get('x-appwrite-project')) return 'appwrite'
  return null
}

/**
 * The session cookie to set for `scope` (a project ID, or `console`). It follows
 * the request's naming, so Appwrite's SDKs and CLI get the `a_session_` cookie
 * they look for; without a project header, the configured mode decides.
 */
export function sessionCookieName(config: Pick<Config, 'apiCompat'>, request: Request, scope: string): string {
  const naming = requestNaming(request) ?? compatOf(config)
  return `${naming === 'appwrite' ? 'a_session_' : 'bw_session_'}${scope.toLowerCase()}`
}

/** Prefix of the headers on webhook deliveries: `x-bunwrite-webhook-` or `x-appwrite-webhook-`. */
export function webhookHeaderPrefix(config: Pick<Config, 'apiCompat'>): string {
  return `x-${compatOf(config)}-webhook-`
}

/** Those headers as they are written in prose and the console: `X-Bunwrite-Webhook`, `X-Appwrite-Webhook`. */
export function webhookHeaderName(config: Pick<Config, 'apiCompat'>): string {
  return compatOf(config) === 'appwrite' ? 'X-Appwrite-Webhook' : 'X-Bunwrite-Webhook'
}

/**
 * Variables for a function, given without prefix (`FUNCTION_ID`, `API_KEY`, ...):
 * `BUNWRITE_*`, plus `APPWRITE_*` in Appwrite mode.
 */
export function functionVariables(config: Pick<Config, 'apiCompat'>, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const prefixes = compatOf(config) === 'appwrite' ? ['APPWRITE_', 'BUNWRITE_'] : ['BUNWRITE_']
  for (const prefix of prefixes) for (const [k, v] of Object.entries(values)) out[prefix + k] = v
  return out
}

/** The project config file name this server writes and suggests. */
export function configFileName(config: Pick<Config, 'apiCompat'>): string {
  return compatOf(config) === 'appwrite' ? 'appwrite.config.json' : 'bunwrite.config.json'
}

/** The CLI this server suggests in messages. */
export function cliName(config: Pick<Config, 'apiCompat'>): string {
  return compatOf(config) === 'appwrite' ? 'appwrite' : 'bunwrite'
}
