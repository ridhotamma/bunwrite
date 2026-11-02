/** Markup for the console-managed observability configuration. */
import { dialog } from '~/console/dialog'
import { html, type Html } from '~/console/html'
import { alert, badge, destroy, header, icon, menu, pageFooter, plural, settingsSection, tabs } from '~/console/ui'
import type { ObservabilitySettings } from '~/observability/settings'
import { OBS, OBS_TABS } from './observability'

export const OBS_SETTINGS = `${OBS}/settings`

export interface ObservabilitySettingsViewOptions {
  settings: ObservabilitySettings
  canManage: boolean
  overridden: boolean
  error?: string
}

const percent = (rate: number): string => (rate * 100).toFixed(2).replace(/\.?0+$/, '')
const seconds = (ms: number): string => String(Math.round(ms / 1000))

function checked(on: boolean): string {
  return on ? 'checked' : ''
}

function signalField(settings: ObservabilitySettings): Html {
  const selected = new Set(settings.otlp?.signals ?? [])
  return html`<div class="fields">
    <label class="check"><input type="checkbox" name="signals" value="traces" ${checked(selected.has('traces'))}><span>Traces</span></label>
    <label class="check"><input type="checkbox" name="signals" value="metrics" ${checked(selected.has('metrics'))}><span>Metrics</span></label>
    <label class="check"><input type="checkbox" name="signals" value="logs" ${checked(selected.has('logs'))}><span>Logs</span></label>
  </div>`
}

export interface FeatureFlagActions {
  save: string
  remove: string
  clear: string
}

const flagValue = (value: boolean | string): Html =>
  typeof value === 'boolean' ? badge(value ? 'On' : 'Off', value ? 'success' : 'info') : html`<span class="mono">${value || html`<span class="subdued">(empty)</span>`}</span>`

function flagValueFields(value: boolean | string): Html {
  const type = typeof value === 'boolean' ? 'boolean' : 'string'
  return html`<label>Type<select name="type" data-show-by>
      <option value="boolean" ${type === 'boolean' ? 'selected' : ''}>Boolean</option>
      <option value="string" ${type === 'string' ? 'selected' : ''}>Text</option>
    </select></label>
    <div data-show-for="boolean" data-for-select="type">
      <label>Value<select name="flagBoolean">
        <option value="true" ${value === true ? 'selected' : ''}>On (true)</option>
        <option value="false" ${value === false ? 'selected' : ''}>Off (false)</option>
      </select></label>
    </div>
    <div data-show-for="string" data-for-select="type">
      <label>Value<input name="flagString" value="${type === 'string' ? String(value) : ''}" placeholder="dark"></label>
    </div>`
}

function addFlagDialog(actions: FeatureFlagActions): Html {
  const form = 'feature-flag-add-form'
  return dialog({
    id: 'feature-flag-add',
    title: 'Add feature flag',
    body: html`<form id="${form}" method="post" action="${actions.save}" class="stack-fields">
      <label>Name<input name="key" class="mono" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,127}" placeholder="new-checkout"><small>Letters, numbers, dot, hyphen or underscore.</small></label>
      ${flagValueFields(true)}
    </form>`,
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="${form}" class="primary">Add flag</button>`,
  })
}

function editFlagDialog(key: string, value: boolean | string, index: number, actions: FeatureFlagActions): Html {
  const id = `feature-flag-edit-${index}`
  const form = `${id}-form`
  return dialog({
    id,
    title: `Edit ${key}`,
    body: html`<form id="${form}" method="post" action="${actions.save}" class="stack-fields">
      <input type="hidden" name="key" value="${key}">
      <label>Name<input value="${key}" class="mono" readonly></label>
      ${flagValueFields(value)}
    </form>`,
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="${form}" class="primary">Save</button>`,
  })
}

function removeFlagForm(key: string, actions: FeatureFlagActions): Html {
  return html`<form method="post" action="${actions.remove}" class="inline" data-confirm="Remove feature flag ${key}?" data-confirm-label="Remove" data-confirm-tone="critical">
    <input type="hidden" name="key" value="${key}">
    <button class="critical small">Remove</button>
  </form>`
}

/** The local-overrides list, modelled on the project Variables table. */
export function featureFlagsView(flags: Record<string, boolean | string>, actions: FeatureFlagActions, canManage: boolean): Html {
  const entries = Object.entries(flags).sort(([a], [b]) => a.localeCompare(b))
  const clear = html`<form method="post" action="${actions.clear}" data-confirm="Delete every local feature flag override?" data-confirm-label="Delete all" data-confirm-tone="critical"><button class="critical">Delete all</button></form>`
  return html`
    <div class="var-toolbar">
      <span class="var-count">${plural(entries.length, 'local override')}</span>
      <div class="var-toolbar-actions">
        ${canManage && entries.length ? menu(clear, { label: 'Feature flag actions', align: 'end' }) : ''}
        ${canManage ? html`<button type="button" class="btn primary" data-dialog-open="#feature-flag-add">${icon('plus')}<span>Add flag</span></button>` : ''}
      </div>
    </div>
    ${entries.length
      ? html`<div class="scroll"><table class="var-table">
          <thead><tr><th>Flag</th><th>Value</th><th class="var-actions-col"></th></tr></thead>
          <tbody>${entries.map(
            ([key, value], index) => html`<tr>
              <td class="var-name" title="${key}"><span class="mono">${key}</span>${badge(typeof value === 'boolean' ? 'Boolean' : 'Text')}</td>
              <td class="clip">${flagValue(value)}</td>
              <td class="var-actions">
                ${canManage
                  ? html`<button type="button" class="btn small" data-dialog-open="#feature-flag-edit-${index}">Edit</button>${removeFlagForm(key, actions)}`
                  : ''}
              </td>
            </tr>`,
          )}</tbody>
        </table></div>`
      : html`<p class="hint">No local overrides. Values from PostHog and the app's defaults still apply.</p>`}
    ${canManage ? addFlagDialog(actions) : ''}
    ${canManage ? entries.map(([key, value], index) => editFlagDialog(key, value, index, actions)) : ''}`
}

/** Instance-wide provider and sampling settings. Environment values are the defaults. */
export function observabilitySettingsView(options: ObservabilitySettingsViewOptions): Html {
  const s = options.settings
  const hasOtlpHeaders = Boolean(s.otlp?.headers)
  const hasDatadogKey = Boolean(s.datadog?.apiKey)
  const hasPosthogKey = Boolean(s.posthog?.apiKey)
  const scope = options.overridden ? 'Console override' : 'Environment defaults'
  return html`${header('Observability settings', { back: OBS, actions: badge(scope, options.overridden ? 'success' : 'info') })}
    ${tabs(OBS_TABS, 'settings')}
    ${options.canManage
      ? ''
      : alert('info', html`Only an organization owner can change instance-wide observability settings. You can still review the current configuration.`)}
    ${options.error ? alert('critical', html`${options.error}`) : ''}
    <form id="observability-settings-form" method="post" action="${OBS_SETTINGS}">
      ${settingsSection(
        'Local console',
        'Bunwrite keeps a bounded local copy of request traces and document events so the Observability pages work without a provider.',
        html`<label class="check"><input type="checkbox" name="console" ${checked(s.console)}><span>Keep local telemetry in the console</span><small>Turning this off leaves external exporters running.</small></label>
          <div class="fields">
            <label>Trace sampling (%)<input name="consoleSampleRate" type="number" min="0" max="100" step="0.01" value="${percent(s.consoleSampleRate)}"><small>Fraction of requests stored as detailed traces.</small></label>
            <label>Spans kept<input name="spanLimit" type="number" min="100" max="100000" value="${s.spanLimit}"></label>
            <label>Events kept<input name="eventLimit" type="number" min="100" max="100000" value="${s.eventLimit}"></label>
          </div>
          <div class="fields">
            <label>Retention (days)<input name="consoleRetentionDays" type="number" min="1" max="90" value="${s.consoleRetentionDays}"></label>
            <label>Flush interval (ms)<input name="flushMs" type="number" min="250" max="60000" value="${s.flushMs}"></label>
          </div>`,
      )}

      ${settingsSection(
        'External exporters',
        'These settings apply to every project on this instance. Leave providers empty to keep only the local console copy.',
        html`<label class="check"><input type="checkbox" name="enabled" ${checked(s.enabled)}><span>Enable external exporters</span><small>When off, no traces, logs, metrics or analytics leave the server.</small></label>
          <div class="fields">
            <label>Service name<input name="serviceName" value="${s.serviceName}"></label>
            <label>Service version<input name="serviceVersion" value="${s.serviceVersion}"></label>
            <label>Environment<input name="environment" value="${s.environment}" placeholder="production"></label>
          </div>
          <div class="fields">
            <label>Trace sampling (%)<input name="sampleRate" type="number" min="0" max="100" step="0.01" value="${percent(s.sampleRate)}"></label>
            <label>Timeout (ms)<input name="timeoutMs" type="number" min="250" max="30000" value="${s.timeoutMs}"></label>
            <label>Queue limit<input name="queueLimit" type="number" min="100" max="100000" value="${s.queueLimit}"></label>
          </div>
          <label class="check"><input type="checkbox" name="debug" ${checked(s.debug)}><span>Log every exporter failure</span><small>Otherwise failures are logged at most once a minute.</small></label>`,
      )}

      ${settingsSection(
        'OTLP/HTTP',
        'Send traces, metrics and logs to any OTLP collector. Per-signal endpoints override the base endpoint.',
        html`<label>Base endpoint<input name="otlpEndpoint" type="url" class="mono" value="${s.otlp?.endpoint ?? ''}" placeholder="https://otlp.example.com"></label>
          <h3 class="field-heading">Signals</h3>
          ${signalField(s)}
          <div class="fields">
            <label>Traces endpoint<input name="otlpTraces" type="url" class="mono" value="${s.otlp?.traces ?? ''}" placeholder="Derived from the base"></label>
            <label>Metrics endpoint<input name="otlpMetrics" type="url" class="mono" value="${s.otlp?.metrics ?? ''}" placeholder="Derived from the base"></label>
            <label>Logs endpoint<input name="otlpLogs" type="url" class="mono" value="${s.otlp?.logs ?? ''}" placeholder="Derived from the base"></label>
          </div>
          <label>Headers<textarea name="otlpHeaders" class="mono" rows="3" placeholder="${hasOtlpHeaders ? 'Configured; leave blank to keep' : 'api-key=...'}"></textarea><small>One <span class="mono">key=value</span> per line, or comma-separated.</small></label>
          <label class="check"><input type="checkbox" name="clearOtlpHeaders"><span>Remove stored OTLP headers</span></label>`,
      )}

      ${settingsSection(
        'Datadog',
        'Native Datadog Logs and metrics intake. Traces use the OTLP section above.',
        html`<div class="fields">
            <label>API key<input name="datadogApiKey" type="password" autocomplete="new-password" placeholder="${hasDatadogKey ? 'Configured; leave blank to keep' : ''}"></label>
            <label>Site<input name="datadogSite" value="${s.datadog?.site ?? 'datadoghq.com'}" placeholder="datadoghq.com"></label>
          </div>
          <div class="fields">
            <label class="check"><input type="checkbox" name="datadogLogs" ${checked(s.datadog?.logs ?? true)}><span>Send logs</span></label>
            <label class="check"><input type="checkbox" name="datadogMetrics" ${checked(s.datadog?.metrics ?? true)}><span>Send metrics</span></label>
          </div>
          <label class="check"><input type="checkbox" name="clearDatadogKey"><span>Remove stored Datadog key</span></label>`,
      )}

      ${settingsSection(
        'PostHog',
        'Product analytics from document events, and server-side feature flags. Documents and response bodies are never sent.',
        html`<div class="fields">
            <label>Project API key<input name="posthogApiKey" type="password" autocomplete="new-password" placeholder="${hasPosthogKey ? 'Configured; leave blank to keep' : 'phc_...'}"></label>
            <label>Host<input name="posthogHost" type="url" class="mono" value="${s.posthog?.host ?? 'https://us.i.posthog.com'}"></label>
          </div>
          <div class="fields center">
            <label class="check"><input type="checkbox" name="posthogAnalytics" ${checked(s.posthog?.analytics ?? true)}><span>Send document analytics</span></label>
            <label class="check"><input type="checkbox" name="posthogFlags" ${checked(s.posthog?.flags ?? true)}><span>Evaluate feature flags</span></label>
            <label>Flag cache (seconds)<input name="posthogFlagsTtl" type="number" min="1" max="3600" value="${seconds(s.posthog?.flagsTtlMs ?? 30_000)}"></label>
          </div>
          <label class="check"><input type="checkbox" name="clearPosthogKey"><span>Remove stored PostHog key</span></label>`,
      )}

    </form>
    ${settingsSection(
      'Feature flags',
      'Local overrides win over PostHog. Each flag is saved immediately; the same values are returned by GET /v1/flags.',
      featureFlagsView(s.localFlags, {
        save: `${OBS_SETTINGS}/flags`,
        remove: `${OBS_SETTINGS}/flags/delete`,
        clear: `${OBS_SETTINGS}/flags/clear`,
      }, options.canManage),
      { id: 'feature-flags' },
    )}
    ${options.canManage ? pageFooter(null, 'Save settings', { form: 'observability-settings-form' }) : ''}
    ${options.overridden && options.canManage
      ? settingsSection(
          'Environment defaults',
          'Remove the console override and return to the values captured from the server environment at boot.',
          html`<div class="foot" style="justify-content:flex-start">${destroy(`${OBS_SETTINGS}/reset`, 'Reset to environment defaults', 'Reset every observability setting to the environment defaults?')}</div>`,
        )
      : ''}
    <p class="help">Console settings are stored in the control database and apply to every project. Environment variables remain the fallback.</p>`
}
