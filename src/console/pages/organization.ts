import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { arrayOf, checked, value } from '~/console/forms'
import { html, page, type Html } from '~/console/html'
import { icon } from '~/console/ui'
import { ORGANIZATION_EMAIL } from '~/console/views/email'
import { avatarUrl } from '~/console/auth'
import { membersView, organizationGeneralView, organizationHeader } from '~/console/views/organization'
import { inlineStatus } from '~/console/views/settings'
import { githubAppSection } from '~/console/views/vcs'
import { SmtpMailer } from '~/mail/mailer'
import type { InviteInput, OrganizationRole } from '~/organizations/service'
import { err } from '~/lib/errors'

const orgId = (ctx: ConsoleContext) => ctx.projects.control.config.orgId
const canManage = async (ctx: ConsoleContext) => (await ctx.organizations.roleOf(orgId(ctx), ctx.admin.email)) === 'owner'
const consoleBaseUrl = (ctx: ConsoleContext) => ctx.projects.control.config.publicEndpoint.replace(/\/v1\/?$/, '')
/** Profile photo URLs by member email, for the Members table. */
async function memberPhotos(ctx: ConsoleContext): Promise<Record<string, string>> {
  return Object.fromEntries((await ctx.auth.list()).filter((admin) => admin.avatarAt).map((admin) => [admin.email, avatarUrl(admin)]))
}

const ownerCount = (members: { status: string; role: string }[]) => members.filter((member) => member.status === 'active' && member.role === 'owner').length

async function orgHeader(ctx: ConsoleContext, active: 'projects' | 'members' | 'settings', actions?: Html) {
  const org = await ctx.organizations.ensure(orgId(ctx), ctx.projects.control.config.projectName)
  const members = await ctx.organizations.members(org.id)
  const counts = { projects: ctx.projects.list().length, members: members.filter((member) => member.status === 'active').length }
  return { org, members, header: organizationHeader(org, counts, active, await canManage(ctx), actions) }
}

const inviteButton = html`<button class="primary" type="button" data-dialog-open="#invite-members">${icon('plus')}<span>Invite members</span></button>`

export function organizationPages(router: ConsoleRouter): void {
  router.get('/console/organization', async ({ ctx }) => {
    if (!(await canManage(ctx))) return ctx.go('/console')
    const { org, header } = await orgHeader(ctx, 'settings')
    const control = ctx.projects.control
    return ctx.render(
      org.name,
      'organization',
      html`${header}${organizationGeneralView(org, { smtp: control.config.consoleSmtp, email: ctx.admin.email })}${githubAppSection(ctx)}`,
    )
  })

  router.post('/console/organization', async ({ ctx }) => {
    if (!(await canManage(ctx))) throw err('general_argument_invalid', 'Only an organization owner can rename the organization.')
    const name = value(ctx.form, 'name')
    await ctx.organizations.updateName(orgId(ctx), name)
    return ctx.go('/console/organization', { tone: 'success', text: 'Organization updated' })
  })

  router.post(ORGANIZATION_EMAIL, async ({ ctx }) => {
    if (!(await canManage(ctx))) throw err('general_argument_invalid', 'Only an organization owner can change email delivery.')
    const control = ctx.projects.control
    if (ctx.form.disable) {
      await control.settings.set('consoleSmtp', { disabled: true })
      return ctx.go('/console/organization', { tone: 'success', text: 'Email turned off' })
    }
    const host = value(ctx.form, 'host')
    if (!host) throw err('general_argument_invalid', 'Enter the SMTP host.')
    await control.settings.set('consoleSmtp', {
      host,
      port: Number(ctx.form.port || 587),
      user: value(ctx.form, 'user') || undefined,
      password: String(ctx.form.password ?? '') || control.config.consoleSmtp?.password,
      secure: checked(ctx.form.secure),
      senderEmail: value(ctx.form, 'senderEmail') || 'no-reply@example.com',
      senderName: value(ctx.form, 'senderName') || `${control.config.projectName} Team`,
    })
    return ctx.go('/console/organization', { tone: 'success', text: 'Email delivery saved' })
  })

  router.post(`${ORGANIZATION_EMAIL}/test`, async ({ ctx }) => {
    if (!(await canManage(ctx))) throw err('general_argument_invalid', 'Only an organization owner can send a test email.')
    const control = ctx.projects.control
    const smtp = control.config.consoleSmtp
    if (!smtp) return page(inlineStatus('Save SMTP settings first.', 'critical'))
    try {
      await new SmtpMailer(smtp).send({
        to: ctx.admin.email,
        subject: `${control.config.projectName}: test email`,
        text: 'SMTP works. This message was sent from the organization settings.',
        html: '<p>SMTP works. This message was sent from the organization settings.</p>',
      })
      return page(inlineStatus(`Sent to ${ctx.admin.email}`, 'success'))
    } catch (error) {
      return page(inlineStatus(error instanceof Error ? error.message : String(error), 'critical'))
    }
  })

  router.get('/console/organization/members', async ({ ctx, url }) => {
    const manager = await canManage(ctx)
    const { org, members, header } = await orgHeader(ctx, 'members', manager ? inviteButton : undefined)
    const query = url.searchParams.get('q') ?? ''
    return ctx.render(
      org.name,
      'organization',
      html`${header}${membersView({
        members: await ctx.organizations.members(org.id, query),
        ownerCount: ownerCount(members),
        canManage: manager,
        currentEmail: ctx.admin.email,
        photos: await memberPhotos(ctx),
        query,
        inviteOpen: manager && url.searchParams.get('invite') === '1',
      })}`,
    )
  })

  router.post('/console/organization/members/invite', async ({ ctx }) => {
    if (!(await canManage(ctx))) throw err('general_argument_invalid', 'Only an organization owner can invite members.')
    const emails = arrayOf(ctx.form.email)
    const roles = arrayOf(ctx.form.role)
    const inputs: InviteInput[] = emails
      .map((email, index) => ({ email: email.trim(), role: (roles[index] === 'owner' ? 'owner' : 'developer') as OrganizationRole }))
      .filter((input) => input.email)
    if (!inputs.length) throw err('general_argument_invalid', 'Add at least one email address.')

    const { org, members, header } = await orgHeader(ctx, 'members', inviteButton)
    const results = await ctx.organizations.invite(org.id, inputs, {
      baseUrl: consoleBaseUrl(ctx),
      orgName: org.name,
      inviter: ctx.admin.email,
      mailer: ctx.projects.control.consoleMailer,
    })
    return ctx.render(
      org.name,
      'organization',
      html`${header}${membersView({
        members: await ctx.organizations.members(org.id),
        ownerCount: ownerCount(members),
        canManage: true,
        currentEmail: ctx.admin.email,
        photos: await memberPhotos(ctx),
        query: '',
        inviteOpen: false,
        inviteResults: results,
      })}`,
    )
  })

  router.post('/console/organization/members/:id/invite-link', async ({ ctx, path }) => {
    if (!(await canManage(ctx))) throw err('general_argument_invalid', 'Only an organization owner can copy invitation links.')
    const member = await ctx.organizations.findMember(orgId(ctx), path.id!)
    if (member.status !== 'invited') throw err('general_argument_invalid', 'That member has already accepted the invitation.')
    const { org, members, header } = await orgHeader(ctx, 'members', inviteButton)
    const [result] = await ctx.organizations.invite(org.id, [{ email: member.email, role: member.role }], {
      baseUrl: consoleBaseUrl(ctx),
      orgName: org.name,
      inviter: ctx.admin.email,
      mailer: ctx.projects.control.consoleMailer,
      notify: false,
    })
    return ctx.render(
      org.name,
      'organization',
      html`${header}${membersView({
        members: await ctx.organizations.members(org.id),
        ownerCount: ownerCount(members),
        canManage: true,
        currentEmail: ctx.admin.email,
        photos: await memberPhotos(ctx),
        query: '',
        inviteOpen: false,
        copiedLink: result,
      })}`,
    )
  })

  router.post('/console/organization/members/:id/resend', async ({ ctx, path }) => {
    if (!(await canManage(ctx))) throw err('general_argument_invalid', 'Only an organization owner can resend invitations.')
    const member = await ctx.organizations.findMember(orgId(ctx), path.id!)
    if (member.status !== 'invited') throw err('general_argument_invalid', 'That member has already accepted the invitation.')
    const { org, members, header } = await orgHeader(ctx, 'members', inviteButton)
    const results = await ctx.organizations.invite(org.id, [{ email: member.email, role: member.role }], {
      baseUrl: consoleBaseUrl(ctx),
      orgName: org.name,
      inviter: ctx.admin.email,
      mailer: ctx.projects.control.consoleMailer,
    })
    return ctx.render(
      org.name,
      'organization',
      html`${header}${membersView({
        members: await ctx.organizations.members(org.id),
        ownerCount: ownerCount(members),
        canManage: true,
        currentEmail: ctx.admin.email,
        photos: await memberPhotos(ctx),
        query: '',
        inviteOpen: false,
        inviteResults: results,
      })}`,
    )
  })

  router.post('/console/organization/members/:id/role', async ({ ctx, path }) => {
    if (!(await canManage(ctx))) throw err('general_argument_invalid', 'Only an organization owner can change roles.')
    const role = value(ctx.form, 'role')
    await ctx.organizations.updateRole(orgId(ctx), path.id!, role === 'owner' ? 'owner' : 'developer', ctx.admin.email)
    return ctx.go('/console/organization/members', { tone: 'success', text: 'Member role updated' })
  })

  router.post('/console/organization/members/:id/delete', async ({ ctx, path }) => {
    if (!(await canManage(ctx))) throw err('general_argument_invalid', 'Only an organization owner can remove members.')
    const member = await ctx.organizations.findMember(orgId(ctx), path.id!)
    await ctx.organizations.remove(orgId(ctx), path.id!, ctx.admin.email)
    return ctx.go('/console/organization/members', { tone: 'success', text: member.status === 'invited' ? 'Invitation revoked' : 'Member removed' })
  })
}
