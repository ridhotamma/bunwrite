/**
 * Signed, short-lived `state` values for the GitHub round trips (app creation
 * and app installation), so a callback only acts on what this server started.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

const sign = (secret: string, body: string) => createHmac('sha256', secret).update(`bunwrite-vcs-state\n${body}`).digest('base64url')

/** `payload` plus an expiry, as `<base64url json>.<hmac>`. */
export function signState(secret: string, payload: Record<string, unknown>, ttlSeconds = 3600): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url')
  return `${body}.${sign(secret, body)}`
}

/** The payload of a state made by signState, or null when it is forged or expired. */
export function readState<T extends Record<string, unknown>>(secret: string, state: string | null | undefined): T | null {
  if (!state) return null
  const [body, mac] = state.split('.')
  if (!body || !mac) return null
  const expected = Buffer.from(sign(secret, body))
  const given = Buffer.from(mac)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number }
    if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null
    return payload
  } catch {
    return null
  }
}
