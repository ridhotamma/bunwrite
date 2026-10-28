/**
 * GitHub REST client for the server's GitHub App: the app's own JWT, cached
 * installation tokens, and the calls Git deployments need (repositories,
 * branches, contents, tarballs, commit statuses, PR comments), plus the
 * one-time manifest conversion and the OAuth exchange used when installing.
 */
import { createHmac, createSign, timingSafeEqual } from 'node:crypto'

import { err } from '~/lib/errors'

export interface GithubAppCredentials {
  appId: string
  slug: string
  privateKey: string
  clientId: string
  clientSecret: string
  webhookSecret: string
  name: string
  owner: string
  htmlUrl: string
  /** `env` when VCS_GITHUB_* set the app, `console` when the one-click setup stored it. */
  source: 'env' | 'console'
}

export interface GithubUrls {
  /** REST API base, such as https://api.github.com. */
  apiUrl: string
  /** Web base, such as https://github.com. */
  url: string
}

export interface GithubRepository {
  id: number
  name: string
  full_name: string
  private: boolean
  default_branch: string
  html_url: string
  pushed_at?: string | null
  owner: { login: string; type?: string }
}

export interface GithubCommit {
  sha: string
  message: string
  author: string
  authorUrl: string
  url: string
}

export interface GithubContent {
  name: string
  path: string
  type: 'file' | 'dir' | string
  size: number
}

export interface GithubPull {
  number: number
  html_url: string
  title: string
  state: string
  user: { login: string; html_url: string }
  head: { ref: string; sha: string; repo: { id: number; full_name: string } | null }
  base: { ref: string; repo: { id: number; full_name: string } }
}

export interface GithubInstallation {
  id: number
  account: { login: string; type: string } | null
  html_url?: string
}

/** The result of creating an app from a manifest. */
export interface GithubManifestApp {
  id: number
  slug: string
  name: string
  owner: { login: string } | null
  html_url: string
  client_id: string
  client_secret: string
  webhook_secret: string | null
  pem: string
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')

/** True when `signature` (X-Hub-Signature-256) is the HMAC of `body` with `secret`. */
export function verifyWebhookSignature(secret: string, body: Uint8Array | string, signature: string | null): boolean {
  if (!secret || !signature?.startsWith('sha256=')) return false
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class GithubClient {
  private readonly tokens = new Map<string, { token: string; until: number }>()
  private readonly repos = new Map<string, { owner: string; name: string; until: number }>()

  constructor(
    private readonly credentials: () => GithubAppCredentials | null,
    private readonly urls: () => GithubUrls,
  ) {}

  get apiUrl(): string {
    return this.urls().apiUrl
  }

  get webUrl(): string {
    return this.urls().url
  }

  private app(): GithubAppCredentials {
    const app = this.credentials()
    if (!app) throw err('general_argument_invalid', 'No GitHub App is set up on this server. Create one in the console (Organization → GitHub App) or set VCS_GITHUB_* variables.')
    return app
  }

  /** A JWT signed with the app's private key; GitHub accepts it for 10 minutes. */
  appJwt(): string {
    const app = this.app()
    const at = Math.floor(Date.now() / 1000)
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload = b64url(JSON.stringify({ iat: at - 60, exp: at + 540, iss: app.appId }))
    const signer = createSign('RSA-SHA256')
    signer.update(`${header}.${payload}`)
    let signature: string
    try {
      signature = signer.sign(app.privateKey).toString('base64url')
    } catch {
      throw new GithubError(0, "The GitHub App's private key could not be read. Check VCS_GITHUB_PRIVATE_KEY, or remove the app and create it again.")
    }
    return `${header}.${payload}.${signature}`
  }

  /** An installation access token, reused until about 10 minutes before it expires. */
  async installationToken(installationId: string): Promise<string> {
    const cached = this.tokens.get(installationId)
    if (cached && cached.until > Date.now()) return cached.token
    const res = await this.call<{ token: string; expires_at: string }>('POST', `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { auth: `Bearer ${this.appJwt()}` })
    const expires = Date.parse(res.expires_at)
    this.tokens.set(installationId, { token: res.token, until: (Number.isFinite(expires) ? expires : Date.now() + 3600_000) - 600_000 })
    return res.token
  }

  /** Forget cached tokens, for an installation that was removed. */
  forget(installationId: string): void {
    this.tokens.delete(installationId)
  }

  private async call<T>(method: string, path: string, options: { auth?: string; body?: unknown; accept?: string; base?: string } = {}): Promise<T> {
    const res = await this.raw(method, path, options)
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  private async raw(method: string, path: string, options: { auth?: string; body?: unknown; accept?: string; base?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = {
      accept: options.accept ?? 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'bunwrite',
    }
    if (options.auth) headers.authorization = options.auth
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const url = path.startsWith('http') ? path : `${options.base ?? this.apiUrl}${path}`
    let res: Response
    try {
      res = await fetch(url, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
    } catch (error) {
      throw new GithubError(0, `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`
      try {
        const body = (await res.json()) as { message?: string }
        if (body.message) message = `${message}: ${body.message}`
      } catch {
        /* not JSON */
      }
      throw new GithubError(res.status, `GitHub ${method} ${path} failed (${message}).`)
    }
    return res
  }

  private async asInstallation<T>(installationId: string, method: string, path: string, options: { body?: unknown; accept?: string } = {}): Promise<T> {
    return this.call<T>(method, path, { ...options, auth: `token ${await this.installationToken(installationId)}` })
  }

  // ---- App setup ----

  /** Exchange the code GitHub sends after "create app from manifest". No auth needed. */
  convertManifest(code: string): Promise<GithubManifestApp> {
    return this.call<GithubManifestApp>('POST', `/app-manifests/${encodeURIComponent(code)}/conversions`)
  }

  /** The app's own view of one installation (JWT auth). */
  installation(installationId: string): Promise<GithubInstallation> {
    return this.call<GithubInstallation>('GET', `/app/installations/${encodeURIComponent(installationId)}`, { auth: `Bearer ${this.appJwt()}` })
  }

  /** Exchange the OAuth code from the install redirect for a user token. */
  async userToken(code: string): Promise<string> {
    const app = this.app()
    const res = await this.call<{ access_token?: string; error_description?: string }>('POST', '/login/oauth/access_token', {
      base: this.webUrl,
      accept: 'application/json',
      body: { client_id: app.clientId, client_secret: app.clientSecret, code },
    })
    if (!res.access_token) throw new GithubError(401, `GitHub did not accept the sign-in: ${res.error_description ?? 'no token'}.`)
    return res.access_token
  }

  /** Installation IDs of this app that the signed-in user can access. */
  async userInstallationIds(userToken: string): Promise<string[]> {
    const ids: string[] = []
    for (let page = 1; page <= 10; page++) {
      const res = await this.call<{ installations: GithubInstallation[] }>('GET', `/user/installations?per_page=100&page=${page}`, { auth: `token ${userToken}` })
      ids.push(...res.installations.map((i) => String(i.id)))
      if (res.installations.length < 100) break
    }
    return ids
  }

  // ---- Repositories ----

  /** Repositories the installation can see, newest push first; `search` filters by name. */
  async repositories(installationId: string, search = ''): Promise<GithubRepository[]> {
    const all: GithubRepository[] = []
    for (let page = 1; page <= 10; page++) {
      const res = await this.asInstallation<{ repositories: GithubRepository[] }>(installationId, 'GET', `/installation/repositories?per_page=100&page=${page}`)
      all.push(...res.repositories)
      if (res.repositories.length < 100) break
    }
    const needle = search.trim().toLowerCase()
    return all
      .filter((r) => !needle || r.full_name.toLowerCase().includes(needle))
      .sort((a, b) => Date.parse(b.pushed_at ?? '') - Date.parse(a.pushed_at ?? '') || a.full_name.localeCompare(b.full_name))
  }

  async repository(installationId: string, repositoryId: string): Promise<GithubRepository> {
    const repo = await this.asInstallation<GithubRepository>(installationId, 'GET', `/repositories/${encodeURIComponent(repositoryId)}`)
    this.repos.set(repositoryId, { owner: repo.owner.login, name: repo.name, until: Date.now() + 600_000 })
    return repo
  }

  /** `owner` and `name` of a repository by its numeric ID, cached for a few minutes. */
  async repoName(installationId: string, repositoryId: string): Promise<{ owner: string; name: string }> {
    const cached = this.repos.get(repositoryId)
    if (cached && cached.until > Date.now()) return cached
    const repo = await this.repository(installationId, repositoryId)
    return { owner: repo.owner.login, name: repo.name }
  }

  async branches(installationId: string, repositoryId: string): Promise<string[]> {
    const { owner, name } = await this.repoName(installationId, repositoryId)
    const out: string[] = []
    for (let page = 1; page <= 10; page++) {
      const res = await this.asInstallation<{ name: string }[]>(installationId, 'GET', `/repos/${owner}/${name}/branches?per_page=100&page=${page}`)
      out.push(...res.map((b) => b.name))
      if (res.length < 100) break
    }
    return out
  }

  /** Entries of a folder at `ref` (the default branch when empty). */
  async contents(installationId: string, repositoryId: string, path: string, ref = ''): Promise<GithubContent[]> {
    const { owner, name } = await this.repoName(installationId, repositoryId)
    const clean = path.replace(/^\/+|\/+$/g, '')
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
    const res = await this.asInstallation<GithubContent[] | GithubContent>(installationId, 'GET', `/repos/${owner}/${name}/contents/${clean.split('/').map(encodeURIComponent).join('/')}${query}`)
    return (Array.isArray(res) ? res : [res]).map((c) => ({ name: c.name, path: c.path, type: c.type, size: c.size }))
  }

  /** A file's text, or null when it is not there. */
  async fileText(installationId: string, repositoryId: string, path: string, ref = ''): Promise<string | null> {
    const { owner, name } = await this.repoName(installationId, repositoryId)
    const clean = path.replace(/^\/+/, '')
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
    try {
      const res = await this.raw('GET', `/repos/${owner}/${name}/contents/${clean.split('/').map(encodeURIComponent).join('/')}${query}`, {
        auth: `token ${await this.installationToken(installationId)}`,
        accept: 'application/vnd.github.raw+json',
      })
      return await res.text()
    } catch (error) {
      if (error instanceof GithubError && error.status === 404) return null
      throw error
    }
  }

  /** The commit a branch, tag or SHA points at. */
  async commit(installationId: string, repositoryId: string, ref: string): Promise<GithubCommit> {
    const { owner, name } = await this.repoName(installationId, repositoryId)
    const c = await this.asInstallation<{
      sha: string
      html_url: string
      commit: { message: string; author: { name: string } | null }
      author: { login: string; html_url: string } | null
    }>(installationId, 'GET', `/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}`)
    return { sha: c.sha, message: c.commit.message, author: c.author?.login ?? c.commit.author?.name ?? '', authorUrl: c.author?.html_url ?? '', url: c.html_url }
  }

  /** Save the .tar.gz of a commit to `target`. */
  async downloadTarball(installationId: string, repositoryId: string, sha: string, target: string): Promise<number> {
    const { owner, name } = await this.repoName(installationId, repositoryId)
    const res = await this.raw('GET', `/repos/${owner}/${name}/tarball/${encodeURIComponent(sha)}`, { auth: `token ${await this.installationToken(installationId)}`, accept: '*/*' })
    return Bun.write(target, res)
  }

  // ---- Checks and comments ----

  async setStatus(
    installationId: string,
    repositoryId: string,
    sha: string,
    status: { state: 'pending' | 'success' | 'failure' | 'error'; context: string; description: string; targetUrl: string },
  ): Promise<void> {
    const { owner, name } = await this.repoName(installationId, repositoryId)
    await this.asInstallation(installationId, 'POST', `/repos/${owner}/${name}/statuses/${encodeURIComponent(sha)}`, {
      body: { state: status.state, context: status.context.slice(0, 255), description: status.description.slice(0, 140), target_url: status.targetUrl || undefined },
    })
  }

  /** The open pull request whose head is `branch` in the same repository, if any. */
  async openPullForBranch(installationId: string, repositoryId: string, branch: string): Promise<GithubPull | null> {
    const { owner, name } = await this.repoName(installationId, repositoryId)
    const res = await this.asInstallation<GithubPull[]>(installationId, 'GET', `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`)
    return res[0] ?? null
  }

  async pull(installationId: string, repositoryId: string, number: number): Promise<GithubPull> {
    const { owner, name } = await this.repoName(installationId, repositoryId)
    return this.asInstallation<GithubPull>(installationId, 'GET', `/repos/${owner}/${name}/pulls/${number}`)
  }

  async createComment(installationId: string, repositoryId: string, number: number, body: string): Promise<string> {
    const { owner, name } = await this.repoName(installationId, repositoryId)
    const res = await this.asInstallation<{ id: number }>(installationId, 'POST', `/repos/${owner}/${name}/issues/${number}/comments`, { body: { body } })
    return String(res.id)
  }

  /** Edit a comment; false when it was deleted on GitHub. */
  async updateComment(installationId: string, repositoryId: string, commentId: string, body: string): Promise<boolean> {
    const { owner, name } = await this.repoName(installationId, repositoryId)
    try {
      await this.asInstallation(installationId, 'PATCH', `/repos/${owner}/${name}/issues/comments/${encodeURIComponent(commentId)}`, { body: { body } })
      return true
    } catch (error) {
      if (error instanceof GithubError && error.status === 404) return false
      throw error
    }
  }
}
