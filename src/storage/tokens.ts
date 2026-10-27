/**
 * Signed links to one file. The console adds `token=` to view URLs of files
 * that are not public, so they open in any browser tab (or for whoever the
 * link is shared with) without a console session, until the token expires.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** How long a signed file link works. */
export const FILE_TOKEN_TTL = 24 * 3600

const signature = (secret: string, bucketId: string, fileId: string, exp: number) =>
  createHmac('sha256', secret).update(`bunwrite-file-token\n${bucketId}\n${fileId}\n${exp}`).digest('base64url')

export function fileToken(secret: string, bucketId: string, fileId: string, ttlSeconds = FILE_TOKEN_TTL, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSeconds
  return `${exp}.${signature(secret, bucketId, fileId, exp)}`
}

/** True when `token` was signed for this file with `secret` and has not expired. */
export function validFileToken(token: string | null | undefined, secret: string, bucketId: string, fileId: string, now = Date.now()): boolean {
  if (!token || !secret) return false
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token)
  if (!m) return false
  const exp = Number(m[1])
  if (exp < now / 1000) return false
  const expected = Buffer.from(signature(secret, bucketId, fileId, exp))
  const given = Buffer.from(m[2]!)
  return expected.length === given.length && timingSafeEqual(expected, given)
}
