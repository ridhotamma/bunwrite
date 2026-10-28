/**
 * Editable email templates: what users receive, the Project API the SDKs use
 * (`project.getEmailTemplate`, `updateEmailTemplate`, `listEmailTemplates`),
 * and the console editor with its preview.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client, ID, Project } from 'node-appwrite'

import { ConsoleAuth } from '~/console/auth'
import { htmlToText } from '~/mail/templates'
import { adminClient, failure, KEY, makeUser, PROJECT, sessionClient, startServer, type TestServer } from './helpers'

let server: TestServer
let project: any
let base: string
let cookie = ''

const REDIRECT = 'http://localhost/verify'

beforeAll(async () => {
  server = startServer()
  project = new Project(new Client().setEndpoint(server.endpoint).setProject(PROJECT).setKey(KEY))
  base = server.endpoint.replace(/\/v1$/, '')
  await new ConsoleAuth(server.db).upsert('admin@example.com', 'console-password')
  const login = await form('/console/login', { email: 'admin@example.com', password: 'console-password' })
  cookie = login.headers.get('set-cookie')!.split(';')[0]!
  // Project pages need a selected project.
  const open = await fetch(`${base}/console/projects/${PROJECT}/open`, { headers: { cookie }, redirect: 'manual' })
  cookie += `; ${open.headers.get('set-cookie')!.split(';')[0]}`
})
afterAll(() => server.stop())

async function form(path: string, fields: Record<string, string>) {
  return fetch(`${base}${path}`, { method: 'POST', body: new URLSearchParams(fields), redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } })
}
const page = async (path: string) => (await fetch(`${base}${path}`, { headers: { cookie } })).text()

/** Ask for a verification email as a fresh user; returns what was sent. */
async function verificationEmail(name = 'Ada') {
  const user = makeUser(server.db)
  server.db.sqlite.query('UPDATE _users SET name = ? WHERE id = ?').run(name, user.id)
  await sessionClient(server.endpoint, user.secret).account.createVerification({ url: REDIRECT })
  return { user, mail: server.mailer.last(`${user.id}@example.com`)! }
}

describe('default templates', () => {
  test('the verification email has the layout, a button to the link, and the link in the text part', async () => {
    const { mail } = await verificationEmail()
    expect(mail.subject).toBe('Account Verification for Test Project')
    expect(mail.html).toStartWith('<!doctype html>')
    expect(mail.html).toContain('Hello Ada,')
    expect(mail.html).toMatch(/<a href="http:\/\/localhost\/verify\?userId=[^"]+&amp;secret=/)
    expect(mail.text).toContain('Confirm email address: http://localhost/verify?userId=')
    expect(mail.text).not.toContain('<')
    expect(mail.from).toBeUndefined()
  })

  test('the OTP email carries the code, and the security phrase when asked for', async () => {
    const guest = sessionClient(server.endpoint)
    const token = await guest.account.createEmailToken({ userId: ID.unique(), email: 'otp@example.com', phrase: true })
    const mail = server.mailer.last('otp@example.com')!
    expect(mail.subject).toBe('OTP for Test Project Login')
    expect(mail.text).toMatch(/\b\d{6}\b/)
    expect(mail.html).toContain(`Security phrase for this email is <strong>${token.phrase}</strong>`)
  })
})

describe('custom templates through the Project API', () => {
  test('a changed template is used, with values escaped in the message and plain in the subject', async () => {
    const saved = await project.updateEmailTemplate({
      templateId: 'verification',
      locale: 'en',
      subject: 'Welcome to {{project}}, {{user}}!',
      message: '<h1>Hi {{ user }}</h1><p><a href="{{redirect}}">Verify</a> for {{project}}. {{unknown}}</p>',
      senderName: 'Pesanle',
      senderEmail: 'hello@pesanle.com',
      replyToEmail: 'support@pesanle.com',
      replyToName: 'Support',
    })
    expect(saved).toMatchObject({ templateId: 'verification', locale: 'en', subject: 'Welcome to {{project}}, {{user}}!', senderEmail: 'hello@pesanle.com' })

    const { mail } = await verificationEmail('<Ada & Co>')
    expect(mail.subject).toBe('Welcome to Test Project, <Ada & Co>!')
    expect(mail.html).toContain('<h1>Hi &lt;Ada &amp; Co&gt;</h1>')
    expect(mail.html).toContain('{{unknown}}')
    expect(mail.text).toContain('Hi <Ada & Co>')
    expect(mail.text).toContain('Verify: http://localhost/verify?userId=')
    expect(mail.from).toEqual({ name: 'Pesanle', address: 'hello@pesanle.com' })
    expect(mail.replyTo).toEqual({ name: 'Support', address: 'support@pesanle.com' })
  })

  test('get returns the saved or default template; list holds only the changed ones', async () => {
    expect(await project.getEmailTemplate({ templateId: 'verification', locale: 'en' })).toMatchObject({ subject: 'Welcome to {{project}}, {{user}}!' })
    const recovery = await project.getEmailTemplate({ templateId: 'recovery' })
    expect(recovery).toMatchObject({ templateId: 'recovery', locale: 'en', subject: 'Password Reset for {{project}}', senderEmail: '' })
    expect(recovery.message).toContain('{{redirect}}')
    const listed = await project.listEmailTemplates()
    expect(listed.templates.map((t: any) => t.templateId)).toEqual(['verification'])
  })

  test('an update keeps the fields it does not send', async () => {
    await project.updateEmailTemplate({ templateId: 'verification', subject: 'Confirm your email' })
    expect(await project.getEmailTemplate({ templateId: 'verification' })).toMatchObject({ subject: 'Confirm your email', senderEmail: 'hello@pesanle.com' })
  })

  test('a custom OTP template that places the phrase itself gets no second phrase', async () => {
    await project.updateEmailTemplate({ templateId: 'otpSession', message: '<p>Code {{otp}}</p><p>Phrase: {{phrase}}</p>' })
    const token = await sessionClient(server.endpoint).account.createEmailToken({ userId: ID.unique(), email: 'otp2@example.com', phrase: true })
    const mail = server.mailer.last('otp2@example.com')!
    expect(mail.html).toContain(`Phrase: ${token.phrase}`)
    expect(mail.html).not.toContain('Security phrase for this email')
  })

  test('team invitations use their template', async () => {
    await project.updateEmailTemplate({ templateId: 'invitation', subject: '{{owner}} added you to {{team}}' })
    const admin = adminClient(server.endpoint)
    await admin.teams.create({ teamId: 'crew', name: 'Crew' })
    const owner = makeUser(server.db)
    server.db.sqlite.query("UPDATE _users SET name = 'Grace' WHERE id = ?").run(owner.id)
    await admin.teams.createMembership({ teamId: 'crew', roles: ['owner'], userId: owner.id })
    await sessionClient(server.endpoint, owner.secret).teams.createMembership({ teamId: 'crew', roles: [], email: 'friend@example.com', url: 'http://localhost/join' })
    expect(server.mailer.last('friend@example.com')!.subject).toBe('Grace added you to Crew')
  })

  test('bad input is refused', async () => {
    expect(await failure(project.updateEmailTemplate({ templateId: 'verification', locale: 'fr', subject: 'x' }))).toMatchObject({ code: 400, message: expect.stringContaining('"en" locale') })
    expect(await failure(project.updateEmailTemplate({ templateId: 'magicSession', subject: 'x' }))).toMatchObject({ code: 400, message: expect.stringContaining('not sent by this server') })
    expect(await failure(project.updateEmailTemplate({ templateId: 'verification', senderEmail: 'not-an-email' }))).toMatchObject({ code: 400 })
    expect(await failure(project.updateEmailTemplate({ templateId: 'verification', subject: 'x'.repeat(256) }))).toMatchObject({ code: 400 })
  })

  test('only API keys and console admins may read or change templates', async () => {
    const user = makeUser(server.db)
    const res = await fetch(`${server.endpoint}/project/templates/email/verification`, { headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-session': user.secret } })
    expect(res.status).toBe(401)
  })
})

describe('console editor', () => {
  test('the Email templates tab lists the templates and opens the first', async () => {
    const html = await page('/console/settings/templates')
    for (const name of ['Verification', 'Reset password', 'OTP session', 'Invite user']) expect(html).toContain(name)
    expect(html).toContain('4 templates')
    expect(html).toContain('name="subject"')
    expect(html).toContain('data-copy-var="{{redirect}}"')
    expect(html).toContain('<iframe class="template-frame" sandbox="allow-same-origin"')
  })

  test('saving from the console changes what is sent', async () => {
    const res = await form('/console/settings/templates/recovery', {
      subject: 'Reset your {{project}} password',
      message: '<p>Hey {{user}}, <a href="{{redirect}}">reset it here</a>.</p>',
      senderName: '',
      senderEmail: '',
      replyToName: '',
      replyToEmail: '',
    })
    expect(res.status).toBe(303)
    expect(new URL(res.headers.get('location')!, base).pathname).toBe('/console/settings/templates/recovery')
    expect(await page('/console/settings/templates/recovery')).toContain('Reset to default')

    const admin = adminClient(server.endpoint)
    await admin.users.create({ userId: 'forgetful', email: 'forgetful@example.com', password: 'password123', name: 'Lin' })
    await sessionClient(server.endpoint).account.createRecovery({ email: 'forgetful@example.com', url: 'http://localhost/reset' })
    const mail = server.mailer.last('forgetful@example.com')!
    expect(mail.subject).toBe('Reset your Test Project password')
    expect(mail.text).toContain('Hey Lin, reset it here: http://localhost/reset?userId=forgetful')
  })

  test('the preview renders the unsaved form with sample values in a sandboxed frame', async () => {
    const res = await form('/console/settings/templates/invitation/preview', {
      subject: '{{owner}} invited you to {{team}}',
      message: '<p>Join {{team}} at {{project}}</p><script>alert(1)</script>',
      senderName: 'Pesanle',
      senderEmail: 'hello@pesanle.com',
      replyToName: '',
      replyToEmail: '',
    })
    const html = await res.text()
    expect(html).toContain('<strong>Grace Hopper invited you to Editors</strong>')
    expect(html).toContain('Pesanle &lt;hello@pesanle.com&gt;')
    expect(html).toContain('sandbox="allow-same-origin"')
    expect(html).not.toContain('allow-scripts')
    // The email is inside srcdoc, escaped once more, so it cannot touch the console page.
    expect(html).toContain('&lt;p&gt;Join Editors at Test Project&lt;/p&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
    // Nothing was saved.
    expect((await project.getEmailTemplate({ templateId: 'invitation' })).subject).toBe('{{owner}} added you to {{team}}')
  })

  test('an invalid save keeps what was typed and says what is wrong', async () => {
    const res = await form('/console/settings/templates/verification', { subject: 'Kept subject', message: '<p>Kept</p>', senderName: '', senderEmail: 'nope', replyToName: '', replyToEmail: '' })
    const html = await res.text()
    expect(html).toContain('senderEmail')
    expect(html).toContain('value="Kept subject"')
    expect(html).toContain('&lt;p&gt;Kept&lt;/p&gt;')
  })

  test('reset goes back to the default', async () => {
    const res = await form('/console/settings/templates/recovery/reset', {})
    expect(res.status).toBe(303)
    expect((await project.getEmailTemplate({ templateId: 'recovery' })).subject).toBe('Password Reset for {{project}}')
    expect(await page('/console/settings/templates/recovery')).not.toContain('Reset to default')
  })

  test('an unknown template goes back to the list', async () => {
    const res = await fetch(`${base}/console/settings/templates/nope`, { headers: { cookie }, redirect: 'manual' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/console/settings/templates')
  })
})

describe('plain-text part', () => {
  test('links, breaks and entities read naturally', () => {
    expect(htmlToText('<p>Hi&nbsp;<b>Ada</b>,<br>welcome</p><p><a href="https://x.test/a?b=1&amp;c=2">Open</a></p><style>p{}</style>')).toBe(
      'Hi Ada,\nwelcome\n\nOpen: https://x.test/a?b=1&c=2',
    )
  })
})
