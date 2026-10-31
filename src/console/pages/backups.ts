/**
 * Organization-level backups. Whole-instance archives cover every project, so
 * they live in the organization shell rather than inside a project's Settings.
 */
import { basename, dirname, join } from 'node:path'
import { rmSync } from 'node:fs'

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
const canManage = (ctx: ConsoleContext) => ctx.organizations.roleOf(orgId(ctx), ctx.admin.email) === 'owner'

function requireOwner(ctx: ConsoleContext): void {
  if (!canManage(ctx)) throw err('general_argument_invalid', 'Only an organization owner can manage backups.')
}

function backupsPage(ctx: ConsoleContext) {
  if (!canManage(ctx)) return ctx.go('/console')
  const control = ctx.projects.control
  const org = ctx.organizations.ensure(orgId(ctx), control.config.projectName)
  const header = organizationHeader(
    org,
    {
      projects: ctx.projects.list().length,
      members: ctx.organizations.members(org.id).filter((member) => member.status === 'active').length,
    },
    'backups',
    true,
  )
  return backupsView(ctx).then((body) => ctx.render('Backups', 'organization', html`${header}${body}`))
}

export function backupPages(router: ConsoleRouter): void {
  router.get(BACKUPS, ({ ctx }) => backupsPage(ctx))

  router.post(BACKUPS, ({ ctx }) => {
    requireOwner(ctx)
    const keep = Number(ctx.form.backupsKeep)
    if (!Number.isInteger(keep) || keep < 1 || keep > 100) {
      throw err('general_argument_invalid', 'Keep between 1 and 100 automatic backups.')
    }
    const control = ctx.projects.control
    const s3 = s3FromForm(ctx.form, 'backupS3', control.config.backups.s3)
    const prefix = value(ctx.form, 'backupPrefix').replace(/^\/+|\/+$/g, '')
    if (prefix.includes('..')) throw err('general_argument_invalid', 'The backup prefix cannot contain "..".')
    control.settings.set('backups', { enabled: checked(ctx.form.backupsEnabled), keep, s3, prefix })
    return ctx.go(BACKUPS, { tone: 'success', text: 'Backup settings saved' })
  })

  router.post(`${BACKUPS}/reset`, ({ ctx }) => {
    requireOwner(ctx)
    ctx.projects.control.settings.reset('backups')
    return ctx.go(BACKUPS, { tone: 'success', text: 'Backup settings reset' })
  })

  router.post(`${BACKUPS}/create`, async ({ ctx }) => {
    requireOwner(ctx)
    const backup = await ctx.projects.control.backups.create('manual')
    return ctx.go(BACKUPS, { tone: 'success', text: `Created ${backup.name}` })
  })

  router.get(`${BACKUPS}/:name/download`, async ({ ctx, path }) => {
    requireOwner(ctx)
    return ctx.projects.control.backups.serve(path.name!)
  })

  router.post(`${BACKUPS}/restore`, async ({ ctx }) => {
    requireOwner(ctx)
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

  router.post(`${BACKUPS}/restore/cancel`, ({ ctx }) => {
    requireOwner(ctx)
    const removed = cancelPendingRestore(ctx.projects.control.config.databasePath)
    return ctx.go(BACKUPS, {
      tone: 'info',
      text: removed ? 'Staged restore cancelled' : 'There is no staged restore to cancel',
    })
  })

  router.post(`${BACKUPS}/:name/delete`, async ({ ctx, path }) => {
    requireOwner(ctx)
    await ctx.projects.control.backups.delete(path.name!)
    return ctx.go(BACKUPS, { tone: 'success', text: 'Backup deleted' })
  })
}
