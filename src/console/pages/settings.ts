import { existsSync } from 'node:fs'

import type { BackupFile } from '~/backups/service'
import type { S3Config } from '~/config'
import type { SettingKey } from '~/settings/service'
import { err } from '~/lib/errors'
import { SmtpMailer } from '~/mail/mailer'
import { dialog } from '~/console/dialog'
import { envBulkDialog, importEnvVariables } from '~/console/env-vars'
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { arrayOf, checked, lines, value } from '~/console/forms'
import { html, page, type Html } from '~/console/html'
import { alert, badge, destroy, emptyState, formatBytes, header, icon, tabs, when } from '~/console/ui'

const SETTINGS = '/console/settings'

const TABS = [
  { key: 'general', label: 'General', href: `${SETTINGS}/general` },
  { key: 'email', label: 'Email & sign-in', href: `${SETTINGS}/email` },
  { key: 'storage', label: 'File storage', href: `${SETTINGS}/storage` },
  { key: 'backups', label: 'Backups', href: `${SETTINGS}/backups` },
  { key: 'functions', label: 'Functions', href: `${SETTINGS}/functions` },
  { key: 'logs', label: 'Request logs', href: `${SETTINGS}/logs` },
  { key: 'access', label: 'Access', href: `${SETTINGS}/access` },
] as const

type SettingsTab = (typeof TABS)[number]['key']

const TAB_OF_SETTING: Record<SettingKey, SettingsTab> = {
  project: 'general',
  smtp: 'email',
  google: 'email',
  functions: 'functions',
  logs: 'logs',
  s3: 'storage',
  backups: 'backups',
}

const tabPath = (tab: SettingsTab) => `${SETTINGS}/${tab}`
const isTab = (key: string): key is SettingsTab => TABS.some((tab) => tab.key === key)

function codeFound(ctx: ConsoleContext): Html {
  const fns = ctx.services.functions.list()
  if (!fns.length) return html``
  const found = fns.filter((f) => ctx.services.functions.codeDir(f).dir).length
  return found === fns.length ? html`Code found for all ${found} functions.` : html`<b style="color:var(--critical)">Code found for ${found} of ${fns.length} functions.</b>`
}

function source(ctx: ConsoleContext, key: SettingKey): Html {
  return ctx.services.settings.overridden(key)
    ? html`${badge('Set here', 'info')} ${destroy(`${SETTINGS}/${key}/reset`, 'Use env value', 'Go back to the value from the server env?')}`
    : badge('From env')
}

function card(ctx: ConsoleContext, id: string, title: string, key: SettingKey | null, hint: string, body: Html): Html {
  return html`<div class="card" id="${id}"><div style="display:flex;gap:8px;align-items:center;margin-bottom:4px"><h2 style="margin:0">${title}</h2><span style="margin-left:auto;display:flex;gap:8px;align-items:center">${key ? source(ctx, key) : ''}</span></div>
    <p class="hint" style="margin:4px 0 12px">${hint}</p>${body}</div>`
}

function projectCard(ctx: ConsoleContext): Html {
  const c = ctx.services.config
  return card(ctx, 'project', 'Project', 'project', 'Name in emails, allowed web origins and how long sign-ins last.', html`
    <form method="post" action="${SETTINGS}/project">
      <div class="fields"><label>Name<input name="projectName" value="${c.projectName}" required></label><label>Project ID<input value="${c.projectId}" class="mono" readonly><small>Set by PROJECT_ID; apps send it.</small></label></div>
      <label>Allowed origins<textarea name="allowedOrigins" class="mono">${c.allowedOrigins.join('\n')}</textarea><small>One per line. <code>*.example.com</code> covers subdomains. Used for CORS and redirect links.</small></label>
      <div class="fields"><label>Session length (days)<input name="sessionDays" type="number" min="1" value="${Math.round(c.sessionDuration / 86400)}"></label><label>Sessions per user<input name="sessionsLimit" type="number" min="1" max="100" value="${c.sessionsLimit}"></label></div>
      <div class="foot"><button class="primary">Save</button></div>
    </form>`)
}

function emailCards(ctx: ConsoleContext): Html {
  const c = ctx.services.config
  const smtp = c.smtp
  const google = c.google
  return html`
    ${card(ctx, 'email', 'Email (SMTP)', 'smtp', 'Sends sign-in codes, password resets and team invitations.', html`
      <form method="post" action="${SETTINGS}/smtp">
        <div class="fields"><label>Host<input name="host" value="${smtp?.host ?? ''}" placeholder="smtp.example.com"></label><label>Port<input name="port" type="number" value="${smtp?.port ?? 587}"></label></div>
        <div class="fields"><label>Username<input name="user" value="${smtp?.user ?? ''}" autocomplete="off"></label><label>Password<input name="password" type="password" placeholder="${smtp?.password ? 'Unchanged' : ''}" autocomplete="new-password"></label></div>
        <div class="fields"><label>Sender email<input name="senderEmail" type="email" value="${smtp?.senderEmail ?? ''}"></label><label>Sender name<input name="senderName" value="${smtp?.senderName ?? ''}"></label></div>
        <label class="check"><input type="checkbox" name="secure" ${smtp?.secure ? 'checked' : ''}>Implicit TLS (port 465)</label>
        <div class="foot"><span id="smtp-test" class="subdued" style="margin-right:auto">Sends to ${ctx.admin.email}</span>
          <button type="button" hx-post="${SETTINGS}/smtp/test" hx-target="#smtp-test" hx-swap="innerHTML" title="Send a test email to ${ctx.admin.email}" ${smtp ? '' : 'disabled'}>Send test email</button>
          ${smtp ? html`<button type="submit" name="disable" value="1" class="critical">Turn off</button>` : ''}<button class="primary">Save</button></div>
      </form>`)}
    ${card(ctx, 'google', 'Google sign-in', 'google', 'OAuth client from Google Cloud. Add the redirect URI below to it.', html`
      <form method="post" action="${SETTINGS}/google">
        <label>Redirect URI<input class="mono" readonly value="${c.publicEndpoint}/account/sessions/oauth2/callback/google/${c.projectId}"></label>
        <div class="fields"><label>Client ID<input name="clientId" value="${google?.clientId ?? ''}" class="mono"></label><label>Client secret<input name="clientSecret" type="password" placeholder="${google?.clientSecret ? 'Unchanged' : ''}" autocomplete="new-password"></label></div>
        <div class="foot">${google ? html`<button type="submit" name="disable" value="1" class="critical">Turn off</button>` : ''}<button class="primary">Save</button></div>
      </form>`)}`
}

function s3Fields(prefix: string, s3: S3Config): Html {
  const field = (label: string, input: Html) => html`<label>${label}${input}</label>`
  return html`
    <div class="fields">
      ${field('Endpoint', html`<input name="${prefix}Endpoint" class="mono" value="${s3.endpoint}" placeholder="https://s3.example.com">`)}
      ${field('Bucket', html`<input name="${prefix}Bucket" value="${s3.bucket}">`)}
      ${field('Region', html`<input name="${prefix}Region" value="${s3.region}">`)}
    </div>
    <div class="fields">
      ${field('Access key', html`<input name="${prefix}AccessKey" class="mono" value="${s3.accessKey}">`)}
      ${field('Secret', html`<input name="${prefix}Secret" type="password" placeholder="${s3.secret ? 'Unchanged' : ''}" autocomplete="new-password">`)}
    </div>
    <label class="check"><input type="checkbox" name="${prefix}ForcePathStyle" ${s3.forcePathStyle ? 'checked' : ''}>Force path-style addressing</label>`
}

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

function storageCard(ctx: ConsoleContext): Html {
  const s3 = ctx.services.config.s3
  return card(ctx, 'storage', 'File storage', 's3', 'Local disk by default. Use S3-compatible storage when disk space is limited.', html`
    <form method="post" action="${SETTINGS}/storage">
      <label class="check"><input type="checkbox" name="s3Enabled" ${s3.enabled ? 'checked' : ''}>Use S3 storage</label>
      ${alert('warning', html`Existing files are not moved when you switch storage. Migrate them manually between the local folder and S3; tools such as <code>rclone</code> or <code>s5cmd</code> can help.`)}
      ${s3Fields('s3', s3)}
      <div class="foot"><button class="primary">Save</button></div>
    </form>`)
}

async function backupsCards(ctx: ConsoleContext): Promise<Html> {
  const c = ctx.services.config
  let backups: BackupFile[] = []
  let error = ''
  try {
    backups = await ctx.services.backups.list()
  } catch (problem) {
    error = problem instanceof Error ? problem.message : String(problem)
  }
  return html`
    ${error ? alert('critical', html`${error}`) : ''}
    <div class="card flush">
      <div class="toolbar"><h2 style="margin:0">Backups</h2>
        <form method="post" action="${SETTINGS}/backups/create" class="inline" style="margin-left:auto"><button class="primary">Initialize new backup</button></form>
      </div>
      ${backups.length
        ? html`<div class="scroll"><table><thead><tr><th>Backup</th><th class="num">Size</th><th class="hide-sm">Created</th><th></th></tr></thead><tbody>
          ${backups.map((b) => html`<tr><td class="mono clip">${b.name}</td><td class="num">${formatBytes(b.size)}</td><td class="hide-sm">${when(b.modified)}</td>
            <td class="num"><a class="btn small" href="${SETTINGS}/backups/${encodeURIComponent(b.name)}/download" hx-boost="false">Download</a>
              ${destroy(`${SETTINGS}/backups/${encodeURIComponent(b.name)}/delete`, 'Delete', `Delete ${b.name}?`)}</td></tr>`)}
          </tbody></table></div>`
        : emptyState('No backups yet', 'Create one now, or wait for the daily automatic backup.')}
    </div>
    ${card(ctx, 'backup-options', 'Backup options', 'backups', 'Database snapshots. Automatic backups run once a day at 02:00 UTC.', html`
      <form method="post" action="${SETTINGS}/backups">
        <label class="check"><input type="checkbox" name="backupsEnabled" ${c.backups.enabled ? 'checked' : ''}>Enable auto backups</label>
        <div class="fields"><label>Keep automatic backups<input name="backupsKeep" type="number" min="1" max="100" value="${c.backups.keep}"></label></div>
        <label class="check"><input type="checkbox" name="backupS3Enabled" ${c.backups.s3.enabled ? 'checked' : ''}>Store backups in S3 storage</label>
        ${s3Fields('backupS3', c.backups.s3)}
        <div class="foot"><button>Save</button></div>
      </form>`)}`
}

function functionCards(ctx: ConsoleContext): Html {
  const c = ctx.services.config
  const fns = ctx.services.functions.list().filter((f) => f.schedule)
  const globals = ctx.services.functions.globalVariables()
  return html`
    ${card(ctx, 'schedules', 'Functions', 'functions', 'Where function code lives, and which schedules are paused.', html`
      <form method="post" action="${SETTINGS}/functions">
        <label>Code folder<input name="functionsDir" class="mono" value="${c.functionsDir}"><small>The folder with appwrite.config.json; function paths are read from it. ${codeFound(ctx)}</small></label>
        <div class="subdued" style="margin:4px 0 8px">Paused schedules do not fire. Running a function by hand still works.</div>
        ${fns.length ? fns.map((f) => html`<label class="check"><input type="checkbox" name="paused" value="${f.id}" ${c.skipSchedules.includes(f.id) ? 'checked' : ''}>Pause <span class="mono">${f.id}</span>&nbsp;<span class="subdued">${f.schedule}</span></label>`) : html`<p class="subdued">No scheduled functions.</p>`}
        <div class="foot"><button>Save</button></div>
      </form>`)}
    ${card(ctx, 'global-vars', 'Global function variables', null, 'Available to every function. A variable set on one function with the same name wins.', html`
      ${globals.length
        ? html`<ul class="list">${globals.map((v) => html`<li><span class="mono">${v.key}</span><span>${v.secret ? html`<span class="subdued">••••••</span>` : html`<span class="mono clip">${v.value}</span>`} ${destroy(`${SETTINGS}/functions/variables/delete`, 'Remove', `Remove global variable ${v.key}?`, { key: v.key })}</span></li>`)}</ul>`
        : html`<p class="hint" style="margin:0 0 12px">None set. Values from the server env and FUNCTIONS_ENV_FILE still apply.</p>`}
      <form method="post" action="${SETTINGS}/functions/variables" style="margin-top:12px">
        <div class="fields"><label>Name<input name="key" class="mono" required pattern="[A-Za-z_][A-Za-z0-9_]*"></label><label>Value<input name="value"></label></div>
        <label class="check"><input type="checkbox" name="secret" checked>Hide the value</label>
        <div class="foot"><button type="button" data-dialog-open="#bulk-global-vars">${icon('upload-simple')}<span>Bulk upload</span></button><button>Add global variable</button></div>
      </form>`)}
    ${envBulkDialog({ id: 'bulk-global-vars', title: 'Import global variables', action: `${SETTINGS}/functions/variables/bulk` })}`
}

function logsCard(ctx: ConsoleContext): Html {
  const c = ctx.services.config
  return card(ctx, 'logs', 'Request logs', 'logs', 'How long request logs are kept, and whether client IP addresses are stored.', html`
    <form method="post" action="${SETTINGS}/logs">
      <div class="fields">
        <label>Retention (days)<input name="retentionDays" type="number" min="0" value="${c.logRetentionDays}"><small>0 keeps logs until you clear them.</small></label>
        <label class="check"><input type="checkbox" name="logIp" ${c.logIp ? 'checked' : ''}>Store IP addresses<small>&nbsp;· off keeps visitor IPs out of logs</small></label>
      </div>
      <p class="help">Recording is ${c.logRequests ? 'on' : 'off'} (LOG_REQUESTS). <a href="/console/logs">Open request logs</a>.</p>
      <div class="foot"><button>Save</button></div>
    </form>`)
}

function accessCards(ctx: ConsoleContext): Html {
  const keys = ctx.services.settings.listKeys()
  const admins = ctx.auth.list()
  return html`
    ${card(ctx, 'keys', 'API keys', null, 'Server keys with full access. Keys from the API_KEYS env var also work and are not listed.', html`
      ${keys.length
        ? html`<div class="scroll"><table><thead><tr><th>Name</th><th class="hide-sm">Key</th><th>Last used</th><th class="hide-sm">Expires</th><th></th></tr></thead><tbody>
          ${keys.map((k) => html`<tr><td>${k.name}</td><td class="mono hide-sm">${k.hint}…</td><td>${when(k.accessed_at)}</td><td class="hide-sm">${k.expire ? when(k.expire) : 'Never'}</td>
            <td class="num">${destroy(`${SETTINGS}/keys/${k.id}/delete`, 'Revoke', `Revoke ${k.name}? Apps using it stop working.`)}</td></tr>`)}</tbody></table></div>`
        : ''}
      <form method="post" action="${SETTINGS}/keys" style="margin-top:12px" hx-push-url="false"><div class="fields"><label>Name<input name="name" required placeholder="Dashboard server"></label><label>Expires<input name="expire" type="date"><small>Optional.</small></label></div>
        <div class="foot"><button>Create key</button></div></form>`)}
    ${card(ctx, 'admins', 'Console admins', null, 'People who can sign in here. Separate from your app users.', html`
      <ul class="list">${admins.map((a) => html`<li><span>${a.email}${a.seq === ctx.admin.seq ? html` ${badge('You')}` : ''}</span><span>${admins.length > 1 ? destroy(`${SETTINGS}/admins/${a.seq}/delete`, 'Remove', `Remove ${a.email}?`) : ''}</span></li>`)}</ul>
      <form method="post" action="${SETTINGS}/admins" style="margin-top:12px"><div class="fields"><label>Email<input name="email" type="email" required></label><label>Password<input name="password" type="password" minlength="8" required autocomplete="new-password"></label></div>
        <div class="foot"><button>Add admin</button></div></form>`)}`
}

function apiKeyDialog(secret: string): Html {
  return dialog({
    id: 'api-key-dialog',
    title: 'API key created',
    open: true,
    body: html`<p class="dialog-message">Copy this key now. It is not shown again.</p>
      <label>Key<input id="api-key-value" class="mono" readonly autocomplete="off" spellcheck="false" value="${secret}"></label>`,
    actions: html`<button type="button" data-copy-target="#api-key-value">${icon('copy')}<span data-copy-label>Copy key</span></button><button type="button" class="primary" data-dialog-close>Done</button>`,
  })
}

async function view(ctx: ConsoleContext, tab: SettingsTab, created?: string): Promise<Response> {
  let body: Html
  switch (tab) {
    case 'general':
      body = projectCard(ctx)
      break
    case 'email':
      body = emailCards(ctx)
      break
    case 'storage':
      body = storageCard(ctx)
      break
    case 'backups':
      body = await backupsCards(ctx)
      break
    case 'functions':
      body = functionCards(ctx)
      break
    case 'logs':
      body = logsCard(ctx)
      break
    case 'access':
      body = accessCards(ctx)
      break
  }
  return ctx.render(
    'Settings',
    'settings',
    html`${header('Settings')}
    ${tabs(TABS, tab)}
    ${body}
    ${created ? apiKeyDialog(created) : ''}`,
  )
}

export function settingsPages(router: ConsoleRouter): void {
  router.get(SETTINGS, ({ ctx }) => ctx.go(tabPath('general')))
  router.get(`${SETTINGS}/:tab`, async ({ ctx, path }) => {
    const tab = path.tab ?? ''
    return isTab(tab) ? await view(ctx, tab) : ctx.go(tabPath('general'))
  })

  router.get(`${SETTINGS}/backups/:name/download`, async ({ ctx, path }) => ctx.services.backups.serve(path.name!))

  router.post(`${SETTINGS}/project`, ({ ctx }) => {
    const f = ctx.form
    const days = Number(f.sessionDays)
    const limit = Number(f.sessionsLimit)
    if (!(days >= 1) || !(limit >= 1 && limit <= 100)) throw err('general_argument_invalid', 'Session length and sessions per user must be positive.')
    ctx.services.settings.set('project', {
      projectName: value(f, 'projectName') || ctx.services.config.projectName,
      allowedOrigins: lines(f.allowedOrigins),
      sessionDuration: Math.round(days * 86400),
      sessionsLimit: Math.round(limit),
    })
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
    if (!smtp) return page(html`<span style="color:var(--critical)">Save SMTP settings first.</span>`)
    try {
      await new SmtpMailer(smtp).send({
        to: ctx.admin.email,
        subject: `${ctx.services.config.projectName}: test email`,
        text: 'SMTP works. This message was sent from the console.',
        html: '<p>SMTP works. This message was sent from the console.</p>',
      })
      return page(html`<span style="color:var(--success)">Sent to ${ctx.admin.email}</span>`)
    } catch (error) {
      return page(html`<span style="color:var(--critical)">${error instanceof Error ? error.message : String(error)}</span>`)
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

  router.post(`${SETTINGS}/storage`, ({ ctx }) => {
    ctx.services.settings.set('s3', s3FromForm(ctx.form, 's3', ctx.services.config.s3))
    return ctx.go(tabPath('storage'), { tone: 'success', text: 'Storage settings saved' })
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
    if (!['project', 'smtp', 'google', 'functions', 'logs', 's3', 'backups'].includes(key)) throw err('general_argument_invalid', 'Unknown setting.')
    ctx.services.settings.reset(key)
    if (key === 'logs') ctx.services.requestLogs.prune()
    return ctx.go(tabPath(TAB_OF_SETTING[key]), { tone: 'success', text: 'Back to the env value' })
  })

  router.post(`${SETTINGS}/keys`, ({ ctx }) => {
    const expire = value(ctx.form, 'expire')
    const { secret } = ctx.services.settings.createKey(value(ctx.form, 'name'), expire ? `${expire}T23:59:59.999+00:00` : null)
    // Shown once in this response; never put in a URL, where history would keep it.
    return view(ctx, 'access', secret)
  })

  router.post(`${SETTINGS}/keys/:id/delete`, ({ ctx, path }) => {
    ctx.services.settings.deleteKey(path.id!)
    return ctx.go(tabPath('access'), { tone: 'success', text: 'Key revoked' })
  })

  router.post(`${SETTINGS}/admins`, async ({ ctx }) => {
    await ctx.auth.upsert(String(ctx.form.email ?? ''), String(ctx.form.password ?? ''))
    return ctx.go(tabPath('access'), { tone: 'success', text: 'Admin saved' })
  })

  router.post(`${SETTINGS}/admins/:seq/delete`, ({ ctx, path }) => {
    ctx.auth.remove(Number(path.seq))
    return ctx.go(tabPath('access'), { tone: 'success', text: 'Admin removed' })
  })
}
