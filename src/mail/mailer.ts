/**
 * Outgoing email. Real SMTP through nodemailer when configured; tests swap in
 * a MemoryMailer. Texts follow Appwrite's English templates so the emails
 * people receive read the same as before.
 */
import nodemailer from 'nodemailer'

import type { SmtpConfig } from '~/config'
import { err } from '~/lib/errors'

export interface Mail {
  to: string
  subject: string
  html: string
  text: string
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
      from: { name: this.config.senderName, address: this.config.senderEmail },
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

function layout(paragraphs: string[], button?: { href: string; label: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join('')
  const cta = button
    ? `<p style="margin:24px 0"><a href="${escape(button.href)}" style="background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">${escape(button.label)}</a></p>`
    : ''
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222;line-height:1.5;max-width:560px;margin:0 auto;padding:24px">${body}${cta}</body></html>`
}

const bold = (s: string) => `<strong>${escape(s)}</strong>`

export function otpMail(project: string, to: string, user: string, otp: string, phrase?: string): Mail {
  const paragraphs = [
    `Hello ${escape(user)},`,
    `Enter the following verification code when prompted to securely sign in to your ${bold(project)} account. This code will expire in 15 minutes.`,
    `<span style="font-size:28px;letter-spacing:6px;font-weight:700">${escape(otp)}</span>`,
  ]
  if (phrase) paragraphs.push(`Security phrase for this email is ${bold(phrase)}. You can trust this email if this phrase matches the phrase shown during sign in.`)
  paragraphs.push('Thanks,', `${escape(project)} team`)
  return {
    to,
    subject: `OTP for ${project} Login`,
    html: layout(paragraphs),
    text: `Hello ${user},\n\nYour ${project} sign-in code is ${otp}. It expires in 15 minutes.\n\nThanks,\n${project} team`,
  }
}

export function recoveryMail(project: string, to: string, user: string, link: string): Mail {
  return {
    to,
    subject: `Password Reset for ${project}`,
    html: layout(
      [
        `Hello ${escape(user)},`,
        `Follow this link to reset your ${bold(project)} password.`,
        "If you didn't ask to reset your password, you can ignore this message.",
        'Thanks,',
        `${escape(project)} team`,
      ],
      { href: link, label: 'Reset password' },
    ),
    text: `Hello ${user},\n\nFollow this link to reset your ${project} password:\n${link}\n\nIf you didn't ask to reset your password, you can ignore this message.`,
  }
}

export function invitationMail(project: string, to: string, user: string, owner: string, team: string, link: string): Mail {
  return {
    to,
    subject: `Invitation to ${team} Team at ${project}`,
    html: layout(
      [
        `Hello ${escape(user)},`,
        `This mail was sent to you because ${bold(owner)} invited you to become a member of the ${bold(team)} team at ${bold(project)}.`,
        'If you are not interested, you can ignore this message.',
        'Thanks,',
        `${escape(project)} team`,
      ],
      { href: link, label: `Accept invite to ${team}` },
    ),
    text: `Hello ${user},\n\n${owner} invited you to join ${team} at ${project}:\n${link}`,
  }
}

export function verificationMail(project: string, to: string, user: string, link: string): Mail {
  return {
    to,
    subject: `Account Verification for ${project}`,
    html: layout(
      [`Hello ${escape(user)},`, `Follow this link to verify your email address for ${bold(project)}.`, 'Thanks,', `${escape(project)} team`],
      { href: link, label: 'Verify email' },
    ),
    text: `Hello ${user},\n\nFollow this link to verify your email address:\n${link}`,
  }
}
