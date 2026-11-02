/**
 * A small, honest progress model for the backup onboarding wizard.
 *
 * The console can only observe what it owns. For SQLite that is the archive
 * list; for Postgres it is the live server state plus whatever WAL-G can see
 * from this process. A restore test is the one result the server cannot prove
 * by itself, so the operator records it here after running the isolated check.
 *
 * The record lives next to the data directory, like the Litestream settings, so
 * it works for both drivers and never needs a database migration.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Config } from '~/config'
import { dataDirOf } from '~/projects/paths'
import type { PostgresDoctorReport } from './postgres'
import type { BackupFile } from './service'

export type ReadinessStatus = 'done' | 'todo' | 'warn'
export type ReadinessStage = 'unprotected' | 'configured' | 'backed-up' | 'verified'

export interface ReadinessStep {
  key: 'storage' | 'schedule' | 'archive' | 'drill'
  label: string
  detail: string
  status: ReadinessStatus
}

export interface BackupReadiness {
  driver: 'sqlite' | 'postgres'
  stage: ReadinessStage
  title: string
  summary: string
  steps: ReadinessStep[]
  /** Steps that are done or handled with a warning. */
  done: number
  total: number
  percent: number
  /** Storage is outside this server (S3 or WAL-G object storage). */
  offsite: boolean
  lastDrillAt?: string
  complete: boolean
}

export interface ReadinessRecord {
  drillAt?: string
  drillDriver?: 'sqlite' | 'postgres'
  drillNote?: string
  /** A Postgres base backup the operator confirmed when WAL-G is not visible here. */
  baseBackupAt?: string
}

/** How long a restore test counts as fresh before the card asks for another. */
export const DRILL_MAX_AGE_DAYS = 30

export const readinessPath = (databasePath: string): string => join(dataDirOf(databasePath), 'backup-readiness.json')

export function readReadinessRecord(databasePath: string): ReadinessRecord {
  const path = readinessPath(databasePath)
  if (!existsSync(path)) return {}
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const object = value as Record<string, unknown>
    const stringOf = (key: string) => (typeof object[key] === 'string' ? (object[key] as string) : undefined)
    return {
      drillAt: stringOf('drillAt'),
      drillDriver: object.drillDriver === 'sqlite' || object.drillDriver === 'postgres' ? object.drillDriver : undefined,
      drillNote: stringOf('drillNote'),
      baseBackupAt: stringOf('baseBackupAt'),
    }
  } catch {
    // A corrupt record is treated as "not verified" rather than blocking the page.
    return {}
  }
}

export function writeReadinessRecord(databasePath: string, record: ReadinessRecord): void {
  const path = readinessPath(databasePath)
  mkdirSync(dataDirOf(databasePath), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

/** Record a successful restore test; the wizard and the readiness card share it. */
export function recordDrill(databasePath: string, driver: 'sqlite' | 'postgres', note?: string, now = new Date()): ReadinessRecord {
  const record = { ...readReadinessRecord(databasePath), drillAt: now.toISOString(), drillDriver: driver, drillNote: note }
  writeReadinessRecord(databasePath, record)
  return record
}

/** Remember that the operator took a Postgres base backup on a host we cannot see. */
export function recordPostgresBaseBackup(databasePath: string, now = new Date()): ReadinessRecord {
  const record = { ...readReadinessRecord(databasePath), baseBackupAt: now.toISOString() }
  writeReadinessRecord(databasePath, record)
  return record
}

export function drillIsRecent(at: string | undefined, now = Date.now(), days = DRILL_MAX_AGE_DAYS): boolean {
  if (!at) return false
  const time = new Date(at).getTime()
  return Number.isFinite(time) && now - time <= days * 24 * 60 * 60 * 1000
}

/** Missing paths only happen in tests and partial configs; treat those as no record. */
function recordOf(config: Config): ReadinessRecord {
  return config.databasePath ? readReadinessRecord(config.databasePath) : {}
}

const dayOf = (at: string): string => {
  const date = new Date(at)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : at
}

function stageOf(steps: ReadinessStep[], drillRecent: boolean): ReadinessStage {
  const archiveDone = steps.find((step) => step.key === 'archive')?.status !== 'todo'
  const scheduleDone = steps.find((step) => step.key === 'schedule')?.status !== 'todo'
  if (drillRecent) return 'verified'
  if (archiveDone) return 'backed-up'
  if (scheduleDone) return 'configured'
  return 'unprotected'
}

function titleOf(stage: ReadinessStage, driver: 'sqlite' | 'postgres', offsite: boolean): string {
  if (stage === 'verified') return offsite ? 'Protected and verified' : 'Protected on this server'
  if (stage === 'backed-up') return 'Backups running — test a restore'
  if (stage === 'configured') return 'Almost there — create the first backup'
  return driver === 'postgres' ? 'Not protected yet' : 'Backups are off'
}

function summaryOf(stage: ReadinessStage, driver: 'sqlite' | 'postgres', offsite: boolean): string {
  if (stage === 'verified') return 'A backup exists and a restore was tested. Nothing else is required.'
  if (stage === 'backed-up') return 'Your data is being copied. Run the restore test once to prove the copy can be recovered.'
  if (stage === 'configured') return driver === 'postgres' ? 'Archiving is configured. Take the first base backup to finish.' : 'The schedule is saved. Create the first archive to finish.'
  if (offsite) return 'Add a schedule and the first backup so a lost server is only an inconvenience.'
  return driver === 'postgres' ? 'Turn on WAL archiving to start protecting this database.' : 'Turn on automatic backups to start protecting this instance.'
}

function build(driver: 'sqlite' | 'postgres', steps: ReadinessStep[], offsite: boolean, record: ReadinessRecord, now: number): BackupReadiness {
  const drillRecent = drillIsRecent(record.drillAt, now)
  const done = steps.filter((step) => step.status !== 'todo').length
  const stage = stageOf(steps, drillRecent)
  return {
    driver,
    stage,
    title: titleOf(stage, driver, offsite),
    summary: summaryOf(stage, driver, offsite),
    steps,
    done,
    total: steps.length,
    percent: Math.round((done / steps.length) * 100),
    offsite,
    lastDrillAt: record.drillAt,
    complete: steps.every((step) => step.status !== 'todo'),
  }
}

function drillStep(record: ReadinessRecord, now: number): ReadinessStep {
  const recent = drillIsRecent(record.drillAt, now)
  if (recent) {
    return {
      key: 'drill',
      label: 'Restore tested',
      detail: `Last tested ${dayOf(record.drillAt!)}. Test again after big changes.`,
      status: 'done',
    }
  }
  if (record.drillAt) {
    return {
      key: 'drill',
      label: 'Restore test is stale',
      detail: `Last tested ${dayOf(record.drillAt)}. Run it once more to refresh this check.`,
      status: 'todo',
    }
  }
  return {
    key: 'drill',
    label: 'Restore test',
    detail: 'Not tested yet. This is the step that proves the backup is usable.',
    status: 'todo',
  }
}

export interface SqliteReadinessInput {
  config: Config
  backups: BackupFile[]
  record?: ReadinessRecord
  now?: number
}

/** Progress for the whole-instance SQLite archives the console owns. */
export function sqliteReadiness(input: SqliteReadinessInput): BackupReadiness {
  const now = input.now ?? Date.now()
  const record = input.record ?? recordOf(input.config)
  const s3 = input.config.backups.s3
  const latest = input.backups[0]

  const steps: ReadinessStep[] = [
    {
      key: 'storage',
      label: s3.enabled ? 'Off-site storage' : 'Storage on this server',
      detail: s3.enabled
        ? `Archives are copied to ${s3.bucket}${input.config.backups.prefix ? ` under ${input.config.backups.prefix}/` : ''}.`
        : 'Archives stay in the data directory. A lost server loses them too — add S3 when you can.',
      // Local storage is a valid choice for the wizard, so it does not block
      // progress. The title still says when protection is local-only.
      status: 'done',
    },
    {
      key: 'schedule',
      label: 'Automatic schedule',
      detail: input.config.backups.enabled
        ? `${input.config.backups.schedule} (UTC), keeping ${input.config.backups.keep}.`
        : 'Off. Turn it on so a backup does not depend on someone remembering.',
      status: input.config.backups.enabled ? 'done' : 'todo',
    },
    {
      key: 'archive',
      label: 'First backup',
      detail: latest
        ? `${input.backups.length} archive${input.backups.length === 1 ? '' : 's'}; newest is ${latest.name}.`
        : 'No archive yet. Create one now to finish setup.',
      status: latest ? 'done' : 'todo',
    },
    drillStep(record, now),
  ]

  return build('sqlite', steps, s3.enabled, record, now)
}

export interface PostgresReadinessInput {
  config: Config
  report: PostgresDoctorReport | null
  record?: ReadinessRecord
  now?: number
}

/** Progress for WAL-G, including the operator-confirmed steps the app cannot see. */
export function postgresReadiness(input: PostgresReadinessInput): BackupReadiness {
  const now = input.now ?? Date.now()
  const record = input.record ?? recordOf(input.config)
  const report = input.report
  const status = report?.status
  const walg = report?.walg
  const archiver = status?.archiver
  const latest = walg?.backups[0]
  const archiveMode = status?.settings.archiveMode === 'on' && status?.settings.walLevel === 'replica'
  const archived = Boolean(archiver && (archiver.archivedCount > 0 || archiver.lastArchivedAt))
  const failures = Boolean(archiver && archiver.failedCount > 0)
  const saved = input.config.backups?.s3
  const savedInConsole = Boolean(saved?.enabled && saved.bucket)

  const storage: ReadinessStep = walg?.configured
    ? {
        key: 'storage',
        label: 'WAL-G storage',
        detail: `Configured${walg.binary ? '' : ' (wal-g is not visible from the app process)'}${walg.error ? `: ${walg.error}` : '.'}`,
        status: 'done',
      }
    : savedInConsole
      ? {
          key: 'storage',
          label: 'WAL-G storage',
          detail: `Saved in the console for ${saved?.bucket}. Set the same WALG_* values on the Postgres host.`,
          status: 'done',
        }
      : {
          key: 'storage',
          label: 'WAL-G storage',
          detail: walg?.error ?? 'Set WALG_S3_PREFIX and the storage credentials on the Postgres host.',
          status: 'todo',
        }

  const schedule: ReadinessStep = archiveMode
    ? {
        key: 'schedule',
        label: 'Continuous WAL archiving',
        detail: failures
          ? `${archiver!.failedCount} archive failure${archiver!.failedCount === 1 ? '' : 's'}; check pg_stat_archiver.`
          : archived
            ? `Last segment archived${archiver?.lastArchivedAt ? ` ${dayOf(archiver.lastArchivedAt)}` : ''}.`
            : 'On, waiting for the first WAL segment. An idle database can take a while.',
        status: failures ? 'warn' : 'done',
      }
    : {
        key: 'schedule',
        label: 'Continuous WAL archiving',
        detail: status ? 'Off. Set wal_level = replica and archive_mode = on in postgresql.conf.' : 'Could not read the Postgres settings.',
        status: 'todo',
      }

  const baseBackupAt = latest?.modified ?? record.baseBackupAt
  const archive: ReadinessStep = baseBackupAt
    ? {
        key: 'archive',
        label: 'Base backup',
        detail: latest ? `Latest is ${latest.name}${latest.modified ? ` from ${dayOf(latest.modified)}` : ''}.` : `Confirmed ${dayOf(baseBackupAt)}.`,
        status: 'done',
      }
    : {
        key: 'archive',
        label: 'Base backup',
        detail: 'None yet. Run wal-g backup-push $PGDATA on the database host, then check again.',
        status: 'todo',
      }

  const steps = [storage, schedule, archive, drillStep(record, now)]
  return build('postgres', steps, Boolean(walg?.configured || savedInConsole), record, now)
}

/** The first step a returning visitor still needs to finish (1-based; 5 means done). */
export function firstIncompleteStep(readiness: BackupReadiness): number {
  const order: ReadinessStep['key'][] = ['storage', 'schedule', 'archive', 'drill']
  for (let index = 0; index < order.length; index++) {
    if (readiness.steps.find((step) => step.key === order[index])?.status === 'todo') return index + 1
  }
  return 5
}
