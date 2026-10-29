/** Settings tab markup. The page loads data and validates writes; this module renders it. */
import { gitTabView } from '~/console/views/vcs'
import type { BackupFile } from '~/backups/service'
import { OAUTH_PROVIDERS, OAUTH_PROVIDER_IDS, type OAuthProviderId, type S3Config } from '~/config'
import type { ConsoleContext } from '~/console/context'
import { html, type Html } from '~/console/html'
import { SETTINGS, SETTING_GROUPS, TABS, type SettingsTab } from '~/console/settings-meta'
import { alert, badge, destroy, emptyState, formatBytes, header, icon, settingsSection, when } from '~/console/ui'
import { SAMPLE_INVOICE } from '~/render/sample'
import type { SettingKey } from '~/settings/service'
import type { TemplateFields, TemplateId } from '~/mail/templates'
import { MIN_COMPRESS_BYTES } from '~/lib/compress'
import { PROJECT_SCOPE } from '~/variables/service'
import { templatesView } from './templates'
import { variableList } from './variables'

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
  const copy = (id: string) => html`<button type="button" data-copy-target="#${id}">${icon('copy')}<span data-copy-label>Copy</span></button>`
  return card(ctx, 'project', 'Project', 'project', 'Name in emails, allowed web origins and how long sign-ins last.', html`
    <form method="post" action="${SETTINGS}/project">
      <label>Name<div class="copy-row"><input id="project-name" name="projectName" value="${c.projectName}" required>${copy('project-name')}</div></label>
      <label>Organization ID<div class="copy-row"><input id="project-org-id" class="mono" readonly value="${c.orgId || '—'}">${copy('project-org-id')}</div><small>Generated on first start and stored in the database.</small></label>
      <label>Project ID<div class="copy-row"><input id="project-id" class="mono" readonly value="${c.projectId}">${copy('project-id')}</div><small>Set when the project was created. Apps send this in X-Bunwrite-Project (or X-Appwrite-Project).</small></label>
      <label>Allowed origins<textarea name="allowedOrigins" class="mono">${c.allowedOrigins.join('\n')}</textarea><small>One per line. <code>*.example.com</code> covers subdomains. Used for CORS and redirect links.</small></label>
      <div class="fields"><label>Session length (days)<input name="sessionDays" type="number" min="1" value="${Math.round(c.sessionDuration / 86400)}"></label><label>Sessions per user<input name="sessionsLimit" type="number" min="1" max="100" value="${c.sessionsLimit}"></label></div>
      <div class="foot"><button class="primary">Save</button></div>
    </form>`)
}

const OAUTH_HINTS: Record<OAuthProviderId, string> = {
  apple: 'Sign in with Apple service from the Apple Developer portal. Add the redirect URI below to it.',
  facebook: 'Facebook app from Meta for Developers. Add the redirect URI below to it.',
  github: 'GitHub OAuth App from Developer settings. Add the redirect URI below to it.',
  google: 'OAuth client from Google Cloud. Add the redirect URI below to it.',
}

function oauthCard(ctx: ConsoleContext, id: OAuthProviderId): Html {
  const c = ctx.services.config
  const meta = OAUTH_PROVIDERS[id]
  const config = c.oauth[id] ?? null
  const redirect = `${c.publicEndpoint}/account/sessions/oauth2/callback/${id}/${c.projectId}`
  const credentials = id === 'apple'
    ? html`
        <div class="fields">
          <label>Client ID (Service ID)<input name="clientId" value="${config?.clientId ?? ''}" class="mono"></label>
          <label>Team ID<input name="teamId" value="${config?.teamId ?? ''}" class="mono"></label>
          <label>Key ID<input name="keyId" value="${config?.keyId ?? ''}" class="mono"></label>
        </div>
        <label>Private key (.p8)<textarea name="privateKey" class="mono" rows="4" autocomplete="off" placeholder="${config?.privateKey ? 'Unchanged' : '-----BEGIN PRIVATE KEY-----'}"></textarea><small>Signs the client secret Apple requires. Downloaded from the Apple Developer portal.</small></label>`
    : html`
        <div class="fields">
          <label>Client ID<input name="clientId" value="${config?.clientId ?? ''}" class="mono"></label>
          <label>Client secret<input name="clientSecret" type="password" placeholder="${config?.clientSecret ? 'Unchanged' : ''}" autocomplete="new-password"></label>
        </div>`
  return card(ctx, id, `${meta.name} sign-in`, id, OAUTH_HINTS[id], html`
    <form method="post" action="${SETTINGS}/${id}">
      <label>Redirect URI<input class="mono" readonly value="${redirect}"></label>
      ${credentials}
      <div class="foot">${config ? html`<button type="submit" name="disable" value="1" class="critical">Turn off</button>` : ''}<button class="primary">Save</button></div>
    </form>`)
}

function emailCards(ctx: ConsoleContext): Html {
  const smtp = ctx.services.config.smtp
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
    ${OAUTH_PROVIDER_IDS.map((id) => oauthCard(ctx, id))}`
}

function s3Fields(prefix: string, s3: S3Config): Html {
  const field = (label: string, input: Html) => html`<label>${label}${input}</label>`
  return html`
    <label>Endpoint<input name="${prefix}Endpoint" class="mono" value="${s3.endpoint}" placeholder="https://s3.example.com"></label>
    <div class="fields">
      ${field('Bucket', html`<input name="${prefix}Bucket" value="${s3.bucket}">`)}
      ${field('Region', html`<input name="${prefix}Region" value="${s3.region}">`)}
    </div>
    <div class="fields">
      ${field('Access key', html`<input name="${prefix}AccessKey" class="mono" value="${s3.accessKey}">`)}
      ${field('Secret', html`<input name="${prefix}Secret" type="password" placeholder="${s3.secret ? 'Unchanged' : ''}" autocomplete="new-password">`)}
    </div>
    <label class="check"><input type="checkbox" name="${prefix}ForcePathStyle" ${s3.forcePathStyle ? 'checked' : ''}>Force path-style addressing
      <small>Without this, requests go to <span class="mono">&lt;bucket&gt;.&lt;endpoint host&gt;</span>, which many S3-compatible services and their certificates do not cover. Turn it on for MinIO, Supabase or R2, and for AWS bucket names that contain dots.</small></label>`
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
          ? html`<ul class="list backup-list">${backups.map(
              (b) => html`<li>
                <div class="backup-meta">
                  <span class="mono clip" title="${b.name}">${b.name}</span>
                  <span class="subdued cell-sub">${formatBytes(b.size)} · Created ${when(b.modified)}</span>
                </div>
                <div class="backup-actions">
                  <a class="btn small" href="${SETTINGS}/backups/${encodeURIComponent(b.name)}/download" hx-boost="false">Download</a>
                  <form method="post" action="${SETTINGS}/backups/${encodeURIComponent(b.name)}/delete" class="inline" data-confirm="Delete ${b.name}?" data-confirm-label="Delete" data-confirm-tone="critical">
                    <button class="critical small">Delete</button>
                  </form>
                </div>
              </li>`,
            )}</ul>`
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

function projectVariablesCard(ctx: ConsoleContext): Html {
  const projectVars = ctx.services.variables.list(PROJECT_SCOPE)
  return card(ctx, 'project-vars', 'Global variables', null, 'Available to every site and function. A site or function variable with the same name wins.', variableList(projectVars, {
    id: 'project-vars',
    save: `${SETTINGS}/variables`,
    remove: `${SETTINGS}/variables/delete`,
    addLabel: 'Add variable',
    bulk: { id: 'bulk-project-vars', title: 'Import global variables', action: `${SETTINGS}/variables/bulk` },
    clear: { action: `${SETTINGS}/variables/clear`, confirm: `Delete all ${projectVars.length} global variables? This cannot be undone.` },
    empty: html`<p class="hint" style="margin:0">None set. Values from the server environment still apply.</p>`,
  }))
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
    ${card(ctx, 'global-vars', 'Global function variables', null, 'Available to every function. A variable set on one function with the same name wins.', variableList(globals, {
      id: 'global-vars',
      save: `${SETTINGS}/functions/variables`,
      remove: `${SETTINGS}/functions/variables/delete`,
      addLabel: 'Add global variable',
      bulk: { id: 'bulk-global-vars', title: 'Import global variables', action: `${SETTINGS}/functions/variables/bulk` },
      clear: { action: `${SETTINGS}/functions/variables/clear`, confirm: `Delete all ${globals.length} global variables? This cannot be undone.` },
      empty: html`<p class="hint" style="margin:0">None set. Values from FUNCTIONS_ENV_FILE still apply.</p>`,
    }))}`
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
      <div class="fields center">
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

const TAB_BY_KEY = Object.fromEntries(TABS.map((tab) => [tab.key, tab])) as Record<SettingsTab, (typeof TABS)[number]>

function settingsNav(active: SettingsTab): Html {
  return html`<nav class="settings-nav" aria-label="Settings sections">
    ${SETTING_GROUPS.map(
      (group) => html`<div class="settings-nav-group">
        <div class="settings-nav-label">${group.label}</div>
        ${group.tabs.map((key) => {
          const tab = TAB_BY_KEY[key]
          return html`<a href="${tab.href}" class="${key === active ? 'on' : ''}" ${key === active ? html`aria-current="page"` : ''}>${tab.label}</a>`
        })}
      </div>`,
    )}
  </nav>`
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
    case 'variables':
      body = projectVariablesCard(ctx)
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
    case 'git':
      body = gitTabView(ctx)
      break
  }
  return html`${header('Settings')}
    <div class="settings-layout">
      ${settingsNav(tab)}
      <div class="settings-content">${body}</div>
    </div>`
}
