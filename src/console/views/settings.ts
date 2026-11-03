/** Settings tab markup. The page loads data and validates writes; this module renders it. */
import { gitTabView } from '~/console/views/vcs'
import { OAUTH_PROVIDERS, OAUTH_PROVIDER_IDS, type OAuthProviderId, type S3Config } from '~/config'
import type { ConsoleContext } from '~/console/context'
import { html, type Html } from '~/console/html'
import { SETTINGS, SETTING_GROUPS, TABS, type SettingsTab } from '~/console/settings-meta'
import { alert, badge, destroy, formatBytes, header, icon, settingsSection } from '~/console/ui'
import { SAMPLE_INVOICE } from '~/render/sample'
import type { SettingKey } from '~/settings/service'
import type { TemplateFields, TemplateId } from '~/mail/templates'
import { MIN_COMPRESS_BYTES } from '~/lib/compress'
import { PROJECT_SCOPE } from '~/variables/service'
import { templatesView } from './templates'
import { variableList } from './variables'
import { smtpForm } from './smtp'

async function codeFound(ctx: ConsoleContext): Promise<Html> {
  const fns = await ctx.services.functions.list()
  if (!fns.length) return html``
  const dirs = await Promise.all(fns.map((f) => ctx.services.functions.codeDir(f)))
  const found = dirs.filter((code) => code.dir).length
  return found === fns.length
    ? html`Code found for all ${found} functions.`
    : html`<b style="color:var(--critical)">Code found for ${found} of ${fns.length} functions.</b>`
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
  return card(
    ctx,
    'project',
    'Project',
    'project',
    'Name in emails, allowed web origins and how long sign-ins last.',
    html` <form method="post" action="${SETTINGS}/project">
      <label
        >Name
        <div class="copy-row"><input id="project-name" name="projectName" value="${c.projectName}" required />${copy('project-name')}</div></label
      >
      <label
        >Organization ID
        <div class="copy-row"><input id="project-org-id" class="mono" readonly value="${c.orgId || '—'}" />${copy('project-org-id')}</div>
        <small>Generated on first start and stored in the database.</small></label
      >
      <label
        >Project ID
        <div class="copy-row"><input id="project-id" class="mono" readonly value="${c.projectId}" />${copy('project-id')}</div>
        <small>Set when the project was created. Apps send this in X-Bunwrite-Project (or X-Appwrite-Project).</small></label
      >
      <label
        >Allowed origins<textarea name="allowedOrigins" class="mono">${c.allowedOrigins.join('\n')}</textarea
        ><small>One per line. <code>*.example.com</code> covers subdomains. Used for CORS and redirect links.</small></label
      >
      <div class="fields">
        <label>Session length (days)<input name="sessionDays" type="number" min="1" value="${Math.round(c.sessionDuration / 86400)}" /></label
        ><label>Sessions per user<input name="sessionsLimit" type="number" min="1" max="100" value="${c.sessionsLimit}" /></label>
      </div>
      <div class="foot"><button class="primary">Save</button></div>
    </form>`,
  )
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
  const credentials =
    id === 'apple'
      ? html` <div class="fields">
            <label>Client ID (Service ID)<input name="clientId" value="${config?.clientId ?? ''}" class="mono" /></label>
            <label>Team ID<input name="teamId" value="${config?.teamId ?? ''}" class="mono" /></label>
            <label>Key ID<input name="keyId" value="${config?.keyId ?? ''}" class="mono" /></label>
          </div>
          <label
            >Private key (.p8)<textarea
              name="privateKey"
              class="mono"
              rows="4"
              autocomplete="off"
              placeholder="${config?.privateKey ? 'Unchanged' : '-----BEGIN PRIVATE KEY-----'}"
            ></textarea
            ><small>Signs the client secret Apple requires. Downloaded from the Apple Developer portal.</small></label
          >`
      : html` <div class="fields">
          <label>Client ID<input name="clientId" value="${config?.clientId ?? ''}" class="mono" /></label>
          <label
            >Client secret<input name="clientSecret" type="password" placeholder="${config?.clientSecret ? 'Unchanged' : ''}" autocomplete="new-password"
          /></label>
        </div>`
  return card(
    ctx,
    id,
    `${meta.name} sign-in`,
    id,
    OAUTH_HINTS[id],
    html` <form method="post" action="${SETTINGS}/${id}">
      <label>Redirect URI<input class="mono" readonly value="${redirect}" /></label>
      ${credentials}
      <div class="foot">
        ${config ? html`<button type="submit" name="disable" value="1" class="critical">Turn off</button>` : ''}<button class="primary">Save</button>
      </div>
    </form>`,
  )
}

function emailCards(ctx: ConsoleContext): Html {
  const smtp = ctx.services.config.smtp
  return html` ${card(
    ctx,
    'email',
    'Email (SMTP)',
    'smtp',
    'Sends this project\'s sign-in codes, password resets and team invitations. It is separate from the console email settings used for MFA.',
    smtpForm({ action: `${SETTINGS}/smtp`, testAction: `${SETTINGS}/smtp/test`, smtp, recipient: ctx.admin.email }),
  )}
  ${OAUTH_PROVIDER_IDS.map((id) => oauthCard(ctx, id))}`
}

export function s3Fields(prefix: string, s3: S3Config): Html {
  const field = (label: string, input: Html) => html`<label>${label}${input}</label>`
  return html` <label>Endpoint<input name="${prefix}Endpoint" class="mono" value="${s3.endpoint}" placeholder="https://s3.example.com" /></label>
    <div class="fields">
      ${field('Bucket', html`<input name="${prefix}Bucket" value="${s3.bucket}" />`)}
      ${field('Region', html`<input name="${prefix}Region" value="${s3.region}" />`)}
    </div>
    <div class="fields">
      ${field('Access key', html`<input name="${prefix}AccessKey" class="mono" value="${s3.accessKey}" />`)}
      ${field('Secret', html`<input name="${prefix}Secret" type="password" placeholder="${s3.secret ? 'Unchanged' : ''}" autocomplete="new-password" />`)}
    </div>
    <label class="check"
      ><input type="checkbox" name="${prefix}ForcePathStyle" ${s3.forcePathStyle ? 'checked' : ''} />Force path-style addressing
      <small
        >Without this, requests go to <span class="mono">&lt;bucket&gt;.&lt;endpoint host&gt;</span>, which many S3-compatible services and their certificates
        do not cover. Turn it on for MinIO, Supabase or R2, and for AWS bucket names that contain dots.</small
      ></label
    >`
}

function storageCard(ctx: ConsoleContext): Html {
  const s3 = ctx.services.config.s3
  return card(
    ctx,
    'storage',
    'File storage',
    's3',
    'Local disk by default. Use S3-compatible storage when disk space is limited.',
    html` <form method="post" action="${SETTINGS}/storage">
      <label class="check"><input type="checkbox" name="s3Enabled" ${s3.enabled ? 'checked' : ''} />Use S3 storage</label>
      ${alert('warning', html`Existing files are not moved when you switch storage. Migrate them manually between the local folder and S3; tools such as <code>rclone</code> or <code>s5cmd</code> can help.`)}
      ${s3Fields('s3', s3)}
      <div class="foot"><button class="primary">Save</button></div>
    </form>`,
  )
}

function databaseCard(ctx: ConsoleContext): Html {
  const mode = ctx.services.config.sqliteSynchronous
  return card(
    ctx,
    'database',
    'Commit durability',
    'database',
    'How the project database acknowledges writes. It is independent of the other projects on this server.',
    html` <form method="post" action="${SETTINGS}/database">
      <label
        >Synchronous mode
        <select name="synchronous">
          <option value="NORMAL" ${mode === 'NORMAL' ? 'selected' : ''}>NORMAL — fast; recent commits can be lost on power failure</option>
          <option value="FULL" ${mode === 'FULL' ? 'selected' : ''}>FULL — fsync every commit; for payments and ledgers</option>
        </select>
      </label>
      ${alert('warning', html`<b>NORMAL</b> keeps the database consistent, but a power loss or OS crash can roll back transactions committed since the last checkpoint. Use <b>FULL</b> for orders, payments, accounting ledgers and any write that must be on disk before the response is sent. FULL adds an fsync to every commit and lowers write throughput.`)}
      <div class="foot"><button class="primary">Save</button></div>
    </form>`,
  )
}

async function projectVariablesCard(ctx: ConsoleContext): Promise<Html> {
  const projectVars = await ctx.services.variables.list(PROJECT_SCOPE)
  return card(
    ctx,
    'project-vars',
    'Global variables',
    null,
    'Available to every site and function. A site or function variable with the same name wins.',
    variableList(projectVars, {
      id: 'project-vars',
      save: `${SETTINGS}/variables`,
      remove: `${SETTINGS}/variables/delete`,
      addLabel: 'Add variable',
      bulk: { id: 'bulk-project-vars', title: 'Import global variables', action: `${SETTINGS}/variables/bulk` },
      clear: { action: `${SETTINGS}/variables/clear`, confirm: `Delete all ${projectVars.length} global variables? This cannot be undone.` },
      empty: html`<p class="hint" style="margin:0">None set. Values from the server environment still apply.</p>`,
    }),
  )
}

async function functionCards(ctx: ConsoleContext): Promise<Html> {
  const c = ctx.services.config
  const fns = (await ctx.services.functions.list()).filter((f) => f.schedule)
  return card(
    ctx,
    'schedules',
    'Functions',
    'functions',
    'Where function code lives, and which schedules are paused.',
    html` <form method="post" action="${SETTINGS}/functions">
      <label
        >Code folder<input name="functionsDir" class="mono" value="${c.functionsDir}" /><small
          >The folder with the project config file (bunwrite.config.json or appwrite.config.json); function paths are read from it.
          ${await codeFound(ctx)}</small
        ></label
      >
      <div class="subdued" style="margin:4px 0 8px">Paused schedules do not fire. Running a function by hand still works.</div>
      ${fns.length ? fns.map((f) => html`<label class="check"><input type="checkbox" name="paused" value="${f.id}" ${c.skipSchedules.includes(f.id) ? 'checked' : ''} />Pause <span class="mono">${f.id}</span>&nbsp;<span class="subdued">${f.schedule}</span></label>`) : html`<p class="subdued">No scheduled functions.</p>`}
      <div class="foot"><button class="primary">Save</button></div>
    </form>`,
  )
}

function vectorsCards(ctx: ConsoleContext): Html {
  const c = ctx.services.config.vectors
  const http = c.embedder === 'http'
  return html`${card(
    ctx,
    'vectors-embedding',
    'Embeddings',
    'vectors',
    'How text is turned into vectors. Local works offline; HTTP calls any OpenAI-compatible embeddings API.',
    html` <form method="post" action="${SETTINGS}/vectors/embedding">
      <label
        >Provider<select name="embedder">
          <option value="local" ${http ? '' : 'selected'}>Local, offline feature hashing</option>
          <option value="http" ${http ? 'selected' : ''}>OpenAI-compatible HTTP API</option>
        </select>
        <small>Collections record the provider and dimension they were built with. Changing either means re-indexing.</small></label
      >
      <div class="fields">
        <label>Dimensions<input name="dimension" type="number" min="8" max="8192" value="${c.dimension}" required /><small>The local embedder uses this width; for HTTP it must match the model.</small></label>
        <label>Batch size<input name="embeddingBatchSize" type="number" min="1" max="256" value="${c.embeddingBatchSize}" required /><small>Texts sent per embeddings request.</small></label>
      </div>
      <label
        >Endpoint<input name="embeddingUrl" class="mono" value="${c.embeddingUrl}" placeholder="https://api.openai.com/v1" /><small
          >Base URL or a full <span class="mono">/embeddings</span> endpoint. Required for HTTP; ignored by the local embedder.</small
        ></label
      >
      <div class="fields">
        <label>Model<input name="embeddingModel" class="mono" value="${c.embeddingModel}" placeholder="text-embedding-3-small" /></label>
        <label>API key<input name="embeddingApiKey" type="password" placeholder="${c.embeddingApiKey ? 'Unchanged' : 'Optional'}" autocomplete="new-password" /><small>Leave blank to keep the saved key.</small></label>
      </div>
      <div class="fields">
        <label>Request timeout (ms)<input name="timeoutMs" type="number" min="1000" max="120000" value="${c.timeoutMs}" required /><small>Applies to embedding and chat requests.</small></label>
        <label class="check"
          ><input type="checkbox" name="sendDimensions" ${c.sendDimensions ? 'checked' : ''} /><span>Send the dimensions field</span
          ><small>Needed by some OpenAI v3 models; turn off for gateways that reject it.</small></label
        >
      </div>
      <p class="help">Existing collections keep their old provider and width. Add their points again after a change, or text queries will not match.</p>
      <div class="foot"><button class="primary">Save</button></div>
    </form>`,
  )}
  ${card(
    ctx,
    'vectors-answers',
    'Answer generation',
    null,
    'Optional. When off, RAG returns the retrieved context and sources without asking a model.',
    html` <form method="post" action="${SETTINGS}/vectors/answers">
      <label class="check"
        ><input type="checkbox" name="enabled" ${c.chatUrl ? 'checked' : ''} /><span>Generate answers with a chat model</span
        ><small>Uses an OpenAI-compatible <span class="mono">/chat/completions</span> endpoint.</small></label
      >
      <div class="fields">
        <label>Chat endpoint<input name="chatUrl" class="mono" value="${c.chatUrl}" placeholder="https://api.openai.com/v1" /></label>
        <label>Model<input name="chatModel" class="mono" value="${c.chatModel}" placeholder="gpt-4o-mini" /></label>
      </div>
      <label
        >API key<input name="chatApiKey" type="password" placeholder="${c.chatApiKey ? 'Unchanged' : 'Optional'}" autocomplete="new-password" /><small>Leave blank to keep the saved key.</small></label
      >
      <div class="fields">
        <label>Temperature<input name="chatTemperature" type="number" min="0" max="2" step="0.1" value="${c.chatTemperature}" required /></label>
        <label>Maximum answer tokens<input name="chatMaxTokens" type="number" min="1" max="32000" value="${c.chatMaxTokens}" required /></label>
        <label>Context characters<input name="contextChars" type="number" min="256" max="200000" value="${c.contextChars}" required /><small>Retrieved text sent to the model.</small></label>
      </div>
      <label>System prompt<textarea name="chatSystemPrompt" rows="4">${c.chatSystemPrompt}</textarea></label>
      <div class="foot"><button class="primary">Save</button></div>
    </form>`,
  )}
  ${card(
    ctx,
    'vectors-limits',
    'Ingestion and limits',
    null,
    'Defaults for new ingests and the maximum points one collection may hold.',
    html` <form method="post" action="${SETTINGS}/vectors/limits">
      <label
        >Points per collection<input name="maxPoints" type="number" min="1" max="1000000" value="${c.maxPoints}" required /><small
          >Search scans points in-process. A lower cap keeps memory and search time predictable.</small
        ></label
      >
      <div class="fields">
        <label>Chunk size<input name="chunkSize" type="number" min="64" max="8000" value="${c.chunkSize}" required /><small>Characters per ingested chunk.</small></label>
        <label>Chunk overlap<input name="chunkOverlap" type="number" min="0" value="${c.chunkOverlap}" required /><small>Cannot exceed half the chunk size.</small></label>
      </div>
      <div class="foot"><button class="primary">Save</button></div>
    </form>`,
  )}`
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
  const choices = CACHE_CHOICES.some(([s]) => s === seconds)
    ? CACHE_CHOICES
    : [...CACHE_CHOICES, [seconds, `${seconds.toLocaleString('en-US')} seconds`] as [number, string]]
  return html`<select name="${name}">
    ${choices.map(([s, label]) => html`<option value="${s}" ${s === seconds ? 'selected' : ''}>${label}</option>`)}
  </select>`
}

function cacheCards(ctx: ConsoleContext): Html {
  const c = ctx.services.config.cache
  const stats = ctx.services.storage.previewCacheStats()
  const compression = ctx.services.config.compression
  return html`${card(
    ctx,
    'cache',
    'Cache lifetimes',
    'cache',
    'How long browsers reuse files and image previews before asking again, and how long generated previews stay on disk.',
    html` <form method="post" action="${SETTINGS}/cache">
      <div class="fields">
        <label>File views and downloads${cacheSelect('fileMaxAge', c.fileMaxAge)}</label>
        <label>Image previews${cacheSelect('previewMaxAge', c.previewMaxAge)}</label>
      </div>
      <label
        >Keep generated previews (days)<input name="previewRetentionDays" type="number" min="0" max="3650" value="${c.previewRetentionDays}" /><small
          >Older previews are deleted and made again on the next request. 0 keeps them until the file is deleted.</small
        ></label
      >
      <p class="help">
        Files are cached as private, so only the visitor's browser keeps them, never a shared proxy. When the time is up the browser asks again and gets a quick
        "not modified" reply if the file is the same. Uploaded files never change, so long lifetimes are safe.
      </p>
      <div class="foot"><button class="primary">Save</button></div>
    </form>`,
  )}
  ${card(
    ctx,
    'previews',
    'Generated previews',
    null,
    'Resized and converted images made for preview links, kept on this server so each size is made once.',
    html` <ul class="list">
        <li><span class="subdued">Cached previews</span><span>${stats.files.toLocaleString('en-US')}</span></li>
        <li><span class="subdued">Disk space</span><span>${formatBytes(stats.bytes)}</span></li>
      </ul>
      <form
        method="post"
        action="${SETTINGS}/cache/previews/clear"
        data-confirm="Delete all ${stats.files} cached previews? They are made again when next requested."
        data-confirm-label="Clear previews"
        class="foot"
      >
        <button ${stats.files ? '' : 'disabled'}>Clear previews</button>
      </form>`,
  )}
  ${card(
    ctx,
    'compression',
    'Compression',
    null,
    'Applies to the whole server, every project and the console.',
    html` <ul class="list">
        <li><span class="subdued">Responses</span><span>${compression ? badge('On', 'success') : badge('Off')}</span></li>
        <li><span class="subdued">Encodings</span><span>Brotli, else gzip</span></li>
        <li><span class="subdued">Realtime messages</span><span>${compression ? 'Per-message deflate' : 'Off'}</span></li>
      </ul>
      <p class="help">
        JSON, HTML, scripts, text, SVG and other text-based responses over ${formatBytes(MIN_COMPRESS_BYTES)} are compressed. Images, video, zip and PDF are
        already compressed and go out as they are.
        ${compression ? html`Set <code>COMPRESSION=false</code> only if a proxy in front already compresses.` : html`Turned off with <code>COMPRESSION=false</code>.`}
      </p>`,
  )}`
}

function logsCard(ctx: ConsoleContext): Html {
  const c = ctx.services.config
  const samplePercent = Math.round(c.logSampleRate * 1000) / 10
  return card(
    ctx,
    'logs',
    'Request logs',
    'logs',
    'Whether requests are recorded, how they are sampled, where they are kept and how they are printed.',
    html` <form method="post" action="${SETTINGS}/logs">
      <label class="check"
        ><input type="checkbox" name="logRequests" ${c.logRequests ? 'checked' : ''} /><span>Record requests</span
        ><small>Writes one line per request to the server output and this project's request log. Only successful requests are sampled; errors are always recorded.</small></label
      >
      <div class="fields start">
        <label
          >Retention (days)<input name="retentionDays" type="number" min="0" value="${c.logRetentionDays}" /><small
            >0 keeps logs until you clear them.</small
          ></label
        >
        <label
          >Sample successful requests (%)<input name="logSampleRate" type="number" min="0" max="100" step="0.1" value="${samplePercent}" required /><small
            >100 records every request. Errors bypass sampling.</small
          ></label
        >
      </div>
      <div class="fields center">
        <label
          >Output format<select name="logFormat">
            <option value="text" ${c.logFormat === 'text' ? 'selected' : ''}>Text, for journald and terminal logs</option>
            <option value="json" ${c.logFormat === 'json' ? 'selected' : ''}>JSON, for a log collector</option>
          </select></label
        >
        <label class="check"
          ><input type="checkbox" name="logIp" ${c.logIp ? 'checked' : ''} /><span>Store IP addresses</span
          ><small>Off keeps visitor IPs out of logs.</small></label
        >
      </div>
      <p class="help">Applies immediately. <a href="/console/logs">Open request logs</a>.</p>
      <div class="foot"><button class="primary">Save</button></div>
    </form>`,
  )
}

function renderCards(ctx: ConsoleContext): Html {
  const c = ctx.services.config.render
  const status = ctx.services.render.status()
  const chrome = status.chrome
    ? html`Chromium: <code>${status.chrome}</code>${status.running ? ' · running' : ' · starts on the first render, stops after a minute idle'}`
    : html`<b style="color:var(--critical)">Chromium not found.</b> Install <code>chromium</code>, set <code>CHROME_PATH</code>,
        or use the published Docker image. A local image needs <code>BUNWRITE_WITH_CHROMIUM=true</code>.`
  return html`${card(
    ctx,
    'render',
    'HTML rendering',
    'render',
    'Render HTML to PDF (POST /v1/pdf) or to png, jpg, webp, avif and gif images (POST /v1/image) with an API key. Uses headless Chromium, about 150 MB while rendering.',
    html` <form method="post" action="${SETTINGS}/render">
      <label class="check"
        ><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''} /><span>Enable HTML rendering</span
        ><small>Off disables POST /v1/pdf and POST /v1/image.</small></label
      >
      <label class="check"
        ><input type="checkbox" name="allowRemote" ${c.allowRemote ? 'checked' : ''} /><span>Allow remote images, fonts and stylesheets</span
        ><small>Off blocks every http(s) request; embed assets as data: URLs instead.</small></label
      >
      <p class="help">${chrome}</p>
      <div class="foot"><button class="primary">Save</button></div>
    </form>`,
  )}
  ${
    c.enabled && status.chrome
      ? card(
          ctx,
          'render-test',
          'Try it',
          null,
          'Renders this HTML and opens the result in a new tab.',
          html` <form method="post" action="${SETTINGS}/render/test" target="_blank" hx-boost="false">
            <label>HTML<textarea name="html" class="mono tall" spellcheck="false">${SAMPLE_INVOICE}</textarea></label>
            <label
              >Output<select name="output">
                ${['pdf', 'png', 'jpg', 'webp'].map((o) => html`<option value="${o}">${o.toUpperCase()}</option>`)}
              </select></label
            >
            <div class="foot"><button class="primary">Render</button></div>
          </form>`,
        )
      : ''
  }`
}

/** An inline result for htmx requests, such as the SMTP test button. */
export function inlineStatus(message: string, tone: 'success' | 'critical'): Html {
  return html`<span style="color:var(--${tone})">${message}</span>`
}

const TAB_BY_KEY = Object.fromEntries(TABS.map((tab) => [tab.key, tab])) as Record<SettingsTab, (typeof TABS)[number]>

function settingsNav(active: SettingsTab): Html {
  return html`<nav class="settings-nav" aria-label="Settings sections">
    ${SETTING_GROUPS.map(
      (group) =>
        html`<div class="settings-nav-group">
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
    case 'functions':
      body = await functionCards(ctx)
      break
    case 'variables':
      body = await projectVariablesCard(ctx)
      break
    case 'logs':
      body = logsCard(ctx)
      break
    case 'cache':
      body = cacheCards(ctx)
      break
    case 'database':
      body = databaseCard(ctx)
      break
    case 'vectors':
      body = vectorsCards(ctx)
      break
    case 'render':
      body = renderCards(ctx)
      break
    case 'git':
      body = await gitTabView(ctx)
      break
  }
  return html`${header('Settings')}
    <div class="settings-layout">
      ${settingsNav(tab)}
      <div class="settings-content">${body}</div>
    </div>`
}
