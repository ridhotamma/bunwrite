/**
 * Outgoing email. Real SMTP through nodemailer when configured; tests swap in
 * a MemoryMailer. The emails a project sends to its users come from editable
 * templates (templates.ts); this file keeps the console's own invitation.
 */
import nodemailer from 'nodemailer'

import type { SmtpConfig } from '~/config'
import { err } from '~/lib/errors'

export interface Mail {
  to: string
  subject: string
  html: string
  text: string
  /** Overrides the SMTP sender, as a template may. */
  from?: { name: string; address: string }
  replyTo?: { name: string; address: string }
}

export interface Mailer {
  readonly enabled: boolean
  send(mail: Mail): Promise<void>
}

export class SmtpMailer implements Mailer {
  readonly enabled = true
  private transport: nodemailer.Transporter

  constructor(private config: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.password } : undefined,
    })
  }

  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({
      from: mail.from?.address ? mail.from : { name: mail.from?.name || this.config.senderName, address: this.config.senderEmail },
      replyTo: mail.replyTo?.address ? mail.replyTo : undefined,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    })
  }
}

/** No SMTP configured: flows that need email fail like Appwrite's ("SMTP disabled"). */
export class DisabledMailer implements Mailer {
  readonly enabled = false
  async send(): Promise<void> {
    throw err('general_smtp_disabled', 'SMTP disabled')
  }
}

export class MemoryMailer implements Mailer {
  readonly enabled = true
  sent: Mail[] = []
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail)
  }
  last(to?: string): Mail | undefined {
    return [...this.sent].reverse().find((m) => !to || m.to === to)
  }
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function organizationInviteMail(org: string, inviter: string, to: string, link: string): Mail {
  const paragraphs = [
    `${escape(inviter)} invited you to join ${bold(org)} on Bunwrite.`,
    'Accept the invitation to create your account and access the organization projects.',
  ]
  return {
    to,
    subject: `Join ${org} on Bunwrite`,
    html: layout(paragraphs, { href: link, label: 'Accept invitation' }),
    text: `${inviter} invited you to join ${org} on Bunwrite.\n\nAccept the invitation: ${link}`,
  }
}

function layout(paragraphs: string[], button?: { href: string; label: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join('')
  const cta = button
    ? `<p style="margin:24px 0"><a href="${escape(button.href)}" style="background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">${escape(button.label)}</a></p>`
    : ''
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222;line-height:1.5;max-width:560px;margin:0 auto;padding:24px">${body}${cta}</body></html>`
}

const bold = (s: string) => `<strong>${escape(s)}</strong>`
