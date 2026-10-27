/**
 * Google sign-in, Appwrite's token flow:
 *
 * 1. `GET /account/tokens/oauth2/google?success&failure` redirects (301) to
 *    Google with a signed `state`.
 * 2. Google calls `/account/sessions/oauth2/callback/google/<projectId>`; the
 *    user is found by Google identity, then by email, or created.
 * 3. The browser is sent to `success?userId=..&secret=..`, which the app
 *    exchanges for a session with `account.createSession`.
 *
 * The callback URL is the same as Appwrite's, so the redirect URI registered
 * in Google Cloud keeps working when this server takes over the hostname.
 */
import type { Config, GoogleConfig } from '../config'
import type { Db } from '../db/connection'
import { now } from '../lib/datetime'
import { AppwriteError, err } from '../lib/errors'
import { uniqueId } from '../lib/ids'
import { assertRedirect, withQuery } from '../lib/origins'
import type { AuthService } from './service'

const OAUTH2_TOKEN_TTL = 15 * 60
const STATE_TTL = 15 * 60
const SCOPES = ['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile', 'openid']

interface State {
  success: string
  failure: string
  token: boolean
  exp: number
  nonce: string
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))).toString('base64url')
}

export class OAuthService {
  constructor(
    private db: Db,
    private config: Config,
    private auth: AuthService,
  ) {}

  private google(provider: string): GoogleConfig {
    if (provider !== 'google') throw err('project_provider_unsupported', `The chosen OAuth provider is unsupported: ${provider}`)
    if (!this.config.google) throw err('project_provider_disabled', 'This provider is disabled. Please enable the provider from your project settings.')
    return this.config.google
  }

  callbackUrl(provider: string): string {
    return `${this.config.publicEndpoint}/account/sessions/oauth2/callback/${provider}/${this.config.projectId}`
  }

  /** Step 1: where to send the browser. */
  async authorizeUrl(provider: string, success: unknown, failure: unknown, scopes: unknown): Promise<string> {
    const google = this.google(provider)
    const state: State = {
      success: assertRedirect(success, this.config.allowedOrigins, 'success'),
      failure: assertRedirect(failure ?? success, this.config.allowedOrigins, 'failure'),
      token: true,
      exp: Math.floor(Date.now() / 1000) + STATE_TTL,
      nonce: uniqueId(),
    }
    const payload = Buffer.from(JSON.stringify(state)).toString('base64url')
    const extra = Array.isArray(scopes) ? scopes.map(String) : []
    const url = new URL(google.authUrl)
    url.searchParams.set('client_id', google.clientId)
    url.searchParams.set('redirect_uri', this.callbackUrl(provider))
    url.searchParams.set('scope', [...new Set([...SCOPES, ...extra])].join(' '))
    url.searchParams.set('state', `${payload}.${await sign(this.config.secret, payload)}`)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    return url.toString()
  }

  private async readState(raw: string | null): Promise<State | null> {
    if (!raw) return null
    const [payload, signature] = raw.split('.')
    if (!payload || !signature || (await sign(this.config.secret, payload)) !== signature) return null
    try {
      const state = JSON.parse(Buffer.from(payload, 'base64url').toString()) as State
      return state.exp > Date.now() / 1000 ? state : null
    } catch {
      return null
    }
  }

  /** Steps 2–3: returns the URL to redirect the browser to. */
  async callback(provider: string, url: URL): Promise<string> {
    const state = await this.readState(url.searchParams.get('state'))
    if (!state) throw err('general_argument_invalid', 'Invalid `state` param.')
    try {
      const google = this.google(provider)
      const code = url.searchParams.get('code')
      if (!code) throw err('user_oauth2_bad_request', url.searchParams.get('error') ?? 'Missing OAuth2 code.')

      const tokenRes = await fetch(google.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: google.clientId,
          client_secret: google.clientSecret,
          redirect_uri: this.callbackUrl(provider),
          grant_type: 'authorization_code',
        }),
      })
      const tokens = (await tokenRes.json().catch(() => ({}))) as Record<string, any>
      if (!tokenRes.ok || !tokens.access_token) throw err('user_oauth2_provider_error', 'Failed to obtain access token.')

      const infoRes = await fetch(`${google.userinfoUrl}?access_token=${encodeURIComponent(tokens.access_token)}`)
      const info = (await infoRes.json().catch(() => ({}))) as Record<string, any>
      const uid = String(info.sub ?? '')
      const email = typeof info.email === 'string' ? info.email.toLowerCase() : ''
      if (!uid || !email) throw err('user_oauth2_provider_error', 'Missing ID or email from OAuth2 provider.')
      if (info.email_verified === false) throw err('user_oauth2_provider_error', 'The OAuth2 provider email is not verified.')

      const userId = await this.resolveUser(provider, uid, email, String(info.name ?? ''), tokens)
      const { secret } = this.auth.createToken(userId, 'oauth2', { ttl: OAUTH2_TOKEN_TTL, provider })
      return withQuery(state.success, { userId, secret })
    } catch (error) {
      const e = error instanceof AppwriteError ? error : err('general_unknown', 'Server Error')
      if (!(error instanceof AppwriteError)) console.error('[oauth] callback failed:', error)
      return withQuery(state.failure, { error: JSON.stringify(e.toJSON()) })
    }
  }

  private async resolveUser(provider: string, uid: string, email: string, name: string, tokens: Record<string, any>): Promise<string> {
    const sql = this.db.sqlite
    const stamp = now()
    const expiry = tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString().replace('Z', '+00:00') : ''
    const identity = sql.query<{ user_id: string }, [string, string]>('SELECT user_id FROM _identities WHERE provider = ? AND provider_uid = ?').get(provider, uid)
    let userId = identity?.user_id ?? this.auth.userByEmail(email)?.id
    if (!userId) userId = (await this.auth.createUser({ email, name, emailVerification: true })).id
    const user = this.auth.user(userId)
    if (!user.status) throw err('user_blocked')
    if (!user.email_verification && user.email === email) this.auth.updateUser(userId, { email_verification: 1 })

    if (identity) {
      sql
        .query(
          'UPDATE _identities SET provider_email = ?, provider_access_token = ?, provider_refresh_token = ?, provider_access_token_expiry = ?, updated_at = ? WHERE provider = ? AND provider_uid = ?',
        )
        .run(email, tokens.access_token ?? '', tokens.refresh_token ?? '', expiry, stamp, provider, uid)
    } else {
      sql
        .query(
          `INSERT INTO _identities (id, user_id, provider, provider_uid, provider_email, provider_access_token, provider_access_token_expiry, provider_refresh_token, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(uniqueId(), userId, provider, uid, email, tokens.access_token ?? '', expiry, tokens.refresh_token ?? '', stamp, stamp)
    }
    return userId
  }

  /** Provider details a session created from an oauth2 token carries. */
  identity(userId: string, provider: string) {
    return this.db.sqlite
      .query<any, [string, string]>('SELECT * FROM _identities WHERE user_id = ? AND provider = ? ORDER BY seq DESC LIMIT 1')
      .get(userId, provider)
  }
}
