/** One line per HTTP request on stdout, in text or JSON. */
import type { Server } from 'bun'

export type LogFormat = 'text' | 'json'

export interface RequestLog {
  id: string
  method: string
  path: string
  status: number
  durationMs: number
  requestBytes?: number
  responseBytes?: number
  ip?: string
  project?: string
  auth?: string
  referer?: string
  userAgent?: string
  error?: string
}

const clean = (value: string) => value.replace(/[\s\u0000-\u001f]+/g, '_')

export const truncate = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value)

/** Keep a proxy-provided ID when it is safe, otherwise make one. */
export function requestId(request: Request): string {
  const supplied = request.headers.get('x-request-id') ?? request.headers.get('cf-ray')
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID()
}

export function clientIp(request: Request, server?: Server<any>): string | undefined {
  const forwarded = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || server?.requestIP(request)?.address || undefined
}

const levelOf = (status: number) => (status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info')

export function formatRequestLog(entry: RequestLog, format: LogFormat): string {
  const time = new Date().toISOString()
  const duration = Math.round(entry.durationMs * 10) / 10
  if (format === 'json') {
    return JSON.stringify({ time, level: levelOf(entry.status), msg: 'request', ...entry, durationMs: duration })
  }
  const parts = [
    time,
    levelOf(entry.status).toUpperCase(),
    clean(entry.method),
    clean(entry.path),
    String(entry.status),
    `${duration.toFixed(1)}ms`,
    `req=${clean(entry.id)}`,
  ]
  if (entry.ip) parts.push(`ip=${clean(entry.ip)}`)
  if (entry.project) parts.push(`project=${clean(entry.project)}`)
  if (entry.auth) parts.push(`auth=${clean(entry.auth)}`)
  if (entry.error) parts.push(`error=${JSON.stringify(entry.error)}`)
  return parts.join(' ')
}

export function logRequest(entry: RequestLog, format: LogFormat): void {
  console.log(formatRequestLog(entry, format))
}
