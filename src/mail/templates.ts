/**
 * Editable email templates for the emails a project sends, as in Appwrite's
 * Auth → Templates: a subject and an HTML message per template, with
 * `{{variable}}` placeholders, and an optional sender and reply-to.
 *
 * Saved templates live in `_settings` (`emailTemplates`); a template nobody
 * changed uses the default below. Variable values are HTML-escaped in the
 * message and inserted as plain text in the subject. The message is wrapped
 * in a fixed layout, and the plain-text part is made from the HTML.
 */
import type { Config } from '~/config'
import type { Db } from '~/db/connection'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import type { Mail } from './mailer'

/** Templates this server sends, with Appwrite's IDs. */
export const TEMPLATE_IDS = ['verification', 'recovery', 'otpSession', 'invitation'] as const
export type TemplateId = (typeof TEMPLATE_IDS)[number]

/** Appwrite templates for features this server does not have. */
const UNSENT_IDS = ['magicSession', 'mfaChallenge', 'sessionAlert']

/** Only English is sent; other locales are refused rather than silently ignored. */
export const TEMPLATE_LOCALE = 'en'

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
      paragraph('Enter the following verification code when prompted to securely sign in to your <strong>{{project}}</strong> account. This code will expire in 15 minutes.'),
      paragraph('<span style="font-size:28px;letter-spacing:6px;font-weight:700">{{otp}}</span>'),
      paragraph("If you didn't ask to sign in, you can ignore this message."),
      signOff,
    ].join('\n'),
  },
  invitation: {
    subject: 'Invitation to {{team}} Team at {{project}}',
    message: [
      paragraph('Hello {{user}},'),
      paragraph('This mail was sent to you because <strong>{{owner}}</strong> invited you to become a member of the <strong>{{team}}</strong> team at <strong>{{project}}</strong>.'),
      button('Accept invite to {{team}}'),
      paragraph('If you are not interested, you can ignore this message.'),
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

export function localeParam(locale: unknown): string {
  if (locale === undefined || locale === null || locale === '' || locale === TEMPLATE_LOCALE) return TEMPLATE_LOCALE
  throw err('general_argument_invalid', `Only the "${TEMPLATE_LOCALE}" locale is supported for email templates.`)
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

type Saved = Partial<Record<TemplateId, Partial<TemplateFields> & { updatedAt?: string }>>

export class EmailTemplateService {
  constructor(
    private db: Db,
    private config: Config,
  ) {}

  private saved(): Saved {
    const row = this.db.sqlite.query<{ value: string }, [string]>('SELECT value FROM _settings WHERE key = ?').get('emailTemplates')
    return row ? (JSON.parse(row.value) as Saved) : {}
  }

  private write(saved: Saved): void {
    this.db.sqlite
      .query("INSERT INTO _settings (key, value, updated_at) VALUES ('emailTemplates', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(JSON.stringify(saved), now())
  }

  /** Whether the template was changed from its default. */
  customized(id: TemplateId): boolean {
    return Boolean(this.saved()[id])
  }

  get(id: TemplateId): TemplateFields {
    const custom = this.saved()[id] ?? {}
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

  /** Save the fields given; others keep their current value. Saving the defaults back clears the customization. */
  update(id: TemplateId, input: Partial<Record<keyof TemplateFields, unknown>>): TemplateFields {
    const next = { ...this.get(id) }
    for (const key of Object.keys(next) as (keyof TemplateFields)[]) {
      const value = input[key]
      if (value === undefined || value === null) continue
      if (typeof value !== 'string') throw err('general_argument_invalid', `Invalid \`${key}\` param: Value must be a valid string`)
      next[key] = value.trim() === '' && (key === 'subject' || key === 'message') ? DEFAULTS[id][key] : value
    }
    validate(next)
    const saved = this.saved()
    const isDefault = JSON.stringify(next) === JSON.stringify(this.defaults(id))
    if (isDefault) delete saved[id]
    else saved[id] = { ...next, updatedAt: now() }
    this.write(saved)
    return this.get(id)
  }

  reset(id: TemplateId): TemplateFields {
    const saved = this.saved()
    delete saved[id]
    this.write(saved)
    return this.get(id)
  }

  /**
   * The finished email. `project` is filled in from the project name; a
   * security phrase is added after the message when the template has no
   * `{{phrase}}` of its own, so sign-in codes keep it.
   */
  render(id: TemplateId, to: string, vars: Record<string, string>, fields: TemplateFields = this.get(id)): Mail {
    const values: Record<string, string> = { project: this.config.projectName, ...vars }
    let body = fill(fields.message, values, true)
    if (values.phrase && !/\{\{\s*phrase\s*\}\}/.test(fields.message)) {
      body += paragraph(`Security phrase for this email is <strong>${escapeHtml(values.phrase)}</strong>. You can trust this email if this phrase matches the phrase shown during sign in.`)
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
  preview(id: TemplateId, fields: TemplateFields): Mail {
    return this.render(id, 'preview@example.com', templateInfo(id).sample, fields)
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
