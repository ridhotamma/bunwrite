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

/** A function's or site's Git repository (Appwrite's provider* settings); empty when not connected. */
const providerSettings = {
  installationId: text('installation_id').notNull().default(''),
  providerRepositoryId: text('provider_repository_id').notNull().default(''),
  providerBranch: text('provider_branch').notNull().default(''),
  providerRootDirectory: text('provider_root_directory').notNull().default(''),
  providerSilentMode: integer('provider_silent_mode', { mode: 'boolean' }).notNull().default(false),
}

/** Where a deployment's code came from: `manual` uploads, or a `vcs` commit. */
const deploymentSource = {
  type: text('type').notNull().default('manual'),
  providerRepository: text('provider_repository').notNull().default(''),
  providerBranch: text('provider_branch').notNull().default(''),
  providerCommitHash: text('provider_commit_hash').notNull().default(''),
  providerCommitMessage: text('provider_commit_message').notNull().default(''),
  providerCommitAuthor: text('provider_commit_author').notNull().default(''),
  providerCommitAuthorUrl: text('provider_commit_author_url').notNull().default(''),
  providerCommitUrl: text('provider_commit_url').notNull().default(''),
  /** Pull request number for a fork's PR; 0 otherwise. */
  providerPullRequest: integer('provider_pull_request').notNull().default(0),
}

/** Project registry in the control database. Each project has its own database file. */
export const projects = sqliteTable('_projects', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  name: text('name').notNull(),
  orgId: text('org_id').notNull(),
  ...timestamps,
})

/** Organization owning the projects on this instance. */
export const organizations = sqliteTable('_organizations', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  name: text('name').notNull(),
  ...timestamps,
})

/** Console users who belong to an organization, including pending invitations. */
export const organizationMembers = sqliteTable(
  '_organization_members',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    organizationId: text('organization_id').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull().default(''),
    /** owner | developer */
    role: text('role').notNull().default('developer'),
    /** invited | active */
    status: text('status').notNull().default('invited'),
    inviteHash: text('invite_hash'),
    invitedAt: text('invited_at').notNull(),
    joinedAt: text('joined_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('_organization_members_email').on(t.organizationId, t.email),
    index('_organization_members_org').on(t.organizationId),
    uniqueIndex('_organization_members_invite').on(t.inviteHash),
  ],
)

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
  /** Build command run on each new deployment. */
  commands: text('commands').notNull().default(''),
  logging: integer('logging', { mode: 'boolean' }).notNull().default(true),
  /** Active deployment; empty runs the code at `path`. */
  deploymentId: text('deployment_id').notNull().default(''),
  /** Appwrite settings with no effect here, kept so the API returns what was set. */
  buildSpecification: text('build_specification').notNull().default('s-1vcpu-512mb'),
  runtimeSpecification: text('runtime_specification').notNull().default('s-1vcpu-512mb'),
  deploymentRetention: integer('deployment_retention').notNull().default(0),
  ...providerSettings,
  ...timestamps,
})

/** Code uploaded with `appwrite push functions` (or createDeployment), unpacked under <data>/deployments. */
export const deployments = sqliteTable(
  '_deployments',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    functionId: text('function_id').notNull(),
    entrypoint: text('entrypoint').notNull(),
    commands: text('commands').notNull().default(''),
    /** waiting (uploading), building, ready or failed. */
    status: text('status').notNull().default('waiting'),
    buildLogs: text('build_logs').notNull().default(''),
    buildDuration: real('build_duration').notNull().default(0),
    sourceSize: integer('source_size').notNull().default(0),
    /** Make it the active deployment once built. */
    activate: integer('activate', { mode: 'boolean' }).notNull().default(false),
    chunksTotal: integer('chunks_total').notNull().default(1),
    chunksUploaded: integer('chunks_uploaded').notNull().default(0),
    /** The function's runtime when this deployment was built; '' ran on the server's Bun. */
    runtime: text('runtime').notNull().default(''),
    ...deploymentSource,
    ...timestamps,
  },
  (t) => [index('_deployments_function').on(t.functionId)],
)

/**
 * Sites: uploaded files served as they are on `<id>.<SITES_DOMAIN>` or a
 * custom domain, or (`adapter: ssr`) an app built here and run behind the
 * server.
 */
export const sites = sqliteTable('_sites', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Appwrite's framework key; always served as static files here. */
  framework: text('framework').notNull().default('other'),
  /** Folder inside the upload to serve, such as `dist`. Empty serves the top. */
  outputDirectory: text('output_directory').notNull().default(''),
  /** Served for paths with no file (single-page apps), such as `index.html`. */
  fallbackFile: text('fallback_file').notNull().default(''),
  /** Live deployment; empty serves nothing yet. */
  deploymentId: text('deployment_id').notNull().default(''),
  /** Optional custom domain, such as `www.example.com`. */
  domain: text('domain').notNull().default(''),
  /** Function that answers `/api/*` on the site's own domain; empty for none. */
  apiFunctionId: text('api_function_id').notNull().default(''),
  /** Command that starts the app for `adapter: ssr`; empty for static sites. */
  startCommand: text('start_command').notNull().default(''),
  /** Appwrite settings; `installCommand` and `buildCommand` run for SSR sites. */
  installCommand: text('install_command').notNull().default(''),
  buildCommand: text('build_command').notNull().default(''),
  buildRuntime: text('build_runtime').notNull().default(''),
  adapter: text('adapter').notNull().default('static'),
  /** After-build cleanup of SSR sites: auto, standalone, production or none (see sites/prune.ts). */
  pruneMode: text('prune_mode').notNull().default('auto'),
  ...providerSettings,
  ...timestamps,
})

export const siteDeployments = sqliteTable(
  '_site_deployments',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    siteId: text('site_id').notNull(),
    /** waiting (uploading), processing, ready or failed. */
    status: text('status').notNull().default('waiting'),
    buildLogs: text('build_logs').notNull().default(''),
    buildDuration: real('build_duration').notNull().default(0),
    sourceSize: integer('source_size').notNull().default(0),
    /** Files and bytes served, counted once unpacked. */
    fileCount: integer('file_count').notNull().default(0),
    totalSize: integer('total_size').notNull().default(0),
    /** The site's start command when this deployment was made, so a rollback keeps its runtime. */
    startCommand: text('start_command').notNull().default(''),
    activate: integer('activate', { mode: 'boolean' }).notNull().default(false),
    chunksTotal: integer('chunks_total').notNull().default(1),
    chunksUploaded: integer('chunks_uploaded').notNull().default(0),
    /** The site's build runtime when this deployment was made, so a rollback runs on its own runtime; '' is the server's Bun. */
    runtime: text('runtime').notNull().default(''),
    ...deploymentSource,
    ...timestamps,
  },
  (t) => [index('_site_deployments_site').on(t.siteId, t.seq)],
)

/** A site's branch preview host (`<siteId>--git-<slug>`): the newest ready deployment of that branch. */
export const siteBranches = sqliteTable(
  '_site_branches',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    siteId: text('site_id').notNull(),
    branch: text('branch').notNull(),
    slug: text('slug').notNull(),
    deploymentId: text('deployment_id').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('_site_branches_slug').on(t.siteId, t.slug)],
)

/** GitHub App installations connected to this project (Appwrite's `installations`). */
export const vcsInstallations = sqliteTable('_vcs_installations', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  provider: text('provider').notNull().default('github'),
  providerInstallationId: text('provider_installation_id').notNull(),
  /** Account the app is installed on: a user or organization login. */
  organization: text('organization').notNull().default(''),
  accountType: text('account_type').notNull().default(''),
  ...timestamps,
})

/**
 * Control database only: the server's GitHub App, made by the console's
 * one-click setup. VCS_GITHUB_* env vars take precedence over this row.
 */
export const vcsGithubApp = sqliteTable('_vcs_github_app', {
  key: text('key').primaryKey(),
  appId: text('app_id').notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull().default(''),
  owner: text('owner').notNull().default(''),
  htmlUrl: text('html_url').notNull().default(''),
  clientId: text('client_id').notNull().default(''),
  clientSecret: text('client_secret').notNull().default(''),
  webhookSecret: text('webhook_secret').notNull().default(''),
  privateKey: text('private_key').notNull(),
  ...timestamps,
})

/**
 * Control database only: which project's site or function a repository
 * deploys, so a webhook (which has no project) finds them. Appwrite's console
 * `repositories` collection.
 */
export const vcsRepositories = sqliteTable(
  '_vcs_repositories',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    projectId: text('project_id').notNull(),
    installationId: text('installation_id').notNull(),
    providerInstallationId: text('provider_installation_id').notNull(),
    providerRepositoryId: text('provider_repository_id').notNull(),
    /** `owner/name`, for messages; GitHub's numeric ID is what matches. */
    providerRepositoryName: text('provider_repository_name').notNull().default(''),
    /** function | site */
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    /** Pull requests from forks that an admin approved for builds. */
    providerPullRequestIds: json<string[]>('provider_pull_request_ids').notNull().default(sql`'[]'`),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('_vcs_repositories_resource').on(t.projectId, t.resourceType, t.resourceId),
    index('_vcs_repositories_provider').on(t.providerRepositoryId),
  ],
)

/** Control database only: the one Bunwrite comment kept up to date on each pull request. */
export const vcsComments = sqliteTable(
  '_vcs_comments',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    providerRepositoryId: text('provider_repository_id').notNull(),
    pullRequest: integer('pull_request').notNull(),
    commentId: text('comment_id').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('_vcs_comments_pr').on(t.providerRepositoryId, t.pullRequest)],
)

/**
 * Appwrite-compatible proxy rules: one row per custom domain, pointing at a
 * site or a function. A resource can have any number of them. The default
 * `<id>.<sitesDomain>` / `<id>.<functionsDomain>` hosts are computed, not rows.
 */
export const proxyRules = sqliteTable(
  '_proxy_rules',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    /** site | function */
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    domain: text('domain').notNull().unique(),
    ...timestamps,
  },
  (t) => [index('_proxy_rules_resource').on(t.resourceType, t.resourceId, t.seq)],
)

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

/** People who may sign in to /console. Separate from project users, as in Appwrite. */
export const consoleAdmins = sqliteTable('_console_admins', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  password: text('password').notNull(),
  ...timestamps,
})

export const consoleSessions = sqliteTable('_console_sessions', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  adminId: integer('admin_id')
    .notNull()
    .references(() => consoleAdmins.seq, { onDelete: 'cascade' }),
  secretHash: text('secret_hash').notNull().unique(),
  expire: text('expire').notNull(),
  createdAt: text('created_at').notNull(),
})

/** Settings edited in the console; they override the matching env vars. */
export const settings = sqliteTable('_settings', {
  key: text('key').primaryKey(),
  value: json<unknown>('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** API keys made in the console (env API_KEYS keep working too). Only the sha256 is stored. */
export const apiKeys = sqliteTable('_api_keys', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  name: text('name').notNull(),
  secretHash: text('secret_hash').notNull().unique(),
  /** First characters, so a key can be recognised in the list. */
  hint: text('hint').notNull(),
  expire: text('expire'),
  accessedAt: text('accessed_at'),
  ...timestamps,
})

/** Function variables (Appwrite's per-function env). function_id '*' applies to every function. */
export const functionVars = sqliteTable(
  '_function_vars',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    functionId: text('function_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    secret: integer('secret', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('_function_vars_fn_key').on(t.functionId, t.key)],
)

/** HTTP requests shown on the console's Request logs page; pruned by LOG_RETENTION_DAYS. */
export const requestLogs = sqliteTable(
  '_request_logs',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    status: integer('status').notNull(),
    durationMs: real('duration_ms').notNull().default(0),
    requestBytes: integer('request_bytes').notNull().default(0),
    responseBytes: integer('response_bytes').notNull().default(0),
    ip: text('ip').notNull().default(''),
    project: text('project').notNull().default(''),
    /** guest, key, console, or user:<id>. */
    auth: text('auth').notNull().default(''),
    referer: text('referer').notNull().default(''),
    userAgent: text('user_agent').notNull().default(''),
    /** API or console error message, empty on success. */
    error: text('error').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('_request_logs_created').on(t.createdAt), index('_request_logs_status').on(t.status)],
)

/** Outgoing webhooks (Appwrite's project webhooks), as `appwrite push webhooks` makes them. */
export const webhooks = sqliteTable('_webhooks', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  events: json<string[]>('events').notNull().default(sql`'[]'`),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Verify the receiver's TLS certificate. */
  tls: integer('tls', { mode: 'boolean' }).notNull().default(true),
  authUsername: text('auth_username').notNull().default(''),
  authPassword: text('auth_password').notNull().default(''),
  /** Signs each delivery (the X-Bunwrite-Webhook-Signature header, or X-Appwrite-Webhook-Signature). */
  secret: text('secret').notNull(),
  /** The last delivery error, empty after a success. */
  logs: text('logs').notNull().default(''),
  /** Failed deliveries in a row; the webhook turns itself off at 10. */
  attempts: integer('attempts').notNull().default(0),
  ...timestamps,
})

/** Messaging topics. Only their names and subscribe roles are kept; this server sends no messages. */
export const topics = sqliteTable('_topics', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  name: text('name').notNull(),
  subscribe: json<string[]>('subscribe').notNull().default(sql`'[]'`),
  ...timestamps,
})
