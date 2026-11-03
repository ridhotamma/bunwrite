/**
 * Litestream settings edited in the console.
 *
 * Litestream starts before Bunwrite, so the console cannot launch it directly.
 * Saving writes three private files into the data directory:
 *
 *   litestream.json        source of truth for the console form
 *   litestream.env         shell variables sourced by the entrypoint
 *   litestream.generated.yml  complete replication config, including endpoint
 *
 * The container entrypoint and the systemd wrapper source `litestream.env`
 * before deciding whether to start Litestream. Changes therefore take effect on
 * the next restart. Environment variables remain the fallback when no console
 * settings file exists.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { dataDirOf, projectFolder } from '~/projects/paths'

export interface LitestreamSettings {
  enabled: boolean
  replicaUrl: string
  accessKeyId: string
  secretAccessKey: string
  /** AWS region or the S3-compatible endpoint's region. */
  region: string
  /** Empty for AWS S3; set for R2, MinIO and other S3-compatible stores. */
  endpoint: string
  forcePathStyle: boolean
  syncInterval: string
  heartbeatUrl: string
  snapshotInterval: string
  snapshotRetention: string
  l0Retention: string
}

const REPLICA_SCHEMES = ['s3:', 'gs:', 'abs:', 'file:']
const DURATION = /^\d+(?:\.\d+)?(?:ms|s|m|h)$/

const truthy = (value: string | undefined): boolean => ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())

const trimSlash = (value: string): string => value.trim().replace(/\/+$/, '')

export function litestreamSettingsFromEnv(env: Record<string, string | undefined> = process.env): LitestreamSettings {
  return {
    enabled: Boolean((env.LITESTREAM_REPLICA_URL ?? '').trim()),
    replicaUrl: (env.LITESTREAM_REPLICA_URL ?? '').trim(),
    accessKeyId: (env.AWS_ACCESS_KEY_ID ?? '').trim(),
    secretAccessKey: (env.AWS_SECRET_ACCESS_KEY ?? '').trim(),
    region: (env.LITESTREAM_S3_REGION ?? env.AWS_DEFAULT_REGION ?? '').trim(),
    endpoint: (env.LITESTREAM_S3_ENDPOINT ?? '').trim(),
    forcePathStyle: truthy(env.LITESTREAM_S3_FORCE_PATH_STYLE),
    syncInterval: (env.LITESTREAM_SYNC_INTERVAL ?? '1s').trim() || '1s',
    heartbeatUrl: (env.LITESTREAM_HEARTBEAT_URL ?? '').trim(),
    snapshotInterval: '24h',
    snapshotRetention: '168h',
    l0Retention: '24h',
  }
}

export const litestreamSettingsPath = (databasePath: string): string => join(dataDirOf(databasePath), 'litestream.json')
export const litestreamEnvPath = (databasePath: string): string => join(dataDirOf(databasePath), 'litestream.env')
export const litestreamConfigPath = (databasePath: string): string => join(dataDirOf(databasePath), 'litestream.generated.yml')

function stringOf(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function booleanOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function normalizeLitestreamSettings(value: unknown, defaults: LitestreamSettings): LitestreamSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaults }
  const object = value as Record<string, unknown>
  return {
    enabled: booleanOf(object.enabled, defaults.enabled),
    replicaUrl: stringOf(object.replicaUrl, defaults.replicaUrl),
    accessKeyId: stringOf(object.accessKeyId, defaults.accessKeyId),
    secretAccessKey: stringOf(object.secretAccessKey, defaults.secretAccessKey),
    region: stringOf(object.region, defaults.region),
    endpoint: stringOf(object.endpoint, defaults.endpoint),
    forcePathStyle: booleanOf(object.forcePathStyle, defaults.forcePathStyle),
    syncInterval: stringOf(object.syncInterval, defaults.syncInterval) || '1s',
    heartbeatUrl: stringOf(object.heartbeatUrl, defaults.heartbeatUrl),
    snapshotInterval: stringOf(object.snapshotInterval, defaults.snapshotInterval) || '24h',
    snapshotRetention: stringOf(object.snapshotRetention, defaults.snapshotRetention) || '168h',
    l0Retention: stringOf(object.l0Retention, defaults.l0Retention) || '24h',
  }
}

/** Read the console override, or null when the environment should be used. */
export function readLitestreamSettings(databasePath: string): LitestreamSettings | null {
  const path = litestreamSettingsPath(databasePath)
  if (!existsSync(path)) return null
  try {
    return normalizeLitestreamSettings(JSON.parse(readFileSync(path, 'utf8')), litestreamSettingsFromEnv({}))
  } catch {
    return null
  }
}

/** Validate a merged form value; throws a user-facing message. */
export function validateLitestreamSettings(settings: LitestreamSettings): LitestreamSettings {
  const next = {
    ...settings,
    replicaUrl: trimSlash(settings.replicaUrl),
    endpoint: trimSlash(settings.endpoint),
    syncInterval: settings.syncInterval.trim() || '1s',
    heartbeatUrl: settings.heartbeatUrl.trim(),
    snapshotInterval: settings.snapshotInterval.trim() || '24h',
    snapshotRetention: settings.snapshotRetention.trim() || '168h',
    l0Retention: settings.l0Retention.trim() || '24h',
  }
  if (next.enabled && !next.replicaUrl) throw new Error('A replica URL is required when Litestream is enabled.')
  if (next.replicaUrl) {
    let url: URL
    try {
      url = new URL(next.replicaUrl)
    } catch {
      throw new Error('The replica URL is not valid.')
    }
    if (!REPLICA_SCHEMES.includes(url.protocol)) {
      throw new Error('The replica URL must use s3://, gs://, abs:// or file://.')
    }
  }
  if (next.endpoint) {
    let url: URL
    try {
      url = new URL(next.endpoint)
    } catch {
      throw new Error('The S3 endpoint is not a valid URL.')
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The S3 endpoint must use http or https.')
  }
  if (next.heartbeatUrl) {
    let url: URL
    try {
      url = new URL(next.heartbeatUrl)
    } catch {
      throw new Error('The heartbeat URL is not valid.')
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The heartbeat URL must use http or https.')
  }
  for (const [label, value] of [
    ['sync interval', next.syncInterval],
    ['snapshot interval', next.snapshotInterval],
    ['snapshot retention', next.snapshotRetention],
    ['L0 retention', next.l0Retention],
  ] as const) {
    if (!DURATION.test(value)) throw new Error(`The ${label} must look like 30s, 5m, 24h or 500ms.`)
  }
  if ((next.accessKeyId && !next.secretAccessKey) || (!next.accessKeyId && next.secretAccessKey)) {
    throw new Error('S3 access key ID and secret access key must be provided together.')
  }
  return next
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function envFile(settings: LitestreamSettings, databasePath: string): string {
  const lines = [
    '# Generated by the Bunwrite console. Changes apply on the next restart.',
    `LITESTREAM_REPLICA_URL=${shellQuote(settings.enabled ? settings.replicaUrl : '')}`,
    `LITESTREAM_SYNC_INTERVAL=${shellQuote(settings.syncInterval)}`,
    `LITESTREAM_HEARTBEAT_URL=${shellQuote(settings.heartbeatUrl)}`,
    `LITESTREAM_S3_ENDPOINT=${shellQuote(settings.endpoint)}`,
    `LITESTREAM_S3_REGION=${shellQuote(settings.region)}`,
    `LITESTREAM_S3_FORCE_PATH_STYLE=${shellQuote(settings.forcePathStyle ? 'true' : 'false')}`,
    `LITESTREAM_CONFIG=${shellQuote(litestreamConfigPath(databasePath))}`,
    `AWS_ACCESS_KEY_ID=${shellQuote(settings.accessKeyId)}`,
    `AWS_SECRET_ACCESS_KEY=${shellQuote(settings.secretAccessKey)}`,
    `AWS_DEFAULT_REGION=${shellQuote(settings.region)}`,
  ]
  return `${lines.join('\n')}\n`
}

const yaml = (value: string): string => JSON.stringify(value)

function replicaBlock(settings: LitestreamSettings, url: string, indent: string): string[] {
  const lines = [`${indent}replica:`, `${indent}  url: ${yaml(url)}`, `${indent}  sync-interval: ${yaml(settings.syncInterval)}`]
  if (settings.endpoint) {
    lines.push(`${indent}  endpoint: ${yaml(settings.endpoint)}`, `${indent}  region: ${yaml(settings.region || 'auto')}`)
    lines.push(`${indent}  force-path-style: ${settings.forcePathStyle ? 'true' : 'false'}`)
  }
  return lines
}

function configFile(
  settings: LitestreamSettings,
  databasePath: string,
  layout: { projectsDir?: string; legacyDatabasePath?: string; legacyProjectId?: string } = {},
): string {
  const database = resolve(databasePath)
  const dataDir = dataDirOf(databasePath)
  const base = trimSlash(settings.replicaUrl)
  const lines = [
    '# Generated by the Bunwrite console. Changes apply on the next restart.',
    'dbs:',
    `  - path: ${yaml(database)}`,
    '    restore-if-db-not-exists: true',
    ...replicaBlock(settings, `${base}/${basename(database)}`, '    '),
    '',
  ]
  // The install's first project may still live at DATABASE_PATH rather than
  // under projects/. Replicate it explicitly so an upgrade does not silently
  // stop backing it up.
  if (layout.legacyDatabasePath && layout.legacyProjectId && existsSync(layout.legacyDatabasePath)) {
    lines.push(
      `  - path: ${yaml(resolve(layout.legacyDatabasePath))}`,
      '    restore-if-db-not-exists: true',
      ...replicaBlock(settings, `${base}/projects/${projectFolder(layout.legacyProjectId)}/bunwrite.sqlite`, '    '),
      '',
    )
  }
  lines.push(
    `  - dir: ${yaml(layout.projectsDir ?? join(dataDir, 'projects'))}`,
    '    pattern: "bunwrite.sqlite"',
    '    recursive: true',
    '    watch: true',
    ...replicaBlock(settings, `${base}/projects`, '    '),
    '',
    'snapshot:',
    `  interval: ${yaml(settings.snapshotInterval)}`,
    `  retention: ${yaml(settings.snapshotRetention)}`,
    `l0-retention: ${yaml(settings.l0Retention)}`,
  )
  if (settings.heartbeatUrl) lines.push(`heartbeat-url: ${yaml(settings.heartbeatUrl)}`, 'heartbeat-interval: 5m')
  return `${lines.join('\n')}\n`
}

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, content, { mode: 0o600 })
  renameSync(temp, path)
}

/** Persist console settings and the files the entrypoint/Litestream read at boot. */
export function writeLitestreamSettings(
  databasePath: string,
  value: LitestreamSettings,
  layout: { settingsPath?: string; projectsDir?: string; legacyDatabasePath?: string; legacyProjectId?: string } = {},
): LitestreamSettings {
  const settings = validateLitestreamSettings(value)
  const settingsPath = layout.settingsPath ?? databasePath
  const dataDir = dataDirOf(settingsPath)
  mkdirSync(dataDir, { recursive: true })
  writePrivate(litestreamSettingsPath(settingsPath), `${JSON.stringify(settings, null, 2)}\n`)
  writePrivate(litestreamEnvPath(settingsPath), envFile(settings, settingsPath))
  if (settings.enabled) writePrivate(litestreamConfigPath(settingsPath), configFile(settings, databasePath, layout))
  else rmSync(litestreamConfigPath(settingsPath), { force: true })
  return settings
}

/** Forget the console override and return to the environment settings. */
export function resetLitestreamSettings(databasePath: string): void {
  rmSync(litestreamSettingsPath(databasePath), { force: true })
  rmSync(litestreamEnvPath(databasePath), { force: true })
  rmSync(litestreamConfigPath(databasePath), { force: true })
}
