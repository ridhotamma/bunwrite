/**
 * First-run instance bootstrap. Generates the organization ID, project ID,
 * signing secret and an initial API key when they are not supplied by the
 * environment, and stores them in `_settings` so backups include them.
 *
 * Precedence: environment > stored value > generated value. Generated values
 * are only persisted once; changing the environment overrides them for that
 * process without rewriting the stored defaults.
 */
import type { Db } from '~/db/connection'
import { now } from '~/lib/datetime'
import { randomSecret, sha256, uniqueId } from '~/lib/ids'

const INSTANCE_KEY = 'instance'
const DEFAULT_KEY_NAME = 'Default key'

export interface InstanceInfo {
  orgId: string
  projectId: string
  secret: string
  /** Plaintext bootstrap key, kept only until the first console admin exists. */
  apiKey?: string
  createdAt: string
}

export interface BootstrapResult {
  /** Environment with the generated values filled in, for `configFromEnv`. */
  env: Record<string, string | undefined>
  orgId: string
  projectId: string
  /** Present only while there is no console admin yet. */
  apiKey?: string
  /** At least one value was generated (not merely copied from the environment). */
  generated: boolean
  /** The stored instance record was created or changed. */
  created: boolean
}

const generateOrgId = () => `org_${randomSecret(8)}`
const generateProjectId = () => `prj_${randomSecret(8)}`
const generateApiKey = () => `standard_${randomSecret(64)}`

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

function adminCount(db: Db): number {
  return (db.sqlite.query('SELECT count(*) AS n FROM _console_admins').get() as { n: number }).n
}

/** Make sure the generated key is accepted by apiKeyValid(), with only its hash stored. */
function ensureApiKeyRow(db: Db, key: string): void {
  const hash = sha256(key)
  const existing = db.sqlite.query<{ id: string }, [string]>('SELECT id FROM _api_keys WHERE secret_hash = ?').get(hash)
  if (existing) return
  const stamp = now()
  db.sqlite
    .query('INSERT INTO _api_keys (id, name, secret_hash, hint, expire, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
    .run(uniqueId(), DEFAULT_KEY_NAME, hash, key.slice(0, 16), stamp, stamp)
}

export function bootstrapInstance(db: Db, env: Record<string, string | undefined> = process.env): BootstrapResult {
  const stored = read(db)
  const info: InstanceInfo = stored ?? { orgId: '', projectId: '', secret: '', createdAt: now() }
  let generated = false
  let created = !stored

  const envOrg = env.ORG_ID?.trim()
  const envProject = env.PROJECT_ID?.trim()
  const envSecret = env.SECRET?.trim()
  const envApiKeys = env.API_KEYS?.trim()

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

  const orgId = envOrg || info.orgId
  const projectId = envProject || info.projectId
  const secret = envSecret || info.secret
  if (secret.length < 32) throw new Error('SECRET must be at least 32 characters')

  const setupComplete = adminCount(db) > 0
  let apiKey: string | undefined
  if (!envApiKeys && !setupComplete) {
    apiKey = info.apiKey || generateApiKey()
    if (!info.apiKey) {
      info.apiKey = apiKey
      generated = true
      created = true
    }
    ensureApiKeyRow(db, apiKey)
  } else if (info.apiKey) {
    // The key stays valid in _api_keys; only the plaintext copy is removed.
    delete info.apiKey
    created = true
  }

  if (created) write(db, info)

  const merged: Record<string, string | undefined> = { ...env, ORG_ID: orgId, PROJECT_ID: projectId, SECRET: secret }
  if (apiKey) merged.API_KEYS = apiKey
  return { env: merged, orgId, projectId, apiKey, generated, created }
}

/** Drop the plaintext bootstrap key after the first admin is created. */
export function clearInstanceApiKey(db: Db): void {
  const stored = read(db)
  if (!stored?.apiKey) return
  write(db, { orgId: stored.orgId, projectId: stored.projectId, secret: stored.secret, createdAt: stored.createdAt })
}
