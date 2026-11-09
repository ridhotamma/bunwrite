import { existsSync } from 'node:fs'

import { OAUTH_PROVIDERS, OAUTH_PROVIDER_IDS } from '~/config'
import type { VectorsConfig } from '~/vectors/config'
import { SETTING_KEYS, type SettingKey } from '~/settings/service'
import type { ImageOutput } from '~/render/service'
import { err } from '~/lib/errors'
import { SmtpMailer } from '~/mail/mailer'
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { arrayOf, checked, lines, s3FromForm, value } from '~/console/forms'
import { html, page } from '~/console/html'
import { alert } from '~/console/ui'
import { inlineStatus, settingsView } from '~/console/views/settings'
import { SETTINGS, TAB_OF_SETTING, isTab, tabPath } from '~/console/settings-meta'
import { templatePath, templatePreview } from '~/console/views/templates'
import { isTemplateId, normalizedTemplateLocale, TEMPLATE_LOCALE, type TemplateFields, type TemplateId } from '~/mail/templates'
import { BunwriteError } from '~/lib/errors'
import { PROJECT_SCOPE } from '~/variables/service'
import { registerVariableRoutes } from './variables'

function wholeSetting(form: Record<string, unknown>, key: string, label: string, min: number, max: number): number {
  const raw = value(form, key)
  const parsed = Number(raw)
  if (raw === '' || !Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw err(
      'general_argument_invalid',
      `${label} must be between ${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')}.`,
    )
  }
  return Math.round(parsed)
}

function decimalSetting(form: Record<string, unknown>, key: string, label: string, min: number, max: number): number {
  const raw = value(form, key)
  const parsed = Number(raw)
  if (raw === '' || !Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw err('general_argument_invalid', `${label} must be between ${min} and ${max}.`)
  }
  return parsed
}

function httpUrl(raw: string, label: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw err('general_argument_invalid', `${label} must be a valid http or https URL.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw err('general_argument_invalid', `${label} must be a valid http or https URL.`)
  }
  return raw.replace(/\/+$/, '')
}

async function saveVectors(ctx: ConsoleContext, patch: Partial<VectorsConfig>): Promise<void> {
  await ctx.services.settings.set('vectors', { ...ctx.services.config.vectors, ...patch })
}

/** Settings handlers. Tab markup lives in console/views/settings. */
export function settingsPages(router: ConsoleRouter): void {
  router.get(SETTINGS, ({ ctx }) => ctx.go(tabPath('general')))
  router.get(`${SETTINGS}/:tab`, async ({ ctx, path }) => {
    const tab = path.tab ?? ''
    // The old Access tab moved to its own API page.
    if (tab === 'access') return ctx.go('/console/api')
    // Whole-instance backups moved to the organization shell.
    if (tab === 'backups') return ctx.go('/console/organization/backups')
    return isTab(tab) ? ctx.render('Settings', 'settings', await settingsView(ctx, tab)) : ctx.go(tabPath('general'))
  })

  // ---- Email templates ----

  const templateOf = (id: string | undefined): TemplateId => {
    if (!id || !isTemplateId(id)) throw err('general_argument_invalid', 'Unknown email template.')
    return id
  }
  const templateForm = (form: Record<string, unknown>): TemplateFields => ({
    subject: String(form.subject ?? ''),
    message: String(form.message ?? ''),
    senderName: value(form, 'senderName'),
    senderEmail: value(form, 'senderEmail'),
    replyToEmail: value(form, 'replyToEmail'),
    replyToName: value(form, 'replyToName'),
  })
  const templateRedirect = (id: TemplateId, locale: string) =>
    locale === TEMPLATE_LOCALE ? templatePath(id) : `${templatePath(id)}?locale=${encodeURIComponent(locale)}`

  router.get(`${SETTINGS}/templates/:id`, async ({ ctx, path }) => {
    if (!path.id || !isTemplateId(path.id)) return ctx.go(tabPath('templates'))
    const locale = normalizedTemplateLocale(ctx.url.searchParams.get('locale'))
    return ctx.render('Email templates', 'settings', await settingsView(ctx, 'templates', { template: path.id, locale }))
  })

  router.post(`${SETTINGS}/templates/:id`, async ({ ctx, path }) => {
    const id = templateOf(path.id)
    const locale = normalizedTemplateLocale(ctx.form.locale)
    const fields = templateForm(ctx.form)
    try {
      await ctx.services.templates.update(id, locale, fields)
    } catch (error) {
      // Keep what was typed on the page instead of losing it on a redirect.
      if (!(error instanceof BunwriteError)) throw error
      return ctx.render(
        'Email templates',
        'settings',
        html`${alert('critical', html`${error.message}`)}${await settingsView(ctx, 'templates', { template: id, locale, fields })}`,
      )
    }
    return ctx.go(templateRedirect(id, locale), { tone: 'success', text: locale === TEMPLATE_LOCALE ? 'Template updated' : `Template updated for ${locale}` })
  })

  router.post(`${SETTINGS}/templates/:id/reset`, async ({ ctx, path }) => {
    const id = templateOf(path.id)
    const locale = normalizedTemplateLocale(ctx.form.locale)
    await ctx.services.templates.reset(id, locale)
    return ctx.go(templateRedirect(id, locale), { tone: 'success', text: 'Template reset to the default' })
  })

  // The unsaved form rendered with sample values, for the Preview tab.
  router.post(`${SETTINGS}/templates/:id/preview`, ({ ctx, path }) => {
    const id = templateOf(path.id)
    const locale = normalizedTemplateLocale(ctx.form.locale)
    const fields = templateForm(ctx.form)
    const defaults = ctx.services.templates.defaults(id)
    return page(templatePreview(ctx.services.templates.preview(id, { ...fields, subject: fields.subject || defaults.subject, message: fields.message || defaults.message }, locale)))
  })

  router.post(`${SETTINGS}/project`, async ({ ctx }) => {
    const f = ctx.form
    const days = Number(f.sessionDays)
    const limit = Number(f.sessionsLimit)
    if (!(days >= 1) || !(limit >= 1 && limit <= 100)) throw err('general_argument_invalid', 'Session length and sessions per user must be positive.')
    const projectName = value(f, 'projectName') || ctx.services.config.projectName
    await ctx.services.settings.set('project', {
      projectName,
      allowedOrigins: lines(f.allowedOrigins),
      sessionDuration: Math.round(days * 86400),
      sessionsLimit: Math.round(limit),
    })
    await ctx.projects.update(ctx.currentProject.id, { name: projectName })
    return ctx.go(tabPath('general'), { tone: 'success', text: 'Project settings saved' })
  })

  router.post(`${SETTINGS}/smtp`, async ({ ctx }) => {
    const f = ctx.form
    if (f.disable) {
      await ctx.services.settings.set('smtp', { disabled: true })
      return ctx.go(tabPath('email'), { tone: 'success', text: 'Email turned off' })
    }
    const host = value(f, 'host')
    if (!host) throw err('general_argument_invalid', 'Enter the SMTP host.')
    await ctx.services.settings.set('smtp', {
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

  for (const id of OAUTH_PROVIDER_IDS) {
    router.post(`${SETTINGS}/${id}`, async ({ ctx }) => {
      const meta = OAUTH_PROVIDERS[id]
      if (ctx.form.disable) {
        await ctx.services.settings.set(id, { disabled: true })
        return ctx.go(tabPath('email'), { tone: 'success', text: `${meta.name} sign-in turned off` })
      }
      const f = ctx.form
      const current = ctx.services.config.oauth[id] ?? null
      const clientId = value(f, 'clientId')
      if (!clientId) throw err('general_argument_invalid', `Enter the ${meta.name} client ID.`)
      if (id === 'apple') {
        const teamId = value(f, 'teamId') || current?.teamId || ''
        const keyId = value(f, 'keyId') || current?.keyId || ''
        const privateKey = String(f.privateKey ?? '').trim() || current?.privateKey || ''
        if (!teamId || !keyId || !privateKey) throw err('general_argument_invalid', 'Enter the Apple team ID, key ID and .p8 private key.')
        await ctx.services.settings.set(id, { clientId, clientSecret: '', teamId, keyId, privateKey })
      } else {
        const clientSecret = String(f.clientSecret ?? '') || current?.clientSecret || ''
        if (!clientSecret) throw err('general_argument_invalid', 'Enter both the client ID and secret.')
        await ctx.services.settings.set(id, { clientId, clientSecret })
      }
      return ctx.go(tabPath('email'), { tone: 'success', text: `${meta.name} sign-in saved` })
    })
  }

  router.post(`${SETTINGS}/functions`, async ({ ctx }) => {
    const functionsDir = value(ctx.form, 'functionsDir')
    if (functionsDir && !existsSync(functionsDir)) throw err('general_argument_invalid', `No folder at ${functionsDir}.`)
    await ctx.services.settings.set('functions', { skipSchedules: arrayOf(ctx.form.paused), functionsDir: functionsDir || undefined })
    return ctx.go(tabPath('functions'), { tone: 'success', text: 'Schedules saved' })
  })

  registerVariableRoutes(router, {
    base: `${SETTINGS}/variables`,
    scope: () => PROJECT_SCOPE,
    store: (ctx) => ctx.services.variables,
    changed: (ctx) => {
      for (const site of ctx.services.sites.list()) ctx.services.sites.ssr.stopSite(site.id)
    },
    then: () => tabPath('variables'),
  })

  router.post(`${SETTINGS}/logs`, async ({ ctx }) => {
    const f = ctx.form
    const days = Number(f.retentionDays)
    if (!Number.isFinite(days) || days < 0) throw err('general_argument_invalid', 'Retention must be zero or more days.')
    const sampleRaw = value(f, 'logSampleRate')
    const sample = Number(sampleRaw)
    if (sampleRaw === '' || !Number.isFinite(sample) || sample < 0 || sample > 100) {
      throw err('general_argument_invalid', 'Successful request sampling must be between 0 and 100 percent.')
    }
    await ctx.services.settings.set('logs', {
      retentionDays: Math.round(days),
      logRequests: checked(f.logRequests),
      logSampleRate: Math.round((sample / 100) * 1000) / 1000,
      logFormat: value(f, 'logFormat') === 'json' ? 'json' : 'text',
      logIp: checked(f.logIp),
    })
    await ctx.services.requestLogs.prune()
    return ctx.go(tabPath('logs'), { tone: 'success', text: 'Log settings saved' })
  })

  router.post(`${SETTINGS}/render`, async ({ ctx }) => {
    await ctx.services.settings.set('render', { enabled: checked(ctx.form.enabled), allowRemote: checked(ctx.form.allowRemote) })
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

  router.post(`${SETTINGS}/storage`, async ({ ctx }) => {
    await ctx.services.settings.set('s3', s3FromForm(ctx.form, 's3', ctx.services.config.s3))
    return ctx.go(tabPath('storage'), { tone: 'success', text: 'Storage settings saved' })
  })

  router.post(`${SETTINGS}/cache`, async ({ ctx }) => {
    const f = ctx.form
    const seconds = (name: string) => {
      const n = Number(f[name])
      if (!Number.isFinite(n) || n < 0) throw err('general_argument_invalid', 'Cache lifetimes must be zero or more seconds.')
      return Math.round(n)
    }
    const days = Number(f.previewRetentionDays)
    if (!Number.isFinite(days) || days < 0 || days > 3650) throw err('general_argument_invalid', 'Keep previews between 0 and 3650 days.')
    await ctx.services.settings.set('cache', {
      fileMaxAge: seconds('fileMaxAge'),
      previewMaxAge: seconds('previewMaxAge'),
      publicMaxAge: f.publicMaxAge === undefined ? ctx.services.config.cache.publicMaxAge : seconds('publicMaxAge'),
      previewRetentionDays: Math.round(days),
    })
    ctx.services.storage.prunePreviews(true)
    return ctx.go(tabPath('cache'), { tone: 'success', text: 'Cache settings saved' })
  })

  router.post(`${SETTINGS}/cache/previews/clear`, ({ ctx }) => {
    ctx.services.storage.clearPreviews()
    return ctx.go(tabPath('cache'), { tone: 'success', text: 'Preview cache cleared' })
  })

  router.post(`${SETTINGS}/database`, async ({ ctx }) => {
    const mode = String(ctx.form.synchronous ?? '').trim().toUpperCase()
    if (mode !== 'NORMAL' && mode !== 'FULL') throw err('general_argument_invalid', 'Synchronous mode must be NORMAL or FULL.')
    await ctx.services.settings.set('database', { synchronous: mode })
    return ctx.go(tabPath('database'), { tone: 'success', text: `Database durability set to ${mode}` })
  })

  router.post(`${SETTINGS}/vectors/embedding`, async ({ ctx }) => {
    const f = ctx.form
    const current = ctx.services.config.vectors
    const embedder = value(f, 'embedder') === 'http' ? 'http' : 'local'
    const embeddingUrl = value(f, 'embeddingUrl').replace(/\/+$/, '')
    const embeddingModel = value(f, 'embeddingModel')
    if (embedder === 'http') {
      if (!embeddingUrl) throw err('general_argument_invalid', 'Enter the embeddings endpoint.')
      httpUrl(embeddingUrl, 'The embeddings endpoint')
      if (!embeddingModel) throw err('general_argument_invalid', 'Enter the embedding model name.')
    }
    await saveVectors(ctx, {
      embedder,
      dimension: wholeSetting(f, 'dimension', 'Dimensions', 8, 8192),
      embeddingUrl,
      embeddingApiKey: String(f.embeddingApiKey ?? '').trim() || current.embeddingApiKey,
      embeddingModel: embeddingModel || current.embeddingModel,
      sendDimensions: checked(f.sendDimensions),
      embeddingBatchSize: wholeSetting(f, 'embeddingBatchSize', 'Embedding batch size', 1, 256),
      timeoutMs: wholeSetting(f, 'timeoutMs', 'Request timeout', 1_000, 120_000),
    })
    return ctx.go(tabPath('vectors'), { tone: 'success', text: 'Embedding settings saved' })
  })

  router.post(`${SETTINGS}/vectors/answers`, async ({ ctx }) => {
    const f = ctx.form
    const current = ctx.services.config.vectors
    const enabled = checked(f.enabled)
    const chatUrl = enabled ? value(f, 'chatUrl').replace(/\/+$/, '') : ''
    if (enabled) {
      if (!chatUrl) throw err('general_argument_invalid', 'Enter the chat completions endpoint or turn answer generation off.')
      httpUrl(chatUrl, 'The chat endpoint')
    }
    const chatModel = value(f, 'chatModel') || current.chatModel
    if (enabled && !chatModel) throw err('general_argument_invalid', 'Enter the chat model name.')
    const chatSystemPrompt = String(f.chatSystemPrompt ?? '').trim() || current.chatSystemPrompt
    await saveVectors(ctx, {
      chatUrl,
      chatApiKey: String(f.chatApiKey ?? '').trim() || current.chatApiKey,
      chatModel,
      chatSystemPrompt,
      chatTemperature: decimalSetting(f, 'chatTemperature', 'Temperature', 0, 2),
      chatMaxTokens: wholeSetting(f, 'chatMaxTokens', 'Maximum answer tokens', 1, 32_000),
      contextChars: wholeSetting(f, 'contextChars', 'Context characters', 256, 200_000),
    })
    return ctx.go(tabPath('vectors'), { tone: 'success', text: 'Answer generation settings saved' })
  })

  router.post(`${SETTINGS}/vectors/retrieval`, async ({ ctx }) => {
    const f = ctx.form
    const current = ctx.services.config.vectors
    const rerankUrl = value(f, 'rerankUrl').replace(/\/+$/, '')
    if (rerankUrl) httpUrl(rerankUrl, 'The rerank endpoint')
    const alpha = Number(f.hybridAlpha)
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
      throw err('general_argument_invalid', 'Vector weight must be between 0 and 1.')
    }
    const candidates = Number(f.rerankCandidates ?? 0)
    if (!Number.isInteger(candidates) || candidates < 0 || candidates > 500) {
      throw err('general_argument_invalid', 'Rerank candidates must be a whole number between 0 and 500.')
    }
    await saveVectors(ctx, {
      hybridSearch: checked(f.hybridSearch),
      hybridAlpha: alpha,
      rerank: checked(f.rerank),
      rerankUrl,
      rerankApiKey: String(f.rerankApiKey ?? '').trim() || current.rerankApiKey,
      rerankModel: value(f, 'rerankModel'),
      rerankCandidates: candidates,
    })
    return ctx.go(tabPath('vectors'), { tone: 'success', text: 'Retrieval settings saved' })
  })

  router.post(`${SETTINGS}/vectors/limits`, async ({ ctx }) => {
    const f = ctx.form
    const chunkSize = wholeSetting(f, 'chunkSize', 'Chunk size', 64, 8_000)
    await saveVectors(ctx, {
      maxPoints: wholeSetting(f, 'maxPoints', 'Points per collection', 1, 1_000_000),
      chunkSize,
      chunkOverlap: wholeSetting(f, 'chunkOverlap', 'Chunk overlap', 0, Math.floor(chunkSize / 2)),
    })
    return ctx.go(tabPath('vectors'), { tone: 'success', text: 'Ingestion limits saved' })
  })

  router.post(`${SETTINGS}/:key/reset`, async ({ ctx, path }) => {
    const key = path.key as SettingKey
    if (!SETTING_KEYS.includes(key)) throw err('general_argument_invalid', 'Unknown setting.')
    if (key === 'backups') return ctx.go('/console/organization/backups')
    await ctx.services.settings.reset(key)
    if (key === 'project') await ctx.projects.update(ctx.currentProject.id, { name: ctx.services.config.projectName })
    if (key === 'logs') await ctx.services.requestLogs.prune()
    if (key === 'cache') ctx.services.storage.prunePreviews(true)
    return ctx.go(tabPath(TAB_OF_SETTING[key]), { tone: 'success', text: 'Setting reset' })
  })
}
