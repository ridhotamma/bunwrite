/**
 * Built-in tables, managed by Drizzle. Collection data lives in tables made at
 * runtime from appwrite.config.json (see schema/ddl.ts), not here.
 */
import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>()
const timestamps = {
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}

export const databases = sqliteTable('_databases', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  ...timestamps,
})

export const collections = sqliteTable(
  '_collections',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    databaseId: text('database_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    documentSecurity: integer('document_security', { mode: 'boolean' }).notNull().default(true),
    permissions: json<string[]>('permissions').notNull().default(sql`'[]'`),
    attributes: json<unknown[]>('attributes').notNull().default(sql`'[]'`),
    indexes: json<unknown[]>('indexes').notNull().default(sql`'[]'`),
    ...timestamps,
  },
  (t) => [uniqueIndex('_collections_db_id').on(t.databaseId, t.id)],
)

export const transactions = sqliteTable('_transactions', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  /** pending | committing | committed | failed | rolledBack */
  status: text('status').notNull(),
  operations: integer('operations').notNull().default(0),
  expiresAt: text('expires_at').notNull(),
  /** User who opened it; null when opened with an API key. */
  userId: text('user_id'),
  ...timestamps,
})

export const transactionLogs = sqliteTable(
  '_transaction_logs',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    transactionSeq: integer('transaction_seq')
      .notNull()
      .references(() => transactions.seq, { onDelete: 'cascade' }),
    databaseId: text('database_id').notNull(),
    collectionId: text('collection_id').notNull(),
    documentId: text('document_id'),
    action: text('action').notNull(),
    data: json<unknown>('data'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('_transaction_logs_tx').on(t.transactionSeq)],
)

export const users = sqliteTable('_users', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  name: text('name').notNull().default(''),
  email: text('email').unique(),
  phone: text('phone').unique(),
  /** Password hash, in the format named by `hash`. */
  password: text('password'),
  hash: text('hash').notNull().default('argon2'),
  hashOptions: json<Record<string, unknown>>('hash_options').notNull().default(sql`'{}'`),
  registration: text('registration').notNull(),
  status: integer('status', { mode: 'boolean' }).notNull().default(true),
  labels: json<string[]>('labels').notNull().default(sql`'[]'`),
  passwordUpdate: text('password_update'),
  emailVerification: integer('email_verification', { mode: 'boolean' }).notNull().default(false),
  phoneVerification: integer('phone_verification', { mode: 'boolean' }).notNull().default(false),
  mfa: integer('mfa', { mode: 'boolean' }).notNull().default(false),
  prefs: json<Record<string, unknown>>('prefs').notNull().default(sql`'{}'`),
  accessedAt: text('accessed_at'),
  ...timestamps,
})

export const sessions = sqliteTable(
  '_sessions',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the session secret; the secret itself is never stored. */
    secretHash: text('secret_hash').notNull().unique(),
    provider: text('provider').notNull(),
    providerUid: text('provider_uid').notNull().default(''),
    providerAccessToken: text('provider_access_token').notNull().default(''),
    providerAccessTokenExpiry: text('provider_access_token_expiry').notNull().default(''),
    providerRefreshToken: text('provider_refresh_token').notNull().default(''),
    ip: text('ip').notNull().default(''),
    userAgent: text('user_agent').notNull().default(''),
    factors: json<string[]>('factors').notNull().default(sql`'[]'`),
    expire: text('expire').notNull(),
    ...timestamps,
  },
  (t) => [index('_sessions_user').on(t.userId)],
)

export const tokens = sqliteTable(
  '_tokens',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** email | recovery | verification | magic-url | oauth2 | generic */
    type: text('type').notNull(),
    /** OAuth provider for `oauth2` tokens, so the session records it. */
    provider: text('provider'),
    secretHash: text('secret_hash').notNull(),
    expire: text('expire').notNull(),
    ...timestamps,
  },
  (t) => [index('_tokens_user').on(t.userId)],
)

export const teams = sqliteTable('_teams', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  name: text('name').notNull(),
  prefs: json<Record<string, unknown>>('prefs').notNull().default(sql`'{}'`),
  ...timestamps,
})

export const memberships = sqliteTable(
  '_memberships',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roles: json<string[]>('roles').notNull().default(sql`'[]'`),
    invited: text('invited').notNull(),
    joined: text('joined'),
    confirm: integer('confirm', { mode: 'boolean' }).notNull().default(false),
    secretHash: text('secret_hash'),
    ...timestamps,
  },
  (t) => [uniqueIndex('_memberships_team_user').on(t.teamId, t.userId), index('_memberships_user').on(t.userId)],
)

/** A user's link to an OAuth provider account (Appwrite "identities"). */
export const identities = sqliteTable(
  '_identities',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerUid: text('provider_uid').notNull(),
    providerEmail: text('provider_email').notNull().default(''),
    providerAccessToken: text('provider_access_token').notNull().default(''),
    providerAccessTokenExpiry: text('provider_access_token_expiry').notNull().default(''),
    providerRefreshToken: text('provider_refresh_token').notNull().default(''),
    ...timestamps,
  },
  (t) => [uniqueIndex('_identities_provider_uid').on(t.provider, t.providerUid), index('_identities_user').on(t.userId)],
)

export const buckets = sqliteTable('_buckets', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  fileSecurity: integer('file_security', { mode: 'boolean' }).notNull().default(true),
  permissions: json<string[]>('permissions').notNull().default(sql`'[]'`),
  maximumFileSize: integer('maximum_file_size').notNull().default(30000000),
  allowedFileExtensions: json<string[]>('allowed_file_extensions').notNull().default(sql`'[]'`),
  compression: text('compression').notNull().default('none'),
  encryption: integer('encryption', { mode: 'boolean' }).notNull().default(false),
  antivirus: integer('antivirus', { mode: 'boolean' }).notNull().default(false),
  transformations: integer('transformations', { mode: 'boolean' }).notNull().default(true),
  ...timestamps,
})

export const files = sqliteTable(
  '_files',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    bucketId: text('bucket_id').notNull(),
    name: text('name').notNull(),
    permissions: json<string[]>('permissions').notNull().default(sql`'[]'`),
    signature: text('signature').notNull().default(''),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    sizeOriginal: integer('size_original').notNull().default(0),
    chunksTotal: integer('chunks_total').notNull().default(1),
    chunksUploaded: integer('chunks_uploaded').notNull().default(1),
    ...timestamps,
  },
  (t) => [uniqueIndex('_files_bucket_id').on(t.bucketId, t.id)],
)

export const functions = sqliteTable('_functions', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  name: text('name').notNull(),
  runtime: text('runtime').notNull(),
  entrypoint: text('entrypoint').notNull(),
  /** Absolute folder of the function's code. */
  path: text('path').notNull(),
  execute: json<string[]>('execute').notNull().default(sql`'[]'`),
  events: json<string[]>('events').notNull().default(sql`'[]'`),
  schedule: text('schedule').notNull().default(''),
  timeout: integer('timeout').notNull().default(15),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  scopes: json<string[]>('scopes').notNull().default(sql`'[]'`),
  ...timestamps,
})

export const executions = sqliteTable(
  '_executions',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    functionId: text('function_id').notNull(),
    trigger: text('trigger').notNull(),
    /** waiting | processing | completed | failed | scheduled */
    status: text('status').notNull(),
    requestMethod: text('request_method').notNull().default('POST'),
    requestPath: text('request_path').notNull().default('/'),
    requestHeaders: json<{ name: string; value: string }[]>('request_headers').notNull().default(sql`'[]'`),
    requestBody: text('request_body').notNull().default(''),
    responseStatusCode: integer('response_status_code').notNull().default(0),
    responseBody: text('response_body').notNull().default(''),
    responseHeaders: json<{ name: string; value: string }[]>('response_headers').notNull().default(sql`'[]'`),
    logs: text('logs').notNull().default(''),
    errors: text('errors').notNull().default(''),
    duration: real('duration').notNull().default(0),
    scheduledAt: text('scheduled_at'),
    userId: text('user_id'),
    ...timestamps,
  },
  (t) => [index('_executions_function').on(t.functionId, t.seq)],
)
