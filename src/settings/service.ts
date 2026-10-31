/**
 * Project settings edited in the console. Stored in `_settings` and applied
 * over the Config in place, so the next request sees them. Values left unset
 * use the defaults captured when the service starts; API keys live in
 * `_api_keys`.
 */
import type { BackupsConfig, CacheConfig, Config, OAuthConfig, OAuthProviderId, S3Config, SmtpConfig } from '~/config'
import { OAUTH_PROVIDERS, OAUTH_PROVIDER_IDS } from '~/config'
import type { VersionMonitor } from '~/cluster/versions'
import type { RenderConfig } from '~/render/service'
import type { SqlDatabase } from '~/db/driver'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { randomSecret, sha256, uniqueId } from '~/lib/ids'
import type { SqliteSynchronous } from '~/system/autotune'
import { storedApiKeyScopes } from './scopes'

export interface ProjectSettings {
  projectName: string
  allowedOrigins: string[]
  sessionDuration: number
  sessionsLimit: number
}

export type SettingKey =
  | 'project'
  | 'smtp'
  | 'google'
  | 'facebook'
  | 'github'
  | 'apple'
  | 'functions'
  | 'logs'
  | 's3'
  | 'backups'
  | 'render'
  | 'cache'
  | 'database'

export const SETTING_KEYS: SettingKey[] = [
  'project',
  'smtp',
  'google',
  'facebook',
  'github',
  'apple',
  'functions',
  'logs',
  's3',
  'backups',
  'render',
  'cache',
  'database',
]

const cloneOAuth = (oauth: Config['oauth']): Config['oauth'] =>
  Object.fromEntries(Object.entries(oauth).map(([id, config]) => [id, config ? { ...config } : config])) as Config['oauth']

export interface ApiKeyRow {
  id: string
  name: string
  hint: string
  /** Allowed scopes; null means full access (legacy keys). */
  scopes: string[] | null
  expire: string | null
  accessed_at: string | null
  created_at: string
}

export interface SettingsOptions {
  /** A value inherited when this project has no stored setting: the default project's live SMTP. */
  smtpDefault?: () => SmtpConfig | null
}

export class SettingsService {
  /** Env values, kept so a console setting can be cleared back to them. */
  private readonly defaults: Pick<
    Config,
    | 'projectName'
    | 'allowedOrigins'
    | 'sessionDuration'
    | 'sessionsLimit'
    | 'smtp'
    | 'oauth'
    | 'skipSchedules'
    | 'functionsDir'
    | 'logRetentionDays'
    | 'logIp'
    | 's3'
    | 'backups'
    | 'render'
    | 'cache'
    | 'sqliteSynchronous'
  >
  private readonly listeners = new Set<(key: SettingKey) => void>()
  /** Parsed `_settings` rows; reads are synchronous so the config overlay stays cheap. */
  private readonly stored = new Map<SettingKey, unknown>()

  constructor(
    private db: SqlDatabase,
    private config: Config,
    private onChange: (key: SettingKey) => void = () => {},
    private readonly options: SettingsOptions = {},
  ) {
    this.defaults = {
      projectName: config.projectName,
      allowedOrigins: [...config.allowedOrigins],
      sessionDuration: config.sessionDuration,
      sessionsLimit: config.sessionsLimit,
      smtp: config.smtp ? { ...config.smtp } : null,
      oauth: cloneOAuth(config.oauth),
      skipSchedules: [...config.skipSchedules],
      functionsDir: config.functionsDir,
      logRetentionDays: config.logRetentionDays,
      logIp: config.logIp,
      s3: { ...config.s3 },
      backups: { ...config.backups, s3: { ...config.backups.s3 } },
      render: { ...config.render },
      cache: { ...config.cache },
      sqliteSynchronous: config.sqliteSynchronous,
    }
    // SQLite loads synchronously, exactly as before. A network backend leaves
    // the map empty until `load()` runs; the boot path awaits `services.ready()`.
    if (this.db.dialect === 'sqlite') this.loadSync()
    for (const key of SETTING_KEYS) this.apply(key)
  }

  private read<T>(key: SettingKey): T | null {
    return (this.stored.get(key) as T | undefined) ?? null
  }

  private applyStored(rows: Array<{ key: string; value: string }>): void {
    this.stored.clear()
    for (const row of rows) {
      try {
        this.stored.set(row.key as SettingKey, JSON.parse(row.value))
      } catch {
        // A corrupt row falls back to the environment default.
      }
    }
  }

  /** Load `_settings` over the synchronous SQLite path (constructor). */
  private loadSync(): void {
    this.applyStored(
      this.db.sqlite!.query<{ key: string; value: string }, []>('SELECT key, value FROM _settings').all(),
    )
  }

  /** Load `_settings` through the driver port and re-apply every setting. */
  async load(): Promise<void> {
    this.applyStored(await this.db.driver.all<{ key: string; value: string }>('SELECT key, value FROM _settings'))
    this.refreshAll()
  }

  /** Whether a setting comes from the console rather than env. */
  overridden(key: SettingKey): boolean {
    return this.stored.has(key)
  }

  private apply(key: SettingKey): void {
    const c = this.config
    switch (key) {
      case 'project': {
        const v = this.read<ProjectSettings>('project')
        c.projectName = v?.projectName ?? this.defaults.projectName
        c.allowedOrigins = v?.allowedOrigins ?? [...this.defaults.allowedOrigins]
        c.sessionDuration = v?.sessionDuration ?? this.defaults.sessionDuration
        c.sessionsLimit = v?.sessionsLimit ?? this.defaults.sessionsLimit
        break
      }
      case 'smtp': {
        const v = this.read<SmtpConfig | { disabled: true }>('smtp')
        c.smtp = v === null ? this.defaultSmtp() : 'disabled' in v ? null : v
        break
      }
      case 'google':
      case 'facebook':
      case 'github':
      case 'apple':
        this.applyOAuth(key)
        break
      case 'functions': {
        const v = this.read<{ skipSchedules?: string[]; functionsDir?: string }>('functions')
        c.skipSchedules = v?.skipSchedules ?? [...this.defaults.skipSchedules]
        c.functionsDir = v?.functionsDir || this.defaults.functionsDir
        break
      }
      case 'logs': {
        const v = this.read<{ retentionDays?: number; logIp?: boolean }>('logs')
        c.logRetentionDays = v?.retentionDays ?? this.defaults.logRetentionDays
        c.logIp = v?.logIp ?? this.defaults.logIp
        break
      }
      case 's3': {
        const v = this.read<S3Config>('s3')
        c.s3 = v ? { ...v } : { ...this.defaults.s3 }
        break
      }
      case 'backups': {
        const v = this.read<BackupsConfig>('backups')
        c.backups = v ? { ...v, s3: { ...v.s3 } } : { ...this.defaults.backups, s3: { ...this.defaults.backups.s3 } }
        break
      }
      case 'render': {
        const v = this.read<Partial<RenderConfig>>('render')
        c.render = { ...this.defaults.render, ...v }
        break
      }
      case 'cache': {
        const v = this.read<Partial<CacheConfig>>('cache')
        c.cache = { ...this.defaults.cache, ...v }
        break
      }
      case 'database': {
        const v = this.read<{ synchronous?: SqliteSynchronous }>('database')
        const mode = v?.synchronous === 'FULL' ? 'FULL' : v?.synchronous === 'NORMAL' ? 'NORMAL' : this.defaults.sqliteSynchronous
        c.sqliteSynchronous = mode
        // The pragma is connection-local, so each process applies the project's
        // stored value to its own connection when settings refresh. It is a
        // SQLite-only setting; other backends keep their own durability config.
        if (this.db.dialect === 'sqlite') this.db.sqlite!.run(`PRAGMA synchronous = ${mode}`)
        break
      }
    }
  }

  private defaultSmtp(): SmtpConfig | null {
    return this.options.smtpDefault ? this.options.smtpDefault() : this.defaults.smtp
  }

  /**
   * OAuth provider credentials: stored values win, provider defaults fill
   * URLs, and a `disabled` marker turns the provider off even if env set it.
   */
  private applyOAuth(id: OAuthProviderId): void {
    const meta = OAUTH_PROVIDERS[id]
    const stored = this.read<Partial<OAuthConfig> | { disabled: true }>(id)
    if (stored && 'disabled' in stored) {
      this.config.oauth[id] = null
      return
    }
    const fallback = this.defaults.oauth[id] ?? null
    if (!stored) {
      this.config.oauth[id] = fallback ? { ...fallback } : null
      return
    }
    const merged = { authUrl: meta.authUrl, tokenUrl: meta.tokenUrl, ...(meta.userinfoUrl ? { userinfoUrl: meta.userinfoUrl } : {}), ...fallback, ...stored } as OAuthConfig
    merged.clientId ??= ''
    merged.clientSecret ??= ''
    this.config.oauth[id] = merged
  }

  async set(key: SettingKey, value: unknown): Promise<void> {
    await this.db.driver.run(
      'INSERT INTO _settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, JSON.stringify(value), now()],
    )
    // Keep the in-memory value in the same shape a later load() would parse.
    this.stored.set(key, JSON.parse(JSON.stringify(value)))
    this.apply(key)
    this.emit(key)
  }

  /** Forget the console value and go back to env. */
  async reset(key: SettingKey): Promise<void> {
    await this.db.driver.run('DELETE FROM _settings WHERE key = ?', [key])
    this.stored.delete(key)
    this.apply(key)
    this.emit(key)
  }

  /** Re-apply a setting without touching the stored value, after a shared default changed. */
  refresh(key: SettingKey): void {
    this.apply(key)
    this.emit(key)
  }

  /** Re-read every stored setting after the database was replaced. */
  refreshAll(): void {
    for (const key of SETTING_KEYS) this.refresh(key)
  }

  /** Observe applied changes, including refreshes of shared defaults. */
  subscribe(listener: (key: SettingKey) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(key: SettingKey): void {
    this.onChange(key)
    for (const listener of this.listeners) listener(key)
  }

  // ---------------------------------------------------------- API keys

  async listKeys(): Promise<ApiKeyRow[]> {
    const rows = await this.db.driver.all<Omit<ApiKeyRow, 'scopes'> & { scopes: string | null }>(
      'SELECT id, name, hint, scopes, expire, accessed_at, created_at FROM _api_keys ORDER BY seq',
    )
    return rows.map((row) => ({ ...row, scopes: storedApiKeyScopes(row.scopes) }))
  }

  /** Returns the secret once; only its hash is kept. `scopes` null keeps full access. */
  async createKey(name: string, expire: string | null, scopes: string[] | null = null): Promise<{ key: ApiKeyRow; secret: string }> {
    if (!name.trim()) throw err('general_argument_invalid', 'A key needs a name.')
    const secret = `standard_${randomSecret(64)}`
    const id = uniqueId()
    const stamp = now()
    await this.db.driver.run(
      'INSERT INTO _api_keys (id, name, secret_hash, hint, scopes, expire, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name.trim(), sha256(secret), secret.slice(0, 16), scopes ? JSON.stringify(scopes) : null, expire, stamp, stamp],
    )
    return { key: (await this.listKeys()).find((k) => k.id === id)!, secret }
  }

  async deleteKey(id: string): Promise<void> {
    await this.db.driver.run('DELETE FROM _api_keys WHERE id = ?', [id])
  }
}

interface CachedApiKey {
  id: string
  expire: string | null
  accessedAt: string | null
  scopes: string[] | null
}

interface ApiKeyCache {
  version: number
  entries: Map<string, CachedApiKey>
}

/** Enough for every key an instance is likely to use, without unbounded growth. */
const API_KEY_CACHE_MAX = 2_000

/**
 * One cache per SQLite connection. Triggers on `_api_keys` bump `_meta.keys`,
 * and the VersionMonitor passes that counter in, so a new or revoked key is
 * visible on the next request without a `_api_keys` lookup per request.
 */
const apiKeyCaches = new WeakMap<object, ApiKeyCache>()

async function readKeysVersion(db: SqlDatabase): Promise<number> {
  try {
    const row = await db.driver.get<{ value: number }>('SELECT value FROM _meta WHERE key = ?', ['keys'])
    return Number(row?.value ?? 0)
  } catch {
    return 0
  }
}

function apiKeyCache(db: SqlDatabase, version: number): ApiKeyCache {
  let cache = apiKeyCaches.get(db.driver)
  if (!cache) {
    cache = { version, entries: new Map() }
    apiKeyCaches.set(db.driver, cache)
  }
  if (cache.version !== version) {
    cache.entries.clear()
    cache.version = version
  }
  return cache
}

export interface ApiKeyIdentity {
  /** `_api_keys.id`, or null for an environment/internal key. */
  id: string | null
  /** Allowed scopes; null means full access. */
  scopes: string[] | null
}

/** Resolve an API key and its scopes; null when it is unknown, expired or internal-only. */
export async function resolveApiKey(db: SqlDatabase, config: Config, key: string, versions?: VersionMonitor): Promise<ApiKeyIdentity | null> {
  if (config.apiKeys.includes(key) || (config.internalKey && key === config.internalKey)) {
    return { id: null, scopes: null }
  }

  const hash = sha256(key)
  const cache = apiKeyCache(db, versions?.keysVersion() ?? (await readKeysVersion(db)))
  const stamp = now()
  const hit = cache.entries.get(hash)
  if (hit) {
    if (hit.expire && hit.expire < stamp) {
      cache.entries.delete(hash)
      return null
    }
    // Record use at most once a minute, the same as the uncached path.
    if (!hit.accessedAt || hit.accessedAt.slice(0, 16) !== stamp.slice(0, 16)) {
      await db.driver.run('UPDATE _api_keys SET accessed_at = ? WHERE id = ?', [stamp, hit.id])
      hit.accessedAt = stamp
    }
    return { id: hit.id, scopes: hit.scopes }
  }

  const row = await db.driver.get<{ id: string; scopes: string | null; expire: string | null; accessed_at: string | null }>(
    'SELECT id, scopes, expire, accessed_at FROM _api_keys WHERE secret_hash = ?',
    [hash],
  )
  if (!row) return null
  if (row.expire && row.expire < stamp) return null

  if (cache.entries.size >= API_KEY_CACHE_MAX) cache.entries.clear()
  const scopes = storedApiKeyScopes(row.scopes)
  const entry: CachedApiKey = { id: row.id, expire: row.expire, accessedAt: row.accessed_at, scopes }
  cache.entries.set(hash, entry)
  if (!row.accessed_at || row.accessed_at.slice(0, 16) !== stamp.slice(0, 16)) {
    await db.driver.run('UPDATE _api_keys SET accessed_at = ? WHERE id = ?', [stamp, row.id])
    entry.accessedAt = stamp
  }
  return { id: row.id, scopes }
}

/** Is this API key (X-Bunwrite-Key or X-Appwrite-Key) acceptable? Programmatic keys, the functions' internal key, or a live console key. */
export async function apiKeyValid(db: SqlDatabase, config: Config, key: string, versions?: VersionMonitor): Promise<boolean> {
  return (await resolveApiKey(db, config, key, versions)) !== null
}
