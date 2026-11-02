/**
 * Organization-level backups. Whole-instance archives cover every project, so
 * they live in the organization shell rather than inside a project's Settings.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { litestreamSettingsFromEnv, readLitestreamSettings, resetLitestreamSettings, writeLitestreamSettings, type LitestreamSettings } from '~/backups/litestream-settings'
import { cancelPendingRestore, pendingRestoreDir, readPendingRestore, stagePendingRestore } from '~/backups/pending'
import { postgresDoctor, type PostgresDoctorReport } from '~/backups/postgres'
import { firstIncompleteStep, postgresReadiness, readReadinessRecord, recordDrill, recordPostgresBaseBackup, sqliteReadiness } from '~/backups/readiness'
import { restoreInstance } from '~/backups/restore'
import type { BackupFile } from '~/backups/service'
import type { S3Config } from '~/config'
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { checked, s3FromForm, value } from '~/console/forms'
import { html } from '~/console/html'
import { BACKUP_SETUP } from '~/console/views/backup-shared'
import { backupSetupView } from '~/console/views/backup-setup'
import { organizationHeader } from '~/console/views/organization'
import { BACKUP_SCHEDULES, BACKUPS, backupsView } from '~/console/views/backups'
import { parseCron } from '~/functions/cron'
import { err } from '~/lib/errors'
import { uniqueId } from '~/lib/ids'

const orgId = (ctx: ConsoleContext) => ctx.projects.control.config.orgId
const canManage = async (ctx: ConsoleContext) => (await ctx.organizations.roleOf(orgId(ctx), ctx.admin.email)) === 'owner'

async function requireOwner(ctx: ConsoleContext): Promise<void> {
  if (!(await canManage(ctx))) throw err('general_argument_invalid', 'Only an organization owner can manage backups.')
}

/** The archive and Litestream flows only operate on local SQLite files. */
function requireLocalBackups(ctx: ConsoleContext): void {
  if (!ctx.projects.control.db.capabilities.localFile) {
    throw err('general_argument_invalid', 'Whole-instance archives are only available with DB_DRIVER=sqlite. Use WAL-G or managed PITR for Postgres.')
  }
}

function litestreamFromForm(ctx: ConsoleContext, current: LitestreamSettings): LitestreamSettings {
  const f = ctx.form
  // The console hides the connection fields while replication is off. Keep the
  // saved replica and credentials so turning it back on does not lose them.
  if (!checked(f.litestreamEnabled)) return { ...current, enabled: false }
  const clear = checked(f.clearLitestreamCredentials)
  return {
    enabled: checked(f.litestreamEnabled),
    replicaUrl: value(f, 'litestreamReplicaUrl'),
    accessKeyId: clear ? '' : value(f, 'litestreamAccessKeyId') || current.accessKeyId,
    secretAccessKey: clear ? '' : String(f.litestreamSecretAccessKey ?? '') || current.secretAccessKey,
    region: value(f, 'litestreamRegion'),
    endpoint: value(f, 'litestreamEndpoint'),
    forcePathStyle: checked(f.litestreamForcePathStyle),
    syncInterval: value(f, 'litestreamSyncInterval') || '1s',
    heartbeatUrl: value(f, 'litestreamHeartbeatUrl'),
    snapshotInterval: value(f, 'litestreamSnapshotInterval') || '24h',
    snapshotRetention: value(f, 'litestreamSnapshotRetention') || '168h',
    l0Retention: value(f, 'litestreamL0Retention') || '24h',
  }
}

async function organizationShell(ctx: ConsoleContext, title: string, body: ReturnType<typeof html>) {
  const control = ctx.projects.control
  const org = await ctx.organizations.ensure(orgId(ctx), control.config.projectName)
  const header = organizationHeader(
    org,
    {
      projects: ctx.projects.list().length,
      members: (await ctx.organizations.members(org.id)).filter((member) => member.status === 'active').length,
    },
    'backups',
    true,
  )
  return ctx.render(title, 'organization', html`${header}${body}`)
}

async function backupsPage(ctx: ConsoleContext) {
  if (!(await canManage(ctx))) return ctx.go('/console')
  const body = await backupsView(ctx)
  return organizationShell(ctx, 'Backups', body)
}

/** Parse the wizard's S3 fields. Endpoint stays optional for AWS S3. */
function wizardS3(ctx: ConsoleContext, existing: S3Config): S3Config {
  const f = ctx.form
  const bucket = value(f, 'backupS3Bucket')
  const region = value(f, 'backupS3Region')
  const accessKey = value(f, 'backupS3AccessKey')
  const secret = String(f.backupS3Secret ?? '') || existing.secret
  const forcePathStyle = checked(f.backupS3ForcePathStyle)
  if (!bucket || !region || !accessKey || !secret) {
    throw err('general_argument_invalid', 'Bucket, region, access key and secret are required for S3 storage.')
  }
  let endpoint = value(f, 'backupS3Endpoint').replace(/\/$/, '')
  if (!endpoint) endpoint = `https://s3.${region}.amazonaws.com`
  try {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol')
  } catch {
    throw err('general_argument_invalid', 'The S3 endpoint must be a valid http or https URL.')
  }
  return { enabled: true, bucket, region, endpoint, accessKey, secret, forcePathStyle }
}

async function setupPage(ctx: ConsoleContext) {
  if (!(await canManage(ctx))) return ctx.go('/console')
  const control = ctx.projects.control
  const config = control.config
  const driver = control.db.capabilities.localFile ? 'sqlite' : 'postgres'
  const record = readReadinessRecord(config.databasePath)
  let backups: BackupFile[] = []
  let report: PostgresDoctorReport | null = null
  let statusError = ''
  if (driver === 'sqlite') {
    try {
      backups = await control.backups.list()
    } catch (error) {
      statusError = error instanceof Error ? error.message : String(error)
    }
  } else {
    try {
      report = await postgresDoctor({
        sql: control.db.driver,
        env: process.env,
        databaseUrl: config.databaseUrl,
        pgdata: process.env.PGDATA,
        docker: true,
        walgAdvisory: true,
      })
    } catch (error) {
      statusError = error instanceof Error ? error.message : String(error)
    }
  }
  const readiness =
    driver === 'sqlite'
      ? sqliteReadiness({ config, backups, record })
      : postgresReadiness({ config, report, record })
  const requested = Number(ctx.url.searchParams.get('step'))
  const step =
    Number.isInteger(requested) && requested >= 1 && requested <= 5
      ? requested
      : control.settings.overridden('backups')
        ? firstIncompleteStep(readiness)
        : 1
  const latest = backups[0]
  const body = backupSetupView({
    driver,
    step,
    readiness,
    backups: config.backups,
    latestBackup: latest,
    report,
    verified: ctx.url.searchParams.get('verified') === '1',
    error: statusError || undefined,
  })
  return organizationShell(ctx, 'Backup setup', body)
}

export function backupPages(router: ConsoleRouter): void {
  router.get(BACKUPS, ({ ctx }) => backupsPage(ctx))
  router.get(BACKUP_SETUP, ({ ctx }) => setupPage(ctx))

  router.post(`${BACKUP_SETUP}/storage`, async ({ ctx }) => {
    await requireOwner(ctx)
    const control = ctx.projects.control
    const current = control.config.backups
    const local = control.db.capabilities.localFile
    const mode = value(ctx.form, 'storageMode') === 's3' || !local ? 's3' : 'local'
    const s3 = mode === 's3' ? wizardS3(ctx, current.s3) : { ...current.s3, enabled: false }
    const prefix = value(ctx.form, 'backupPrefix').replace(/^\/+|\/+$/g, '')
    if (prefix.includes('..')) throw err('general_argument_invalid', 'The backup prefix cannot contain "..".')
    await control.settings.set('backups', { ...current, s3, prefix })
    return ctx.go(`${BACKUP_SETUP}?step=2`, { tone: 'success', text: mode === 's3' ? 'Storage saved' : 'Local storage selected' })
  })

  router.post(`${BACKUP_SETUP}/schedule`, async ({ ctx }) => {
    await requireOwner(ctx)
    const control = ctx.projects.control
    const keep = Number(ctx.form.backupsKeep)
    if (!Number.isInteger(keep) || keep < 1 || keep > 100) {
      throw err('general_argument_invalid', 'Keep between 1 and 100 automatic backups.')
    }
    const preset = BACKUP_SCHEDULES.find((entry) => entry.key === value(ctx.form, 'backupSchedulePreset'))
    const schedule = preset?.cron || value(ctx.form, 'backupSchedule').trim() || control.config.backups.schedule || '0 2 * * *'
    try {
      parseCron(schedule)
    } catch (error) {
      throw err('general_argument_invalid', error instanceof Error ? error.message : 'Invalid backup schedule.')
    }
    await control.settings.set('backups', { ...control.config.backups, enabled: true, schedule, keep })
    return ctx.go(`${BACKUP_SETUP}?step=3`, { tone: 'success', text: 'Schedule saved' })
  })

  router.post(`${BACKUP_SETUP}/first`, async ({ ctx }) => {
    await requireOwner(ctx)
    const control = ctx.projects.control
    if (!control.db.capabilities.localFile) {
      if (!checked(ctx.form.baseBackupConfirmed)) {
        throw err('general_argument_invalid', 'Confirm that the base backup exists before continuing.')
      }
      recordPostgresBaseBackup(control.config.databasePath)
      return ctx.go(`${BACKUP_SETUP}?step=4`, { tone: 'success', text: 'Base backup recorded' })
    }
    requireLocalBackups(ctx)
    const backup = await control.backups.create('manual')
    return ctx.go(`${BACKUP_SETUP}?step=4`, { tone: 'success', text: `Created ${backup.name}` })
  })

  router.post(`${BACKUP_SETUP}/verify`, async ({ ctx }) => {
    await requireOwner(ctx)
    const control = ctx.projects.control
    const config = control.config
    if (!control.db.capabilities.localFile) {
      if (!checked(ctx.form.drillConfirmed)) {
        throw err('general_argument_invalid', 'Run the restore and confirm it before recording the test.')
      }
      recordDrill(config.databasePath, 'postgres', 'Isolated Docker restore check')
      return ctx.go(`${BACKUP_SETUP}?step=5&verified=1`, { tone: 'success', text: 'Restore test recorded' })
    }
    requireLocalBackups(ctx)
    const [latest] = await control.backups.list()
    if (!latest) throw err('general_argument_invalid', 'Create a backup before testing a restore.')
    // Pull the archive to a temporary file, including from S3, then validate
    // every database in it. The live data directory is never touched.
    const dir = mkdtempSync(join(tmpdir(), 'bunwrite-drill-'))
    try {
      const archive = join(dir, latest.name)
      await Bun.write(archive, await control.backups.serve(latest.name))
      await restoreInstance({
        databasePath: config.databasePath,
        archive,
        key: config.backupEncryptionKey,
        dryRun: true,
        log: () => {},
      })
      recordDrill(config.databasePath, 'sqlite', `Validated ${latest.name}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    return ctx.go(`${BACKUP_SETUP}?step=5&verified=1`, { tone: 'success', text: 'Restore test passed' })
  })

  router.post(BACKUPS, async ({ ctx }) => {
    await requireOwner(ctx)
    requireLocalBackups(ctx)
    const keep = Number(ctx.form.backupsKeep)
    if (!Number.isInteger(keep) || keep < 1 || keep > 100) {
      throw err('general_argument_invalid', 'Keep between 1 and 100 automatic backups.')
    }
    const control = ctx.projects.control
    // A known preset wins over the cron input. The input is hidden (and not
    // submitted) while a preset is selected, but without JavaScript it can
    // still carry the previous expression.
    const preset = BACKUP_SCHEDULES.find((entry) => entry.key === value(ctx.form, 'backupSchedulePreset'))
    const schedule = preset?.cron || value(ctx.form, 'backupSchedule').trim() || control.config.backups.schedule || '0 2 * * *'
    try {
      parseCron(schedule)
    } catch (error) {
      throw err('general_argument_invalid', error instanceof Error ? error.message : 'Invalid backup schedule.')
    }
    // Turning S3 off keeps the connection details for when it is turned back on.
    const s3 = checked(ctx.form.backupS3Enabled)
      ? s3FromForm(ctx.form, 'backupS3', control.config.backups.s3)
      : { ...control.config.backups.s3, enabled: false }
    const prefix = value(ctx.form, 'backupPrefix').replace(/^\/+|\/+$/g, '')
    if (prefix.includes('..')) throw err('general_argument_invalid', 'The backup prefix cannot contain "..".')
    await control.settings.set('backups', { enabled: checked(ctx.form.backupsEnabled), schedule, keep, s3, prefix })
    return ctx.go(BACKUPS, { tone: 'success', text: 'Backup settings saved' })
  })

  router.post(`${BACKUPS}/reset`, async ({ ctx }) => {
    await requireOwner(ctx)
    requireLocalBackups(ctx)
    await ctx.projects.control.settings.reset('backups')
    return ctx.go(BACKUPS, { tone: 'success', text: 'Backup settings reset' })
  })

  router.post(`${BACKUPS}/litestream`, async ({ ctx }) => {
    await requireOwner(ctx)
    requireLocalBackups(ctx)
    const config = ctx.projects.control.config
    const current = readLitestreamSettings(config.databasePath) ?? litestreamSettingsFromEnv()
    try {
      writeLitestreamSettings(config.databasePath, litestreamFromForm(ctx, current))
    } catch (error) {
      throw err('general_argument_invalid', error instanceof Error ? error.message : String(error))
    }
    return ctx.go(BACKUPS, { tone: 'success', text: 'Litestream settings saved. Restart Bunwrite to apply them.' })
  })

  router.post(`${BACKUPS}/litestream/reset`, async ({ ctx }) => {
    await requireOwner(ctx)
    requireLocalBackups(ctx)
    resetLitestreamSettings(ctx.projects.control.config.databasePath)
    return ctx.go(BACKUPS, { tone: 'success', text: 'Litestream console settings removed. Restart Bunwrite to use the environment again.' })
  })

  router.post(`${BACKUPS}/create`, async ({ ctx }) => {
    await requireOwner(ctx)
    requireLocalBackups(ctx)
    const backup = await ctx.projects.control.backups.create('manual')
    return ctx.go(BACKUPS, { tone: 'success', text: `Created ${backup.name}` })
  })

  router.get(`${BACKUPS}/:name/download`, async ({ ctx, path }) => {
    await requireOwner(ctx)
    requireLocalBackups(ctx)
    return ctx.projects.control.backups.serve(path.name!)
  })

  router.post(`${BACKUPS}/restore`, async ({ ctx }) => {
    await requireOwner(ctx)
    requireLocalBackups(ctx)
    const file = ctx.form.backup
    if (!(file instanceof Blob) || file.size === 0) throw err('general_argument_invalid', 'Choose a backup archive to restore.')
    const config = ctx.projects.control.config
    if (readPendingRestore(config.databasePath)) {
      throw err('general_argument_invalid', 'A restore is already staged. Restart Bunwrite to apply it, or cancel it first.')
    }
    const key = value(ctx.form, 'backupKey') || undefined
    const upload = join(dirname(pendingRestoreDir(config.databasePath)), `.restore-upload-${uniqueId()}`)
    try {
      if (!(await Bun.write(upload, file))) throw new Error('The backup archive is empty.')
      // Validate every database before anything is staged.
      await restoreInstance({
        databasePath: config.databasePath,
        archive: upload,
        key: key ?? config.backupEncryptionKey,
        dryRun: true,
        log: () => {},
      })
      stagePendingRestore({
        databasePath: config.databasePath,
        archive: upload,
        name: basename(String((file as File).name || 'backup archive')),
        key,
      })
    } catch (error) {
      rmSync(upload, { force: true })
      throw error
    }
    return ctx.go(BACKUPS, { tone: 'success', text: 'Archive validated and staged. Restart Bunwrite to apply it.' })
  })

  router.post(`${BACKUPS}/restore/cancel`, async ({ ctx }) => {
    await requireOwner(ctx)
    const removed = cancelPendingRestore(ctx.projects.control.config.databasePath)
    return ctx.go(BACKUPS, {
      tone: 'info',
      text: removed ? 'Staged restore cancelled' : 'There is no staged restore to cancel',
    })
  })

  router.post(`${BACKUPS}/:name/delete`, async ({ ctx, path }) => {
    await requireOwner(ctx)
    requireLocalBackups(ctx)
    await ctx.projects.control.backups.delete(path.name!)
    return ctx.go(BACKUPS, { tone: 'success', text: 'Backup deleted' })
  })
}
