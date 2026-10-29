import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ConsoleAuth } from '~/console/auth'
import { OrganizationService } from '~/organizations/service'
import { startServer, type TestServer } from './helpers'

describe('organizations', () => {
  let server: TestServer
  let base: string
  let cookie = ''
  let auth: ConsoleAuth
  let organizations: OrganizationService
  let devCookie = ''

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers: { cookie, ...headers }, redirect: 'manual' })
  const form = (path: string, fields: Array<[string, string]>, headers: Record<string, string> = {}) => {
    const body = new URLSearchParams()
    for (const [key, value] of fields) body.append(key, value)
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body,
      redirect: 'manual',
    })
  }

  beforeAll(async () => {
    server = startServer()
    base = server.endpoint.replace(/\/v1$/, '')
    auth = new ConsoleAuth(server.db)
    organizations = new OrganizationService(server.db)
    await auth.upsert('owner@example.com', 'password-123')
    organizations.ensure('org_test', 'Test Project')
    organizations.ensureAdmin('org_test', 'owner@example.com')
    const secret = (await auth.login('owner@example.com', 'password-123'))!
    cookie = `bunwrite_console=${secret}`
  })

  afterAll(() => {
    server.services.requestLogs.flush()
    server.stop()
  })

  test('general settings show and update the organization', async () => {
    const page = await (await get('/console/organization')).text()
    expect(page).toContain('Organization ID')
    expect(page).toContain('org_test')
    expect(page).toContain('Organization name')
    expect(page).toContain('>Settings</a>')
    expect(page).toContain('>Members</a>')

    const updated = await form('/console/organization', [['name', 'Acme']])
    expect(updated.status).toBe(303)
    expect(organizations.get('org_test')!.name).toBe('Acme')
    expect(await (await get('/console')).text()).toContain('Acme')
  })

  test('the owner is listed as a member and can open the invite dialog', async () => {
    const page = await (await get('/console/organization/members')).text()
    expect(page).toContain('owner@example.com')
    expect(page).toContain('Owner')
    expect(page).toContain('Invite')

    const invite = await (await get('/console/organization/members?invite=1')).text()
    expect(invite).toContain('id="invite-members"')
    expect(invite).toContain('data-add-row="#invite-row-template"')
    expect(invite).toContain('action="/console/organization/members/invite"')
  })

  test('invites by email, then accepts the invitation as a new member', async () => {
    const invited = await form('/console/organization/members/invite', [
      ['email', 'dev@example.com'],
      ['role', 'developer'],
      ['email', 'second@example.com'],
      ['role', 'owner'],
    ])
    expect(invited.status).toBe(200)
    const page = await invited.text()
    expect(page).toContain('Invitations sent')
    expect(page).toContain('dev@example.com')
    // Pending invitations are listed apart from active members, with resend and revoke.
    const pending = page.slice(page.indexOf('Pending invitations'))
    expect(page.indexOf('Pending invitations')).toBeGreaterThan(-1)
    expect(pending).toContain('dev@example.com')
    expect(pending).toContain('Copy invitation link')
    expect(pending).toContain('Resend invitation')
    expect(pending).toContain('Revoke invitation')

    const mail = server.mailer.last('dev@example.com')!
    const link = /https?:\/\/\S+\/console\/invite\/[a-f0-9]+/.exec(mail.text)![0]!
    const token = link.split('/').pop()!

    const acceptPage = await (await fetch(link)).text()
    expect(acceptPage).toContain('Join Acme')
    expect(acceptPage).toContain('dev@example.com')

    const accepted = await fetch(link, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Dev User', password: 'password-123' }),
      redirect: 'manual',
    })
    expect(accepted.status).toBe(303)
    devCookie = accepted.headers.get('set-cookie')!.split(';')[0]!
    expect(organizations.findByEmail('org_test', 'dev@example.com')!.status).toBe('active')
    expect(organizations.findByEmail('org_test', 'dev@example.com')!.role).toBe('developer')
    expect(auth.find('dev@example.com')).not.toBeNull()
    expect(await (await fetch(link)).text()).toContain('Invitation unavailable')

    const members = await (await get('/console/organization/members', { cookie: devCookie })).text()
    expect(members).toContain('Dev User')
    expect(members).toContain('Developer')
    expect(members).not.toContain('data-dialog-open="#invite-members"')
    expect(members).not.toContain('href="/console/organization/members?invite=1"')
    expect(members).not.toContain('>Settings</a>')

    const settings = await get('/console/organization', { cookie: devCookie })
    expect(settings.status).toBe(303)
    expect(settings.headers.get('location')).toBe('/console')

    const searched = await (await get('/console/organization/members?q=dev')).text()
    const listed = searched.slice(searched.indexOf('<div id="members-list">'))
    expect(listed).toContain('dev@example.com')
    expect(listed).not.toContain('owner@example.com')
  })

  test('developers cannot manage the organization', async () => {
    const renamed = await form('/console/organization', [['name', 'Nope']], { cookie: devCookie })
    expect(renamed.status).toBe(303)
    expect(organizations.get('org_test')!.name).toBe('Acme')

    const invited = await form(
      '/console/organization/members/invite',
      [
        ['email', 'nope@example.com'],
        ['role', 'developer'],
      ],
      { cookie: devCookie },
    )
    expect(invited.status).toBe(303)
    expect(organizations.findByEmail('org_test', 'nope@example.com')).toBeNull()
  })

  test('an invitation can be resent, replacing the previous link', async () => {
    const invited = await form('/console/organization/members/invite', [
      ['email', 'resend@example.com'],
      ['role', 'developer'],
    ])
    expect(invited.status).toBe(200)
    const first = /https?:\/\/\S+\/console\/invite\/[a-f0-9]+/.exec(server.mailer.last('resend@example.com')!.text)![0]!
    const member = organizations.findByEmail('org_test', 'resend@example.com')!

    const resent = await form(`/console/organization/members/${member.id}/resend`, [])
    expect(resent.status).toBe(200)
    const second = /https?:\/\/\S+\/console\/invite\/[a-f0-9]+/.exec(server.mailer.last('resend@example.com')!.text)![0]!
    expect(second).not.toBe(first)
    expect(await (await fetch(first)).text()).toContain('Invitation unavailable')
    expect(await (await fetch(second)).text()).toContain('Join Acme')
  })

  test('an invitation link can be copied without sending another email', async () => {
    const invited = await form('/console/organization/members/invite', [
      ['email', 'copy@example.com'],
      ['role', 'developer'],
    ])
    expect(invited.status).toBe(200)
    const first = /https?:\/\/\S+\/console\/invite\/[a-f0-9]+/.exec(server.mailer.last('copy@example.com')!.text)![0]!
    const member = organizations.findByEmail('org_test', 'copy@example.com')!
    const sentBefore = server.mailer.sent.length

    const copied = await form(`/console/organization/members/${member.id}/invite-link`, [])
    expect(copied.status).toBe(200)
    const page = await copied.text()
    expect(page).toContain('id="invitation-link"')
    const second = /id="invitation-link-value"[^>]*value="([^"]+)"/.exec(page)![1]!

    expect(second).not.toBe(first)
    expect(server.mailer.sent.length).toBe(sentBefore)
    expect(await (await fetch(first)).text()).toContain('Invitation unavailable')
    expect(await (await fetch(second)).text()).toContain('Join Acme')
  })

  test('an existing console account has to sign in before accepting an invitation', async () => {
    await auth.upsert('existing@example.com', 'password-123')
    const invited = await form('/console/organization/members/invite', [
      ['email', 'existing@example.com'],
      ['role', 'developer'],
    ])
    expect(invited.status).toBe(200)
    const mail = server.mailer.last('existing@example.com')!
    const link = /https?:\/\/\S+\/console\/invite\/[a-f0-9]+/.exec(mail.text)![0]!

    const page = await (await fetch(link)).text()
    expect(page).toContain('Your account already exists')
    expect(page).toContain('Sign in and join')
    expect(organizations.findByEmail('org_test', 'existing@example.com')!.status).toBe('invited')

    const wrong = await fetch(link, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'wrong-password' }),
      redirect: 'manual',
    })
    expect(wrong.status).toBe(200)
    expect(await wrong.text()).toContain('Incorrect email or password.')
    expect(organizations.findByEmail('org_test', 'existing@example.com')!.status).toBe('invited')

    const accepted = await fetch(link, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'password-123' }),
      redirect: 'manual',
    })
    expect(accepted.status).toBe(303)
    expect(accepted.headers.get('set-cookie')).toContain('bunwrite_console=')
    expect(organizations.findByEmail('org_test', 'existing@example.com')!.status).toBe('active')
    expect(await (await fetch(link)).text()).toContain('Invitation unavailable')
  })

  test('owners can change roles, protect the last owner, and remove members', async () => {
    const owner = organizations.findByEmail('org_test', 'owner@example.com')!
    expect(() => organizations.updateRole('org_test', owner.id, 'developer', owner.email)).toThrow('your own role')
    expect(() => organizations.remove('org_test', owner.id, owner.email)).toThrow('yourself')

    const dev = organizations.findByEmail('org_test', 'dev@example.com')!
    const promoted = await form(`/console/organization/members/${dev.id}/role`, [['role', 'owner']])
    expect(promoted.status).toBe(303)
    expect(organizations.findByEmail('org_test', 'dev@example.com')!.role).toBe('owner')

    const removed = await form(`/console/organization/members/${dev.id}/delete`, [])
    expect(removed.status).toBe(303)
    expect(organizations.findByEmail('org_test', 'dev@example.com')).toBeNull()
    expect(auth.find('dev@example.com')).toBeNull()
  })
})
