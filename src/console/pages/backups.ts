/**
 * Organization-level backups. Whole-instance archives cover every project, so
 * they live in the organization shell rather than inside a project's Settings.
 */
import { basename, dirname, join } from 'node:path'
import { rmSync } from 'node:fs'

import { litestreamSettingsFromEnv, readLitestreamSettings, resetLitestreamSettings, writeLitestreamSettings, type LitestreamSettings } from '~/backups/litestream-settings'
import { cancelPendingRestore, pendingRestoreDir, readPendingRestore, stagePendingRestore } from '~/backups/pending'
import { restoreInstance } from '~/backups/restore'
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { checked, s3FromForm, value } from '~/console/forms'
import { html } from '~/console/html'
import { organizationHeader } from '~/console/views/organization'
import { BACKUPS, backupsView } from '~/console/views/backups'
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

async function backupsPage(ctx: ConsoleContext) {
  if (!(await canManage(ctx))) return ctx.go('/console')
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
  return backupsView(ctx).then((body) => ctx.render('Backups', 'organization', html`${header}${body}`))
}

export function backupPages(router: ConsoleRouter): void {
  router.get(BACKUPS, ({ ctx }) => backupsPage(ctx))

  router.post(BACKUPS, async ({ ctx }) => {
    await requireOwner(ctx)
    requireLocalBackups(ctx)
    const keep = Number(ctx.form.backupsKeep)
    if (!Number.isInteger(keep) || keep < 1 || keep > 100) {
      throw err('general_argument_invalid', 'Keep between 1 and 100 automatic backups.')
    }
    const control = ctx.projects.control
    const s3 = s3FromForm(ctx.form, 'backupS3', control.config.backups.s3)
    const prefix = value(ctx.form, 'backupPrefix').replace(/^\/+|\/+$/g, '')
    if (prefix.includes('..')) throw err('general_argument_invalid', 'The backup prefix cannot contain "..".')
    await control.settings.set('backups', { enabled: checked(ctx.form.backupsEnabled), keep, s3, prefix })
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
