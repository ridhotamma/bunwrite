/** HS256 JWTs for `account.createJWT` / `users.createJWT`. */

export interface JwtClaims {
  userId: string
  sessionId: string
  exp: number
}

const encoder = new TextEncoder()
const b64url = (data: Uint8Array | string) =>
  Buffer.from(typeof data === 'string' ? encoder.encode(data) : data).toString('base64url')

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)))
}

export async function signJwt(claims: Omit<JwtClaims, 'exp'>, secret: string, ttlSeconds = 900): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds }))
  const signature = b64url(await hmac(secret, `${header}.${payload}`))
  return `${header}.${payload}.${signature}`
}

export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  const [header, payload, signature] = token.split('.')
  if (!header || !payload || !signature) return null
  const expected = b64url(await hmac(secret, `${header}.${payload}`))
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return null
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as JwtClaims
    if (typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000) return null
    return claims
  } catch {
    return null
  }
}
