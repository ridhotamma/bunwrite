import type { AppContext } from '~/app'
import { membershipModel, teamModel } from '~/auth/models'
import { err } from '~/lib/errors'
import { bool, json, list, noContent, str } from '~/lib/http'
import { assertRedirect, withQuery } from '~/lib/origins'
import type { Router } from '~/lib/router'

export function teamRoutes(router: Router<AppContext>): void {
  router.get('/teams', ({ ctx, params }) => {
    const { total, teams } = ctx.teams.list(ctx.caller, list(params.queries), str(params.search), bool(params.total, true))
    return json({ total, teams: teams.map(teamModel) })
  })

  router.post('/teams', ({ ctx, params }) =>
    json(teamModel(ctx.teams.create(ctx.caller, { teamId: params.teamId, name: params.name, roles: params.roles })), 201),
  )

  router.get('/teams/:teamId', ({ ctx, path }) => {
    ctx.teams.assertAccess(ctx.caller, path.teamId!, 'member')
    return json(teamModel(ctx.teams.team(path.teamId!)))
  })

  router.put('/teams/:teamId', ({ ctx, path, params }) => {
    ctx.teams.assertAccess(ctx.caller, path.teamId!, 'owner')
    if (typeof params.name !== 'string' || !params.name || params.name.length > 128) {
      throw err('general_argument_invalid', 'Invalid `name` param: Value must be a valid string and at least 1 chars and no longer than 128 chars')
    }
    return json(teamModel(ctx.teams.update(path.teamId!, { name: params.name })))
  })

  router.delete('/teams/:teamId', ({ ctx, path }) => {
    ctx.teams.assertAccess(ctx.caller, path.teamId!, 'owner')
    ctx.teams.delete(path.teamId!)
    return noContent()
  })

  router.get('/teams/:teamId/prefs', ({ ctx, path }) => {
    ctx.teams.assertAccess(ctx.caller, path.teamId!, 'member')
    return json(JSON.parse(ctx.teams.team(path.teamId!).prefs))
  })

  router.put('/teams/:teamId/prefs', ({ ctx, path, params }) => {
    ctx.teams.assertAccess(ctx.caller, path.teamId!, 'owner')
    const prefs = params.prefs
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
      throw err('general_argument_invalid', 'Invalid `prefs` param: Value must be a valid object.')
    }
    ctx.teams.update(path.teamId!, { prefs: JSON.stringify(prefs) })
    return json(prefs)
  })

  router.get('/teams/:teamId/memberships', ({ ctx, path, params }) => {
    ctx.teams.assertAccess(ctx.caller, path.teamId!, 'member')
    const { total, memberships } = ctx.teams.listMemberships({ teamId: path.teamId! }, list(params.queries), str(params.search), bool(params.total, true))
    return json({ total, memberships: memberships.map(membershipModel) })
  })

  router.post('/teams/:teamId/memberships', async ({ ctx, path, params }) => {
    // Invitations from a user need a link to send; API-key memberships are confirmed at once.
    if (!ctx.caller.privileged) ctx.access.assertAuthMethod('invites')
    const url = ctx.caller.privileged ? str(params.url) : assertRedirect(params.url, ctx.config.allowedOrigins, 'url')
    if (!ctx.caller.privileged && !ctx.mailer.enabled) throw err('general_smtp_disabled', 'SMTP Disabled')
    const { membership, secret } = await ctx.teams.createMembership(ctx.caller, path.teamId!, {
      email: params.email,
      userId: params.userId,
      phone: params.phone,
      roles: params.roles,
      name: params.name,
    })
    if (secret && url && membership.user_email) {
      const link = withQuery(url, { membershipId: membership.id, userId: membership.user_id, secret, teamId: membership.team_id })
      const owner = ctx.caller.user?.name || ctx.caller.user?.email || ctx.config.projectName
      await ctx.mailer.send(
        ctx.templates.render('invitation', membership.user_email, { user: membership.user_name || membership.user_email, owner, team: membership.team_name, redirect: link }),
      )
    }
    return json(membershipModel(membership), 201)
  })

  router.get('/teams/:teamId/memberships/:membershipId', ({ ctx, path }) => {
    ctx.teams.assertAccess(ctx.caller, path.teamId!, 'member')
    return json(membershipModel(ctx.teams.membership(path.teamId!, path.membershipId!)))
  })

  router.patch('/teams/:teamId/memberships/:membershipId', ({ ctx, path, params }) =>
    json(membershipModel(ctx.teams.updateMembership(ctx.caller, path.teamId!, path.membershipId!, params.roles))),
  )

  router.delete('/teams/:teamId/memberships/:membershipId', ({ ctx, path }) => {
    ctx.teams.deleteMembership(ctx.caller, path.teamId!, path.membershipId!)
    return noContent()
  })

  router.patch('/teams/:teamId/memberships/:membershipId/status', ({ ctx, path, params }) =>
    json(membershipModel(ctx.teams.confirmMembership(path.teamId!, path.membershipId!, params.userId, params.secret))),
  )
}
