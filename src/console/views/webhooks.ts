/**
 * Webhooks page markup. The page loads data and validates writes; this module
 * renders it.
 */
import type { ConsoleContext } from '~/console/context'
import { dialog } from '~/console/dialog'
import { html, type Html } from '~/console/html'
import { alert, badge, destroy, emptyState, header, icon, pageFooter, settingsSection, tabs, when } from '~/console/ui'
import { webhookHeaderPrefix } from '~/lib/compat'
import type { WebhookRow } from '~/webhooks/service'

export const WEBHOOKS = '/console/webhooks'
export const webhookUrl = (id: string) => `${WEBHOOKS}/${encodeURIComponent(id)}`

export type WebhookTab = 'deliveries' | 'settings'

/** What a form shows before it is saved: the stored webhook, or the values just typed. */
export interface WebhookDraft {
  id?: string
  name: string
  url: string
  events: string[]
  enabled: boolean
  tls: boolean
  authUsername: string
}

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

export function draftOf(w: WebhookRow): WebhookDraft {
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    events: JSON.parse(w.events) as string[],
    enabled: Boolean(w.enabled),
    tls: Boolean(w.tls),
    authUsername: w.auth_username,
  }
}

function statusOf(w: WebhookRow): Html {
  if (!w.enabled) return w.attempts >= 10 ? badge('Off after failures', 'critical') : badge('Disabled')
  return w.attempts > 0 ? badge('Failing', 'attention') : badge('Enabled', 'success')
}

interface EventChoice {
  value: string
  label: string
}

interface EventGroup {
  label: Html
  choices: EventChoice[]
  open?: boolean
}

const ACTIONS = ['create', 'update', 'delete'] as const

/** Any change plus one checkbox per document action, for a `databases.<db>.collections.<id>.documents` base. */
function choicesFor(base: string): EventChoice[] {
  return [
    { value: `${base}.*`, label: 'Any change' },
    ...ACTIONS.map((action) => ({
      value: `${base}.*.${action}`,
      label: action === 'create' ? 'Created' : action === 'update' ? 'Updated' : 'Deleted',
    })),
  ]
}

/**
 * The events this schema can raise, as checkboxes: everything, each database and
 * each collection. `*` matches any part, just as it does in Appwrite.
 */
function eventGroups(ctx: ConsoleContext): EventGroup[] {
  const groups: EventGroup[] = [
    {
      label: html`All databases and collections`,
      choices: choicesFor('databases.*.collections.*.documents'),
      open: true,
    },
  ]
  const collections = ctx.schema.collectionDefinitions()
  for (const database of ctx.services.registry.databases.values()) {
    groups.push({
      label: html`Database <span class="mono">${database.id}</span> <span class="subdued">${database.name}</span>`,
      choices: choicesFor(`databases.${database.id}.collections.*.documents`),
    })
    for (const collection of collections.filter((c) => c.databaseId === database.id)) {
      groups.push({
        label: html`<span class="mono">${database.id}/${collection.$id}</span> <span class="subdued">${collection.name}</span>`,
        choices: choicesFor(`databases.${database.id}.collections.${collection.$id}.documents`),
      })
    }
  }
  return groups
}

/** Checkboxes for the known events, plus a textarea for patterns the list cannot express. */
function eventPicker(ctx: ConsoleContext, selected: Set<string>): Html {
  const groups = eventGroups(ctx)
  const known = new Set(groups.flatMap((group) => group.choices.map((choice) => choice.value)))
  const custom = [...selected].filter((event) => !known.has(event))
  return html`<p class="hint">Pick the document changes to receive. Appwrite sends one POST per change per matching event.</p>
    ${groups.map(
      (group) => html`<details class="disclosure" ${group.open ? html`open` : ''}>
        <summary>${group.label} <span class="subdued">${plural(group.choices.length, 'event')}</span></summary>
        <div class="fields">${group.choices.map(
          (choice) => html`<label class="check"><input type="checkbox" name="events" value="${choice.value}" ${selected.has(choice.value) ? 'checked' : ''}>${choice.label}<small class="mono">${choice.value}</small></label>`,
        )}</div>
      </details>`,
    )}
    <label style="margin-top:16px">Other events<textarea name="customEvents" class="mono" rows="3" spellcheck="false" placeholder="databases.main.collections.notes.documents.*.update">${custom.join('\n')}</textarea><small>One per line, for patterns the list above does not cover. Comma-separated works too.</small></label>`
}

function generalFields(draft: WebhookDraft, hasPassword: boolean, idField?: Html): Html {
  return html`<label>Name<input name="name" value="${draft.name}" required ${idField ? html`data-slug-source autofocus` : ''}></label>
    ${idField ?? ''}
    <label>Endpoint URL<input name="url" type="url" class="mono" value="${draft.url}" required placeholder="https://example.com/webhooks/appwrite"><small>http or https. Deliveries time out after 15 seconds.</small></label>
    <label class="check"><input type="checkbox" name="enabled" ${draft.enabled ? 'checked' : ''}><span>Send deliveries</span><small>Turning it back on resets the failure count.</small></label>
    <label class="check"><input type="checkbox" name="tls" ${draft.tls ? 'checked' : ''}><span>Verify the receiver's TLS certificate</span><small>Turn off only when the receiver uses a self-signed certificate.</small></label>
    <div class="fields"><label>Basic auth username<input name="authUsername" value="${draft.authUsername}" autocomplete="off"></label><label>Basic auth password<input name="authPassword" type="password" placeholder="${hasPassword ? 'Unchanged' : ''}" autocomplete="new-password"></label></div>
    <p class="help">Basic auth is sent as an <span class="mono">Authorization</span> header. Leave both empty for none.</p>`
}

export function webhooksView(ctx: ConsoleContext): Html {
  const hooks = ctx.services.webhooks.list()
  const create = html`<a class="btn primary" href="${WEBHOOKS}/new">${icon('plus')}<span>Create webhook</span></a>`
  return html`${header('Webhooks', { actions: hooks.length ? create : undefined })}
    <div class="card flush">
      ${hooks.length
        ? html`<div class="scroll"><table><thead><tr><th>Webhook</th><th class="hide-sm">Endpoint</th><th class="num">Events</th><th class="num">Failures</th><th>Status</th></tr></thead><tbody>
          ${hooks.map((hook) => {
            const events = JSON.parse(hook.events) as string[]
            return html`<tr class="row-link" onclick="location='${webhookUrl(hook.id)}'">
              <td><a href="${webhookUrl(hook.id)}">${hook.name}</a><div class="mono subdued cell-sub">${hook.id}</div></td>
              <td class="hide-sm mono clip subdued">${hook.url}</td>
              <td class="num">${events.length}</td>
              <td class="num">${hook.attempts}</td>
              <td>${statusOf(hook)}</td></tr>`
          })}
          </tbody></table></div>`
        : emptyState('No webhooks yet', 'Webhooks POST document changes to a URL you control, outside the app.', create)}
    </div>`
}

export function webhookCreateView(ctx: ConsoleContext, options: { draft?: WebhookDraft; error?: string } = {}): Html {
  const draft = options.draft ?? { name: '', url: '', events: [], enabled: true, tls: true, authUsername: '' }
  return html`${header('Create webhook', { back: WEBHOOKS })}
    ${options.error ? alert('critical', html`${options.error}`) : ''}
    <form method="post" action="${WEBHOOKS}">
      ${settingsSection(
        'General',
        'The name shown here, and the URL that receives each document change.',
        html`${generalFields(
          draft,
          false,
          html`<label>ID<input name="id" value="${draft.id ?? ''}" class="mono" data-slug-from="name" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}" placeholder="Generated if empty"><small>At most 36 characters. Filled in from the name; it cannot change later.</small></label>`,
        )}`,
      )}
      ${settingsSection(
        'Events',
        'Choose the document changes to receive. Webhooks fire for document events only.',
        eventPicker(ctx, new Set(draft.events)),
      )}
      ${settingsSection(
        'Security',
        'The secret receivers use to verify each delivery.',
        html`<label>Signing secret<input name="secret" type="password" autocomplete="new-password" placeholder="Generated if empty"><small>A random 128-character secret is made when this is empty.</small></label>`,
      )}
      ${pageFooter(WEBHOOKS, 'Create webhook')}
    </form>`
}

function deliveriesView(w: WebhookRow, h: string): Html {
  const events = JSON.parse(w.events) as string[]
  const stopped = !w.enabled && w.attempts >= 10
  return html`
    ${stopped ? alert('critical', html`Deliveries stopped after 10 failures in a row. Turn the webhook back on in <a href="${webhookUrl(w.id)}/settings">Settings</a>; saving resets the count.`) : ''}
    ${!w.enabled && !stopped ? alert('info', html`This webhook is off, so nothing is sent. Turn it on in <a href="${webhookUrl(w.id)}/settings">Settings</a>.`) : ''}
    ${settingsSection(
      'Status',
      'Deliveries run in the background and never hold up the API request that changed a document.',
      html`<ul class="list">
        <li><span class="subdued">Delivery</span><span>${statusOf(w)}</span></li>
        <li><span class="subdued">Failures in a row</span><span>${w.attempts} of 10</span></li>
        <li><span class="subdued">Last updated</span><span>${when(w.updated_at)}</span></li>
        <li><span class="subdued">Created</span><span>${when(w.created_at)}</span></li>
      </ul>`,
    )}
    ${settingsSection(
      'Last failed delivery',
      'A successful delivery clears the count and this message. Ten failures in a row turn the webhook off.',
      w.logs ? html`<pre>${w.logs}</pre>` : html`<p class="subdued" style="margin:0">No failed deliveries. The endpoint has accepted every recent delivery.</p>`,
    )}
    ${settingsSection(
      'Events',
      `Any document change that matches an event below is sent to ${w.url}.`,
      events.length
        ? html`<ul class="list">${events.map((event) => html`<li><span class="mono">${event}</span></li>`)}</ul>`
        : html`<p class="hint" style="margin:0">No events selected, so nothing is delivered. <a href="${webhookUrl(w.id)}/settings">Choose events</a>.</p>`,
    )}
    ${settingsSection(
      'The request',
      h === 'X-Appwrite-Webhook'
        ? 'Appwrite-compatible headers (API_COMPAT=appwrite), so a receiver written for Appwrite works unchanged.'
        : 'Bunwrite headers. Set API_COMPAT=appwrite in the server environment to send Appwrite\'s instead.',
      html`<ul class="list">
        <li><span class="subdued">Method and body</span><span><span class="mono">POST</span> with the document as JSON</span></li>
        <li><span class="subdued">Signature</span><span class="mono">${h}-Signature</span></li>
        <li><span class="subdued">Webhook</span><span class="mono">${h}-Id</span>, <span class="mono">-Name</span></span></li>
        <li><span class="subdued">Events</span><span class="mono">${h}-Events</span></li>
        <li><span class="subdued">Project and user</span><span class="mono">${h}-Project-Id</span>, <span class="mono">-User-Id</span></span></li>
      </ul>
      <p class="help">The signature is the base64 HMAC-SHA1 of the URL followed by the raw body, keyed by the signing secret.</p>`,
    )}`
}

function secretSection(w: WebhookRow, h: string): Html {
  return settingsSection(
    'Signing secret',
    `Receivers check ${h}-Signature with this secret. Rotate it if it may have leaked; deliveries fail verification until the receiver is updated.`,
    html`<label>Secret<div class="copy-row"><input id="webhook-secret" type="password" class="mono" readonly value="${w.secret}" autocomplete="off"><button type="button" data-copy-target="#webhook-secret">${icon('copy')}<span data-copy-label>Copy</span></button></div><small>Stored with this project. Copy it into the receiver's configuration.</small></label>
      <form method="post" action="${webhookUrl(w.id)}/secret" class="foot" data-confirm="Replace the signing secret? Deliveries fail verification until the receiver is updated." data-confirm-label="Rotate secret">
        <button>Rotate secret</button>
      </form>`,
  )
}

export function webhookView(
  ctx: ConsoleContext,
  w: WebhookRow,
  tab: WebhookTab,
  options: { draft?: WebhookDraft; error?: string; secret?: string } = {},
): Html {
  const draft = options.draft ?? draftOf(w)
  const base = webhookUrl(w.id)
  // `X-Bunwrite-Webhook` or `X-Appwrite-Webhook`, as deliveries carry them.
  const h = webhookHeaderPrefix(ctx.services.config).slice(0, -1).replace(/(^|-)([a-z])/g, (_, d: string, c: string) => d + c.toUpperCase())
  const body =
    tab === 'deliveries'
      ? deliveriesView(w, h)
      : html`
        ${settingsSection(
          'General',
          'Where deliveries go, and whether the receiver must present a valid certificate.',
          html`<form method="post" action="${base}/settings">${generalFields(draft, Boolean(w.auth_password))}<div class="foot"><button class="primary">Save</button></div></form>`,
        )}
        ${settingsSection(
          'Events',
          'Document changes that trigger a delivery. Pick from the schema or enter a pattern by hand.',
          html`<form method="post" action="${base}/events">${eventPicker(ctx, new Set(draft.events))}<div class="foot"><button class="primary">Save events</button></div></form>`,
        )}
        ${secretSection(w, h)}
        ${settingsSection(
          'Delete webhook',
          'Stops deliveries and removes the webhook. This cannot be undone.',
          html`<p class="hint" style="margin:0 0 12px">${w.name} will stop receiving document events.</p>${destroy(`${base}/delete`, 'Delete webhook', `Delete ${w.name}?`)}`,
        )}`
  return html`${header(w.name, { back: WEBHOOKS })}
    ${tabs(
      [
        { key: 'deliveries', label: 'Deliveries', href: base },
        { key: 'settings', label: 'Settings', href: `${base}/settings` },
      ],
      tab,
    )}
    ${options.error ? alert('critical', html`${options.error}`) : ''}
    ${body}
    ${options.secret ? secretDialog(options.secret) : ''}`
}

function secretDialog(secret: string): Html {
  return dialog({
    id: 'webhook-secret-dialog',
    title: 'New signing secret',
    open: true,
    body: html`<p class="dialog-message">Update the receiver before the next delivery. The old secret stops working now.</p>
      <label>Secret<input id="webhook-secret-value" class="mono" readonly autocomplete="off" spellcheck="false" value="${secret}"></label>`,
    actions: html`<button type="button" data-copy-target="#webhook-secret-value">${icon('copy')}<span data-copy-label>Copy secret</span></button><button type="button" class="primary" data-dialog-close>Done</button>`,
  })
}
