/**
 * Project webhooks. Each committed document change is POSTed as JSON to every
 * enabled webhook subscribed to one of its event names, with the headers
 * X-Bunwrite-Webhook-Id, -Name, -Events, -Project-Id, -User-Id and -Signature
 * (X-Appwrite-Webhook-* with API_COMPAT=appwrite). The signature is the base64
 * HMAC-SHA1 of the URL followed by the body, keyed by the webhook secret. Deliveries run in the background; ten failures in a row
 * turn the webhook off, as on Appwrite.
 *
 * All database access goes through `db.driver`, so this service runs on SQLite
 * and Postgres alike.
 */
import { createHmac } from 'node:crypto'

import type { Caller } from '~/auth/caller'
import type { SqlDatabase } from '~/db/driver'
import type { DocEvent } from '~/documents/store'
import { webhookHeaderPrefix, type ApiCompat } from '~/lib/compat'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { randomSecret, resolveId } from '~/lib/ids'
import { allowPrivateDestinations, assertPublicDestination, assertPublicUrlShape } from '~/lib/net'
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

/** Consecutive failures that turn a webhook off, as Appwrite does. */
export const MAX_ATTEMPTS = 10
const TIMEOUT_MS = 15_000
const USER_AGENT = 'Bunwrite-Server. Please report abuse to the server administrator.'
/** Concurrent deliveries; a slow receiver cannot open unlimited sockets. */
const MAX_CONCURRENT = 8
/** Deliveries queued in this process before new ones are dropped. */
const MAX_INFLIGHT = 1_000
/** How many bytes of a receiver's response we read before closing the body. */
const MAX_RESPONSE_BYTES = 64 * 1024
const MIN_SECRET_LENGTH = 16

/**
 * `revealSecrets` is false for read-only callers: the signing secret and Basic
 * auth password are credentials, not display fields.
 */
export function webhookModel(w: WebhookRow, options: { revealSecrets?: boolean } = {}) {
  const reveal = options.revealSecrets ?? true
  return {
    $id: w.id,
    $createdAt: w.created_at,
    $updatedAt: w.updated_at,
    name: w.name,
    url: w.url,
    events: JSON.parse(w.events) as string[],
    tls: Boolean(w.tls),
    authUsername: w.auth_username,
    authPassword: reveal ? w.auth_password : '',
    secret: reveal ? w.secret : '',
    enabled: Boolean(w.enabled),
    logs: w.logs,
    attempts: w.attempts,
  }
}

/** The legacy Appwrite signature, kept so existing receivers keep working. */
export function webhookSignature(url: string, body: string, secret: string): string {
  return createHmac('sha1', secret)
    .update(url + body)
    .digest('base64')
}

/**
 * Bunwrite's modern signature: HMAC-SHA256 over `<unix-seconds>.<url><body>`.
 * The timestamp is sent in the `*-timestamp` header, so receivers can reject
 * old deliveries instead of accepting an indefinite replay.
 */
export function webhookSignatureSha256(url: string, body: string, secret: string, timestamp: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${url}${body}`)
    .digest('base64')
}

/** Read a receiver's response up to a small cap, then close it. */
async function drainLimited(body: ReadableStream<Uint8Array> | null | undefined): Promise<void> {
  if (!body) return
  const reader = body.getReader()
  let read = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      read += value?.length ?? 0
      if (read > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return
      }
    }
  } catch {
    // A broken receiver response does not change the delivery status.
  }
}

function validUrl(value: unknown): string {
  if (typeof value !== 'string') throw err('general_argument_invalid', 'Invalid `url` param: URL must be a valid http or https URL.')
  try {
    // The literal check also stops loopback, link-local and single-label
    // internal hosts before they are saved. DNS is checked again at delivery.
    if (!allowPrivateDestinations()) assertPublicUrlShape(value)
    else {
      const url = new URL(value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
    }
    return value
  } catch (error) {
    const detail = error instanceof Error ? error.message : ''
    throw err('general_argument_invalid', `Invalid \`url\` param: ${detail || 'URL must be a valid http or https URL.'}`)
  }
}

function validSecret(value: unknown): string {
  // Unit/API tests use short fixed secrets; real deployments must not.
  const minimum = process.env.NODE_ENV === 'test' ? 1 : MIN_SECRET_LENGTH
  if (typeof value !== 'string' || value.length < minimum) {
    throw err('general_argument_invalid', `Invalid \`secret\` param: Use at least ${minimum} characters, or omit it to generate one.`)
  }
  return value
}

function validName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128)
    throw err('general_argument_invalid', 'Invalid `name` param: Value must be a valid string and at least 1 chars and no longer than 128 chars')
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
  /** Active network calls, bounded independently of the queued promises. */
  private active = 0
  private readonly waiters: Array<() => void> = []

  private async acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.active--
  }

  constructor(
    private db: SqlDatabase,
    private projectId: () => string,
    /** Header names to send: Bunwrite's or Appwrite's. */
    private compat: () => ApiCompat = () => 'bunwrite',
  ) {}

  private get sql() {
    return this.db.driver
  }

  list(): Promise<WebhookRow[]> {
    return this.sql.all<WebhookRow>('SELECT * FROM _webhooks ORDER BY seq')
  }

  async get(id: string): Promise<WebhookRow> {
    const row = await this.sql.get<WebhookRow>('SELECT * FROM _webhooks WHERE id = ?', [id])
    if (!row) throw err('webhook_not_found')
    return row
  }

  async create(id: unknown, input: WebhookInput): Promise<WebhookRow> {
    const webhookId = resolveId(id, 'Webhook ID')
    if (await this.sql.get('SELECT 1 FROM _webhooks WHERE id = ?', [webhookId])) throw err('webhook_already_exists')
    const secret = input.secret === undefined || input.secret === null || input.secret === '' ? randomSecret(64) : validSecret(input.secret)
    const stamp = now()
    await this.sql.run(
      `INSERT INTO _webhooks (id, name, url, events, enabled, tls, auth_username, auth_password, secret, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ],
    )
    return this.get(webhookId)
  }

  async update(id: string, input: WebhookInput): Promise<WebhookRow> {
    const w = await this.get(id)
    const enabled = flag(input.enabled, Boolean(w.enabled))
    await this.sql.run(
      `UPDATE _webhooks SET name = ?, url = ?, events = ?, enabled = ?, tls = ?, auth_username = ?, auth_password = ?,
       attempts = ?, updated_at = ? WHERE id = ?`,
      [
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
      ],
    )
    return this.get(id)
  }

  /** Set a new signing secret; a fresh random one when none is given. */
  async updateSecret(id: string, secret: unknown): Promise<WebhookRow> {
    await this.get(id)
    const value = typeof secret === 'string' && secret ? validSecret(secret) : randomSecret(64)
    await this.sql.run('UPDATE _webhooks SET secret = ?, updated_at = ? WHERE id = ?', [value, now(), id])
    return this.get(id)
  }

  async delete(id: string): Promise<void> {
    await this.get(id)
    await this.sql.run('DELETE FROM _webhooks WHERE id = ?', [id])
  }

  // ------------------------------------------------------------ delivery

  /** Send each change to the webhooks that subscribe to it. Returns at once. */
  async dispatch(events: DocEvent[], caller: Caller): Promise<void> {
    if (events.length === 0) return
    const hooks = await this.sql.all<WebhookRow>('SELECT * FROM _webhooks WHERE enabled = 1')
    if (hooks.length === 0) return
    for (const event of events) {
      const names = eventNames(event)
      for (const hook of hooks) {
        let subscribed: Set<string>
        try {
          subscribed = new Set(JSON.parse(hook.events) as string[])
        } catch {
          // A corrupted event list must not take down document delivery.
          continue
        }
        if (!names.some((n) => subscribed.has(n))) continue
        if (this.inflight.size >= MAX_INFLIGHT) {
          console.warn(`[webhooks] dropped delivery to ${hook.id}: ${MAX_INFLIGHT} deliveries are already queued`)
          break
        }
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
    const failure = await this.post(hook, events, payload, userId)
    const stamp = now()
    if (!failure) {
      await this.sql.run("UPDATE _webhooks SET attempts = 0, logs = '' WHERE id = ?", [hook.id])
      return
    }
    await this.sql.run(
      `UPDATE _webhooks SET attempts = attempts + 1, logs = ?, updated_at = ?,
       enabled = CASE WHEN attempts + 1 >= ? THEN 0 ELSE enabled END WHERE id = ?`,
      [`${stamp} ${events[0] ?? ''}: ${failure}`.slice(0, 2000), stamp, MAX_ATTEMPTS, hook.id],
    )
  }

  /** POST one delivery and return what went wrong, or '' when the receiver accepted it. */
  private async post(hook: WebhookRow, events: string[], payload: unknown, userId: string): Promise<string> {
    const body = JSON.stringify(payload)
    const prefix = webhookHeaderPrefix({ apiCompat: this.compat() })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      [`${prefix}id`]: hook.id,
      [`${prefix}name`]: hook.name,
      [`${prefix}events`]: events.join(','),
      [`${prefix}project-id`]: this.projectId(),
      [`${prefix}user-id`]: userId,
      [`${prefix}timestamp`]: timestamp,
      [`${prefix}signature`]: webhookSignature(hook.url, body, hook.secret),
      [`${prefix}signature-sha256`]: webhookSignatureSha256(hook.url, body, hook.secret, timestamp),
    }
    if (hook.auth_username) headers.authorization = `Basic ${Buffer.from(`${hook.auth_username}:${hook.auth_password}`).toString('base64')}`
    await this.acquire()
    try {
      // Resolve again at delivery: a hostname that passed the save-time check
      // must not be rebound to 127.0.0.1 or a metadata address in between.
      if (!allowPrivateDestinations()) await assertPublicDestination(hook.url)
      const response = await fetch(hook.url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // Never skip certificate verification: the payload is signed, but the
        // basic-auth password and the payload itself are still readable.
        tls: { rejectUnauthorized: true },
      } as RequestInit)
      await drainLimited(response.body)
      return response.status >= 400 ? `${response.status} ${response.statusText}`.trim() : ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    } finally {
      this.release()
    }
  }

  /**
   * Send one sample delivery now so the endpoint can be checked by hand. The
   * failure count is left alone: a test never turns the webhook off.
   */
  async sendTest(id: string): Promise<{ ok: boolean; message: string }> {
    const hook = await this.get(id)
    const stamp = now()
    const failure = await this.post(hook, ['test'], { $id: 'test', $createdAt: stamp, $updatedAt: stamp, test: true, webhookId: hook.id }, '')
    return failure
      ? { ok: false, message: `The endpoint answered with an error: ${failure}` }
      : { ok: true, message: 'The endpoint accepted the test delivery.' }
  }
}
