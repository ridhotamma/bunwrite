/**
 * First-run instance bootstrap. Generates the organization ID, project ID,
 * signing secret and an initial API key when they are not supplied, and stores
 * them in `_settings` so backups include them.
 *
 * Precedence: stored value > environment seed > generated value. Environment
 * project settings are imported once into `_settings` / `_api_keys` (the
 * "env_seed" marker records that), then ignored: the database is the source of
 * truth and later changes belong in the console.
 */
import type { Config } from '~/config'
import { list, OAUTH_PROVIDER_IDS, oauthFromEnv, smtpFromEnv } from '~/config'
import type { Db } from '~/db/connection'
import { now } from '~/lib/datetime'
import { randomSecret, sha256, uniqueId } from '~/lib/ids'

const INSTANCE_KEY = 'instance'
const SEED_KEY = 'env_seed'
const SEED_VERSION = 1
const DEFAULT_KEY_NAME = 'Default key'
const SEEDED_KEY_NAME = 'Imported from env'
const DEFAULT_PROJECT_NAME = 'Bunwrite'

export interface InstanceInfo {
  orgId: string
  projectId: string
  projectName: string
  secret: string
  /** Plaintext bootstrap key, kept only until the first console admin exists. */
  apiKey?: string
  createdAt: string
}

export interface BootstrapResult {
  orgId: string
  projectId: string
  projectName: string
  secret: string
  /** Present only while there is no console admin yet. */
  apiKey?: string
  /** At least one value was generated (not merely copied from the environment). */
  generated: boolean
  /** The stored instance record was created or changed. */
  created: boolean
  /** Environment variables ignored because the database already has values. */
  ignoredEnv: string[]
}

export interface BootstrapOptions {
  /** Set false when re-opening an existing project DB: never mint another key. */
  generateApiKey?: boolean
}

interface SeedInfo {
  version: number
  at: string
}

interface ProjectSettingsSeed {
  projectName?: string
  allowedOrigins?: string[]
  sessionDuration?: number
  sessionsLimit?: number
}

const generateOrgId = () => `org_${randomSecret(8)}`
const generateProjectId = () => `prj_${randomSecret(8)}`
const generateApiKeyValue = () => `standard_${randomSecret(64)}`

function read(db: Db): InstanceInfo | null {
  const row = db.sqlite.query<{ value: string }, [string]>('SELECT value FROM _settings WHERE key = ?').get(INSTANCE_KEY)
  if (!row) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(row.value) as Record<string, unknown>
  } catch {
    throw new Error('The instance record in _settings is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The instance record in _settings must be a JSON object.')
  }
  return {
    orgId: typeof parsed.orgId === 'string' ? parsed.orgId : '',
    projectId: typeof parsed.projectId === 'string' ? parsed.projectId : '',
    projectName: typeof parsed.projectName === 'string' ? parsed.projectName : '',
    secret: typeof parsed.secret === 'string' ? parsed.secret : '',
    apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : now(),
  }
}

function write(db: Db, info: InstanceInfo): void {
  db.sqlite
    .query('INSERT INTO _settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(INSTANCE_KEY, JSON.stringify(info), now())
}

function readSetting<T>(db: Db, key: string): T | null {
  const row = db.sqlite.query<{ value: string }, [string]>('SELECT value FROM _settings WHERE key = ?').get(key)
  return row ? (JSON.parse(row.value) as T) : null
}

function writeSetting(db: Db, key: string, value: unknown): void {
  db.sqlite
    .query('INSERT INTO _settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), now())
}

function adminCount(db: Db): number {
  return (db.sqlite.query('SELECT count(*) AS n FROM _console_admins').get() as { n: number }).n
}

/** The name the console already uses for this project, when it exists. */
function storedProjectName(db: Db, projectId: string): string {
  const row = db.sqlite.query<{ name: string }, [string]>('SELECT name FROM _projects WHERE id = ?').get(projectId)
  return row?.name ?? ''
}

/** Make sure the key is accepted by apiKeyValid(), with only its hash stored. */
function ensureApiKeyRow(db: Db, key: string, name = DEFAULT_KEY_NAME): void {
  const hash = sha256(key)
  const existing = db.sqlite.query<{ id: string }, [string]>('SELECT id FROM _api_keys WHERE secret_hash = ?').get(hash)
  if (existing) return
  const stamp = now()
  db.sqlite
    .query('INSERT INTO _api_keys (id, name, secret_hash, hint, expire, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
    .run(uniqueId(), name, hash, key.slice(0, 16), stamp, stamp)
}

/** Import old env API keys once, so they appear in the console and can be revoked. */
function importEnvApiKeys(db: Db, keys: string[]): void {
  for (const key of keys) ensureApiKeyRow(db, key, SEEDED_KEY_NAME)
}

function validPositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}

function validNonNegative(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

/**
 * Copy project settings from the environment into `_settings` the first time
 * this code sees the database. Values already set in the console win, so an
 * upgrade does not overwrite them.
 */
function seedProjectSettings(db: Db, env: Record<string, string | undefined>, projectName: string): void {
  const project = readSetting<ProjectSettingsSeed>(db, 'project')
  const origins = env.ALLOWED_ORIGINS !== undefined ? list(env.ALLOWED_ORIGINS) : undefined
  const duration = env.SESSION_DURATION !== undefined ? Number(env.SESSION_DURATION) : undefined
  const limit = env.SESSIONS_LIMIT !== undefined ? Number(env.SESSIONS_LIMIT) : undefined
  if (origins !== undefined || validPositive(duration) || validNonNegative(limit)) {
    writeSetting(db, 'project', {
      projectName: project?.projectName || projectName,
      allowedOrigins: project?.allowedOrigins ?? origins ?? [],
      sessionDuration: project?.sessionDuration ?? (validPositive(duration) ? duration : 31536000),
      sessionsLimit: project?.sessionsLimit ?? (validNonNegative(limit) ? limit : 10),
    } satisfies ProjectSettingsSeed)
  }

  const smtp = smtpFromEnv(env)
  if (smtp && !readSetting<Config['smtp']>(db, 'smtp')) writeSetting(db, 'smtp', smtp)

  const providers = oauthFromEnv(env)
  for (const id of OAUTH_PROVIDER_IDS) {
    const provider = providers[id]
    if (provider && !readSetting(db, id)) writeSetting(db, id, provider)
  }

  if (env.FUNCTIONS_SKIP_SCHEDULES !== undefined) {
    const functions = readSetting<{ skipSchedules?: string[]; functionsDir?: string }>(db, 'functions')
    if (!functions?.skipSchedules) writeSetting(db, 'functions', { ...functions, skipSchedules: list(env.FUNCTIONS_SKIP_SCHEDULES) })
  }

  if (env.API_KEYS !== undefined) importEnvApiKeys(db, list(env.API_KEYS))

  writeSetting(db, SEED_KEY, { version: SEED_VERSION, at: now() } satisfies SeedInfo)
}

/** Project env values that are set after the initial seed but no longer apply. */
function ignoredEnvironment(
  env: Record<string, string | undefined>,
  info: InstanceInfo,
  projectName: string,
): string[] {
  const ignored: string[] = []
  if (env.ORG_ID?.trim() && env.ORG_ID.trim() !== info.orgId) ignored.push('ORG_ID')
  if (env.PROJECT_ID?.trim() && env.PROJECT_ID.trim() !== info.projectId) ignored.push('PROJECT_ID')
  if (env.SECRET?.trim() && env.SECRET.trim() !== info.secret) ignored.push('SECRET')
  if (env.PROJECT_NAME?.trim() && env.PROJECT_NAME.trim() !== projectName) ignored.push('PROJECT_NAME')
  if (list(env.API_KEYS).length) ignored.push('API_KEYS')
  if (env.ALLOWED_ORIGINS !== undefined && list(env.ALLOWED_ORIGINS).length) ignored.push('ALLOWED_ORIGINS')
  if (env.SESSION_DURATION?.trim()) ignored.push('SESSION_DURATION')
  if (env.SESSIONS_LIMIT?.trim()) ignored.push('SESSIONS_LIMIT')
  if (env.SMTP_HOST) ignored.push('SMTP_*')
  for (const id of OAUTH_PROVIDER_IDS) {
    const prefix = id.toUpperCase()
    const names = [`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`, `${prefix}_AUTH_URL`, `${prefix}_TOKEN_URL`, `${prefix}_USERINFO_URL`]
    if (id === 'apple') names.push('APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY')
    if (names.some((name) => env[name])) ignored.push(`${prefix}_*`)
  }
  if (env.FUNCTIONS_SKIP_SCHEDULES !== undefined && list(env.FUNCTIONS_SKIP_SCHEDULES).length) ignored.push('FUNCTIONS_SKIP_SCHEDULES')
  return ignored
}

export function bootstrapInstance(
  db: Db,
  env: Record<string, string | undefined> = process.env,
  options: BootstrapOptions = {},
): BootstrapResult {
  const generateApiKey = options.generateApiKey ?? true
  const stored = read(db)
  const info: InstanceInfo = stored ?? { orgId: '', projectId: '', projectName: '', secret: '', createdAt: now() }
  let generated = false
  let created = !stored

  const envOrg = env.ORG_ID?.trim()
  const envProject = env.PROJECT_ID?.trim()
  const envSecret = env.SECRET?.trim()
  const envName = env.PROJECT_NAME?.trim()

  // Stored values win. The environment only fills fields that are missing,
  // which is how a new database (and a legacy partial record) gets seeded.
  if (!info.orgId) {
    info.orgId = envOrg || generateOrgId()
    created = true
    if (!envOrg) generated = true
  }
  if (!info.projectId) {
    info.projectId = envProject || generateProjectId()
    created = true
    if (!envProject) generated = true
  }
  if (!info.secret) {
    info.secret = envSecret || randomSecret(32)
    created = true
    if (!envSecret) generated = true
  }
  if (info.secret.length < 32) throw new Error('SECRET must be at least 32 characters')

  if (!info.projectName) {
    info.projectName = storedProjectName(db, info.projectId) || envName || DEFAULT_PROJECT_NAME
    created = true
  }

  const seeded = readSetting<SeedInfo>(db, SEED_KEY) !== null
  if (!seeded) seedProjectSettings(db, env, info.projectName)
  const configuredName =
    readSetting<ProjectSettingsSeed>(db, 'project')?.projectName || storedProjectName(db, info.projectId) || info.projectName
  if (configuredName && info.projectName !== configuredName) {
    info.projectName = configuredName
    created = true
  }

  const setupComplete = adminCount(db) > 0
  const envKeysSeeded = !seeded && env.API_KEYS !== undefined && list(env.API_KEYS).length > 0
  let apiKey: string | undefined
  if (!envKeysSeeded && !setupComplete && generateApiKey) {
    apiKey = info.apiKey || generateApiKeyValue()
    if (!info.apiKey) {
      info.apiKey = apiKey
      generated = true
      created = true
    }
    ensureApiKeyRow(db, apiKey)
  }
  if (setupComplete && info.apiKey) {
    // The key stays valid in _api_keys; only the plaintext copy is removed.
    delete info.apiKey
    created = true
  }

  if (created) write(db, info)

  return {
    orgId: info.orgId,
    projectId: info.projectId,
    projectName: configuredName,
    secret: info.secret,
    apiKey,
    generated,
    created,
    ignoredEnv: seeded ? ignoredEnvironment(env, info, configuredName) : [],
  }
}

/** Drop the plaintext bootstrap key after the first admin is created. */
export function clearInstanceApiKey(db: Db): void {
  const stored = read(db)
  if (!stored?.apiKey) return
  write(db, { ...stored, apiKey: undefined })
}
