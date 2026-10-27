import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { arrayOf, value } from '~/console/forms'
import { html, type Html } from '~/console/html'
import { icon } from '~/console/ui'
import { membersView, organizationGeneralView, organizationHeader } from '~/console/views/organization'
import type { InviteInput, OrganizationRole } from '~/organizations/service'
import { err } from '~/lib/errors'

const orgId = (ctx: ConsoleContext) => ctx.projects.control.config.orgId
const canManage = (ctx: ConsoleContext) => ctx.organizations.roleOf(orgId(ctx), ctx.admin.email) === 'owner'
const consoleBaseUrl = (ctx: ConsoleContext) => ctx.projects.control.config.publicEndpoint.replace(/\/v1\/?$/, '')
const ownerCount = (members: { status: string; role: string }[]) =>
  members.filter((member) => member.status === 'active' && member.role === 'owner').length

function orgHeader(ctx: ConsoleContext, active: 'projects' | 'members' | 'settings', actions?: Html) {
  const org = ctx.organizations.ensure(orgId(ctx), ctx.projects.control.config.projectName)
  const members = ctx.organizations.members(org.id)
  const counts = { projects: ctx.projects.list().length, members: members.filter((member) => member.status === 'active').length }
  return { org, members, header: organizationHeader(org, counts, active, canManage(ctx), actions) }
}

const inviteButton = html`<button class="primary" type="button" data-dialog-open="#invite-members">${icon('plus')}<span>Invite members</span></button>`

export function organizationPages(router: ConsoleRouter): void {
  router.get('/console/organization', ({ ctx }) => {
    if (!canManage(ctx)) return ctx.go('/console')
    const { org, header } = orgHeader(ctx, 'settings')
    return ctx.render(org.name, 'organization', html`${header}${organizationGeneralView(org)}`)
  })

  router.post('/console/organization', ({ ctx }) => {
    if (!canManage(ctx)) throw err('general_argument_invalid', 'Only an organization owner can rename the organization.')
    const name = value(ctx.form, 'name')
    ctx.organizations.updateName(orgId(ctx), name)
    return ctx.go('/console/organization', { tone: 'success', text: 'Organization updated' })
  })

  router.get('/console/organization/members', ({ ctx, url }) => {
    const manager = canManage(ctx)
    const { org, members, header } = orgHeader(ctx, 'members', manager ? inviteButton : undefined)
    const query = url.searchParams.get('q') ?? ''
    return ctx.render(
      org.name,
      'organization',
      html`${header}${membersView({
        members: ctx.organizations.members(org.id, query),
        ownerCount: ownerCount(members),
        canManage: manager,
        currentEmail: ctx.admin.email,
        query,
        inviteOpen: manager && url.searchParams.get('invite') === '1',
      })}`,
    )
  })

  router.post('/console/organization/members/invite', async ({ ctx }) => {
    if (!canManage(ctx)) throw err('general_argument_invalid', 'Only an organization owner can invite members.')
    const emails = arrayOf(ctx.form.email)
    const roles = arrayOf(ctx.form.role)
    const inputs: InviteInput[] = emails
      .map((email, index) => ({ email: email.trim(), role: (roles[index] === 'owner' ? 'owner' : 'developer') as OrganizationRole }))
      .filter((input) => input.email)
    if (!inputs.length) throw err('general_argument_invalid', 'Add at least one email address.')

    const { org, members, header } = orgHeader(ctx, 'members', inviteButton)
    const results = await ctx.organizations.invite(org.id, inputs, {
      baseUrl: consoleBaseUrl(ctx),
      orgName: org.name,
      inviter: ctx.admin.email,
      mailer: ctx.projects.control.mailer,
    })
    return ctx.render(
      org.name,
      'organization',
      html`${header}${membersView({
        members: ctx.organizations.members(org.id),
        ownerCount: ownerCount(members),
        canManage: true,
        currentEmail: ctx.admin.email,
        query: '',
        inviteOpen: false,
        inviteResults: results,
      })}`,
    )
  })

  router.post('/console/organization/members/:id/resend', async ({ ctx, path }) => {
    if (!canManage(ctx)) throw err('general_argument_invalid', 'Only an organization owner can resend invitations.')
    const member = ctx.organizations.findMember(orgId(ctx), path.id!)
    if (member.status !== 'invited') throw err('general_argument_invalid', 'That member has already accepted the invitation.')
    const { org, members, header } = orgHeader(ctx, 'members', inviteButton)
    const results = await ctx.organizations.invite(org.id, [{ email: member.email, role: member.role }], {
      baseUrl: consoleBaseUrl(ctx),
      orgName: org.name,
      inviter: ctx.admin.email,
      mailer: ctx.projects.control.mailer,
    })
    return ctx.render(
      org.name,
      'organization',
      html`${header}${membersView({
        members: ctx.organizations.members(org.id),
        ownerCount: ownerCount(members),
        canManage: true,
        currentEmail: ctx.admin.email,
        query: '',
        inviteOpen: false,
        inviteResults: results,
      })}`,
    )
  })

  router.post('/console/organization/members/:id/role', ({ ctx, path }) => {
    if (!canManage(ctx)) throw err('general_argument_invalid', 'Only an organization owner can change roles.')
    const role = value(ctx.form, 'role')
    ctx.organizations.updateRole(orgId(ctx), path.id!, role === 'owner' ? 'owner' : 'developer', ctx.admin.email)
    return ctx.go('/console/organization/members', { tone: 'success', text: 'Member role updated' })
  })

  router.post('/console/organization/members/:id/delete', ({ ctx, path }) => {
    if (!canManage(ctx)) throw err('general_argument_invalid', 'Only an organization owner can remove members.')
    const member = ctx.organizations.findMember(orgId(ctx), path.id!)
    ctx.organizations.remove(orgId(ctx), path.id!, ctx.admin.email)
    return ctx.go('/console/organization/members', { tone: 'success', text: member.status === 'invited' ? 'Invitation revoked' : 'Member removed' })
  })
}
