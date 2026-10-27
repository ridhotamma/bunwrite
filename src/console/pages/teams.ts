import { keyCaller } from '~/auth/caller'
import { membershipModel } from '~/auth/models'
import type { ConsoleRouter } from '~/console/context'
import { lines, parseJsonObject, value } from '~/console/forms'
import { html } from '~/console/html'
import { badge, destroy, emptyState, formFooter, header, listCard, searchForm, when } from '~/console/ui'

const USERS = '/console/auth/users'
const TEAMS = '/console/auth/teams'

export function teamPages(router: ConsoleRouter): void {
  router.get(TEAMS, ({ ctx, url }) => {
    const search = url.searchParams.get('search') ?? ''
    const { total, teams } = ctx.services.teams.list(
      keyCaller(),
      [JSON.stringify({ method: 'orderDesc', attribute: '$createdAt' }), JSON.stringify({ method: 'limit', values: [100] })],
      search || undefined,
    )
    const body = teams.length
      ? html`<div class="scroll"><table><thead><tr><th>Name</th><th class="hide-sm">ID</th><th class="num">Members</th><th class="hide-sm">Created</th></tr></thead><tbody>
          ${teams.map((t) => html`<tr class="row-link" onclick="location='${TEAMS}/${t.id}'"><td><a href="${TEAMS}/${t.id}">${t.name}</a></td><td class="mono hide-sm">${t.id}</td><td class="num">${t.total}</td><td class="hide-sm">${when(t.created_at)}</td></tr>`)}
          </tbody></table></div>${total > 100 ? html`<div class="pager subdued">Showing 100 of ${total}. Search to narrow down.</div>` : ''}`
      : emptyState(search ? 'No teams match' : 'No teams yet', 'In Pesanle each shop is a team.')
    return ctx.render(
      'Teams',
      'teams',
      html`${header('Teams', { actions: html`<a class="btn primary" href="${TEAMS}/new">Create team</a>` })}
      ${listCard('teams', { toolbar: searchForm({ action: TEAMS, target: 'teams', value: search, placeholder: 'Search teams' }), body })}`,
    )
  })

  router.get(`${TEAMS}/new`, ({ ctx }) =>
    ctx.render(
      'Create team',
      'teams',
      html`${header('Create team', { back: TEAMS })}
      <form method="post" action="${TEAMS}" class="card">
        <div class="fields"><label>Name<input name="name" required></label><label>ID<input name="id" class="mono" value="unique()"></label></div>
        ${formFooter(TEAMS, 'Create')}
      </form>`,
    ),
  )

  router.post(TEAMS, ({ ctx }) => {
    const team = ctx.services.teams.create(keyCaller(), { teamId: value(ctx.form, 'id') || 'unique()', name: ctx.form.name, roles: undefined })
    return ctx.go(`${TEAMS}/${team.id}`, { tone: 'success', text: 'Team created' })
  })

  router.get(`${TEAMS}/:id`, ({ ctx, path }) => {
    const t = ctx.services.teams.team(path.id!)
    const members = ctx.services.teams.listMemberships({ teamId: t.id }, [JSON.stringify({ method: 'limit', values: [500] })]).memberships.map(membershipModel)
    const base = `${TEAMS}/${t.id}`
    return ctx.render(
      t.name,
      'teams',
      html`${header(t.name, { back: TEAMS, badges: [badge(`${t.total} member${t.total === 1 ? '' : 's'}`)] })}
      <div class="layout">
        <div class="card flush">
          ${members.length
            ? html`<div class="scroll"><table><thead><tr><th>Member</th><th>Roles</th><th class="hide-sm">Status</th><th></th></tr></thead><tbody>
              ${members.map((m) => html`<tr><td><a href="${USERS}/${m.userId}">${m.userName || m.userEmail || m.userId}</a><div class="subdued">${m.userEmail}</div></td>
                <td><form method="post" action="${base}/members/${m.$id}" style="display:flex;gap:6px"><input name="roles" value="${m.roles.join(', ')}" style="min-width:120px"><button class="small">Save</button></form></td>
                <td class="hide-sm">${m.confirm ? badge('Joined', 'success') : badge('Invited', 'attention')}</td>
                <td class="num">${destroy(`${base}/members/${m.$id}/delete`, 'Remove', `Remove ${m.userName || m.userEmail} from ${t.name}?`)}</td></tr>`)}
              </tbody></table></div>`
            : emptyState('No members', 'Add someone by email or user ID.')}
        </div>
        <div>
          <form method="post" action="${base}/members" class="card"><h2>Add member</h2>
            <label>Email or user ID<input name="who" required></label>
            <label>Roles<input name="roles" placeholder="owner, admin, staff"><small>Comma-separated. Pesanle uses owner, admin and staff.</small></label>
            <p class="help">Added straight away, without an invitation email.</p>
            <div class="foot"><button class="primary">Add</button></div>
          </form>
          <form method="post" action="${base}" class="card"><h2>Team</h2>
            <label>Name<input name="name" value="${t.name}" required></label>
            <label>Preferences<textarea name="prefs" class="mono">${JSON.stringify(JSON.parse(t.prefs), null, 2)}</textarea></label>
            <div class="foot"><button>Save</button></div>
          </form>
          <div class="card"><h2>Delete team</h2><p class="hint">Members lose the roles this team gives them.</p>${destroy(`${base}/delete`, 'Delete team', `Delete ${t.name}?`)}</div>
        </div>
      </div>`,
    )
  })

  router.post(`${TEAMS}/:id`, ({ ctx, path }) => {
    const prefs = parseJsonObject(ctx.form.prefs, 'Preferences must be a JSON object.')
    ctx.services.teams.update(path.id!, { name: value(ctx.form, 'name').slice(0, 128), prefs: JSON.stringify(prefs) })
    return ctx.go(`${TEAMS}/${path.id}`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${TEAMS}/:id/members`, async ({ ctx, path }) => {
    const who = value(ctx.form, 'who')
    await ctx.services.teams.createMembership(keyCaller(), path.id!, { ...(who.includes('@') ? { email: who } : { userId: who }), roles: lines(ctx.form.roles) })
    return ctx.go(`${TEAMS}/${path.id}`, { tone: 'success', text: 'Member added' })
  })

  router.post(`${TEAMS}/:id/members/:mid`, ({ ctx, path }) => {
    ctx.services.teams.updateMembership(keyCaller(), path.id!, path.mid!, lines(ctx.form.roles))
    return ctx.go(`${TEAMS}/${path.id}`, { tone: 'success', text: 'Roles saved' })
  })

  router.post(`${TEAMS}/:id/members/:mid/delete`, ({ ctx, path }) => {
    ctx.services.teams.deleteMembership(keyCaller(), path.id!, path.mid!)
    return ctx.go(`${TEAMS}/${path.id}`, { tone: 'success', text: 'Member removed' })
  })

  router.post(`${TEAMS}/:id/delete`, ({ ctx, path }) => {
    ctx.services.teams.delete(path.id!)
    return ctx.go(TEAMS, { tone: 'success', text: 'Team deleted' })
  })
}
