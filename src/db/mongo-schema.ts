/**
 * MongoDB bootstrap.
 *
 * Mongo creates a collection on its first write, so the only thing a fresh
 * database needs is the uniqueness and lookup indexes that the SQLite schema
 * declares, plus the `_counters` collection used to emulate `_seq`.
 *
 * Dynamic Appwrite collections get the indexes from their collection metadata
 * (`indexes.ts` in the console); a `fulltext` index becomes a Mongo text index.
 */
import type { Attribute, Index } from '~/schema/types'
import { ftsTableName } from '~/schema/types'
import type { DocumentIndex } from './driver'
import type { MongoDriver } from './mongo-driver'

interface IndexSpec {
  name: string
  keys: Record<string, 1 | -1 | 'text'>
  unique?: boolean
}

/**
 * The indexes the services rely on. Names match the SQLite indexes so a log
 * line or an operator's query can be translated between the two.
 */
const SYSTEM_INDEXES: Record<string, IndexSpec[]> = {
  _users: [
    { name: '_users_id', keys: { id: 1 }, unique: true },
    { name: '_users_email', keys: { email: 1 } },
  ],
  _sessions: [
    { name: '_sessions_id', keys: { id: 1 }, unique: true },
    { name: '_sessions_secret', keys: { secret_hash: 1 }, unique: true },
    { name: '_sessions_user', keys: { user_id: 1 } },
  ],
  _tokens: [
    { name: '_tokens_secret', keys: { secret_hash: 1 }, unique: true },
    { name: '_tokens_user', keys: { user_id: 1 } },
  ],
  _teams: [{ name: '_teams_id', keys: { id: 1 }, unique: true }],
  _memberships: [
    { name: '_memberships_id', keys: { id: 1 }, unique: true },
    { name: '_memberships_team_user', keys: { team_id: 1, user_id: 1 }, unique: true },
    { name: '_memberships_user', keys: { user_id: 1 } },
  ],
  _identities: [
    { name: '_identities_provider_uid', keys: { provider: 1, provider_uid: 1 }, unique: true },
    { name: '_identities_user', keys: { user_id: 1 } },
  ],
  _databases: [{ name: '_databases_id', keys: { id: 1 }, unique: true }],
  _collections: [{ name: '_collections_db_id', keys: { database_id: 1, id: 1 }, unique: true }],
  _projects: [{ name: '_projects_id', keys: { id: 1 }, unique: true }],
  _organizations: [{ name: '_organizations_id', keys: { id: 1 }, unique: true }],
  _organization_members: [
    { name: '_organization_members_email', keys: { organization_id: 1, email: 1 }, unique: true },
    { name: '_organization_members_org', keys: { organization_id: 1 } },
  ],
  _buckets: [{ name: '_buckets_id', keys: { id: 1 }, unique: true }],
  _files: [{ name: '_files_bucket_id', keys: { bucket_id: 1, id: 1 }, unique: true }],
  _functions: [{ name: '_functions_id', keys: { id: 1 }, unique: true }],
  _deployments: [
    { name: '_deployments_id', keys: { id: 1 }, unique: true },
    { name: '_deployments_function', keys: { function_id: 1 } },
  ],
  _sites: [{ name: '_sites_id', keys: { id: 1 }, unique: true }],
  _site_deployments: [
    { name: '_site_deployments_id', keys: { id: 1 }, unique: true },
    { name: '_site_deployments_site', keys: { site_id: 1, seq: 1 } },
  ],
  _site_branches: [{ name: '_site_branches_slug', keys: { site_id: 1, slug: 1 }, unique: true }],
  _executions: [
    { name: '_executions_id', keys: { id: 1 }, unique: true },
    { name: '_executions_function', keys: { function_id: 1, seq: 1 } },
    { name: '_executions_queue', keys: { status: 1, available_at: 1 } },
  ],
  _variables: [
    { name: '_variables_id', keys: { id: 1 }, unique: true },
    { name: '_variables_scope_key_context', keys: { scope: 1, key: 1, context: 1 }, unique: true },
  ],
  _function_vars: [{ name: '_function_vars_fn_key_context', keys: { function_id: 1, key: 1, context: 1 }, unique: true }],
  _api_keys: [
    { name: '_api_keys_id', keys: { id: 1 }, unique: true },
    { name: '_api_keys_secret', keys: { secret_hash: 1 }, unique: true },
  ],
  _console_admins: [{ name: '_console_admins_email', keys: { email: 1 }, unique: true }],
  _console_sessions: [{ name: '_console_sessions_secret', keys: { secret_hash: 1 }, unique: true }],
  _console_mfa_challenges: [{ name: '_console_mfa_challenges_secret', keys: { secret_hash: 1 }, unique: true }],
  _request_logs: [
    { name: '_request_logs_created', keys: { created_at: 1 } },
    { name: '_request_logs_status', keys: { status: 1 } },
  ],
  _queue_messages: [
    { name: '_queue_messages_claim', keys: { queue: 1, status: 1, available_at: 1, seq: 1 } },
    { name: '_queue_messages_idempotency', keys: { queue: 1, idempotency_key: 1 }, unique: true },
    { name: '_queue_messages_lease', keys: { status: 1, lease_until: 1 } },
    { name: '_queue_messages_completed', keys: { completed_at: 1 } },
  ],
  _webhooks: [{ name: '_webhooks_id', keys: { id: 1 }, unique: true }],
  _topics: [{ name: '_topics_id', keys: { id: 1 }, unique: true }],
  _vcs_installations: [{ name: '_vcs_installations_id', keys: { id: 1 }, unique: true }],
  _vcs_repositories: [
    { name: '_vcs_repositories_resource', keys: { project_id: 1, resource_type: 1, resource_id: 1 }, unique: true },
    { name: '_vcs_repositories_provider', keys: { provider_repository_id: 1 } },
  ],
  _vcs_comments: [{ name: '_vcs_comments_pr', keys: { provider_repository_id: 1, pull_request: 1 }, unique: true }],
  _proxy_rules: [{ name: '_proxy_rules_resource', keys: { resource_type: 1, resource_id: 1, seq: 1 } }],
  _transactions: [{ name: '_transactions_id', keys: { id: 1 }, unique: true }],
  _transaction_logs: [{ name: '_transaction_logs_tx', keys: { transaction_seq: 1 } }],
  _realtime_events: [{ name: '_realtime_events_created_at', keys: { created_at: 1 } }],
}

const SYSTEM_INDEX_COLUMNS: Record<string, string> = {
  $id: '_id',
  $createdAt: '_createdAt',
  $updatedAt: '_updatedAt',
  $sequence: '_seq',
}

/**
 * Mongo indexes for one Appwrite collection, mirroring `createIndexes` in
 * `schema/push.ts`. The permission table has no Mongo counterpart: permissions
 * stay in the document's own `_permissions` field, which is the shape the
 * permission filter expects.
 */
export function mongoDocumentIndexes(table: string, indexes: Index[], attributes: Attribute[]): DocumentIndex[] {
  const result: DocumentIndex[] = [
    { name: `${table}__createdAt`, keys: { _createdAt: 1 } },
    { name: `${table}__updatedAt`, keys: { _updatedAt: 1 } },
  ]
  const attributeMap = new Map(attributes.map((attribute) => [attribute.key, attribute]))
  for (const index of indexes) {
    if (index.type === 'fulltext') {
      const keys: Record<string, 1 | 'text'> = {}
      for (const key of index.attributes) keys[key] = 'text'
      result.push({ name: ftsTableName(table, index.key), keys })
      continue
    }
    const keys: Record<string, 1 | -1> = {}
    index.attributes.forEach((key, i) => {
      const column = SYSTEM_INDEX_COLUMNS[key] ?? key
      if (!SYSTEM_INDEX_COLUMNS[key] && !attributeMap.has(key)) {
        throw new Error(`Index ${index.key} on ${table} uses unknown attribute ${key}`)
      }
      keys[column] = (index.orders[i] ?? 'ASC').toUpperCase() === 'DESC' ? -1 : 1
    })
    result.push({ name: `${table}__idx_${index.key}`, keys, unique: index.type === 'unique' })
  }
  return result
}

export interface MongoSchemaOptions {
  log?: (line: string) => void
}

/**
 * Create the built-in indexes and the counter collection. Safe to run on every
 * boot: `createIndex` is idempotent and `_counters` is only written on demand.
 */
export async function ensureMongoSchema(driver: MongoDriver, options: MongoSchemaOptions = {}): Promise<void> {
  const log = options.log ?? (() => {})
  await driver.ping()
  for (const [collection, indexes] of Object.entries(SYSTEM_INDEXES)) {
    const target = driver.collection(collection)
    for (const index of indexes) await target.createIndex(index)
  }
  // `_settings` and `_meta` are keyed by their Mongo `_id`; no extra index is
  // needed. `_counters` is created on the first write, atomically.
  log('mongodb schema is current')
}
