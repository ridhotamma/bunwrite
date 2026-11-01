/**
 * The server's GitHub App credentials. VCS_GITHUB_* env vars win field by
 * field; otherwise the app made by the console's one-click setup, stored in
 * the control database's `_vcs_github_app`.
 *
 * Reads stay synchronous because the GitHub client asks for credentials from
 * synchronous helpers. SQLite loads the row in the constructor; a network
 * backend loads it in `VcsHub.ready()`.
 */
import type { Config } from '~/config'
import type { SqlDatabase } from '~/db/driver'
import { now } from '~/lib/datetime'
import type { GithubAppCredentials, GithubManifestApp } from './github'

interface AppRow {
  key: string
  app_id: string
  slug: string
  name: string
  owner: string
  html_url: string
  client_id: string
  client_secret: string
  webhook_secret: string
  private_key: string
}

export class GithubAppStore {
  /** `undefined` means a network backend has not loaded the row yet. */
  private cache: AppRow | null | undefined

  constructor(
    private readonly db: SqlDatabase,
    private readonly config: Config,
  ) {
    if (db.dialect === 'sqlite') this.loadSync()
  }

  private loadSync(): void {
    this.cache = this.db.sqlite?.query<AppRow, []>("SELECT * FROM _vcs_github_app WHERE key = 'github'").get() ?? null
  }

  /** Load the stored app before the console can read it on a network backend. */
  async load(): Promise<void> {
    this.cache =
      (await this.db.driver.get<AppRow>("SELECT * FROM _vcs_github_app WHERE key = 'github'")) ?? null
  }

  private row(): AppRow | null {
    if (this.cache === undefined) {
      if (this.db.sqlite) this.loadSync()
      else return null
    }
    return this.cache ?? null
  }

  /** True when the env vars alone define a complete app. */
  fromEnv(): boolean {
    const e = this.config.vcsGithub
    return Boolean(e.appId && e.privateKey)
  }

  /** The app to use, or null when none is set up. */
  get(): GithubAppCredentials | null {
    const e = this.config.vcsGithub
    const row = this.row()
    const appId = e.appId || row?.app_id || ''
    const privateKey = e.privateKey || row?.private_key || ''
    if (!appId || !privateKey) return null
    return {
      appId,
      privateKey,
      slug: e.appName || row?.slug || '',
      clientId: e.clientId || row?.client_id || '',
      clientSecret: e.clientSecret || row?.client_secret || '',
      webhookSecret: e.webhookSecret || row?.webhook_secret || '',
      name: row?.name || e.appName || '',
      owner: row?.owner || '',
      htmlUrl: row?.html_url || (e.appName ? `${e.url}/apps/${e.appName}` : ''),
      source: this.fromEnv() ? 'env' : 'console',
    }
  }

  /** Store the app GitHub made from our manifest. */
  async save(app: GithubManifestApp): Promise<void> {
    const stamp = now()
    const values = [
      String(app.id),
      app.slug,
      app.name,
      app.owner?.login ?? '',
      app.html_url,
      app.client_id,
      app.client_secret,
      app.webhook_secret ?? '',
      app.pem,
      stamp,
      stamp,
    ]
    await this.db.driver.run(
      `INSERT INTO _vcs_github_app (key, app_id, slug, name, owner, html_url, client_id, client_secret, webhook_secret, private_key, created_at, updated_at)
       VALUES ('github', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET app_id = excluded.app_id, slug = excluded.slug, name = excluded.name, owner = excluded.owner,
         html_url = excluded.html_url, client_id = excluded.client_id, client_secret = excluded.client_secret,
         webhook_secret = excluded.webhook_secret, private_key = excluded.private_key, updated_at = excluded.updated_at`,
      values,
    )
    this.cache = {
      key: 'github',
      app_id: String(app.id),
      slug: app.slug,
      name: app.name,
      owner: app.owner?.login ?? '',
      html_url: app.html_url,
      client_id: app.client_id,
      client_secret: app.client_secret,
      webhook_secret: app.webhook_secret ?? '',
      private_key: app.pem,
    }
  }

  /** Forget the console-made app. The app itself stays on GitHub until deleted there. */
  async remove(): Promise<boolean> {
    const result = await this.db.driver.run("DELETE FROM _vcs_github_app WHERE key = 'github'")
    this.cache = null
    return result.changes > 0
  }

  /** True when the console stored an app (so the console may remove it). */
  stored(): boolean {
    return this.row() !== null
  }
}
