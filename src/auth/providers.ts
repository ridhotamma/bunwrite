/**
 * OAuth provider adapters, following Appwrite's providers:
 * https://github.com/appwrite/appwrite/tree/main/src/Appwrite/Auth/OAuth2
 *
 * Each adapter exchanges the authorization code for tokens and returns the
 * provider account's ID, email, name and whether the provider verified the
 * email. Endpoints and scopes live in OAUTH_PROVIDERS (config.ts).
 */
import type { OAuthConfig, OAuthProviderId } from '~/config'
import { pemFrom } from '~/config'
import { BunwriteError, err } from '~/lib/errors'

export interface OAuthTokens {
  access_token: string
  refresh_token?: string
  expires_in?: number | string
  id_token?: string
}

export interface OAuthIdentity {
  uid: string
  email: string
  name: string
  emailVerified: boolean
}

export interface OAuthProvider {
  /** Extra authorize parameters: Apple posts the callback, Google asks for offline access. */
  authorize?(url: URL): void
  exchange(config: OAuthConfig, code: string, callback: string): Promise<OAuthTokens>
  identity(config: OAuthConfig, tokens: OAuthTokens, user: unknown): Promise<OAuthIdentity>
}

const verified = (value: unknown) => value === true || value === 'true'

async function requestJson<T = Record<string, any>>(url: string | URL, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw err('user_oauth2_provider_error', 'Could not reach the OAuth2 provider.')
  }
  const text = await response.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    // GitHub's token endpoint answers form-encoded when something goes wrong.
    body = text.includes('=') ? Object.fromEntries(new URLSearchParams(text)) : {}
  }
  if (!response.ok) throw err('user_oauth2_provider_error', `The OAuth2 provider answered ${response.status}.`)
  return body as T
}

async function postForm(url: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<Record<string, any>> {
  return requestJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
  })
}

function tokenError(body: Record<string, any>): never {
  const detail = typeof body.error_description === 'string' ? body.error_description : typeof body.error === 'string' ? body.error : ''
  throw err('user_oauth2_provider_error', detail || 'Failed to obtain access token.')
}

const email = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : '')
const text = (value: unknown) => (typeof value === 'string' ? value : '')

const b64url = (value: string | Uint8Array) => Buffer.from(value).toString('base64url')

function jwtClaims(token: string | undefined): Record<string, any> {
  const payload = token?.split('.')[1]
  if (!payload) return {}
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, any>
  } catch {
    return {}
  }
}

function derFromPem(pem: string): ArrayBuffer {
  const body = pemFrom(pem)
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s+/g, '')
  const bytes = Buffer.from(body, 'base64')
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** The ES256 JWT Apple accepts as a client secret; it is signed with the .p8 key. */
export async function appleClientSecret(config: OAuthConfig): Promise<string> {
  if (!config.teamId || !config.keyId || !config.privateKey) {
    throw err('user_oauth2_provider_error', 'Apple sign-in needs a team ID, key ID and .p8 private key.')
  }
  let signature: ArrayBuffer
  try {
    const key = await crypto.subtle.importKey('pkcs8', derFromPem(config.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    const now = Math.floor(Date.now() / 1000)
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }))
    const claims = b64url(
      JSON.stringify({ iss: config.teamId, iat: now, exp: now + 180 * 86400, aud: 'https://appleid.apple.com', sub: config.clientId }),
    )
    signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${header}.${claims}`))
    return `${header}.${claims}.${b64url(new Uint8Array(signature))}`
  } catch (error) {
    if (error instanceof BunwriteError) throw error
    throw err('user_oauth2_provider_error', 'The Apple private key is not a valid .p8 key.')
  }
}

/** Apple posts `user` only on the first authorization: {"name":{"firstName":"..","lastName":".."}}. */
function appleName(user: unknown): string {
  if (!user || typeof user !== 'object') return ''
  const name = (user as { name?: { firstName?: unknown; lastName?: unknown } }).name
  return [name?.firstName, name?.lastName].filter((part): part is string => typeof part === 'string' && part.trim() !== '').join(' ')
}

const providers: Record<OAuthProviderId, OAuthProvider> = {
  google: {
    authorize(url) {
      url.searchParams.set('access_type', 'offline')
      url.searchParams.set('prompt', 'consent')
    },
    async exchange(config, code, callback) {
      const body = await postForm(config.tokenUrl!, {
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: callback,
        grant_type: 'authorization_code',
      })
      if (!body.access_token) tokenError(body)
      return body as OAuthTokens
    },
    async identity(config, tokens) {
      const info = await requestJson(`${config.userinfoUrl}?access_token=${encodeURIComponent(tokens.access_token)}`)
      return {
        uid: text(info.sub),
        email: email(info.email),
        name: text(info.name),
        emailVerified: verified(info.email_verified),
      }
    },
  },

  facebook: {
    async exchange(config, code, callback) {
      const url = new URL(config.tokenUrl!)
      url.searchParams.set('client_id', config.clientId)
      url.searchParams.set('redirect_uri', callback)
      url.searchParams.set('client_secret', config.clientSecret)
      url.searchParams.set('code', code)
      const body = await requestJson(url)
      if (!body.access_token) tokenError(body)
      return body as OAuthTokens
    },
    async identity(config, tokens) {
      const url = new URL(config.userinfoUrl!)
      url.searchParams.set('access_token', tokens.access_token)
      const info = await requestJson(url)
      return {
        uid: text(info.id),
        email: email(info.email),
        name: text(info.name),
        // Facebook exposes no email-verification signal, as in Appwrite.
        emailVerified: false,
      }
    },
  },

  github: {
    async exchange(config, code, callback) {
      const body = await postForm(
        config.tokenUrl!,
        { client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: callback },
        { accept: 'application/json' },
      )
      if (!body.access_token) tokenError(body)
      return body as OAuthTokens
    },
    async identity(config, tokens) {
      const headers = { authorization: `token ${tokens.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'Bunwrite' }
      const user = await requestJson<Record<string, any>>(config.userinfoUrl!, { headers })
      let emails: Array<Record<string, any>> = []
      try {
        emails = await requestJson<Array<Record<string, any>>>(`${config.userinfoUrl}/emails`, { headers })
      } catch {
        // Without user:email the profile email is all GitHub gives us; it stays unverified.
      }
      const candidates = Array.isArray(emails) ? emails.filter((entry) => verified(entry.verified)) : []
      const chosen = candidates.find((entry) => entry.primary === true) ?? candidates[0]
      const address = chosen ? email(chosen.email) : email(user.email)
      return {
        uid: user.id === undefined || user.id === null ? '' : String(user.id),
        email: address,
        name: text(user.name) || text(user.login),
        emailVerified: Boolean(chosen && address),
      }
    },
  },

  apple: {
    authorize(url) {
      url.searchParams.set('response_mode', 'form_post')
    },
    async exchange(config, code, callback) {
      const body = await postForm(config.tokenUrl!, {
        grant_type: 'authorization_code',
        code,
        client_id: config.clientId,
        client_secret: await appleClientSecret(config),
        redirect_uri: callback,
      })
      if (!body.access_token) tokenError(body)
      return body as OAuthTokens
    },
    async identity(_config, tokens, user) {
      // Apple returns no userinfo endpoint: the ID token carries the account.
      const claims = jwtClaims(tokens.id_token)
      return {
        uid: text(claims.sub),
        email: email(claims.email),
        name: appleName(user),
        emailVerified: verified(claims.email_verified),
      }
    },
  },
}

export const OAUTH_PROVIDERS_BY_ID = providers
