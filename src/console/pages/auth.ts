import { keyCaller } from '../../auth/caller'
import { membershipModel, userModel, type UserRowFull } from '../../auth/models'
import { validEmail, validPhone } from '../../auth/service'
import { err } from '../../lib/errors'
import { go, type ConsoleRouter } from '../app'
import { html } from '../html'
import { badge, destroy, emptyState, header, when } from '../layout'

const USERS = '/console/auth/users'
const TEAMS = '/console/auth/teams'
const checked = (v: unknown) => v === 'on' || v === 'true'
const list = (v: unknown) => String(v ?? '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean)

function userStatus(u: UserRowFull) {
  return [
    u.status ? badge('Active', 'success') : badge('Blocked', 'critical'),
    u.email && !u.email_verification ? badge('Unverified', 'attention') : '',
  ]
}

export function authPages(router: ConsoleRouter): void {
  // ---------------------------------------------------------------- users
  router.get(USERS, ({ ctx, url }) => {
    const search = url.searchParams.get('search') ?? ''
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
    const limit = 25
    const { total, users } = ctx.services.auth.listUsers(
      [JSON.stringify({ method: 'orderDesc', attribute: '$createdAt' }), JSON.stringify({ method: 'limit', values: [limit] }), JSON.stringify({ method: 'offset', values: [(page - 1) * limit] })],
      search || undefined,
    )
    const pages = Math.max(1, Math.ceil(total / limit))
    return ctx.render(
      'Users',
      'users',
      html`${header('Users', { actions: html`<a class="btn primary" href="${USERS}/new">Create user</a>` })}
      <div class="card flush" id="users">
        <form class="toolbar" method="get" action="${USERS}" hx-get="${USERS}" hx-target="#users" hx-select="#users" hx-swap="outerHTML" hx-push-url="true" hx-trigger="submit, input changed delay:300ms from:find input">
          <input type="search" name="search" value="${search}" placeholder="Search name, email, phone or ID" autocomplete="off">
        </form>
        ${users.length
          ? html`<div class="scroll"><table><thead><tr><th>Name</th><th>Email</th><th class="hide-sm">Phone</th><th>Status</th><th class="hide-sm">Joined</th></tr></thead><tbody>
            ${users.map((u) => html`<tr class="row-link" onclick="location='${USERS}/${u.id}'"><td><a href="${USERS}/${u.id}">${u.name || html`<span class="subdued">No name</span>`}</a></td>
              <td class="clip">${u.email ?? ''}</td><td class="hide-sm">${u.phone ?? ''}</td><td>${userStatus(u)}</td><td class="hide-sm">${when(u.registration)}</td></tr>`)}
            </tbody></table></div>
            ${pages > 1 ? html`<div class="pager">${page > 1 ? html`<a class="btn" href="?search=${encodeURIComponent(search)}&page=${page - 1}">Previous</a>` : ''}<span class="subdued">Page ${page} of ${pages}</span>${page < pages ? html`<a class="btn" href="?search=${encodeURIComponent(search)}&page=${page + 1}">Next</a>` : ''}</div>` : ''}`
          : emptyState(search ? 'No users match' : 'No users yet', search ? 'Try another name or email.' : 'People appear here when they sign up in your apps.')}
      </div>`,
    )
  })

  router.get(`${USERS}/new`, ({ ctx }) =>
    ctx.render(
      'Create user',
      'users',
      html`${header('Create user', { back: USERS })}
      <form method="post" action="${USERS}" class="card">
        <div class="fields"><label>Name<input name="name"></label><label>Email<input name="email" type="email"></label></div>
        <div class="fields"><label>Phone<input name="phone" placeholder="+62…"></label><label>Password<input name="password" type="password" minlength="8"><small>Optional. At least 8 characters.</small></label></div>
        <div class="foot"><a class="btn" href="${USERS}">Cancel</a><button class="primary">Create</button></div>
      </form>`,
    ),
  )

  router.post(USERS, async ({ ctx, request }) => {
    const f = ctx.form
    const user = await ctx.services.auth.createUser({ email: f.email || undefined, phone: f.phone || undefined, password: f.password || undefined, name: f.name })
    return go(request, `${USERS}/${user.id}`, { tone: 'success', text: 'User created' })
  })

  router.get(`${USERS}/:id`, ({ ctx, path }) => {
    const u = ctx.services.auth.user(path.id!)
    const sessions = ctx.services.auth.sessions(u.id)
    const memberships = ctx.services.teams.listMemberships({ userId: u.id }, [JSON.stringify({ method: 'limit', values: [100] })]).memberships.map(membershipModel)
    const identities = ctx.services.db.sqlite.query<any, [string]>('SELECT provider, provider_email, created_at FROM _identities WHERE user_id = ?').all(u.id)
    const model = userModel(u) as Record<string, any>
    const base = `${USERS}/${u.id}`
    return ctx.render(
      u.name || u.email || u.id,
      'users',
      html`${header(u.name || u.email || u.id, { back: USERS, badges: userStatus(u) })}
      <div class="layout">
        <div>
          <form method="post" action="${base}" class="card">
            <h2>Profile</h2>
            <div class="fields"><label>Name<input name="name" value="${u.name}"></label><label>Email<input name="email" type="email" value="${u.email ?? ''}"></label></div>
            <div class="fields"><label>Phone<input name="phone" value="${u.phone ?? ''}"></label><label>Labels<input name="labels" value="${model.labels.join(', ')}"><small>Comma-separated. Grant <code>label:…</code> roles.</small></label></div>
            <label class="check"><input type="checkbox" name="emailVerification" ${u.email_verification ? 'checked' : ''}>Email verified</label>
            <label class="check"><input type="checkbox" name="phoneVerification" ${u.phone_verification ? 'checked' : ''}>Phone verified</label>
            <div class="foot"><button class="primary">Save</button></div>
          </form>
          <form method="post" action="${base}/prefs" class="card">
            <h2>Preferences</h2>
            <textarea name="prefs" class="mono">${JSON.stringify(model.prefs, null, 2)}</textarea>
            <div class="foot"><button>Save preferences</button></div>
          </form>
          <div class="card flush">
            <div class="toolbar"><h2 style="margin:0">Sessions</h2>${sessions.length ? html`<span class="right" style="margin-left:auto">${destroy(`${base}/sessions/delete`, 'Sign out everywhere', 'End every session of this user?')}</span>` : ''}</div>
            ${sessions.length
              ? html`<div class="scroll"><table><thead><tr><th>Provider</th><th class="hide-sm">IP</th><th>Created</th><th class="hide-sm">Expires</th><th></th></tr></thead><tbody>
                ${sessions.map((s) => html`<tr><td>${s.provider}</td><td class="hide-sm mono">${s.ip || '—'}</td><td>${when(s.created_at)}</td><td class="hide-sm">${when(s.expire)}</td>
                  <td class="num">${destroy(`${base}/sessions/delete`, 'End', 'End this session?', { sessionId: s.id })}</td></tr>`)}</tbody></table></div>`
              : emptyState('No active sessions', 'The user is signed out everywhere.')}
          </div>
        </div>
        <div>
          <div class="card"><h2>Status</h2>
            <p class="hint">${u.status ? 'The user can sign in.' : 'Blocked users cannot sign in or use existing sessions.'}</p>
            <form method="post" action="${base}/status"><input type="hidden" name="status" value="${u.status ? '' : 'on'}"><button class="${u.status ? 'critical' : ''}">${u.status ? 'Block user' : 'Unblock user'}</button></form>
          </div>
          <form method="post" action="${base}/password" class="card"><h2>Password</h2>
            <label>New password<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
            <div class="foot"><button>Set password</button></div>
          </form>
          <div class="card"><h2>Teams</h2>
            ${memberships.length ? html`<ul class="list">${memberships.map((m) => html`<li><a href="${TEAMS}/${m.teamId}">${m.teamName}</a><span class="subdued">${m.roles.join(', ') || 'member'}</span></li>`)}</ul>` : html`<p class="subdued" style="margin:0">Not in any team.</p>`}
          </div>
          <div class="card"><h2>Details</h2><ul class="list">
            <li><span class="subdued">ID</span><span class="mono">${u.id}</span></li>
            <li><span class="subdued">Joined</span><span>${when(u.registration)}</span></li>
            <li><span class="subdued">Last seen</span><span>${when(u.accessed_at)}</span></li>
            <li><span class="subdued">Password</span><span>${u.password ? `${u.hash}` : 'None'}</span></li>
            ${identities.map((i) => html`<li><span class="subdued">${i.provider}</span><span>${i.provider_email}</span></li>`)}
          </ul></div>
          <div class="card"><h2>Delete user</h2><p class="hint">Removes the account, its sessions and team memberships.</p>
            ${destroy(`${base}/delete`, 'Delete user', 'Delete this user? This cannot be undone.')}</div>
        </div>
      </div>`,
    )
  })

  router.post(`${USERS}/:id`, ({ ctx, path, request }) => {
    const f = ctx.form
    const labels = list(f.labels)
    if (labels.some((l) => !/^[a-zA-Z0-9]{1,36}$/.test(l))) throw err('general_argument_invalid', 'Labels may only contain letters and digits.')
    ctx.services.auth.updateUser(path.id!, {
      name: String(f.name ?? '').slice(0, 128),
      email: f.email ? validEmail(f.email) : null,
      phone: f.phone ? validPhone(f.phone, 'phone') : null,
      labels: JSON.stringify([...new Set(labels)]),
      email_verification: checked(f.emailVerification) ? 1 : 0,
      phone_verification: checked(f.phoneVerification) ? 1 : 0,
    })
    return go(request, `${USERS}/${path.id}`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${USERS}/:id/prefs`, ({ ctx, path, request }) => {
    let prefs: unknown
    try {
      prefs = JSON.parse(String(ctx.form.prefs || '{}'))
    } catch {
      throw err('general_argument_invalid', 'Preferences must be a JSON object.')
    }
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw err('general_argument_invalid', 'Preferences must be a JSON object.')
    ctx.services.auth.updateUser(path.id!, { prefs: JSON.stringify(prefs) })
    return go(request, `${USERS}/${path.id}`, { tone: 'success', text: 'Preferences saved' })
  })

  router.post(`${USERS}/:id/status`, ({ ctx, path, request }) => {
    const active = checked(ctx.form.status)
    ctx.services.auth.updateUser(path.id!, { status: active ? 1 : 0 })
    return go(request, `${USERS}/${path.id}`, { tone: 'success', text: active ? 'User unblocked' : 'User blocked' })
  })

  router.post(`${USERS}/:id/password`, async ({ ctx, path, request }) => {
    await ctx.services.auth.setPassword(path.id!, ctx.form.password)
    return go(request, `${USERS}/${path.id}`, { tone: 'success', text: 'Password set' })
  })

  router.post(`${USERS}/:id/sessions/delete`, ({ ctx, path, request }) => {
    if (ctx.form.sessionId) ctx.services.auth.deleteSession(path.id!, String(ctx.form.sessionId))
    else ctx.services.auth.deleteSessions(path.id!)
    return go(request, `${USERS}/${path.id}`, { tone: 'success', text: 'Signed out' })
  })

  router.post(`${USERS}/:id/delete`, ({ ctx, path, request }) => {
    ctx.services.auth.deleteUser(path.id!)
    return go(request, USERS, { tone: 'success', text: 'User deleted' })
  })

  // ---------------------------------------------------------------- teams
  router.get(TEAMS, ({ ctx, url }) => {
    const search = url.searchParams.get('search') ?? ''
    const { total, teams } = ctx.services.teams.list(keyCaller(), [JSON.stringify({ method: 'orderDesc', attribute: '$createdAt' }), JSON.stringify({ method: 'limit', values: [100] })], search || undefined)
    return ctx.render(
      'Teams',
      'teams',
      html`${header('Teams', { actions: html`<a class="btn primary" href="${TEAMS}/new">Create team</a>` })}
      <div class="card flush" id="teams">
        <form class="toolbar" method="get" action="${TEAMS}" hx-get="${TEAMS}" hx-target="#teams" hx-select="#teams" hx-swap="outerHTML" hx-push-url="true" hx-trigger="submit, input changed delay:300ms from:find input">
          <input type="search" name="search" value="${search}" placeholder="Search teams" autocomplete="off">
        </form>
        ${teams.length
          ? html`<div class="scroll"><table><thead><tr><th>Name</th><th class="hide-sm">ID</th><th class="num">Members</th><th class="hide-sm">Created</th></tr></thead><tbody>
            ${teams.map((t) => html`<tr class="row-link" onclick="location='${TEAMS}/${t.id}'"><td><a href="${TEAMS}/${t.id}">${t.name}</a></td><td class="mono hide-sm">${t.id}</td><td class="num">${t.total}</td><td class="hide-sm">${when(t.created_at)}</td></tr>`)}
            </tbody></table></div>${total > 100 ? html`<div class="pager subdued">Showing 100 of ${total}. Search to narrow down.</div>` : ''}`
          : emptyState(search ? 'No teams match' : 'No teams yet', 'In Pesanle each shop is a team.')}
      </div>`,
    )
  })

  router.get(`${TEAMS}/new`, ({ ctx }) =>
    ctx.render(
      'Create team',
      'teams',
      html`${header('Create team', { back: TEAMS })}
      <form method="post" action="${TEAMS}" class="card">
        <div class="fields"><label>Name<input name="name" required></label><label>ID<input name="id" class="mono" value="unique()"></label></div>
        <div class="foot"><a class="btn" href="${TEAMS}">Cancel</a><button class="primary">Create</button></div>
      </form>`,
    ),
  )

  router.post(TEAMS, ({ ctx, request }) => {
    const team = ctx.services.teams.create(keyCaller(), { teamId: ctx.form.id || 'unique()', name: ctx.form.name, roles: undefined })
    return go(request, `${TEAMS}/${team.id}`, { tone: 'success', text: 'Team created' })
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

  router.post(`${TEAMS}/:id`, ({ ctx, path, request }) => {
    let prefs: unknown
    try {
      prefs = JSON.parse(String(ctx.form.prefs || '{}'))
    } catch {
      throw err('general_argument_invalid', 'Preferences must be a JSON object.')
    }
    ctx.services.teams.update(path.id!, { name: String(ctx.form.name ?? '').slice(0, 128), prefs: JSON.stringify(prefs) })
    return go(request, `${TEAMS}/${path.id}`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${TEAMS}/:id/members`, async ({ ctx, path, request }) => {
    const who = String(ctx.form.who ?? '').trim()
    await ctx.services.teams.createMembership(keyCaller(), path.id!, { ...(who.includes('@') ? { email: who } : { userId: who }), roles: list(ctx.form.roles) })
    return go(request, `${TEAMS}/${path.id}`, { tone: 'success', text: 'Member added' })
  })

  router.post(`${TEAMS}/:id/members/:mid`, ({ ctx, path, request }) => {
    ctx.services.teams.updateMembership(keyCaller(), path.id!, path.mid!, list(ctx.form.roles))
    return go(request, `${TEAMS}/${path.id}`, { tone: 'success', text: 'Roles saved' })
  })

  router.post(`${TEAMS}/:id/members/:mid/delete`, ({ ctx, path, request }) => {
    ctx.services.teams.deleteMembership(keyCaller(), path.id!, path.mid!)
    return go(request, `${TEAMS}/${path.id}`, { tone: 'success', text: 'Member removed' })
  })

  router.post(`${TEAMS}/:id/delete`, ({ ctx, path, request }) => {
    ctx.services.teams.delete(path.id!)
    return go(request, TEAMS, { tone: 'success', text: 'Team deleted' })
  })
}
