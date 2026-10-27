import { dirname, resolve } from 'node:path'

import type { LogFormat } from './lib/log'

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

export const emptyS3 = (): S3Config => ({ enabled: false, bucket: '', region: '', endpoint: '', accessKey: '', secret: '', forcePathStyle: false })

export interface Config {
  port: number
  /** SQLite file path. */
  databasePath: string
  /** Must match the X-Appwrite-Project header (keep the old Appwrite project ID). */
  projectId: string
  /** Shown in emails as {{project}}. */
  projectName: string
  /** Accepted X-Appwrite-Key values. Reuse the old Appwrite key so apps need no change. */
  apiKeys: string[]
  /** Signs JWTs and OAuth state. */
  secret: string
  /** Browser origins allowed by CORS and as redirect targets. `*.example.com` matches subdomains. */
  allowedOrigins: string[]
  /** Optional appwrite.config.json applied at startup. */
  schemaPath?: string
  /** Public URL of this API including /v1, used for OAuth callbacks and file links. */
  publicEndpoint: string
  /** Session lifetime in seconds (Appwrite's project setting; Pesanle uses one year). */
  sessionDuration: number
  /** Most sessions a user keeps; the oldest is removed beyond this. */
  sessionsLimit: number
  smtp: SmtpConfig | null
  google: GoogleConfig | null
  /** Directory for uploaded files. */
  storagePath: string
  /** dotenv file with variables for function executions (Appwrite "function variables"). */
  functionsEnvFile?: string
  /** Functions whose schedule is ignored (render's keep-warm ping is pointless here). */
  skipSchedules: string[]
  /** Folder that relative function paths resolve against: where appwrite.config.json lives. */
  functionsDir: string
  /** Per-process key handed to function executions; never stored. */
  internalKey?: string
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
  /** Automatic database backups. */
  backups: BackupsConfig
  /** Local folder for backups when backup S3 storage is off. */
  backupsPath: string
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

export function configFromEnv(env: Record<string, string | undefined> = process.env): Config {
  const projectId = env.PROJECT_ID ?? ''
  const secret = env.SECRET ?? ''
  if (!projectId) throw new Error('PROJECT_ID is required')
  if (secret.length < 32) throw new Error('SECRET must be at least 32 characters')
  const port = Number(env.PORT ?? 8080)
  const retention = Number(env.LOG_RETENTION_DAYS ?? 7)
  return {
    port,
    databasePath: env.DATABASE_PATH ?? './data/pesanle.sqlite',
    projectId,
    projectName: env.PROJECT_NAME ?? 'Pesanle',
    apiKeys: list(env.API_KEYS),
    secret,
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    schemaPath: env.SCHEMA_PATH || undefined,
    publicEndpoint: (env.PUBLIC_ENDPOINT ?? `http://localhost:${port}/v1`).replace(/\/$/, ''),
    sessionDuration: Number(env.SESSION_DURATION ?? 31536000),
    sessionsLimit: Number(env.SESSIONS_LIMIT ?? 10),
    smtp: env.SMTP_HOST
      ? {
          host: env.SMTP_HOST,
          port: Number(env.SMTP_PORT ?? 587),
          user: env.SMTP_USERNAME || undefined,
          password: env.SMTP_PASSWORD || undefined,
          secure: env.SMTP_SECURE === 'tls',
          senderEmail: env.SMTP_SENDER_EMAIL ?? 'no-reply@pesanle.com',
          senderName: env.SMTP_SENDER_NAME ?? `${env.PROJECT_NAME ?? 'Pesanle'} Team`,
        }
      : null,
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            authUrl: env.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
            userinfoUrl: env.GOOGLE_USERINFO_URL ?? 'https://www.googleapis.com/oauth2/v3/userinfo',
          }
        : null,
    storagePath: env.STORAGE_PATH ?? './data/storage',
    functionsEnvFile: env.FUNCTIONS_ENV_FILE || undefined,
    skipSchedules: env.FUNCTIONS_SKIP_SCHEDULES !== undefined ? list(env.FUNCTIONS_SKIP_SCHEDULES) : ['render'],
    functionsDir: resolve(env.FUNCTIONS_DIR || (env.SCHEMA_PATH ? dirname(resolve(env.SCHEMA_PATH)) : '.')),
    consoleEnabled: env.CONSOLE_ENABLED !== 'false',
    schemaSyncOnStart: env.SCHEMA_SYNC_ON_START === 'true',
    logRequests: env.LOG_REQUESTS !== 'false',
    logFormat: env.LOG_FORMAT === 'json' ? 'json' : 'text',
    logRetentionDays: Number.isFinite(retention) && retention >= 0 ? Math.round(retention) : 7,
    logIp: env.LOG_IP !== 'false',
    s3: emptyS3(),
    backups: { enabled: false, keep: 7, s3: emptyS3() },
    backupsPath: env.BACKUPS_PATH ?? './data/backups',
  }
}
