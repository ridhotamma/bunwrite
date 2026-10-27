import { keyCaller } from '~/auth/caller'
import { membershipModel } from '~/auth/models'
import type { ConsoleRouter } from '~/console/context'
import { dialog } from '~/console/dialog'
import { lines, parseJsonObject, value } from '~/console/forms'
import { html, type Html } from '~/console/html'
import { listQueries, pageCount, pageParams } from '~/console/query'
import { avatar, badge, copyableId, destroy, emptyState, header, icon, listCard, pageFooter, pager, searchForm, settingsSection, tabs, when } from '~/console/ui'

const USERS = '/console/auth/users'
const TEAMS = '/console/auth/teams'

const teamUrl = (id: string) => `${TEAMS}/${encodeURIComponent(id)}`
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

const teamTabs = (id: string, on: 'members' | 'settings') =>
  tabs(
    [
      { key: 'members', label: 'Members', href: teamUrl(id) },
      { key: 'settings', label: 'Settings', href: `${teamUrl(id)}/settings` },
    ],
    on,
  )

const teamHeader = (t: { id: string; name: string; total?: number }, actions?: Html): Html =>
  header(t.name, {
    back: TEAMS,
    subtitle: html`${copyableId(t.id, 'team-id-label')}<span class="dot" aria-hidden="true">·</span><span>${plural(t.total ?? 0, 'member')}</span>`,
    actions,
  })

function memberFields(): Html {
  return html`<label>Email or user ID<input name="who" required autofocus placeholder="name@example.com"></label>
    <label>Roles<input name="roles" placeholder="owner, admin, member"><small>Comma-separated.</small></label>
    <p class="help">The member is added straight away, without an invitation email.</p>`
}

function addMemberDialog(t: { id: string; name: string }): Html {
  return dialog({
    id: 'add-member',
    title: `Add member to ${t.name}`,
    body: html`<form id="add-member-form" method="post" action="${teamUrl(t.id)}/members" class="stack-fields">${memberFields()}</form>`,
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="add-member-form" class="primary">Add member</button>`,
  })
}

export function teamPages(router: ConsoleRouter): void {
  router.get(TEAMS, ({ ctx, url }) => {
    const search = url.searchParams.get('search') ?? ''
    const { page, limit } = pageParams(url)
    const { total, teams } = ctx.services.teams.list(keyCaller(), listQueries(page, limit), search || undefined)
    const pages = pageCount(total, limit)
    const create = html`<a class="btn primary" href="${TEAMS}/new">${icon('plus')}<span>Create team</span></a>`
    const body = teams.length
      ? html`<div class="scroll"><table><thead><tr><th>Team</th><th class="num">Members</th><th class="hide-sm">Created</th></tr></thead><tbody>
          ${teams.map((t) => html`<tr class="row-link" onclick="location='${teamUrl(t.id)}'"><td><a href="${teamUrl(t.id)}">${t.name}</a><div class="mono subdued cell-sub">${t.id}</div></td><td class="num">${(t.total ?? 0).toLocaleString('en-US')}</td><td class="hide-sm subdued">${when(t.created_at)}</td></tr>`)}
          </tbody></table></div>`
      : search
        ? emptyState('No teams match', 'Try another name or ID.', html`<a class="btn" href="${TEAMS}">Clear search</a>`)
        : emptyState('No teams yet', 'Teams group users and give them roles across your apps.', create)
    return ctx.render(
      'Teams',
      'teams',
      html`${header('Teams', { actions: teams.length || search ? create : undefined })}
      ${listCard('teams', {
        toolbar: searchForm({ action: TEAMS, target: 'teams', value: search, placeholder: 'Search teams' }),
        body,
        footer: pager({ page, pages, params: { search }, always: total > 0, label: `Page ${page} of ${pages} · ${plural(total, 'team')}` }),
      })}`,
    )
  })

  router.get(`${TEAMS}/new`, ({ ctx }) =>
    ctx.render(
      'Create team',
      'teams',
      html`${header('Create team', { back: TEAMS })}
      <form method="post" action="${TEAMS}">
        ${settingsSection(
          'General',
          'Teams group users so you can share roles and permissions with everyone in them.',
          html`<div class="fields"><label>Name<input name="name" required data-slug-source autofocus placeholder="Support"></label><label>ID<input name="id" class="mono" value="unique()"><small>Leave <code>unique()</code> to generate one.</small></label></div>`,
        )}
        ${pageFooter(TEAMS, 'Create team')}
      </form>`,
    ),
  )

  router.post(TEAMS, ({ ctx }) => {
    const team = ctx.services.teams.create(keyCaller(), { teamId: value(ctx.form, 'id') || 'unique()', name: ctx.form.name, roles: undefined })
    return ctx.go(teamUrl(team.id), { tone: 'success', text: 'Team created' })
  })

  router.get(`${TEAMS}/:id`, ({ ctx, path }) => {
    const t = ctx.services.teams.team(path.id!)
    const members = ctx.services.teams.listMemberships({ teamId: t.id }, [JSON.stringify({ method: 'limit', values: [500] })]).memberships.map(membershipModel)
    const base = teamUrl(t.id)
    const add = html`<a class="btn primary" href="${base}/members/new" data-dialog-open="#add-member">${icon('plus')}<span>Add member</span></a>`
    return ctx.render(
      t.name,
      'teams',
      html`${teamHeader(t, members.length ? add : undefined)}${teamTabs(t.id, 'members')}
      ${listCard('members', {
        body: members.length
          ? html`<div class="scroll"><table><thead><tr><th>Member</th><th>Roles</th><th class="hide-sm">Status</th><th></th></tr></thead><tbody>
            ${members.map((m) => html`<tr><td><div class="member-cell">${avatar(m.userName || m.userEmail || m.userId)}<div><a href="${USERS}/${encodeURIComponent(m.userId)}"><b>${m.userName || m.userEmail || m.userId}</b></a><div class="subdued">${m.userEmail || m.userId}</div></div></div></td>
              <td><form method="post" action="${base}/members/${m.$id}" class="member-role"><input name="roles" value="${m.roles.join(', ')}" aria-label="Roles for ${m.userName || m.userEmail || m.userId}"><button class="small">Save</button></form></td>
              <td class="hide-sm">${m.confirm ? badge('Joined', 'success') : badge('Invited', 'attention')}</td>
              <td class="num">${destroy(`${base}/members/${m.$id}/delete`, 'Remove', `Remove ${m.userName || m.userEmail} from ${t.name}?`)}</td></tr>`)}
            </tbody></table></div>`
          : emptyState('No members yet', 'Add someone by email or user ID. They get this team’s roles straight away.', add),
      })}
      ${addMemberDialog(t)}`,
    )
  })

  // Without JavaScript the "Add member" link lands here instead of opening the dialog.
  router.get(`${TEAMS}/:id/members/new`, ({ ctx, path }) => {
    const t = ctx.services.teams.team(path.id!)
    return ctx.render(
      'Add member',
      'teams',
      html`${header('Add member', { back: teamUrl(t.id), subtitle: t.name })}
      <form method="post" action="${teamUrl(t.id)}/members" class="card narrow">
        ${memberFields()}
        <div class="foot"><a class="btn" href="${teamUrl(t.id)}">Cancel</a><button class="primary">Add member</button></div>
      </form>`,
    )
  })

  router.get(`${TEAMS}/:id/settings`, ({ ctx, path }) => {
    const t = ctx.services.teams.team(path.id!)
    const base = teamUrl(t.id)
    return ctx.render(
      t.name,
      'teams',
      html`${teamHeader(t)}${teamTabs(t.id, 'settings')}
      ${settingsSection(
        'General',
        'The name shown across the console and in permissions.',
        html`<form method="post" action="${base}">
          <label>Name<input name="name" value="${t.name}" required></label>
          <label>ID<div class="copy-row"><input id="team-id" class="mono" readonly value="${t.id}"><button type="button" data-copy-target="#team-id">${icon('copy')}<span data-copy-label>Copy</span></button></div></label>
          <label>Preferences<textarea name="prefs" class="mono" spellcheck="false">${JSON.stringify(JSON.parse(t.prefs), null, 2)}</textarea><small>App-specific settings stored as JSON.</small></label>
          <div class="foot"><button class="primary">Save</button></div>
        </form>`,
        { id: 'team-general' },
      )}
      ${settingsSection(
        'Delete team',
        'Members lose the roles this team gives them. This cannot be undone.',
        destroy(`${base}/delete`, 'Delete team', `Delete ${t.name}?`),
      )}`,
    )
  })

  router.post(`${TEAMS}/:id`, ({ ctx, path }) => {
    const prefs = parseJsonObject(ctx.form.prefs, 'Preferences must be a JSON object.')
    ctx.services.teams.update(path.id!, { name: value(ctx.form, 'name').slice(0, 128), prefs: JSON.stringify(prefs) })
    return ctx.go(`${teamUrl(path.id!)}/settings`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${TEAMS}/:id/members`, async ({ ctx, path }) => {
    const who = value(ctx.form, 'who')
    await ctx.services.teams.createMembership(keyCaller(), path.id!, { ...(who.includes('@') ? { email: who } : { userId: who }), roles: lines(ctx.form.roles) })
    return ctx.go(teamUrl(path.id!), { tone: 'success', text: 'Member added' })
  })

  router.post(`${TEAMS}/:id/members/:mid`, ({ ctx, path }) => {
    ctx.services.teams.updateMembership(keyCaller(), path.id!, path.mid!, lines(ctx.form.roles))
    return ctx.go(teamUrl(path.id!), { tone: 'success', text: 'Roles saved' })
  })

  router.post(`${TEAMS}/:id/members/:mid/delete`, ({ ctx, path }) => {
    ctx.services.teams.deleteMembership(keyCaller(), path.id!, path.mid!)
    return ctx.go(teamUrl(path.id!), { tone: 'success', text: 'Member removed' })
  })

  router.post(`${TEAMS}/:id/delete`, ({ ctx, path }) => {
    ctx.services.teams.delete(path.id!)
    return ctx.go(TEAMS, { tone: 'success', text: 'Team deleted' })
  })
}
