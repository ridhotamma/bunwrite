import { existsSync } from 'node:fs'

import type { S3Config } from '~/config'
import { SETTING_KEYS, type SettingKey } from '~/settings/service'
import type { ImageOutput } from '~/render/service'
import { err } from '~/lib/errors'
import { SmtpMailer } from '~/mail/mailer'
import { importEnvVariables } from '~/console/env-vars'
import type { ConsoleRouter } from '~/console/context'
import { arrayOf, checked, lines, value } from '~/console/forms'
import { page } from '~/console/html'
import { inlineStatus, settingsView } from '~/console/views/settings'
import { SETTINGS, TAB_OF_SETTING, isTab, tabPath } from '~/console/settings-meta'

/** Read S3 fields from a settings form, keeping the stored secret when the field is blank. */
function s3FromForm(form: Record<string, any>, prefix: string, existing: S3Config): S3Config {
  const read = (suffix: string) => value(form, `${prefix}${suffix}`)
  const enabled = checked(form[`${prefix}Enabled`])
  const secret = String(form[`${prefix}Secret`] ?? '') || existing.secret
  const endpoint = read('Endpoint').replace(/\/$/, '')
  const config: S3Config = {
    enabled,
    bucket: read('Bucket'),
    region: read('Region'),
    endpoint,
    accessKey: read('AccessKey'),
    secret,
    forcePathStyle: checked(form[`${prefix}ForcePathStyle`]),
  }
  if (enabled) {
    if (!config.endpoint || !config.bucket || !config.region || !config.accessKey || !config.secret) {
      throw err('general_argument_invalid', 'Endpoint, bucket, region, access key and secret are required for S3 storage.')
    }
    let url: URL
    try {
      url = new URL(config.endpoint)
    } catch {
      throw err('general_argument_invalid', 'The S3 endpoint must be a valid URL.')
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw err('general_argument_invalid', 'The S3 endpoint must use http or https.')
  }
  return config
}

/** Settings handlers. Tab markup lives in console/views/settings. */
export function settingsPages(router: ConsoleRouter): void {
  router.get(SETTINGS, ({ ctx }) => ctx.go(tabPath('general')))
  router.get(`${SETTINGS}/:tab`, async ({ ctx, path }) => {
    const tab = path.tab ?? ''
    // The old Access tab moved to its own API page.
    if (tab === 'access') return ctx.go('/console/api')
    return isTab(tab) ? ctx.render('Settings', 'settings', await settingsView(ctx, tab)) : ctx.go(tabPath('general'))
  })

  router.get(`${SETTINGS}/backups/:name/download`, async ({ ctx, path }) => ctx.services.backups.serve(path.name!))

  router.post(`${SETTINGS}/project`, ({ ctx }) => {
    const f = ctx.form
    const days = Number(f.sessionDays)
    const limit = Number(f.sessionsLimit)
    if (!(days >= 1) || !(limit >= 1 && limit <= 100)) throw err('general_argument_invalid', 'Session length and sessions per user must be positive.')
    const projectName = value(f, 'projectName') || ctx.services.config.projectName
    ctx.services.settings.set('project', {
      projectName,
      allowedOrigins: lines(f.allowedOrigins),
      sessionDuration: Math.round(days * 86400),
      sessionsLimit: Math.round(limit),
    })
    ctx.projects.update(ctx.currentProject.id, { name: projectName })
    return ctx.go(tabPath('general'), { tone: 'success', text: 'Project settings saved' })
  })

  router.post(`${SETTINGS}/smtp`, ({ ctx }) => {
    const f = ctx.form
    if (f.disable) {
      ctx.services.settings.set('smtp', { disabled: true })
      return ctx.go(tabPath('email'), { tone: 'success', text: 'Email turned off' })
    }
    const host = value(f, 'host')
    if (!host) throw err('general_argument_invalid', 'Enter the SMTP host.')
    ctx.services.settings.set('smtp', {
      host,
      port: Number(f.port || 587),
      user: value(f, 'user') || undefined,
      password: String(f.password ?? '') || ctx.services.config.smtp?.password,
      secure: checked(f.secure),
      senderEmail: value(f, 'senderEmail') || 'no-reply@example.com',
      senderName: value(f, 'senderName') || `${ctx.services.config.projectName} Team`,
    })
    return ctx.go(tabPath('email'), { tone: 'success', text: 'Email settings saved' })
  })

  // Answers with a fragment for the inline result next to the button.
  router.post(`${SETTINGS}/smtp/test`, async ({ ctx }) => {
    const smtp = ctx.services.config.smtp
    if (!smtp) return page(inlineStatus('Save SMTP settings first.', 'critical'))
    try {
      await new SmtpMailer(smtp).send({
        to: ctx.admin.email,
        subject: `${ctx.services.config.projectName}: test email`,
        text: 'SMTP works. This message was sent from the console.',
        html: '<p>SMTP works. This message was sent from the console.</p>',
      })
      return page(inlineStatus(`Sent to ${ctx.admin.email}`, 'success'))
    } catch (error) {
      return page(inlineStatus(error instanceof Error ? error.message : String(error), 'critical'))
    }
  })

  router.post(`${SETTINGS}/google`, ({ ctx }) => {
    const f = ctx.form
    if (f.disable) {
      ctx.services.settings.set('google', { disabled: true })
      return ctx.go(tabPath('email'), { tone: 'success', text: 'Google sign-in turned off' })
    }
    const clientId = value(f, 'clientId')
    const clientSecret = String(f.clientSecret ?? '') || ctx.services.config.google?.clientSecret || ''
    if (!clientId || !clientSecret) throw err('general_argument_invalid', 'Enter both the client ID and secret.')
    ctx.services.settings.set('google', { clientId, clientSecret })
    return ctx.go(tabPath('email'), { tone: 'success', text: 'Google sign-in saved' })
  })

  router.post(`${SETTINGS}/functions`, ({ ctx }) => {
    const functionsDir = value(ctx.form, 'functionsDir')
    if (functionsDir && !existsSync(functionsDir)) throw err('general_argument_invalid', `No folder at ${functionsDir}.`)
    ctx.services.settings.set('functions', { skipSchedules: arrayOf(ctx.form.paused), functionsDir: functionsDir || undefined })
    return ctx.go(tabPath('functions'), { tone: 'success', text: 'Schedules saved' })
  })

  router.post(`${SETTINGS}/functions/variables`, ({ ctx }) => {
    ctx.services.functions.setGlobalVariable(value(ctx.form, 'key'), String(ctx.form.value ?? ''), checked(ctx.form.secret))
    return ctx.go(tabPath('functions'), { tone: 'success', text: 'Global variable saved' })
  })

  router.post(`${SETTINGS}/functions/variables/delete`, ({ ctx }) => {
    ctx.services.functions.deleteGlobalVariable(String(ctx.form.key ?? ''))
    return ctx.go(tabPath('functions'), { tone: 'success', text: 'Global variable removed' })
  })

  router.post(`${SETTINGS}/functions/variables/bulk`, ({ ctx }) =>
    importEnvVariables(ctx, (vars, secret) => ctx.services.functions.setGlobalVariables(vars, secret), tabPath('functions')),
  )

  router.post(`${SETTINGS}/logs`, ({ ctx }) => {
    const days = Number(ctx.form.retentionDays)
    if (!Number.isFinite(days) || days < 0) throw err('general_argument_invalid', 'Retention must be zero or more days.')
    ctx.services.settings.set('logs', { retentionDays: Math.round(days), logIp: checked(ctx.form.logIp) })
    ctx.services.requestLogs.prune()
    return ctx.go(tabPath('logs'), { tone: 'success', text: 'Log settings saved' })
  })

  router.post(`${SETTINGS}/render`, ({ ctx }) => {
    ctx.services.settings.set('render', { enabled: checked(ctx.form.enabled), allowRemote: checked(ctx.form.allowRemote) })
    return ctx.go(tabPath('render'), { tone: 'success', text: 'Rendering settings saved' })
  })

  router.post(`${SETTINGS}/render/test`, async ({ ctx }) => {
    const output = value(ctx.form, 'output') || 'pdf'
    const source = value(ctx.form, 'html')
    const headers = { 'content-disposition': `inline; filename="test.${output}"`, 'cache-control': 'no-store' }
    if (output === 'pdf') return new Response(await ctx.services.render.pdf(source), { headers: { ...headers, 'content-type': 'application/pdf' } })
    const { bytes, mime } = await ctx.services.render.image(source, { output: output as ImageOutput, width: 900, scale: 2 })
    return new Response(bytes, { headers: { ...headers, 'content-type': mime } })
  })

  router.post(`${SETTINGS}/storage`, ({ ctx }) => {
    ctx.services.settings.set('s3', s3FromForm(ctx.form, 's3', ctx.services.config.s3))
    return ctx.go(tabPath('storage'), { tone: 'success', text: 'Storage settings saved' })
  })

  router.post(`${SETTINGS}/cache`, ({ ctx }) => {
    const f = ctx.form
    const seconds = (name: string) => {
      const n = Number(f[name])
      if (!Number.isFinite(n) || n < 0) throw err('general_argument_invalid', 'Cache lifetimes must be zero or more seconds.')
      return Math.round(n)
    }
    const days = Number(f.previewRetentionDays)
    if (!Number.isFinite(days) || days < 0 || days > 3650) throw err('general_argument_invalid', 'Keep previews between 0 and 3650 days.')
    ctx.services.settings.set('cache', { fileMaxAge: seconds('fileMaxAge'), previewMaxAge: seconds('previewMaxAge'), previewRetentionDays: Math.round(days) })
    ctx.services.storage.prunePreviews(true)
    return ctx.go(tabPath('cache'), { tone: 'success', text: 'Cache settings saved' })
  })

  router.post(`${SETTINGS}/cache/previews/clear`, ({ ctx }) => {
    ctx.services.storage.clearPreviews()
    return ctx.go(tabPath('cache'), { tone: 'success', text: 'Preview cache cleared' })
  })

  router.post(`${SETTINGS}/backups`, ({ ctx }) => {
    const keep = Number(ctx.form.backupsKeep)
    if (!Number.isInteger(keep) || keep < 1 || keep > 100) throw err('general_argument_invalid', 'Keep between 1 and 100 automatic backups.')
    const s3 = s3FromForm(ctx.form, 'backupS3', ctx.services.config.backups.s3)
    ctx.services.settings.set('backups', { enabled: checked(ctx.form.backupsEnabled), keep, s3 })
    return ctx.go(tabPath('backups'), { tone: 'success', text: 'Backup settings saved' })
  })

  router.post(`${SETTINGS}/backups/create`, async ({ ctx }) => {
    const backup = await ctx.services.backups.create('manual')
    return ctx.go(tabPath('backups'), { tone: 'success', text: `Created ${backup.name}` })
  })

  router.post(`${SETTINGS}/backups/:name/delete`, async ({ ctx, path }) => {
    await ctx.services.backups.delete(path.name!)
    return ctx.go(tabPath('backups'), { tone: 'success', text: 'Backup deleted' })
  })

  router.post(`${SETTINGS}/:key/reset`, ({ ctx, path }) => {
    const key = path.key as SettingKey
    if (!SETTING_KEYS.includes(key)) throw err('general_argument_invalid', 'Unknown setting.')
    ctx.services.settings.reset(key)
    if (key === 'project') ctx.projects.update(ctx.currentProject.id, { name: ctx.services.config.projectName })
    if (key === 'logs') ctx.services.requestLogs.prune()
    if (key === 'cache') ctx.services.storage.prunePreviews(true)
    return ctx.go(tabPath(TAB_OF_SETTING[key]), { tone: 'success', text: 'Setting reset' })
  })
}
