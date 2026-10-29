/**
 * OAuth sign-in, Appwrite's token flow:
 *
 * 1. `GET /account/tokens/oauth2/:provider?success&failure` redirects (301) to
 *    the provider with a signed `state`.
 * 2. The provider calls `/account/sessions/oauth2/callback/:provider/:projectId`;
 *    the user is found by provider identity, by verified email, or created.
 *    Apple posts this callback as a form (`response_mode=form_post`).
 * 3. The browser is sent to `success?userId=..&secret=..`, which the app
 *    exchanges for a session with `account.createSession`.
 *
 * The callback URL is the same as Appwrite's, so redirect URIs registered with
 * each provider keep working when this server takes over the hostname.
 */
import type { Config, OAuthConfig, OAuthProviderId } from '~/config'
import { OAUTH_PROVIDERS, OAUTH_PROVIDER_IDS } from '~/config'
import type { Db } from '~/db/connection'
import type { Params } from '~/lib/http'
import { now } from '~/lib/datetime'
import { BunwriteError, err } from '~/lib/errors'
import { uniqueId } from '~/lib/ids'
import { assertRedirect, withQuery } from '~/lib/origins'
import { OAUTH_PROVIDERS_BY_ID, type OAuthIdentity, type OAuthProvider, type OAuthTokens } from './providers'
import type { AuthService } from './service'

const OAUTH2_TOKEN_TTL = 15 * 60
const STATE_TTL = 15 * 60

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

/** Apple posts `user` as JSON on the first authorization. */
function jsonParam(value: unknown): unknown {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string' || !value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const isProvider = (value: string): value is OAuthProviderId => (OAUTH_PROVIDER_IDS as readonly string[]).includes(value)

export class OAuthService {
  constructor(
    private db: Db,
    private config: Config,
    private auth: AuthService,
    /** Redirect targets: the project's allowed origins and its sites. */
    private origins: () => string[] = () => config.allowedOrigins,
  ) {}

  private provider(provider: string): { id: OAuthProviderId; config: OAuthConfig; definition: OAuthProvider } {
    if (!isProvider(provider)) throw err('project_provider_unsupported', `The chosen OAuth provider is unsupported: ${provider}`)
    const stored = this.config.oauth[provider] ?? null
    if (!stored) throw err('project_provider_disabled', 'This provider is disabled. Please enable the provider from your project settings.')
    const meta = OAUTH_PROVIDERS[provider]
    const config: OAuthConfig = {
      authUrl: meta.authUrl,
      tokenUrl: meta.tokenUrl,
      ...(meta.userinfoUrl ? { userinfoUrl: meta.userinfoUrl } : {}),
      ...stored,
    }
    return { id: provider, config, definition: OAUTH_PROVIDERS_BY_ID[provider] }
  }

  callbackUrl(provider: string): string {
    return `${this.config.publicEndpoint}/account/sessions/oauth2/callback/${provider}/${this.config.projectId}`
  }

  /** Step 1: where to send the browser. */
  async authorizeUrl(provider: string, success: unknown, failure: unknown, scopes: unknown): Promise<string> {
    const { id, config, definition } = this.provider(provider)
    const meta = OAUTH_PROVIDERS[id]
    const state: State = {
      success: assertRedirect(success, this.origins(), 'success'),
      failure: assertRedirect(failure ?? success, this.origins(), 'failure'),
      token: true,
      exp: Math.floor(Date.now() / 1000) + STATE_TTL,
      nonce: uniqueId(),
    }
    const payload = Buffer.from(JSON.stringify(state)).toString('base64url')
    const extra = Array.isArray(scopes) ? scopes.map(String) : []
    const url = new URL(config.authUrl ?? meta.authUrl)
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', this.callbackUrl(id))
    url.searchParams.set('scope', [...new Set([...meta.scopes, ...extra])].join(' '))
    url.searchParams.set('state', `${payload}.${await sign(this.config.secret, payload)}`)
    url.searchParams.set('response_type', 'code')
    definition.authorize?.(url)
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
  async callback(provider: string, params: Params): Promise<string> {
    const state = await this.readState(typeof params.state === 'string' ? params.state : null)
    if (!state) throw err('general_argument_invalid', 'Invalid `state` param.')
    try {
      const { id, config, definition } = this.provider(provider)
      const code = typeof params.code === 'string' ? params.code : ''
      if (!code) throw err('user_oauth2_bad_request', typeof params.error === 'string' ? params.error : 'Missing OAuth2 code.')

      const tokens = await definition.exchange(config, code, this.callbackUrl(id))
      const identity = await definition.identity(config, tokens, jsonParam(params.user))
      if (!identity.uid) throw err('user_missing_id')

      const userId = await this.resolveUser(id, identity, tokens)
      const { secret } = this.auth.createToken(userId, 'oauth2', { ttl: OAUTH2_TOKEN_TTL, provider: id })
      return withQuery(state.success, { userId, secret })
    } catch (error) {
      const e = error instanceof BunwriteError ? error : err('general_unknown', 'Server Error')
      if (!(error instanceof BunwriteError)) console.error('[oauth] callback failed:', error)
      return withQuery(state.failure, { error: JSON.stringify(e.toJSON()) })
    }
  }

  /** Link by identity, then by verified email, otherwise create — Appwrite's order. */
  private async resolveUser(provider: OAuthProviderId, identity: OAuthIdentity, tokens: OAuthTokens): Promise<string> {
    const sql = this.db.sqlite
    const stamp = now()
    const expiry = tokens.expires_in ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString().replace('Z', '+00:00') : ''
    const linked = sql
      .query<{ user_id: string }, [string, string]>('SELECT user_id FROM _identities WHERE provider = ? AND provider_uid = ?')
      .get(provider, identity.uid)

    let userId = linked?.user_id ?? ''
    if (!userId && identity.email) {
      const existing = this.auth.userByEmail(identity.email)
      if (existing) {
        // Appwrite refuses to attach an unverified provider email to an existing account.
        if (!identity.emailVerified) throw err('general_bad_request')
        userId = existing.id
      }
    }
    if (!userId) {
      userId = (await this.auth.createUser({ email: identity.email || undefined, name: identity.name, emailVerification: identity.emailVerified })).id
    }

    let user = this.auth.user(userId)
    if (!user.status) throw err('user_blocked')
    if (identity.emailVerified && user.email === identity.email && !user.email_verification) {
      user = this.auth.updateUser(userId, { email_verification: 1 })
    }
    if (!user.name && identity.name) this.auth.updateUser(userId, { name: identity.name })

    if (linked) {
      sql
        .query(
          'UPDATE _identities SET provider_email = ?, provider_access_token = ?, provider_refresh_token = ?, provider_access_token_expiry = ?, updated_at = ? WHERE provider = ? AND provider_uid = ?',
        )
        .run(identity.email, tokens.access_token, tokens.refresh_token ?? '', expiry, stamp, provider, identity.uid)
    } else {
      sql
        .query(
          `INSERT INTO _identities (id, user_id, provider, provider_uid, provider_email, provider_access_token, provider_access_token_expiry, provider_refresh_token, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(uniqueId(), userId, provider, identity.uid, identity.email, tokens.access_token, expiry, tokens.refresh_token ?? '', stamp, stamp)
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
