/**
 * Project webhooks. Each committed document change is POSTed as JSON to every
 * enabled webhook subscribed to one of its event names, with the headers
 * X-Bunwrite-Webhook-Id, -Name, -Events, -Project-Id, -User-Id and -Signature
 * (X-Appwrite-Webhook-* with API_COMPAT=appwrite). The signature is the base64
 * HMAC-SHA1 of the URL followed by the body, keyed by the webhook secret. Deliveries run in the background; ten failures in a row
 * turn the webhook off, as on Appwrite.
 */
import { createHmac } from 'node:crypto'

import type { Caller } from '~/auth/caller'
import type { Db } from '~/db/connection'
import type { DocEvent } from '~/documents/store'
import { webhookHeaderPrefix, type ApiCompat } from '~/lib/compat'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { randomSecret, resolveId } from '~/lib/ids'
import { eventNames } from '~/realtime/hub'

export interface WebhookRow {
  id: string
  name: string
  url: string
  events: string
  enabled: number
  tls: number
  auth_username: string
  auth_password: string
  secret: string
  logs: string
  attempts: number
  created_at: string
  updated_at: string
}

export interface WebhookInput {
  name?: unknown
  url?: unknown
  events?: unknown
  enabled?: unknown
  tls?: unknown
  authUsername?: unknown
  authPassword?: unknown
  secret?: unknown
}

const MAX_ATTEMPTS = 10
const TIMEOUT_MS = 15_000
const USER_AGENT = 'Bunwrite-Server. Please report abuse to the server administrator.'

export function webhookModel(w: WebhookRow) {
  return {
    $id: w.id,
    $createdAt: w.created_at,
    $updatedAt: w.updated_at,
    name: w.name,
    url: w.url,
    events: JSON.parse(w.events) as string[],
    tls: Boolean(w.tls),
    authUsername: w.auth_username,
    authPassword: w.auth_password,
    secret: w.secret,
    enabled: Boolean(w.enabled),
    logs: w.logs,
    attempts: w.attempts,
  }
}

/** The signature Appwrite sends, so receivers can reuse their check. */
export function webhookSignature(url: string, body: string, secret: string): string {
  return createHmac('sha1', secret).update(url + body).digest('base64')
}

function validUrl(value: unknown): string {
  if (typeof value !== 'string') throw err('general_argument_invalid', 'Invalid `url` param: URL must be a valid http or https URL.')
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
    return value
  } catch {
    throw err('general_argument_invalid', 'Invalid `url` param: URL must be a valid http or https URL.')
  }
}

function validName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw err('general_argument_invalid', 'Invalid `name` param: Value must be a valid string and at least 1 chars and no longer than 128 chars')
  return value
}

function validEvents(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((e) => typeof e !== 'string' || !/^[a-zA-Z0-9_.*-]{1,256}$/.test(e))) {
    throw err('general_argument_invalid', 'Invalid `events` param: Value must be a valid array of up to 100 event names.')
  }
  return [...new Set(value as string[])]
}

const flag = (value: unknown, fallback: boolean) => (value === undefined || value === null ? fallback : Boolean(value))
const text = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback)

export class WebhookService {
  /** Deliveries still in flight; tests and shutdown can wait on them. */
  private inflight = new Set<Promise<void>>()

  constructor(
    private db: Db,
    private projectId: () => string,
    /** Header names to send: Bunwrite's or Appwrite's. */
    private compat: () => ApiCompat = () => 'bunwrite',
  ) {}

  private get sql() {
    return this.db.sqlite
  }

  list(): WebhookRow[] {
    return this.sql.query<WebhookRow, []>('SELECT * FROM _webhooks ORDER BY seq').all()
  }

  get(id: string): WebhookRow {
    const row = this.sql.query<WebhookRow, [string]>('SELECT * FROM _webhooks WHERE id = ?').get(id)
    if (!row) throw err('webhook_not_found')
    return row
  }

  create(id: unknown, input: WebhookInput): WebhookRow {
    const webhookId = resolveId(id, 'Webhook ID')
    if (this.sql.query('SELECT 1 FROM _webhooks WHERE id = ?').get(webhookId)) throw err('webhook_already_exists')
    const secret = input.secret === undefined || input.secret === null || input.secret === '' ? randomSecret(64) : text(input.secret, '')
    const stamp = now()
    this.sql
      .query(
        `INSERT INTO _webhooks (id, name, url, events, enabled, tls, auth_username, auth_password, secret, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        webhookId,
        validName(input.name),
        validUrl(input.url),
        JSON.stringify(validEvents(input.events)),
        flag(input.enabled, true) ? 1 : 0,
        flag(input.tls, true) ? 1 : 0,
        text(input.authUsername, ''),
        text(input.authPassword, ''),
        secret,
        stamp,
        stamp,
      )
    return this.get(webhookId)
  }

  update(id: string, input: WebhookInput): WebhookRow {
    const w = this.get(id)
    const enabled = flag(input.enabled, Boolean(w.enabled))
    this.sql
      .query(
        `UPDATE _webhooks SET name = ?, url = ?, events = ?, enabled = ?, tls = ?, auth_username = ?, auth_password = ?,
         attempts = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.name === undefined ? w.name : validName(input.name),
        input.url === undefined ? w.url : validUrl(input.url),
        input.events === undefined ? w.events : JSON.stringify(validEvents(input.events)),
        enabled ? 1 : 0,
        flag(input.tls, Boolean(w.tls)) ? 1 : 0,
        text(input.authUsername, w.auth_username),
        text(input.authPassword, w.auth_password),
        // Turning a webhook back on gives it a fresh set of attempts.
        enabled && !w.enabled ? 0 : w.attempts,
        now(),
        id,
      )
    return this.get(id)
  }

  /** Set a new signing secret; a fresh random one when none is given. */
  updateSecret(id: string, secret: unknown): WebhookRow {
    this.get(id)
    const value = typeof secret === 'string' && secret ? secret : randomSecret(64)
    this.sql.query('UPDATE _webhooks SET secret = ?, updated_at = ? WHERE id = ?').run(value, now(), id)
    return this.get(id)
  }

  delete(id: string): void {
    this.get(id)
    this.sql.query('DELETE FROM _webhooks WHERE id = ?').run(id)
  }

  // ------------------------------------------------------------ delivery

  /** Send each change to the webhooks that subscribe to it. Returns at once. */
  dispatch(events: DocEvent[], caller: Caller): void {
    if (events.length === 0) return
    const hooks = this.sql.query<WebhookRow, []>('SELECT * FROM _webhooks WHERE enabled = 1').all()
    if (hooks.length === 0) return
    for (const event of events) {
      const names = eventNames(event)
      for (const hook of hooks) {
        const subscribed = new Set(JSON.parse(hook.events) as string[])
        if (!names.some((n) => subscribed.has(n))) continue
        const delivery = this.deliver(hook, names, event.document, caller.user?.id ?? '').finally(() => this.inflight.delete(delivery))
        this.inflight.add(delivery)
      }
    }
  }

  /** Wait until every delivery started so far has finished. */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight])
  }

  private async deliver(hook: WebhookRow, events: string[], payload: unknown, userId: string): Promise<void> {
    const body = JSON.stringify(payload)
    const prefix = webhookHeaderPrefix({ apiCompat: this.compat() })
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      [`${prefix}id`]: hook.id,
      [`${prefix}name`]: hook.name,
      [`${prefix}events`]: events.join(','),
      [`${prefix}project-id`]: this.projectId(),
      [`${prefix}user-id`]: userId,
      [`${prefix}signature`]: webhookSignature(hook.url, body, hook.secret),
    }
    if (hook.auth_username) headers.authorization = `Basic ${Buffer.from(`${hook.auth_username}:${hook.auth_password}`).toString('base64')}`
    let failure = ''
    try {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        tls: { rejectUnauthorized: Boolean(hook.tls) },
      } as RequestInit)
      await response.arrayBuffer().catch(() => undefined)
      if (response.status >= 400) failure = `${response.status} ${response.statusText}`.trim()
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    const stamp = now()
    if (!failure) {
      this.sql.query("UPDATE _webhooks SET attempts = 0, logs = '' WHERE id = ?").run(hook.id)
      return
    }
    this.sql
      .query(
        `UPDATE _webhooks SET attempts = attempts + 1, logs = ?, updated_at = ?,
         enabled = CASE WHEN attempts + 1 >= ? THEN 0 ELSE enabled END WHERE id = ?`,
      )
      .run(`${stamp} ${events[0] ?? ''}: ${failure}`.slice(0, 2000), stamp, MAX_ATTEMPTS, hook.id)
  }
}
