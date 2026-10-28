import { dirname, resolve } from 'node:path'

import type { FunctionSandbox } from './functions/sandbox'
import { parseApiCompat, type ApiCompat } from './lib/compat'
import type { LogFormat } from './lib/log'
import type { RenderConfig } from './render/service'

export interface SmtpConfig {
  host: string
  port: number
  user?: string
  password?: string
  /** 'tls' for implicit TLS (port 465); otherwise STARTTLS when offered. */
  secure: boolean
  senderEmail: string
  senderName: string
}

export interface GoogleConfig {
  clientId: string
  clientSecret: string
  authUrl: string
  tokenUrl: string
  userinfoUrl: string
}

/** S3-compatible storage settings, used for uploads and optionally for backups. */
export interface S3Config {
  enabled: boolean
  bucket: string
  region: string
  endpoint: string
  accessKey: string
  secret: string
  forcePathStyle: boolean
}

export interface BackupsConfig {
  /** Run one database backup a day at 02:00 UTC. */
  enabled: boolean
  /** Keep this many automatic backups; manual backups are never pruned. */
  keep: number
  s3: S3Config
}

/** How long browsers may reuse files and previews, and how long previews stay on disk. */
export interface CacheConfig {
  /** Seconds browsers may reuse a file view or download without asking again; 0 makes them check each time. */
  fileMaxAge: number
  /** Seconds browsers may reuse an image preview; 0 makes them check each time. */
  previewMaxAge: number
  /** Days a generated preview stays on disk before it is made again; 0 keeps previews until the file changes. */
  previewRetentionDays: number
}

/** Appwrite's own values: 45 days for files, 30 for previews. */
export const DEFAULT_CACHE: CacheConfig = { fileMaxAge: 3888000, previewMaxAge: 2592000, previewRetentionDays: 30 }

const wholeNumber = (value: string | undefined, fallback: number) => {
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback
}

export const emptyS3 = (): S3Config => ({ enabled: false, bucket: '', region: '', endpoint: '', accessKey: '', secret: '', forcePathStyle: false })

/** Values generated on first start; shown once on the console setup page. */
export interface BootstrapInfo {
  orgId: string
  projectId: string
  /** Present only until the first console admin exists. */
  apiKey?: string
  generated: boolean
}

export interface Config {
  port: number
  /**
   * Names the server sends: `bunwrite` (X-Bunwrite-* webhook headers, bw_session cookies,
   * BUNWRITE_* function variables) or `appwrite`. Both families are always accepted.
   */
  apiCompat: ApiCompat
  /** Interface to bind (defaults to all interfaces). */
  hostname: string
  /** SQLite file path. */
  databasePath: string
  /** Organization grouping for this instance; stored in the database on first start. */
  orgId: string
  /** Project ID stored in the database; environment values only seed an empty instance. */
  projectId: string
  /** Shown in emails as {{project}}; stored in the database. */
  projectName: string
  /** Programmatic keys (tests); project keys live hashed in `_api_keys`. */
  apiKeys: string[]
  /** Signs JWTs and OAuth state; stored in the database on first start. */
  secret: string
  /** Browser origins allowed by CORS and as redirect targets. `*.example.com` matches subdomains. */
  allowedOrigins: string[]
  /** Optional project config file (bunwrite.config.json or appwrite.config.json) applied at startup. */
  schemaPath?: string
  /** Public URL of this API including /v1, used for OAuth callbacks and file links. */
  publicEndpoint: string
  /** Session lifetime in seconds (defaults to one year). */
  sessionDuration: number
  /** Most sessions a user keeps; the oldest is removed beyond this. */
  sessionsLimit: number
  smtp: SmtpConfig | null
  google: GoogleConfig | null
  /** Directory for uploaded files. */
  storagePath: string
  /** dotenv file with variables for function executions (Appwrite "function variables"). */
  functionsEnvFile?: string
  /** Functions whose schedule is ignored. */
  skipSchedules: string[]
  /** Folder that relative function paths resolve against: where the project config file lives. */
  functionsDir: string
  /** Run a function's build command (`commands`) on each new deployment. */
  functionsBuildCommands: boolean
  /** Each function builds and runs as its own user (functions/sandbox.ts); null when off. */
  functionsSandbox?: FunctionSandbox | null
  /** Per-process key handed to function executions; never stored. */
  internalKey?: string
  /**
   * Sites answer on `<siteId>.<sitesDomain>` (SITES_DOMAIN). Defaults to
   * `<SITES_PREFIX>.<DOMAIN>`, or `<SITES_PREFIX>.localhost` while developing.
   */
  sitesDomain?: string
  /**
   * Functions answer on `<functionId>.<functionsDomain>` (FUNCTIONS_DOMAIN).
   * Defaults to `<FUNCTIONS_PREFIX>.<DOMAIN>`, or `<FUNCTIONS_PREFIX>.localhost`.
   */
  functionsDomain?: string
  /** Prefix of the default site host under DOMAIN; `sites` unless SITES_PREFIX says otherwise. */
  sitesPrefix: string
  /** Prefix of the default function host under DOMAIN; `functions` unless FUNCTIONS_PREFIX says otherwise. */
  functionsPrefix: string
  /** Run an SSR site's install and build commands on this server (SITES_BUILD_COMMANDS). */
  sitesBuildCommands: boolean
  /** Allow sites with `adapter: ssr` to run an app process (SITES_SSR). */
  sitesSsr: boolean
  /** Stop an idle SSR app after this many milliseconds; 0 keeps it running (SITES_SSR_IDLE_MS). */
  sitesSsrIdleMs: number
  /** Most SSR app processes running at once per project (SITES_SSR_MAX_PROCESSES). */
  sitesSsrMaxProcesses: number
  /** Serve the admin console at /console. */
  consoleEnabled: boolean
  /** Apply SCHEMA_PATH on every start. Off by default so console edits are not overwritten. */
  schemaSyncOnStart: boolean
  /** Write one line per HTTP request to stdout. */
  logRequests: boolean
  /** `text` for journald, `json` for a log collector. */
  logFormat: LogFormat
  /** Days to keep request logs in the console; 0 keeps them until cleared. */
  logRetentionDays: number
  /** Store client IP addresses in request logs. */
  logIp: boolean
  /** S3-compatible storage for uploaded files. */
  s3: S3Config
  /** Prefix for S3 object keys, so projects sharing a bucket do not collide. */
  storagePrefix?: string
  /** Automatic database backups. */
  backups: BackupsConfig
  /** Prefix for S3 backup keys. */
  backupsPrefix?: string
  /** Local folder for backups when backup S3 storage is off. */
  backupsPath: string
  /** HTML to PDF and image rendering (POST /v1/pdf, /v1/image). */
  render: RenderConfig
  /** Browser cache lifetimes and preview cache retention. */
  cache: CacheConfig
  /** Compress responses (Brotli or gzip). Server-wide; read from the main project's config. */
  compression: boolean
  /** Proxies whose forwarding headers carry the client's IP (TRUSTED_PROXIES; see lib/client-ip). Server-wide. */
  trustedProxies?: string
  /** Set by the first-run bootstrap; not part of the environment. */
  bootstrap?: BootstrapInfo
}

export const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/** A DNS label used as the site/function namespace under DOMAIN. */
const dnsLabel = (value: string | undefined, fallback: string) =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '') || fallback

/** A host from the environment: lowercase, no scheme, wildcard, path or port. */
const dnsName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^\*\./, '')
    .replace(/[/:].*$/, '')
    .replace(/\.$/, '')

/** SMTP settings from the environment. Used once to seed a new instance. */
export function smtpFromEnv(env: Record<string, string | undefined>): SmtpConfig | null {
  if (!env.SMTP_HOST) return null
  return {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT ?? 587),
    user: env.SMTP_USERNAME || undefined,
    password: env.SMTP_PASSWORD || undefined,
    secure: env.SMTP_SECURE === 'tls',
    senderEmail: env.SMTP_SENDER_EMAIL ?? 'no-reply@example.com',
    senderName: env.SMTP_SENDER_NAME ?? `${env.PROJECT_NAME ?? 'Bunwrite'} Team`,
  }
}

/** Google OAuth settings from the environment. Used once to seed a new instance. */
export function googleFromEnv(env: Record<string, string | undefined>): GoogleConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    authUrl: env.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
    userinfoUrl: env.GOOGLE_USERINFO_URL ?? 'https://www.googleapis.com/oauth2/v3/userinfo',
  }
}

/**
 * Server configuration. Project identity and settings are not read from the
 * environment here: `bootstrapInstance` seeds them into the database once, and
 * `index.ts` fills the project fields before services are created.
 */
export function configFromEnv(env: Record<string, string | undefined> = process.env): Config {
  const port = Number(env.PORT ?? 8080)
  // DOMAIN is only a default for PUBLIC_ENDPOINT: whatever terminates TLS has
  // to be reachable at https://<domain>, and the container cannot know that on
  // its own. Strip a pasted scheme and path so https://x.example/ also works.
  const domain = (env.DOMAIN ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  const sitesPrefix = dnsLabel(env.SITES_PREFIX, 'sites')
  const functionsPrefix = dnsLabel(env.FUNCTIONS_PREFIX, 'functions')
  const sitesDomain = dnsName(env.SITES_DOMAIN || (domain ? `${sitesPrefix}.${domain}` : `${sitesPrefix}.localhost`))
  const functionsDomain = dnsName(env.FUNCTIONS_DOMAIN || (domain ? `${functionsPrefix}.${domain}` : `${functionsPrefix}.localhost`))
  const retention = Number(env.LOG_RETENTION_DAYS ?? 7)
  const ssrIdle = wholeNumber(env.SITES_SSR_IDLE_MS, 5 * 60 * 1000)
  const ssrMax = wholeNumber(env.SITES_SSR_MAX_PROCESSES, 2)
  return {
    port,
    apiCompat: parseApiCompat(env.API_COMPAT),
    hostname: env.HOST || '0.0.0.0',
    databasePath: env.DATABASE_PATH ?? './data/bunwrite.sqlite',
    orgId: '',
    projectId: '',
    projectName: 'Bunwrite',
    apiKeys: [],
    secret: '',
    allowedOrigins: [],
    schemaPath: env.SCHEMA_PATH || undefined,
    publicEndpoint: (
      env.PUBLIC_ENDPOINT ?? (domain ? `https://${domain}/v1` : `http://localhost:${port}/v1`)
    ).replace(/\/$/, ''),
    sessionDuration: 31536000,
    sessionsLimit: 10,
    smtp: null,
    google: null,
    storagePath: env.STORAGE_PATH ?? './data/storage',
    functionsEnvFile: env.FUNCTIONS_ENV_FILE || undefined,
    skipSchedules: [],
    functionsDir: resolve(env.FUNCTIONS_DIR || (env.SCHEMA_PATH ? dirname(resolve(env.SCHEMA_PATH)) : '.')),
    functionsBuildCommands: env.FUNCTIONS_BUILD_COMMANDS !== 'false',
    sitesDomain,
    functionsDomain,
    sitesPrefix,
    functionsPrefix,
    sitesBuildCommands: env.SITES_BUILD_COMMANDS !== 'false',
    sitesSsr: env.SITES_SSR !== 'false',
    sitesSsrIdleMs: ssrIdle,
    sitesSsrMaxProcesses: Math.max(1, ssrMax),
    consoleEnabled: env.CONSOLE_ENABLED !== 'false',
    schemaSyncOnStart: env.SCHEMA_SYNC_ON_START === 'true',
    logRequests: env.LOG_REQUESTS !== 'false',
    logFormat: env.LOG_FORMAT === 'json' ? 'json' : 'text',
    logRetentionDays: Number.isFinite(retention) && retention >= 0 ? Math.round(retention) : 7,
    logIp: env.LOG_IP !== 'false',
    s3: emptyS3(),
    storagePrefix: '',
    backups: { enabled: false, keep: 7, s3: emptyS3() },
    backupsPrefix: '',
    backupsPath: env.BACKUPS_PATH ?? './data/backups',
    render: { enabled: env.RENDER_ENABLED === 'true', allowRemote: env.RENDER_ALLOW_REMOTE === 'true' },
    cache: {
      fileMaxAge: wholeNumber(env.CACHE_FILES_MAX_AGE, DEFAULT_CACHE.fileMaxAge),
      previewMaxAge: wholeNumber(env.CACHE_PREVIEWS_MAX_AGE, DEFAULT_CACHE.previewMaxAge),
      previewRetentionDays: wholeNumber(env.PREVIEW_CACHE_DAYS, DEFAULT_CACHE.previewRetentionDays),
    },
    compression: env.COMPRESSION !== 'false',
    trustedProxies: env.TRUSTED_PROXIES || undefined,
  }
}
