/** Settings tab markup. The page loads data and validates writes; this module renders it. */
import type { BackupFile } from '~/backups/service'
import type { S3Config } from '~/config'
import { envBulkDialog } from '~/console/env-vars'
import type { ConsoleContext } from '~/console/context'
import { html, type Html } from '~/console/html'
import { SETTINGS, TABS, type SettingsTab } from '~/console/settings-meta'
import { alert, badge, destroy, emptyState, formatBytes, header, icon, settingsSection, tabs, when } from '~/console/ui'
import { SAMPLE_INVOICE } from '~/render/sample'
import type { SettingKey } from '~/settings/service'
import type { TemplateFields, TemplateId } from '~/mail/templates'
import { MIN_COMPRESS_BYTES } from '~/lib/compress'
import { templatesView } from './templates'

function codeFound(ctx: ConsoleContext): Html {
  const fns = ctx.services.functions.list()
  if (!fns.length) return html``
  const found = fns.filter((f) => ctx.services.functions.codeDir(f).dir).length
  return found === fns.length ? html`Code found for all ${found} functions.` : html`<b style="color:var(--critical)">Code found for ${found} of ${fns.length} functions.</b>`
}

function source(ctx: ConsoleContext, key: SettingKey): Html {
  return ctx.services.settings.overridden(key)
    ? html`${badge('Custom', 'info')} ${destroy(`${SETTINGS}/${key}/reset`, 'Reset', 'Reset this setting to the default value?')}`
    : badge('Default')
}

function card(ctx: ConsoleContext, id: string, title: string, key: SettingKey | null, hint: string, body: Html): Html {
  return settingsSection(title, hint, body, { id, badge: key ? source(ctx, key) : undefined })
}

function projectCard(ctx: ConsoleContext): Html {
  const c = ctx.services.config
  return card(ctx, 'project', 'Project', 'project', 'Name in emails, allowed web origins and how long sign-ins last.', html`
    <form method="post" action="${SETTINGS}/project">
      <div class="fields"><label>Name<input name="projectName" value="${c.projectName}" required></label><label>Organization ID<input value="${c.orgId || '—'}" class="mono" readonly><small>Generated on first start and stored in the database.</small></label><label>Project ID<input value="${c.projectId}" class="mono" readonly><small>Set when the project was created. Apps send this in X-Bunwrite-Project (or X-Appwrite-Project).</small></label></div>
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
    ${settingsSection(
      'Backups',
      'Database snapshots you can download. Automatic backups run once a day at 02:00 UTC.',
      html`<div class="toolbar"><h2 style="margin:0">Saved backups</h2>
          <form method="post" action="${SETTINGS}/backups/create" class="inline" style="margin-left:auto"><button class="primary">Create backup</button></form>
        </div>
        ${backups.length
          ? html`<div class="scroll"><table><thead><tr><th>Backup</th><th class="num">Size</th><th class="hide-sm">Created</th><th></th></tr></thead><tbody>
            ${backups.map((b) => html`<tr><td class="mono clip">${b.name}</td><td class="num">${formatBytes(b.size)}</td><td class="hide-sm subdued">${when(b.modified)}</td>
              <td class="num"><a class="btn small" href="${SETTINGS}/backups/${encodeURIComponent(b.name)}/download" hx-boost="false">Download</a>
                ${destroy(`${SETTINGS}/backups/${encodeURIComponent(b.name)}/delete`, 'Delete', `Delete ${b.name}?`)}</td></tr>`)}
            </tbody></table></div>`
          : emptyState('No backups yet', 'Create one now, or wait for the daily automatic backup.')}`,
      { id: 'backups', flush: true },
    )}
    ${card(ctx, 'backup-options', 'Backup options', 'backups', 'Choose whether automatic backups run, how many to keep, and where they are stored.', html`
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
        <label>Code folder<input name="functionsDir" class="mono" value="${c.functionsDir}"><small>The folder with the project config file (bunwrite.config.json or appwrite.config.json); function paths are read from it. ${codeFound(ctx)}</small></label>
        <div class="subdued" style="margin:4px 0 8px">Paused schedules do not fire. Running a function by hand still works.</div>
        ${fns.length ? fns.map((f) => html`<label class="check"><input type="checkbox" name="paused" value="${f.id}" ${c.skipSchedules.includes(f.id) ? 'checked' : ''}>Pause <span class="mono">${f.id}</span>&nbsp;<span class="subdued">${f.schedule}</span></label>`) : html`<p class="subdued">No scheduled functions.</p>`}
        <div class="foot"><button>Save</button></div>
      </form>`)}
    ${card(ctx, 'global-vars', 'Global function variables', null, 'Available to every function. A variable set on one function with the same name wins.', html`
      ${globals.length
        ? html`<ul class="list">${globals.map((v) => html`<li><span class="mono">${v.key}</span><span>${v.secret ? html`<span class="subdued">••••••</span>` : html`<span class="mono clip">${v.value}</span>`} ${destroy(`${SETTINGS}/functions/variables/delete`, 'Remove', `Remove global variable ${v.key}?`, { key: v.key })}</span></li>`)}</ul>`
        : html`<p class="hint" style="margin:0 0 12px">None set. Values from FUNCTIONS_ENV_FILE still apply.</p>`}
      <form method="post" action="${SETTINGS}/functions/variables" style="margin-top:12px">
        <div class="fields"><label>Name<input name="key" class="mono" required pattern="[A-Za-z_][A-Za-z0-9_]*"></label><label>Value<input name="value"></label></div>
        <label class="check"><input type="checkbox" name="secret" checked>Hide the value</label>
        <div class="foot"><button type="button" data-dialog-open="#bulk-global-vars">${icon('upload-simple')}<span>Bulk upload</span></button><button>Add global variable</button></div>
      </form>`)}
    ${envBulkDialog({ id: 'bulk-global-vars', title: 'Import global variables', action: `${SETTINGS}/functions/variables/bulk` })}`
}

/** Browser cache choices; a value set in env that is not listed shows as its own option. */
export const CACHE_CHOICES: [number, string][] = [
  [0, 'Off, check every time'],
  [3600, '1 hour'],
  [86400, '1 day'],
  [604800, '7 days'],
  [2592000, '30 days'],
  [3888000, '45 days'],
  [31536000, '1 year'],
]

function cacheSelect(name: string, seconds: number): Html {
  const choices = CACHE_CHOICES.some(([s]) => s === seconds) ? CACHE_CHOICES : [...CACHE_CHOICES, [seconds, `${seconds.toLocaleString('en-US')} seconds`] as [number, string]]
  return html`<select name="${name}">${choices.map(([s, label]) => html`<option value="${s}" ${s === seconds ? 'selected' : ''}>${label}</option>`)}</select>`
}

function cacheCards(ctx: ConsoleContext): Html {
  const c = ctx.services.config.cache
  const stats = ctx.services.storage.previewCacheStats()
  const compression = ctx.services.config.compression
  return html`${card(ctx, 'cache', 'Cache lifetimes', 'cache', 'How long browsers reuse files and image previews before asking again, and how long generated previews stay on disk.', html`
    <form method="post" action="${SETTINGS}/cache">
      <div class="fields">
        <label>File views and downloads${cacheSelect('fileMaxAge', c.fileMaxAge)}</label>
        <label>Image previews${cacheSelect('previewMaxAge', c.previewMaxAge)}</label>
      </div>
      <label>Keep generated previews (days)<input name="previewRetentionDays" type="number" min="0" max="3650" value="${c.previewRetentionDays}"><small>Older previews are deleted and made again on the next request. 0 keeps them until the file is deleted.</small></label>
      <p class="help">Files are cached as private, so only the visitor's browser keeps them, never a shared proxy. When the time is up the browser asks again and gets a quick "not modified" reply if the file is the same. Uploaded files never change, so long lifetimes are safe.</p>
      <div class="foot"><button class="primary">Save</button></div>
    </form>`)}
    ${card(ctx, 'previews', 'Generated previews', null, 'Resized and converted images made for preview links, kept on this server so each size is made once.', html`
      <ul class="list">
        <li><span class="subdued">Cached previews</span><span>${stats.files.toLocaleString('en-US')}</span></li>
        <li><span class="subdued">Disk space</span><span>${formatBytes(stats.bytes)}</span></li>
      </ul>
      <form method="post" action="${SETTINGS}/cache/previews/clear" data-confirm="Delete all ${stats.files} cached previews? They are made again when next requested." data-confirm-label="Clear previews" class="foot">
        <button ${stats.files ? '' : 'disabled'}>Clear previews</button>
      </form>`)}
    ${card(ctx, 'compression', 'Compression', null, 'Applies to the whole server, every project and the console.', html`
      <ul class="list">
        <li><span class="subdued">Responses</span><span>${compression ? badge('On', 'success') : badge('Off')}</span></li>
        <li><span class="subdued">Encodings</span><span>Brotli, else gzip</span></li>
        <li><span class="subdued">Realtime messages</span><span>${compression ? 'Per-message deflate' : 'Off'}</span></li>
      </ul>
      <p class="help">JSON, HTML, scripts, text, SVG and other text-based responses over ${formatBytes(MIN_COMPRESS_BYTES)} are compressed. Images, video, zip and PDF are already compressed and go out as they are. ${compression ? html`Set <code>COMPRESSION=false</code> only if a proxy in front already compresses.` : html`Turned off with <code>COMPRESSION=false</code>.`}</p>`)}`
}

function logsCard(ctx: ConsoleContext): Html {
  const c = ctx.services.config
  return card(ctx, 'logs', 'Request logs', 'logs', 'How long request logs are kept, and whether client IP addresses are stored.', html`
    <form method="post" action="${SETTINGS}/logs">
      <div class="fields">
        <label>Retention (days)<input name="retentionDays" type="number" min="0" value="${c.logRetentionDays}"><small>0 keeps logs until you clear them.</small></label>
        <label class="check"><input type="checkbox" name="logIp" ${c.logIp ? 'checked' : ''}><span>Store IP addresses</span><small>Off keeps visitor IPs out of logs.</small></label>
      </div>
      <p class="help">Recording is ${c.logRequests ? 'on' : 'off'} (LOG_REQUESTS). <a href="/console/logs">Open request logs</a>.</p>
      <div class="foot"><button>Save</button></div>
    </form>`)
}

function renderCards(ctx: ConsoleContext): Html {
  const c = ctx.services.config.render
  const status = ctx.services.render.status()
  const chrome = status.chrome
    ? html`Chromium: <code>${status.chrome}</code>${status.running ? ' · running' : ' · starts on the first render, stops after a minute idle'}`
    : html`<b style="color:var(--critical)">Chromium not found.</b> Install <code>chromium</code> (Docker: build with <code>BUNWRITE_WITH_CHROMIUM=true</code>) or set <code>CHROME_PATH</code>.`
  return html`${card(ctx, 'render', 'HTML rendering', 'render', 'Render HTML to PDF (POST /v1/pdf) or to png, jpg, webp, avif and gif images (POST /v1/image) with an API key. Uses headless Chromium, about 150 MB while rendering.', html`
    <form method="post" action="${SETTINGS}/render">
      <label class="check"><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}><span>Enable HTML rendering</span><small>Off disables POST /v1/pdf and POST /v1/image.</small></label>
      <label class="check"><input type="checkbox" name="allowRemote" ${c.allowRemote ? 'checked' : ''}><span>Allow remote images, fonts and stylesheets</span><small>Off blocks every http(s) request; embed assets as data: URLs instead.</small></label>
      <p class="help">${chrome}</p>
      <div class="foot"><button class="primary">Save</button></div>
    </form>`)}
    ${c.enabled && status.chrome
      ? card(ctx, 'render-test', 'Try it', null, 'Renders this HTML and opens the result in a new tab.', html`
    <form method="post" action="${SETTINGS}/render/test" target="_blank" hx-boost="false">
      <label>HTML<textarea name="html" class="mono tall" spellcheck="false">${SAMPLE_INVOICE}</textarea></label>
      <label>Output<select name="output">${['pdf', 'png', 'jpg', 'webp'].map((o) => html`<option value="${o}">${o.toUpperCase()}</option>`)}</select></label>
      <div class="foot"><button>Render</button></div>
    </form>`)
      : ''}`
}

/** An inline result for htmx requests, such as the SMTP test button. */
export function inlineStatus(message: string, tone: 'success' | 'critical'): Html {
  return html`<span style="color:var(--${tone})">${message}</span>`
}

export async function settingsView(ctx: ConsoleContext, tab: SettingsTab, options: { template?: TemplateId; fields?: TemplateFields } = {}): Promise<Html> {
  let body: Html
  switch (tab) {
    case 'general':
      body = projectCard(ctx)
      break
    case 'email':
      body = emailCards(ctx)
      break
    case 'templates':
      body = templatesView(ctx, options.template ?? 'verification', options.fields)
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
    case 'cache':
      body = cacheCards(ctx)
      break
    case 'render':
      body = renderCards(ctx)
      break
  }
  return html`${header('Settings')}
    ${tabs(TABS, tab)}
    ${body}`
}
