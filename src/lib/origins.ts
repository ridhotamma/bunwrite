import { err } from './errors'

/** Does `origin` (or any URL) match the allowed list? `*.example.com` matches subdomains. */
export function originAllowed(origin: string, allowed: string[]): boolean {
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    return false
  }
  return allowed.some((pattern) => {
    if (pattern === '*') return true
    if (pattern.includes('://')) {
      try {
        return new URL(pattern).origin === new URL(origin).origin
      } catch {
        return false
      }
    }
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) || host === pattern.slice(2)
    return host === pattern
  })
}

/** Appwrite only redirects to hosts on the project's platform list. */
export function assertRedirect(url: unknown, allowed: string[], param: string): string {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url) || !originAllowed(url, allowed)) {
    throw err('general_argument_invalid', `Invalid \`${param}\` param: URL host must be one of: ${allowed.join(', ')}`)
  }
  return url
}

/** Append query parameters to a URL, keeping any it already has. */
export function withQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}
