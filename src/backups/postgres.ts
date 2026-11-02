/**
 * Read-only Postgres backup diagnostics and restore runbook.
 *
 * Bunwrite does not own PGDATA, so it cannot restore a Postgres database the
 * way it swaps a SQLite file. Instead this module inspects the live server,
 * checks the WAL-G configuration and produces the exact operator steps.
 *
 * Everything here is safe to run against a production primary: the queries are
 * read-only and the only external command is `wal-g backup-list`.
 */
import { existsSync } from 'node:fs'

import type { SqlDriver } from '~/db/driver'
import { walgStatus } from './walg'

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'info'

export interface PostgresSettings {
  walLevel: string
  archiveMode: string
  archiveCommand: string
  restoreCommand: string
  archiveTimeoutSeconds: number
}

export interface PostgresArchiver {
  archivedCount: number
  failedCount: number
  lastArchivedWal: string | null
  lastArchivedAt: string | null
  lastFailedWal: string | null
  lastFailedAt: string | null
}

export interface PostgresStatus {
  version: string
  versionNumber: number
  database: string
  user: string
  inRecovery: boolean
  dataDirectory: string | null
  settings: PostgresSettings
  archiver: PostgresArchiver | null
}

export interface WalgBackup {
  name: string
  modified: string | null
}

export interface WalgListResult {
  /** A storage prefix is configured, whether or not the binary was found. */
  configured: boolean
  binary: string | null
  backups: WalgBackup[]
  error?: string
  checkedAt: string
  /** The caller explicitly skipped the external WAL-G checks. */
  skipped?: boolean
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export type CommandRunner = (command: string[], options: { env: Record<string, string | undefined>; timeoutMs: number }) => Promise<CommandResult>

export interface DoctorCheck {
  id: string
  label: string
  status: DoctorStatus
  detail: string
  /** A command or setting that fixes the problem. */
  fix?: string
}

export interface PostgresDoctorOptions {
  sql: SqlDriver
  env?: Record<string, string | undefined>
  /** Reuse a status read by the caller instead of querying twice. */
  status?: PostgresStatus
  /** Reuse a WAL-G listing read by the caller. */
  walg?: WalgListResult
  checkWalg?: boolean
  walgBinary?: string
  run?: CommandRunner
  walgTimeoutMs?: number
  walgCacheMs?: number
  now?: number
  pgdata?: string
  databaseUrl?: string
  bunwriteService?: string
  postgresService?: string
  baseBackup?: string
  targetTime?: string
  docker?: boolean
  /** The caller cannot see the Postgres host's WAL-G environment (console). */
  walgAdvisory?: boolean
}

export interface PostgresDoctorReport {
  status: PostgresStatus
  walg: WalgListResult
  checks: DoctorCheck[]
  runbook: string
  ok: boolean
}

const setting = (value: unknown): string => (value === null || value === undefined ? '' : String(value))
const count = (value: unknown): number => {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

function isoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/** Postgres returns GUC durations as `60s`, `5min`, or `0`. */
export function parseGucSeconds(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/i.exec(String(value ?? '').trim())
  if (!match) return 0
  const amount = Number(match[1])
  const unit = (match[2] ?? 's').toLowerCase()
  const factor = unit === 'ms' ? 0.001 : unit === 'min' ? 60 : unit === 'h' ? 3600 : unit === 'd' ? 86400 : 1
  return amount * factor
}

/** Read the settings and archiver counters that matter for recovery. */
export async function readPostgresStatus(sql: SqlDriver): Promise<PostgresStatus> {
  const row = await sql.get<Record<string, unknown>>(`SELECT
    current_database() AS database,
    current_user AS db_user,
    current_setting('server_version') AS version,
    current_setting('server_version_num') AS version_number,
    pg_is_in_recovery() AS in_recovery,
    current_setting('data_directory', true) AS data_directory,
    current_setting('wal_level') AS wal_level,
    current_setting('archive_mode') AS archive_mode,
    current_setting('archive_command', true) AS archive_command,
    current_setting('restore_command', true) AS restore_command,
    current_setting('archive_timeout') AS archive_timeout`)
  if (!row) throw new Error('Postgres did not return its settings.')

  let archiver: PostgresArchiver | null = null
  try {
    const stats = await sql.get<Record<string, unknown>>(`SELECT
      archived_count,
      failed_count,
      last_archived_wal,
      last_archived_time,
      last_failed_wal,
      last_failed_time
      FROM pg_stat_archiver`)
    if (stats) {
      archiver = {
        archivedCount: count(stats.archived_count),
        failedCount: count(stats.failed_count),
        lastArchivedWal: setting(stats.last_archived_wal) || null,
        lastArchivedAt: isoDate(stats.last_archived_time),
        lastFailedWal: setting(stats.last_failed_wal) || null,
        lastFailedAt: isoDate(stats.last_failed_time),
      }
    }
  } catch {
    // Managed providers often hide pg_stat_archiver. The rest of the checks
    // still work, so report it as unavailable instead of failing the command.
  }

  return {
    version: setting(row.version) || 'unknown',
    versionNumber: count(row.version_number),
    database: setting(row.database),
    user: setting(row.db_user),
    inRecovery: row.in_recovery === true || setting(row.in_recovery) === 't' || setting(row.in_recovery) === 'true',
    dataDirectory: setting(row.data_directory) || null,
    settings: {
      walLevel: setting(row.wal_level),
      archiveMode: setting(row.archive_mode),
      archiveCommand: setting(row.archive_command) === '(disabled)' ? '' : setting(row.archive_command),
      restoreCommand: setting(row.restore_command) === '(disabled)' ? '' : setting(row.restore_command),
      archiveTimeoutSeconds: parseGucSeconds(row.archive_timeout),
    },
    archiver,
  }
}

const defaultRunner: CommandRunner = async (command, { env, timeoutMs }) => {
  const proc = Bun.spawn(command, {
    env: env as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // The process already exited.
    }
  }, timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

export function resolveWalGBinary(binary: string | undefined, env: Record<string, string | undefined> = process.env): string | null {
  const name = (binary ?? env.WALG_BIN ?? 'wal-g').trim()
  if (!name) return null
  if (name.includes('/') || name.includes('\\')) return existsSync(name) ? name : null
  return Bun.which(name, { PATH: env.PATH ?? process.env.PATH ?? '' }) ?? null
}

/** Parse `wal-g backup-list`'s table output. */
export function parseWalgBackupList(output: string): WalgBackup[] {
  const backups: WalgBackup[] = []
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^(name|backup_name)\b/i.test(line)) continue
    const parts = line.split(/\s+/)
    const name = parts[0]
    if (!name || !/^base_/.test(name)) continue
    backups.push({ name, modified: parts[1] ?? null })
  }
  return backups
}

function newestFirst(backups: WalgBackup[]): WalgBackup[] {
  return [...backups].sort((a, b) => {
    const left = a.modified ? new Date(a.modified).getTime() : 0
    const right = b.modified ? new Date(b.modified).getTime() : 0
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return right - left
    return b.name.localeCompare(a.name)
  })
}

let backupListCache: { key: string; at: number; result: WalgListResult } | null = null

export interface WalgListOptions {
  env?: Record<string, string | undefined>
  binary?: string
  run?: CommandRunner
  timeoutMs?: number
  /** Set to 0 to bypass the cache. */
  cacheMs?: number
  now?: number
}

/** Run `wal-g backup-list` once and cache the result briefly for console pages. */
export async function listWalgBackups(options: WalgListOptions = {}): Promise<WalgListResult> {
  const env = options.env ?? process.env
  const configured = walgStatus(env).configured
  const binary = resolveWalGBinary(options.binary, env)
  const checkedAt = new Date(options.now ?? Date.now()).toISOString()
  const cacheMs = options.cacheMs ?? 30_000
  const key = `${binary ?? 'missing'}|${env.WALG_S3_PREFIX ?? ''}|${env.WALG_GS_PREFIX ?? ''}|${env.WALG_AZ_PREFIX ?? ''}|${env.WALG_SWIFT_PREFIX ?? ''}|${env.WALG_FILE_PREFIX ?? ''}`
  const now = options.now ?? Date.now()
  if (cacheMs > 0 && backupListCache && backupListCache.key === key && now - backupListCache.at < cacheMs) return backupListCache.result

  let result: WalgListResult
  if (!configured) {
    result = { configured: false, binary: null, backups: [], error: 'WALG_S3_PREFIX (or another WALG_*_PREFIX) is not set in this process.', checkedAt }
  } else if (!binary) {
    result = { configured: true, binary: null, backups: [], error: 'wal-g was not found. Install it on the Postgres host or set WALG_BIN.', checkedAt }
  } else {
    const run = options.run ?? defaultRunner
    try {
      const response = await run([binary, 'backup-list'], { env, timeoutMs: options.timeoutMs ?? 8_000 })
      if (response.code !== 0) {
        result = {
          configured: true,
          binary,
          backups: [],
          error: (response.stderr || response.stdout).trim().slice(0, 500) || `wal-g backup-list exited ${response.code}.`,
          checkedAt,
        }
      } else {
        result = { configured: true, binary, backups: newestFirst(parseWalgBackupList(response.stdout)), checkedAt }
      }
    } catch (error) {
      result = {
        configured: true,
        binary,
        backups: [],
        error: error instanceof Error ? error.message : String(error),
        checkedAt,
      }
    }
  }
  if (cacheMs > 0) backupListCache = { key, at: now, result }
  return result
}

const ageSeconds = (iso: string | null, now: number): number | null => {
  if (!iso) return null
  const time = new Date(iso).getTime()
  return Number.isNaN(time) ? null : Math.max(0, Math.round((now - time) / 1000))
}

const humanAge = (seconds: number | null): string => {
  if (seconds === null) return 'unknown'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

function baseBackupChecks(walg: WalgListResult, now: number, advisory = false): DoctorCheck[] {
  const failed: DoctorStatus = advisory ? 'warn' : 'fail'
  const hostOnly = advisory ? 'The Bunwrite process cannot see the Postgres host environment. ' : ''
  if (walg.skipped) {
    return [{ id: 'walg-skipped', label: 'WAL-G checks', status: 'info', detail: 'WAL-G checks were skipped.' }]
  }
  if (!walg.configured) {
    return [
      {
        id: 'walg-prefix',
        label: 'WAL-G storage',
        status: failed,
        detail: `${hostOnly}No WALG_*_PREFIX is configured in this process.`,
        fix: 'Run `bunwrite postgres:doctor` on the Postgres host with the WAL-G environment, or set WALG_S3_PREFIX here.',
      },
    ]
  }
  if (!walg.binary) {
    return [
      {
        id: 'walg-binary',
        label: 'WAL-G binary',
        status: failed,
        detail: `${hostOnly}The WAL-G storage prefix is set, but the wal-g executable was not found.`,
        fix: 'Install wal-g on the Postgres host or set WALG_BIN to its absolute path.',
      },
    ]
  }
  if (walg.error) {
    return [
      {
        id: 'walg-list',
        label: 'Base backup list',
        status: failed,
        detail: `${hostOnly}Could not read the base backup list: ${walg.error}`,
        fix: 'Run `wal-g backup-list` as the postgres user with the same WALG_* and AWS_* environment.',
      },
    ]
  }
  const checks: DoctorCheck[] = []
  if (walg.backups.length === 0) {
    checks.push({
      id: 'walg-base-backup',
      label: 'Base backup',
      status: failed,
      detail: `${hostOnly}No base backup exists. WAL archiving alone cannot restore a database.`,
      fix: 'wal-g backup-push "$PGDATA"',
    })
  } else {
    const latest = walg.backups[0]!
    const age = ageSeconds(latest.modified, now)
    checks.push({
      id: 'walg-base-backup',
      label: 'Base backup',
      status: age !== null && age > 7 * 86400 ? 'warn' : 'ok',
      detail: `${latest.name}${age === null ? '' : ` is ${humanAge(age)} old`}.`,
      fix: age !== null && age > 7 * 86400 ? 'Run `wal-g backup-push "$PGDATA"` and schedule it (cron or a systemd timer).' : undefined,
    })
  }
  return checks
}

function checksFor(status: PostgresStatus, walg: WalgListResult, env: Record<string, string | undefined>, now: number, advisory = false): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  const { settings, archiver } = status

  checks.push({
    id: 'wal-level',
    label: 'wal_level',
    status: settings.walLevel === 'replica' || settings.walLevel === 'logical' ? 'ok' : 'fail',
    detail: `wal_level is ${settings.walLevel || 'unset'}.`,
    fix:
      settings.walLevel === 'replica' || settings.walLevel === 'logical'
        ? undefined
        : `ALTER SYSTEM SET wal_level = 'replica'; then restart Postgres.`,
  })

  checks.push({
    id: 'archive-mode',
    label: 'archive_mode',
    status: settings.archiveMode === 'on' || settings.archiveMode === 'always' ? 'ok' : 'fail',
    detail: `archive_mode is ${settings.archiveMode || 'unset'}.`,
    fix:
      settings.archiveMode === 'on' || settings.archiveMode === 'always'
        ? undefined
        : 'ALTER SYSTEM SET archive_mode = on; then restart Postgres.',
  })

  const archiveCommandOk = /wal-g\s+wal-push/.test(settings.archiveCommand)
  checks.push({
    id: 'archive-command',
    label: 'archive_command',
    status: settings.archiveCommand ? (archiveCommandOk ? 'ok' : 'warn') : 'fail',
    detail: settings.archiveCommand
      ? archiveCommandOk
        ? 'Postgres calls wal-g wal-push for every completed WAL segment.'
        : 'A custom command is configured; make sure it actually archives WAL and reports failures.'
      : 'No archive_command is configured, so WAL segments are not archived.',
    fix: archiveCommandOk ? undefined : `ALTER SYSTEM SET archive_command = 'wal-g wal-push %p'; SELECT pg_reload_conf();`,
  })

  const restoreCommandOk = /wal-g\s+wal-fetch/.test(settings.restoreCommand)
  checks.push({
    id: 'restore-command',
    label: 'restore_command',
    status: restoreCommandOk ? 'ok' : 'warn',
    detail: restoreCommandOk
      ? 'Postgres can fetch archived WAL with wal-g wal-fetch.'
      : settings.restoreCommand
        ? `A custom restore_command is set (${settings.restoreCommand}); verify it can fetch WAL-G objects.`
        : 'restore_command is empty in the running server. Set it in postgresql.conf before a point-in-time restore.',
    fix: restoreCommandOk ? undefined : `restore_command = 'wal-g wal-fetch %f %p'`,
  })

  checks.push({
    id: 'archive-timeout',
    label: 'archive_timeout',
    status: settings.archiveTimeoutSeconds > 0 && settings.archiveTimeoutSeconds <= 300 ? 'ok' : 'warn',
    detail:
      settings.archiveTimeoutSeconds > 0
        ? `archive_timeout is ${settings.archiveTimeoutSeconds}s, so an idle database still archives promptly.`
        : 'archive_timeout is 0. A quiet database can wait a long time before its current WAL segment is archived.',
    fix: settings.archiveTimeoutSeconds > 0 && settings.archiveTimeoutSeconds <= 300 ? undefined : `ALTER SYSTEM SET archive_timeout = '60s'; SELECT pg_reload_conf();`,
  })

  if (!archiver) {
    checks.push({
      id: 'archiver-stats',
      label: 'Archiver statistics',
      status: 'warn',
      detail: 'pg_stat_archiver is not readable in this deployment.',
      fix: 'Check the Postgres logs for "archive command failed" messages.',
    })
  } else {
    const lastArchivedAge = ageSeconds(archiver.lastArchivedAt, now)
    const failedAfterSuccess = archiver.lastFailedAt !== null && (archiver.lastArchivedAt === null || archiver.lastFailedAt > archiver.lastArchivedAt)
    const staleThreshold = settings.archiveTimeoutSeconds > 0 ? Math.max(10 * 60, settings.archiveTimeoutSeconds * 4) : 24 * 3600
    if (failedAfterSuccess) {
      checks.push({
        id: 'archiver-failure',
        label: 'Archiver failures',
        status: 'fail',
        detail: `The last archive attempt failed${archiver.lastFailedWal ? ` for ${archiver.lastFailedWal}` : ''}.`,
        fix: 'Run `wal-g wal-push <wal-file>` as the postgres user and fix the storage credentials or permissions.',
      })
    } else if (archiver.archivedCount === 0) {
      checks.push({
        id: 'archiver-success',
        label: 'Archiver',
        status: 'warn',
        detail: 'No WAL segment has been archived yet.',
        fix: 'Generate a write or wait for archive_timeout, then check `SELECT * FROM pg_stat_archiver`.',
      })
    } else if (lastArchivedAge !== null && lastArchivedAge > staleThreshold) {
      checks.push({
        id: 'archiver-stale',
        label: 'Archiver',
        status: 'warn',
        detail: `The last successful archive was ${humanAge(lastArchivedAge)} ago.`,
        fix: 'Check `SELECT * FROM pg_stat_archiver` and the Postgres logs; increase archive_timeout only after the command works.',
      })
    } else {
      checks.push({
        id: 'archiver-success',
        label: 'Archiver',
        status: 'ok',
        detail: `${archiver.archivedCount} WAL segment${archiver.archivedCount === 1 ? '' : 's'} archived${lastArchivedAge === null ? '' : `; last ${humanAge(lastArchivedAge)} ago`}.`,
      })
    }
  }

  checks.push(...baseBackupChecks(walg, now, advisory))

  if (!env.WALG_LIBSODIUM_KEY && !env.WALG_PGP_KEY && !env.WALG_LIBSODIUM_KEY_PATH && !env.WALG_PGP_KEY_PATH) {
    checks.push({
      id: 'walg-encryption',
      label: 'Backup encryption',
      status: 'warn',
      detail: 'WAL-G encryption is not configured. The archive contains every database and stored secret.',
      fix: 'Set WALG_LIBSODIUM_KEY or WALG_PGP_KEY where wal-g runs, then take a new base backup.',
    })
  }

  if (status.dataDirectory) {
    checks.push({ id: 'data-directory', label: 'data_directory', status: 'info', detail: status.dataDirectory })
  } else {
    checks.push({
      id: 'data-directory',
      label: 'data_directory',
      status: 'warn',
      detail: 'The data directory is not readable by this role.',
      fix: 'Pass --pgdata to the runbook command, or use the path from `SHOW data_directory` as a superuser.',
    })
  }

  checks.push({
    id: 'recovery-state',
    label: 'Server role',
    status: 'info',
    detail: status.inRecovery ? 'This server is a standby (in recovery).' : 'This server is a primary and accepts writes.',
  })

  return checks
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const sqlQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`

/** Hide the password but keep the host, database and user useful for a runbook. */
export function maskDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.password) url.password = '***'
    for (const key of [...url.searchParams.keys()]) {
      if (/pass|secret|token|key/i.test(key)) url.searchParams.set(key, '***')
    }
    return url.toString()
  } catch {
    return value.replace(/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@/\s]+@/i, '$1***@')
  }
}

export interface PostgresRunbookOptions {
  status?: PostgresStatus
  env?: Record<string, string | undefined>
  databaseUrl?: string
  pgdata?: string
  bunwriteService?: string
  postgresService?: string
  baseBackup?: string
  targetTime?: string
  docker?: boolean
}

/** Build copy-paste operator steps for a WAL-G restore. */
export function postgresRunbook(options: PostgresRunbookOptions = {}): string {
  const env = options.env ?? process.env
  const status = options.status
  const major = status?.versionNumber ? Math.floor(status.versionNumber / 10_000) : 16
  const pgdata = options.pgdata || status?.dataDirectory || env.PGDATA || `/var/lib/postgresql/${major}/main`
  const bunwriteService = options.bunwriteService || env.BUNWRITE_SERVICE || 'bunwrite'
  const postgresService = options.postgresService || env.POSTGRES_SERVICE || 'postgresql'
  const baseBackup = options.baseBackup || 'LATEST'
  const target = options.targetTime?.trim()
  const database = maskDatabaseUrl(options.databaseUrl ?? env.DATABASE_URL)
  const lines: string[] = []

  lines.push(
    '# Bunwrite Postgres restore runbook (WAL-G)',
    '# Review every line before running it. Stop all writers first: never run',
    '# two Bunwrite instances against the same Postgres database.',
    '',
    '# 1. Stop the application and the database.',
    `sudo systemctl stop ${shellQuote(bunwriteService)}`,
    `sudo systemctl stop ${shellQuote(postgresService)}`,
    '',
    '# 2. WAL-G needs the same environment it used to archive.',
    `export PGDATA=${shellQuote(pgdata)}`,
    'export WALG_S3_PREFIX="${WALG_S3_PREFIX:?set WALG_S3_PREFIX}"',
    '# export AWS_ACCESS_KEY_ID=...',
    '# export AWS_SECRET_ACCESS_KEY=...',
    '',
    '# 3. Confirm the backup you intend to restore.',
    'sudo -u postgres -E wal-g backup-list',
    '',
    '# 4. Move the old data directory aside and restore the base backup.',
    'sudo -u postgres mv "$PGDATA" "$PGDATA.before-restore.$(date +%Y%m%d%H%M%S)"',
    'sudo -u postgres mkdir -p "$PGDATA"',
    'sudo -u postgres chmod 700 "$PGDATA"',
    `sudo -u postgres -E wal-g backup-fetch "$PGDATA" ${shellQuote(baseBackup)}`,
    '',
    '# 5. Add these to postgresql.conf (usually $PGDATA/postgresql.conf):',
    "# restore_command = 'wal-g wal-fetch %f %p'",
  )
  if (target) {
    lines.push(`# recovery_target_time = ${sqlQuote(target)}`)
  } else {
    lines.push("# recovery_target_time = '2026-11-02 10:00:00+00'   # optional point in time")
  }
  lines.push(
    "# recovery_target_action = 'promote'",
    '',
    '# 6. Tell Postgres to recover, then start it.',
    'sudo -u postgres touch "$PGDATA/recovery.signal"',
    `sudo systemctl start ${shellQuote(postgresService)}`,
    'sudo -u postgres psql -c "SELECT pg_last_wal_replay_lsn(), pg_is_in_recovery();"',
    '',
    '# 7. Start Bunwrite once pg_is_in_recovery() is false.',
    `sudo systemctl start ${shellQuote(bunwriteService)}`,
  )
  if (database) lines.push(`# DATABASE_URL was ${database}`)
  lines.push(
    '',
    '# Docker instead of systemd: stop the stack, then use the isolated restore',
    '# service in docker-compose.restore.yml. It restores into a new volume so',
    '# the production volume is never overwritten.',
  )
  if (options.docker) {
    lines.push(
      '#   docker compose stop bunwrite postgres',
      '#   docker compose -f docker-compose.restore.yml --profile restore up --build postgres-restore',
      '#   # Then point DATABASE_URL at the restored instance and verify before cutover.',
    )
  }
  lines.push(
    '',
    '# WAL-G covers databases only. Uploaded files, function code and site builds',
    '# must be restored from STORAGE_PATH / the uploads bucket separately.',
  )
  return lines.join('\n')
}

export async function postgresDoctor(options: PostgresDoctorOptions): Promise<PostgresDoctorReport> {
  const env = options.env ?? process.env
  const status = options.status ?? (await readPostgresStatus(options.sql))
  const walg =
    options.walg ??
    (options.checkWalg === false
      ? { configured: walgStatus(env).configured, binary: null, backups: [], error: 'WAL-G checks were skipped.', checkedAt: new Date(options.now ?? Date.now()).toISOString(), skipped: true }
      : await listWalgBackups({
          env,
          binary: options.walgBinary,
          run: options.run,
          timeoutMs: options.walgTimeoutMs,
          cacheMs: options.walgCacheMs,
          now: options.now,
        }))
  const now = options.now ?? Date.now()
  const checks = checksFor(status, walg, env, now, options.walgAdvisory)
  return {
    status,
    walg,
    checks,
    runbook: postgresRunbook({
      status,
      env,
      databaseUrl: options.databaseUrl,
      pgdata: options.pgdata,
      bunwriteService: options.bunwriteService,
      postgresService: options.postgresService,
      baseBackup: options.baseBackup,
      targetTime: options.targetTime,
      docker: options.docker,
    }),
    ok: !checks.some((check) => check.status === 'fail'),
  }
}

export const doctorTone = (status: DoctorStatus): string => (status === 'ok' ? 'success' : status === 'fail' ? 'critical' : status === 'warn' ? 'attention' : 'info')

export const doctorLabel = (status: DoctorStatus): string => (status === 'ok' ? 'OK' : status === 'fail' ? 'Failed' : status === 'warn' ? 'Warning' : 'Info')
