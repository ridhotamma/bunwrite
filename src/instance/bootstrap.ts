/**
 * First-run instance bootstrap. Generates the organization ID, project ID,
 * signing secret and an initial API key when they are not supplied, and stores
 * them in `_settings` so backups include them.
 *
 * Precedence: stored value > environment seed > generated value. Only the
 * instance identity (organisation ID, project ID and signing secret) can be
 * seeded from the environment. Project settings, API keys, SMTP and OAuth live
 * in the console and are never read from `.env`.
 *
 * The decision logic is shared by both entries at the bottom: `bootstrapInstance`
 * keeps the synchronous SQLite boot path, `bootstrapInstanceAsync` runs the same
 * plan through the driver port on Postgres.
 */
import type { Database } from 'bun:sqlite'

import type { Config } from '~/config'
import type { SqlDatabase, SqlExecutor } from '~/db/driver'
import { now } from '~/lib/datetime'
import { randomSecret, sha256, uniqueId } from '~/lib/ids'

const INSTANCE_KEY = 'instance'
const SEED_KEY = 'env_seed'
const SEED_VERSION = 1
const DEFAULT_KEY_NAME = 'Default key'
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
  /** Set false for project databases: the console SMTP belongs to the control instance. */
  seedConsoleSmtp?: boolean
  /** Name for a newly created instance; the console can change it later. */
  projectName?: string
}

interface SeedInfo {
  version: number
  at: string
}

interface ProjectSettingsSeed {
  projectName?: string
}

interface Snapshot {
  /** Raw `_settings` values, keyed by setting name. */
  settings: Map<string, string>
  adminCount: number
  projectNames: Map<string, string>
  apiKeyHashes: Set<string>
}

interface NewApiKey {
  hash: string
  name: string
  hint: string
}

interface Plan {
  result: BootstrapResult
  /** Only settings this boot changed; rewriting every row would bump versions. */
  settings: Map<string, string>
  apiKeys: NewApiKey[]
  /** Bootstrap keys to revoke once a console admin exists. */
  deleteApiKeys: string[]
  instance?: InstanceInfo
}

const generateOrgId = () => `org_${randomSecret(8)}`
const generateProjectId = () => `prj_${randomSecret(8)}`
const generateApiKeyValue = () => `standard_${randomSecret(64)}`

function snapshotOf(
  settings: Array<{ key: string; value: string }>,
  adminCount: number | string,
  projects: Array<{ id: string; name: string }>,
  keys: Array<{ secret_hash: string }>,
): Snapshot {
  return {
    settings: new Map(settings.map((row) => [row.key, row.value])),
    adminCount: Number(adminCount) || 0,
    projectNames: new Map(projects.map((row) => [row.id, row.name])),
    apiKeyHashes: new Set(keys.map((row) => row.secret_hash)),
  }
}

function snapshotSync(db: Database): Snapshot {
  return snapshotOf(
    db.query<{ key: string; value: string }, []>('SELECT key, value FROM _settings').all(),
    (db.query('SELECT count(*) AS n FROM _console_admins').get() as { n: number }).n,
    db.query<{ id: string; name: string }, []>('SELECT id, name FROM _projects').all(),
    db.query<{ secret_hash: string }, []>('SELECT secret_hash FROM _api_keys').all(),
  )
}

async function snapshotAsync(tx: SqlExecutor): Promise<Snapshot> {
  return snapshotOf(
    await tx.all<{ key: string; value: string }>('SELECT key, value FROM _settings'),
    (await tx.get<{ n: number | string }>('SELECT count(*) AS n FROM _console_admins'))?.n ?? 0,
    await tx.all<{ id: string; name: string }>('SELECT id, name FROM _projects'),
    await tx.all<{ secret_hash: string }>('SELECT secret_hash FROM _api_keys'),
  )
}

/** Parse a stored instance row the same way on both paths. */
function instanceOf(raw: string | undefined): InstanceInfo | null {
  if (raw === undefined) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
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

/** Identity env values that are set after the initial seed but no longer apply. */
function ignoredEnvironment(env: Record<string, string | undefined>, info: InstanceInfo): string[] {
  const ignored: string[] = []
  if (env.ORG_ID?.trim() && env.ORG_ID.trim() !== info.orgId) ignored.push('ORG_ID')
  if (env.PROJECT_ID?.trim() && env.PROJECT_ID.trim() !== info.projectId) ignored.push('PROJECT_ID')
  if (env.SECRET?.trim() && env.SECRET.trim() !== info.secret) ignored.push('SECRET')
  return ignored
}

/**
 * Compute every write first, against one snapshot. The caller applies the plan
 * inside a single transaction, so two workers booting together cannot each
 * create a different instance record.
 */
function planBootstrap(
  snapshot: Snapshot,
  env: Record<string, string | undefined>,
  options: BootstrapOptions,
): Plan {
  const settings = new Map(snapshot.settings)
  const dirty = new Set<string>()
  const hashes = new Set(snapshot.apiKeyHashes)
  const apiKeys: NewApiKey[] = []
  const deleteApiKeys: string[] = []

  const readSetting = <T>(key: string): T | null => {
    const raw = settings.get(key)
    return raw === undefined ? null : (JSON.parse(raw) as T)
  }

  const writeSetting = (key: string, value: unknown): void => {
    settings.set(key, JSON.stringify(value))
    dirty.add(key)
  }

  const storedProjectName = (projectId: string): string => snapshot.projectNames.get(projectId) ?? ''

  const ensureApiKeyRow = (key: string, name = DEFAULT_KEY_NAME): void => {
    const hash = sha256(key)
    if (hashes.has(hash)) return
    hashes.add(hash)
    apiKeys.push({ hash, name, hint: key.slice(0, 16) })
  }

  /**
   * Mark that the one-time environment seeding was considered. Project
   * settings are console-only; the marker lets a later boot report identity
   * variables that no longer apply.
   */
  const seedProjectSettings = (): void => {
    writeSetting(SEED_KEY, { version: SEED_VERSION, at: now() } satisfies SeedInfo)
  }

  const generateApiKey = options.generateApiKey ?? true
  const stored = instanceOf(settings.get(INSTANCE_KEY))
  const info: InstanceInfo = stored ?? { orgId: '', projectId: '', projectName: '', secret: '', createdAt: now() }
  let generated = false
  let created = !stored

  const envOrg = env.ORG_ID?.trim()
  const envProject = env.PROJECT_ID?.trim()
  const envSecret = env.SECRET?.trim()
  const nameHint = options.projectName?.trim()

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
    info.projectName = storedProjectName(info.projectId) || nameHint || DEFAULT_PROJECT_NAME
    created = true
  }

  const seeded = readSetting<SeedInfo>(SEED_KEY) !== null
  if (!seeded) seedProjectSettings()
  // Before the console SMTP was split from project SMTP, both used the `smtp`
  // setting. Copy the old value once so existing MFA and sign-in codes keep
  // working while the default project can now change its own SMTP.
  if (options.seedConsoleSmtp !== false && !readSetting<Config['consoleSmtp']>('consoleSmtp')) {
    const legacy = readSetting<Config['smtp'] | { disabled: true }>('smtp')
    if (legacy) writeSetting('consoleSmtp', legacy)
  }
  const configuredName =
    readSetting<ProjectSettingsSeed>('project')?.projectName || storedProjectName(info.projectId) || info.projectName
  if (configuredName && info.projectName !== configuredName) {
    info.projectName = configuredName
    created = true
  }

  const setupComplete = snapshot.adminCount > 0
  let apiKey: string | undefined
  if (!setupComplete && generateApiKey) {
    apiKey = info.apiKey || generateApiKeyValue()
    if (!info.apiKey) {
      info.apiKey = apiKey
      generated = true
      created = true
    }
    ensureApiKeyRow(apiKey)
  }
  if (setupComplete && info.apiKey) {
    // Revoke the bootstrap key itself, not just its plaintext copy: a copy in
    // an old log or terminal must stop working once an admin exists.
    deleteApiKeys.push(sha256(info.apiKey))
    delete info.apiKey
    created = true
  }

  return {
    result: {
      orgId: info.orgId,
      projectId: info.projectId,
      projectName: configuredName,
      secret: info.secret,
      apiKey,
      generated,
      created,
      ignoredEnv: seeded ? ignoredEnvironment(env, info) : [],
    },
    settings: new Map([...dirty].map((key) => [key, settings.get(key)!])),
    apiKeys,
    deleteApiKeys,
    instance: created ? info : undefined,
  }
}

const UPSERT_SETTING =
  'INSERT INTO _settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
const INSERT_API_KEY = 'INSERT INTO _api_keys (id, name, secret_hash, hint, expire, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)'
const UPSERT_INSTANCE = UPSERT_SETTING

function applyPlanSync(db: Database, plan: Plan): void {
  const stamp = now()
  const setting = db.query(UPSERT_SETTING)
  for (const [key, value] of plan.settings) setting.run(key, value, stamp)
  const removeKey = db.query('DELETE FROM _api_keys WHERE secret_hash = ?')
  for (const hash of plan.deleteApiKeys) removeKey.run(hash)
  const apiKey = db.query(INSERT_API_KEY)
  for (const row of plan.apiKeys) apiKey.run(uniqueId(), row.name, row.hash, row.hint, stamp, stamp)
  if (plan.instance) setting.run(INSTANCE_KEY, JSON.stringify(plan.instance), stamp)
}

async function applyPlanAsync(tx: SqlExecutor, plan: Plan): Promise<void> {
  const stamp = now()
  for (const [key, value] of plan.settings) await tx.run(UPSERT_SETTING, [key, value, stamp])
  for (const hash of plan.deleteApiKeys) await tx.run('DELETE FROM _api_keys WHERE secret_hash = ?', [hash])
  for (const row of plan.apiKeys) await tx.run(INSERT_API_KEY, [uniqueId(), row.name, row.hash, row.hint, stamp, stamp])
  if (plan.instance) await tx.run(UPSERT_INSTANCE, [INSTANCE_KEY, JSON.stringify(plan.instance), stamp])
}

/**
 * Synchronous SQLite bootstrap. The transaction is `IMMEDIATE`, so workers
 * booting at the same time cannot each read an empty instance record and store
 * different secrets.
 */
export function bootstrapInstance(
  db: SqlDatabase,
  env: Record<string, string | undefined> = process.env,
  options: BootstrapOptions = {},
): BootstrapResult {
  const sqlite = db.sqlite
  if (!sqlite) throw new Error('bootstrapInstance is the synchronous SQLite entry point; use bootstrapInstanceAsync for a network backend.')
  return sqlite
    .transaction(() => {
      const plan = planBootstrap(snapshotSync(sqlite), env, options)
      applyPlanSync(sqlite, plan)
      return plan.result
    })
    .immediate()
}

/** The same bootstrap through the driver port (Postgres, or SQLite when called directly). */
export async function bootstrapInstanceAsync(
  db: SqlDatabase,
  env: Record<string, string | undefined> = process.env,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  return db.driver.transaction(async (tx) => {
    // The SQLite driver already takes its write lock; Postgres needs an
    // explicit one so two workers cannot race the read-then-write sequence.
    if (db.dialect === 'postgres') await tx.exec(`SELECT pg_advisory_xact_lock(hashtext('bunwrite:instance-bootstrap'))`)
    const plan = planBootstrap(await snapshotAsync(tx), env, options)
    await applyPlanAsync(tx, plan)
    return plan.result
  })
}

/** Drop the plaintext bootstrap key after the first admin is created (SQLite). */
export function clearInstanceApiKey(db: SqlDatabase, revoke = true): void {
  const sqlite = db.sqlite
  if (!sqlite) throw new Error('clearInstanceApiKey is the synchronous SQLite entry point; use clearInstanceApiKeyAsync for a network backend.')
  sqlite
    .transaction(() => {
      const row = sqlite.query<{ value: string }, [string]>('SELECT value FROM _settings WHERE key = ?').get(INSTANCE_KEY)
      const stored = instanceOf(row?.value)
      if (!stored?.apiKey) return
      applyPlanSync(sqlite, {
        result: { orgId: stored.orgId, projectId: stored.projectId, projectName: stored.projectName, secret: stored.secret, generated: false, created: true, ignoredEnv: [] },
        settings: new Map(),
        apiKeys: [],
        // `revoke: false` keeps a key returned to a caller (new project).
        deleteApiKeys: revoke ? [sha256(stored.apiKey)] : [],
        instance: { ...stored, apiKey: undefined },
      })
    })
    .immediate()
}

/** Drop the plaintext bootstrap key after the first admin is created (network backend). */
export async function clearInstanceApiKeyAsync(db: SqlDatabase, revoke = true): Promise<void> {
  await db.driver.transaction(async (tx) => {
    const row = await tx.get<{ value: string }>('SELECT value FROM _settings WHERE key = ?', [INSTANCE_KEY])
    const stored = instanceOf(row?.value)
    if (!stored?.apiKey) return
    await applyPlanAsync(tx, {
      result: { orgId: stored.orgId, projectId: stored.projectId, projectName: stored.projectName, secret: stored.secret, generated: false, created: true, ignoredEnv: [] },
      settings: new Map(),
      apiKeys: [],
      deleteApiKeys: revoke ? [sha256(stored.apiKey)] : [],
      instance: { ...stored, apiKey: undefined },
    })
  })
}
