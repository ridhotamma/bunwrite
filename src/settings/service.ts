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
import type { Db } from '~/db/connection'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { randomSecret, sha256, uniqueId } from '~/lib/ids'

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
]

const cloneOAuth = (oauth: Config['oauth']): Config['oauth'] =>
  Object.fromEntries(Object.entries(oauth).map(([id, config]) => [id, config ? { ...config } : config])) as Config['oauth']

export interface ApiKeyRow {
  id: string
  name: string
  hint: string
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
  >
  private readonly listeners = new Set<(key: SettingKey) => void>()

  constructor(
    private db: Db,
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
    }
    for (const key of SETTING_KEYS) this.apply(key)
  }

  private read<T>(key: SettingKey): T | null {
    const row = this.db.sqlite.query<{ value: string }, [string]>('SELECT value FROM _settings WHERE key = ?').get(key)
    return row ? (JSON.parse(row.value) as T) : null
  }

  /** Whether a setting comes from the console rather than env. */
  overridden(key: SettingKey): boolean {
    return this.read(key) !== null
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

  set(key: SettingKey, value: unknown): void {
    this.db.sqlite
      .query('INSERT INTO _settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), now())
    this.apply(key)
    this.emit(key)
  }

  /** Forget the console value and go back to env. */
  reset(key: SettingKey): void {
    this.db.sqlite.query('DELETE FROM _settings WHERE key = ?').run(key)
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

  listKeys(): ApiKeyRow[] {
    return this.db.sqlite.query<ApiKeyRow, []>('SELECT id, name, hint, expire, accessed_at, created_at FROM _api_keys ORDER BY seq').all()
  }

  /** Returns the secret once; only its hash is kept. */
  createKey(name: string, expire: string | null): { key: ApiKeyRow; secret: string } {
    if (!name.trim()) throw err('general_argument_invalid', 'A key needs a name.')
    const secret = `standard_${randomSecret(64)}`
    const id = uniqueId()
    const stamp = now()
    this.db.sqlite
      .query('INSERT INTO _api_keys (id, name, secret_hash, hint, expire, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, name.trim(), sha256(secret), secret.slice(0, 16), expire, stamp, stamp)
    return { key: this.listKeys().find((k) => k.id === id)!, secret }
  }

  deleteKey(id: string): void {
    this.db.sqlite.query('DELETE FROM _api_keys WHERE id = ?').run(id)
  }
}

interface CachedApiKey {
  id: string
  expire: string | null
  accessedAt: string | null
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

function readKeysVersion(db: Db): number {
  try {
    const row = db.sqlite.query<{ value: number }, [string]>('SELECT value FROM _meta WHERE key = ?').get('keys')
    return Number(row?.value ?? 0)
  } catch {
    return 0
  }
}

function apiKeyCache(db: Db, version = readKeysVersion(db)): ApiKeyCache {
  let cache = apiKeyCaches.get(db.sqlite)
  if (!cache) {
    cache = { version, entries: new Map() }
    apiKeyCaches.set(db.sqlite, cache)
  }
  if (cache.version !== version) {
    cache.entries.clear()
    cache.version = version
  }
  return cache
}

/** Is this API key (X-Bunwrite-Key or X-Appwrite-Key) acceptable? Programmatic keys, the functions' internal key, or a live console key. */
export function apiKeyValid(db: Db, config: Config, key: string, versions?: VersionMonitor): boolean {
  if (config.apiKeys.includes(key) || (config.internalKey && key === config.internalKey)) return true

  const hash = sha256(key)
  const cache = apiKeyCache(db, versions?.keysVersion())
  const stamp = now()
  const hit = cache.entries.get(hash)
  if (hit) {
    if (hit.expire && hit.expire < stamp) {
      cache.entries.delete(hash)
      return false
    }
    // Record use at most once a minute, the same as the uncached path.
    if (!hit.accessedAt || hit.accessedAt.slice(0, 16) !== stamp.slice(0, 16)) {
      db.sqlite.query('UPDATE _api_keys SET accessed_at = ? WHERE id = ?').run(stamp, hit.id)
      hit.accessedAt = stamp
    }
    return true
  }

  const row = db.sqlite
    .query<{ id: string; expire: string | null; accessed_at: string | null }, [string]>('SELECT id, expire, accessed_at FROM _api_keys WHERE secret_hash = ?')
    .get(hash)
  if (!row) return false
  if (row.expire && row.expire < stamp) return false

  if (cache.entries.size >= API_KEY_CACHE_MAX) cache.entries.clear()
  const entry: CachedApiKey = { id: row.id, expire: row.expire, accessedAt: row.accessed_at }
  cache.entries.set(hash, entry)
  if (!row.accessed_at || row.accessed_at.slice(0, 16) !== stamp.slice(0, 16)) {
    db.sqlite.query('UPDATE _api_keys SET accessed_at = ? WHERE id = ?').run(stamp, row.id)
    entry.accessedAt = stamp
  }
  return true
}
