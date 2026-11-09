/**
 * Editable email templates for the emails a project sends, as in Appwrite's
 * Auth → Templates: a subject and an HTML message per template and locale,
 * with `{{variable}}` placeholders, and an optional sender and reply-to.
 *
 * Saved templates live in `_settings` (`emailTemplates`); a template nobody
 * changed uses the default below. A locale without its own template falls back
 * to its base language (`fr-ca` → `fr`) and then to English, the same chain
 * Appwrite uses. Variable values are HTML-escaped in the message and inserted
 * as plain text in the subject. The message is wrapped in a fixed layout, and
 * the plain-text part is made from the HTML.
 */
import type { Config } from '~/config'
import type { SqlDatabase } from '~/db/driver'
import { LOCALE_CODES } from '~/locale/data'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import type { Mail } from './mailer'

/** Templates this server sends, with Appwrite's IDs. */
export const TEMPLATE_IDS = ['verification', 'magicSession', 'recovery', 'otpSession', 'invitation', 'mfaChallenge'] as const
export type TemplateId = (typeof TEMPLATE_IDS)[number]

/** Appwrite templates for features this server does not have. */
const UNSENT_IDS = ['sessionAlert']

/** The locale used for new templates and the last fallback. */
export const TEMPLATE_LOCALE = 'en'

/** Every locale an email template can be written in, ordered as Appwrite lists them. */
export const TEMPLATE_LOCALES = LOCALE_CODES

export interface TemplateFields {
  subject: string
  message: string
  senderName: string
  senderEmail: string
  replyToEmail: string
  replyToName: string
}

export interface TemplateInfo {
  id: TemplateId
  name: string
  description: string
  variables: string[]
  /** Values used for the console preview. */
  sample: Record<string, string>
}

const paragraph = (inner: string) => `<p style="margin:0 0 16px">${inner}</p>`
const button = (label: string) =>
  `<p style="margin:24px 0"><a href="{{redirect}}" style="display:inline-block;background:#1a1a1a;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${label}</a></p>`
const signOff = paragraph('Thanks,<br>{{project}} team')

const DEFAULTS: Record<TemplateId, { subject: string; message: string }> = {
  verification: {
    subject: 'Account Verification for {{project}}',
    message: [
      paragraph('Hello {{user}},'),
      paragraph('Follow this link to verify your email address for <strong>{{project}}</strong>.'),
      button('Confirm email address'),
      paragraph("If you didn't ask to verify this address, you can ignore this message."),
      signOff,
    ].join('\n'),
  },
  magicSession: {
    subject: 'Sign in to {{project}}',
    message: [
      paragraph('Hello {{user}},'),
      paragraph('Click the button below to securely sign in to your <strong>{{project}}</strong> account. This link will expire in 1 hour.'),
      button('Sign in to {{project}}'),
      paragraph("If you didn't ask to sign in, you can ignore this message."),
      signOff,
    ].join('\n'),
  },
  recovery: {
    subject: 'Password Reset for {{project}}',
    message: [
      paragraph('Hello {{user}},'),
      paragraph('Follow this link to reset your <strong>{{project}}</strong> password.'),
      button('Reset password'),
      paragraph("If you didn't ask to reset your password, you can ignore this message."),
      signOff,
    ].join('\n'),
  },
  otpSession: {
    subject: 'OTP for {{project}} Login',
    message: [
      paragraph('Hello {{user}},'),
      paragraph(
        'Enter the following verification code when prompted to securely sign in to your <strong>{{project}}</strong> account. This code will expire in 15 minutes.',
      ),
      paragraph('<span style="font-size:28px;letter-spacing:6px;font-weight:700">{{otp}}</span>'),
      paragraph("If you didn't ask to sign in, you can ignore this message."),
      signOff,
    ].join('\n'),
  },
  invitation: {
    subject: 'Invitation to {{team}} Team at {{project}}',
    message: [
      paragraph('Hello {{user}},'),
      paragraph(
        'This mail was sent to you because <strong>{{owner}}</strong> invited you to become a member of the <strong>{{team}}</strong> team at <strong>{{project}}</strong>.',
      ),
      button('Accept invite to {{team}}'),
      paragraph('If you are not interested, you can ignore this message.'),
      signOff,
    ].join('\n'),
  },
  mfaChallenge: {
    subject: 'Your {{project}} console sign-in code',
    message: [
      paragraph('Hello {{user}},'),
      paragraph('Enter this code to finish signing in to the <strong>{{project}}</strong> console. It expires in 10 minutes.'),
      paragraph('<span style="font-size:28px;letter-spacing:6px;font-weight:700">{{otp}}</span>'),
      paragraph("If you didn't ask to sign in, change your password and ignore this message."),
      signOff,
    ].join('\n'),
  },
}

const SAMPLE_LINK = 'https://example.com/link?userId=user123&secret=sample'

export const TEMPLATES: TemplateInfo[] = [
  {
    id: 'verification',
    name: 'Verification',
    description: 'Sent when a user asks to verify their email address.',
    variables: ['user', 'project', 'redirect'],
    sample: { user: 'Ada Lovelace', redirect: SAMPLE_LINK },
  },
  {
    id: 'magicSession',
    name: 'Magic URL',
    description: 'Sent when a user signs in with a magic link.',
    variables: ['user', 'project', 'redirect', 'phrase'],
    sample: { user: 'Ada Lovelace', redirect: SAMPLE_LINK, phrase: '' },
  },
  {
    id: 'recovery',
    name: 'Reset password',
    description: 'Sent to users who forgot their password.',
    variables: ['user', 'project', 'redirect'],
    sample: { user: 'Ada Lovelace', redirect: SAMPLE_LINK },
  },
  {
    id: 'otpSession',
    name: 'OTP session',
    description: 'Sent to users who sign in with an email code.',
    variables: ['user', 'project', 'otp', 'phrase'],
    sample: { user: 'Ada Lovelace', otp: '123456', phrase: '' },
  },
  {
    id: 'invitation',
    name: 'Invite user',
    description: 'Sent when someone is invited to join a team.',
    variables: ['user', 'project', 'team', 'owner', 'redirect'],
    sample: { user: 'Ada Lovelace', team: 'Editors', owner: 'Grace Hopper', redirect: SAMPLE_LINK },
  },
  {
    id: 'mfaChallenge',
    name: 'Console MFA',
    description: 'Sign-in code for console admins.',
    variables: ['user', 'project', 'otp'],
    sample: { user: 'admin@example.com', otp: '123456' },
  },
]

export const templateInfo = (id: TemplateId) => TEMPLATES.find((t) => t.id === id)!

export function isTemplateId(id: string): id is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(id)
}

/** Validate a template ID from a request; Appwrite IDs this server never sends get their own message. */
export function templateIdParam(id: unknown): TemplateId {
  if (typeof id === 'string' && isTemplateId(id)) return id
  if (typeof id === 'string' && UNSENT_IDS.includes(id)) {
    throw err('general_argument_invalid', `The ${id} email is not sent by this server, so it has no template. Templates: ${TEMPLATE_IDS.join(', ')}.`)
  }
  throw err('general_argument_invalid', `Invalid \`templateId\` param: must be one of ${TEMPLATE_IDS.join(', ')}`)
}

export function isTemplateLocale(value: unknown): boolean {
  return typeof value === 'string' && LOCALE_CODES.some((locale) => locale.code === value)
}

/** A template locale from a request: an exact supported code, its base language, or English. Invalid values are refused. */
export function templateLocale(value: unknown, param = 'locale'): string {
  if (value === undefined || value === null || value === '') return TEMPLATE_LOCALE
  if (typeof value !== 'string') throw err('general_argument_invalid', `Invalid \`${param}\` param: Value must be a supported locale code`)
  const code = value.trim().toLowerCase().replace(/_/g, '-')
  if (isTemplateLocale(code)) return code
  const base = code.split('-')[0]!
  if (isTemplateLocale(base)) return base
  throw err('general_argument_invalid', `Invalid \`${param}\` param: Value must be a supported locale code`)
}

/** The console's lenient version: an unknown locale falls back to English instead of failing the page. */
export function normalizedTemplateLocale(value: unknown): string {
  try {
    return templateLocale(value)
  } catch {
    return TEMPLATE_LOCALE
  }
}

/** Exact locale, base language, then English: Appwrite's email-template fallback chain. */
export function templateLocaleChain(value: unknown): string[] {
  const exact = normalizedTemplateLocale(value)
  const base = exact.split('-')[0]!
  return [...new Set([exact, base, TEMPLATE_LOCALE].filter(isTemplateLocale))]
}

/** Kept for the Project API, which calls the parameter `locale`. */
export function localeParam(locale: unknown): string {
  return templateLocale(locale)
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!)

/** Replace `{{name}}` (spaces allowed inside the braces); unknown names are left as written. */
function fill(text: string, vars: Record<string, string>, escape: boolean): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? (escape ? escapeHtml(vars[name]!) : vars[name]!) : match,
  )
}

/** The frame every message sits in. */
export function emailLayout(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:24px 12px;background:#f4f4f5"><div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#27272a">${body}</div></body></html>`
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }

/** A readable plain-text version: links become "label: url", paragraphs and breaks become new lines. */
export function htmlToText(source: string): string {
  return source
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').trim()
      return text && text !== href ? `${text}: ${href}` : href
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e]!)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const FIELD_KEYS: readonly (keyof TemplateFields)[] = ['subject', 'message', 'senderName', 'senderEmail', 'replyToEmail', 'replyToName']

type SavedTemplate = Partial<TemplateFields> & { updatedAt?: string }
type Saved = Partial<Record<TemplateId, Partial<Record<string, SavedTemplate>>>>

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function savedEntry(record: Record<string, unknown>): SavedTemplate {
  const entry: SavedTemplate = {}
  for (const key of FIELD_KEYS) {
    const value = record[key]
    if (typeof value === 'string') entry[key] = value
  }
  if (typeof record.updatedAt === 'string') entry.updatedAt = record.updatedAt
  return entry
}

/**
 * Parse the settings row. The old on-disk shape stored one template per ID
 * (`{ verification: { subject, ... } }`); it is read as English so existing
 * installations keep their customization after this upgrade.
 */
function parseSaved(value: unknown): Saved {
  const saved: Saved = {}
  const root = recordOf(value)
  if (!root) return saved
  for (const [id, raw] of Object.entries(root)) {
    if (!isTemplateId(id)) continue
    const record = recordOf(raw)
    if (!record) continue
    if (FIELD_KEYS.some((key) => key in record)) {
      saved[id] = { [TEMPLATE_LOCALE]: savedEntry(record) }
      continue
    }
    const locales: Partial<Record<string, SavedTemplate>> = {}
    for (const [locale, entry] of Object.entries(record)) {
      if (!isTemplateLocale(locale)) continue
      const parsed = recordOf(entry)
      if (parsed) locales[locale] = savedEntry(parsed)
    }
    if (Object.keys(locales).length) saved[id] = locales
  }
  return saved
}

export class EmailTemplateService {
  /** Parsed `emailTemplates` row; reads stay synchronous so render() can stay sync. */
  private cache: Saved | null = null

  constructor(
    private db: SqlDatabase,
    private config: Config,
  ) {
    if (db.dialect === 'sqlite') this.loadSync()
  }

  private parse(row: { value: string } | null): Saved {
    if (!row) return {}
    try {
      return parseSaved(JSON.parse(row.value))
    } catch {
      return {}
    }
  }

  private loadSync(): void {
    this.cache = this.parse(
      this.db.sqlite!.query<{ value: string }, [string]>('SELECT value FROM _settings WHERE key = ?').get('emailTemplates') ?? null,
    )
  }

  /** Load the templates on a network backend; the boot path awaits this. */
  async load(): Promise<void> {
    this.cache = this.parse(await this.db.driver.get<{ value: string }>('SELECT value FROM _settings WHERE key = ?', ['emailTemplates']))
  }

  private saved(): Saved {
    return this.cache ?? {}
  }

  private async write(saved: Saved): Promise<void> {
    await this.db.driver.run(
      "INSERT INTO _settings (key, value, updated_at) VALUES ('emailTemplates', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [JSON.stringify(saved), now()],
    )
    this.cache = saved
  }

  private entry(id: TemplateId, locale: unknown): SavedTemplate | null {
    const locales = this.saved()[id]
    if (!locales) return null
    for (const code of templateLocaleChain(locale)) {
      const entry = locales[code]
      if (entry) return entry
    }
    return null
  }

  /** Whether the template was changed in any language. */
  customized(id: TemplateId): boolean {
    return Object.keys(this.saved()[id] ?? {}).length > 0
  }

  /** Whether this exact language has its own saved template. */
  translated(id: TemplateId, locale: unknown): boolean {
    return Boolean(this.saved()[id]?.[normalizedTemplateLocale(locale)])
  }

  /** Languages this template was translated into. */
  locales(id: TemplateId): string[] {
    return Object.keys(this.saved()[id] ?? {})
  }

  get(id: TemplateId, locale: unknown = TEMPLATE_LOCALE): TemplateFields {
    const custom = this.entry(id, locale) ?? {}
    return {
      subject: custom.subject || DEFAULTS[id].subject,
      message: custom.message || DEFAULTS[id].message,
      senderName: custom.senderName ?? '',
      senderEmail: custom.senderEmail ?? '',
      replyToEmail: custom.replyToEmail ?? '',
      replyToName: custom.replyToName ?? '',
    }
  }

  defaults(id: TemplateId): TemplateFields {
    return { ...DEFAULTS[id], senderName: '', senderEmail: '', replyToEmail: '', replyToName: '' }
  }

  /** Custom templates for every language, as the Project API lists them. */
  allCustom(): { id: TemplateId; locale: string; fields: TemplateFields }[] {
    const out: { id: TemplateId; locale: string; fields: TemplateFields }[] = []
    for (const id of TEMPLATE_IDS) {
      for (const locale of this.locales(id)) out.push({ id, locale, fields: this.get(id, locale) })
    }
    return out
  }

  /**
   * Save the fields given for one language; others keep their current value.
   * Saving the default fields back clears that language's customization.
   */
  async update(id: TemplateId, locale: unknown, input: Partial<Record<keyof TemplateFields, unknown>>): Promise<TemplateFields> {
    const code = templateLocale(locale)
    const next = { ...this.get(id, code) }
    for (const key of FIELD_KEYS) {
      const value = input[key]
      if (value === undefined || value === null) continue
      if (typeof value !== 'string') throw err('general_argument_invalid', `Invalid \`${key}\` param: Value must be a valid string`)
      next[key] = value.trim() === '' && (key === 'subject' || key === 'message') ? DEFAULTS[id][key] : value
    }
    validate(next)
    const saved = { ...this.saved() }
    const locales = { ...saved[id] }
    const isDefault = FIELD_KEYS.every((key) => next[key] === this.defaults(id)[key])
    if (isDefault) delete locales[code]
    else locales[code] = { ...next, updatedAt: now() }
    if (Object.keys(locales).length) saved[id] = locales
    else delete saved[id]
    await this.write(saved)
    return this.get(id, code)
  }

  /** Reset only this language; other translations stay. */
  async reset(id: TemplateId, locale: unknown = TEMPLATE_LOCALE): Promise<TemplateFields> {
    const code = templateLocale(locale)
    const saved = { ...this.saved() }
    const locales = { ...saved[id] }
    delete locales[code]
    if (Object.keys(locales).length) saved[id] = locales
    else delete saved[id]
    await this.write(saved)
    return this.get(id, code)
  }

  /**
   * The finished email. `project` is filled in from the project name; a
   * security phrase is added after the message when the template has no
   * `{{phrase}}` of its own, so sign-in codes keep it.
   */
  render(
    id: TemplateId,
    to: string,
    vars: Record<string, string>,
    options: { locale?: string; fields?: TemplateFields } = {},
  ): Mail {
    const fields = options.fields ?? this.get(id, options.locale)
    const values: Record<string, string> = { project: this.config.projectName, ...vars }
    let body = fill(fields.message, values, true)
    if (values.phrase && !/\{\{\s*phrase\s*\}\}/.test(fields.message)) {
      body += paragraph(
        `Security phrase for this email is <strong>${escapeHtml(values.phrase)}</strong>. You can trust this email if this phrase matches the phrase shown during sign in.`,
      )
    }
    const mail: Mail = {
      to,
      subject: fill(fields.subject, values, false).replace(/[\r\n]+/g, ' '),
      html: emailLayout(body),
      text: htmlToText(body),
    }
    if (fields.senderEmail) mail.from = { name: fields.senderName || this.config.smtp?.senderName || '', address: fields.senderEmail }
    else if (fields.senderName) mail.from = { name: fields.senderName, address: this.config.smtp?.senderEmail ?? '' }
    if (fields.replyToEmail) mail.replyTo = { name: fields.replyToName, address: fields.replyToEmail }
    return mail
  }

  /** The console preview: the template filled with sample values. */
  preview(id: TemplateId, fields: TemplateFields, locale: unknown = TEMPLATE_LOCALE): Mail {
    return this.render(id, 'preview@example.com', templateInfo(id).sample, { locale: normalizedTemplateLocale(locale), fields })
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validate(t: TemplateFields): void {
  if (t.subject.length > 255) throw err('general_argument_invalid', 'Invalid `subject` param: Value must be a valid string and no longer than 255 chars')
  if (t.message.length > 10_000_000) throw err('general_argument_invalid', 'Invalid `message` param: the message is too long.')
  if (t.senderName.length > 255 || t.replyToName.length > 255) throw err('general_argument_invalid', 'Sender and reply-to names must be 255 characters or less.')
  if (t.senderEmail && !EMAIL.test(t.senderEmail)) throw err('general_argument_invalid', 'Invalid `senderEmail` param: Value must be a valid email address')
  if (t.replyToEmail && !EMAIL.test(t.replyToEmail)) throw err('general_argument_invalid', 'Invalid `replyToEmail` param: Value must be a valid email address')
}
