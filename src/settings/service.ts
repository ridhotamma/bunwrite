/**
 * Project settings edited in the console. Stored in `_settings` and applied
 * over the env-derived Config in place, so the next request sees them; env
 * values remain the defaults. API keys made here live in `_api_keys`.
 */
import type { BackupsConfig, Config, GoogleConfig, S3Config, SmtpConfig } from '~/config'
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

export type SettingKey = 'project' | 'smtp' | 'google' | 'functions' | 'logs' | 's3' | 'backups'

export interface ApiKeyRow {
  id: string
  name: string
  hint: string
  expire: string | null
  accessed_at: string | null
  created_at: string
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
    | 'google'
    | 'skipSchedules'
    | 'functionsDir'
    | 'logRetentionDays'
    | 'logIp'
    | 's3'
    | 'backups'
  >

  constructor(
    private db: Db,
    private config: Config,
    private onChange: (key: SettingKey) => void = () => {},
  ) {
    this.defaults = {
      projectName: config.projectName,
      allowedOrigins: [...config.allowedOrigins],
      sessionDuration: config.sessionDuration,
      sessionsLimit: config.sessionsLimit,
      smtp: config.smtp ? { ...config.smtp } : null,
      google: config.google ? { ...config.google } : null,
      skipSchedules: [...config.skipSchedules],
      functionsDir: config.functionsDir,
      logRetentionDays: config.logRetentionDays,
      logIp: config.logIp,
      s3: { ...config.s3 },
      backups: { ...config.backups, s3: { ...config.backups.s3 } },
    }
    for (const key of ['project', 'smtp', 'google', 'functions', 'logs', 's3', 'backups'] as SettingKey[]) this.apply(key)
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
        c.smtp = v === null ? this.defaults.smtp : 'disabled' in v ? null : v
        break
      }
      case 'google': {
        const v = this.read<Partial<GoogleConfig> | { disabled: true }>('google')
        if (v === null) c.google = this.defaults.google
        else if ('disabled' in v) c.google = null
        else
          c.google = {
            authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            userinfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
            ...v,
          } as GoogleConfig
        break
      }
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
    }
  }

  set(key: SettingKey, value: unknown): void {
    this.db.sqlite
      .query('INSERT INTO _settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), now())
    this.apply(key)
    this.onChange(key)
  }

  /** Forget the console value and go back to env. */
  reset(key: SettingKey): void {
    this.db.sqlite.query('DELETE FROM _settings WHERE key = ?').run(key)
    this.apply(key)
    this.onChange(key)
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

/** Is this X-Appwrite-Key acceptable? Env keys, the functions' internal key, or a live console key. */
export function apiKeyValid(db: Db, config: Config, key: string): boolean {
  if (config.apiKeys.includes(key) || (config.internalKey && key === config.internalKey)) return true
  const row = db.sqlite
    .query<{ id: string; expire: string | null; accessed_at: string | null }, [string]>('SELECT id, expire, accessed_at FROM _api_keys WHERE secret_hash = ?')
    .get(sha256(key))
  if (!row) return false
  const stamp = now()
  if (row.expire && row.expire < stamp) return false
  // Record use at most once a minute.
  if (!row.accessed_at || row.accessed_at.slice(0, 16) !== stamp.slice(0, 16)) {
    db.sqlite.query('UPDATE _api_keys SET accessed_at = ? WHERE id = ?').run(stamp, row.id)
  }
  return true
}
