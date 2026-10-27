import { membershipModel, userModel, type UserRowFull } from '~/auth/models'
import { validEmail, validPhone } from '~/auth/service'
import { err } from '~/lib/errors'
import type { ConsoleRouter } from '~/console/context'
import { checked, lines, parseJsonObject, value } from '~/console/forms'
import { html } from '~/console/html'
import { listQueries, pageCount, pageParams } from '~/console/query'
import { badge, destroy, emptyState, formFooter, header, listCard, pager, searchForm, when } from '~/console/ui'

const USERS = '/console/auth/users'
const TEAMS = '/console/auth/teams'

function userStatus(u: UserRowFull) {
  return [u.status ? badge('Active', 'success') : badge('Blocked', 'critical'), u.email && !u.email_verification ? badge('Unverified', 'attention') : '']
}

export function userPages(router: ConsoleRouter): void {
  router.get(USERS, ({ ctx, url }) => {
    const search = url.searchParams.get('search') ?? ''
    const { page, limit } = pageParams(url)
    const { total, users } = ctx.services.auth.listUsers(listQueries(page, limit), search || undefined)
    const pages = pageCount(total, limit)
    const body = users.length
      ? html`<div class="scroll"><table><thead><tr><th>Name</th><th>Email</th><th class="hide-sm">Phone</th><th>Status</th><th class="hide-sm">Joined</th></tr></thead><tbody>
          ${users.map((u) => html`<tr class="row-link" onclick="location='${USERS}/${u.id}'"><td><a href="${USERS}/${u.id}">${u.name || html`<span class="subdued">No name</span>`}</a></td>
            <td class="clip">${u.email ?? ''}</td><td class="hide-sm">${u.phone ?? ''}</td><td>${userStatus(u)}</td><td class="hide-sm">${when(u.registration)}</td></tr>`)}
          </tbody></table></div>`
      : emptyState(search ? 'No users match' : 'No users yet', search ? 'Try another name or email.' : 'People appear here when they sign up in your apps.')
    return ctx.render(
      'Users',
      'users',
      html`${header('Users', { actions: html`<a class="btn primary" href="${USERS}/new">Create user</a>` })}
      ${listCard('users', {
        toolbar: searchForm({ action: USERS, target: 'users', value: search, placeholder: 'Search name, email, phone or ID' }),
        body,
        footer: pager({ page, pages, params: { search } }),
      })}`,
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
        ${formFooter(USERS, 'Create')}
      </form>`,
    ),
  )

  router.post(USERS, async ({ ctx }) => {
    const f = ctx.form
    const user = await ctx.services.auth.createUser({ email: f.email || undefined, phone: f.phone || undefined, password: f.password || undefined, name: f.name })
    return ctx.go(`${USERS}/${user.id}`, { tone: 'success', text: 'User created' })
  })

  router.get(`${USERS}/:id`, ({ ctx, path }) => {
    const u = ctx.services.auth.user(path.id!)
    const sessions = ctx.services.auth.sessions(u.id)
    const memberships = ctx.services.teams.listMemberships({ userId: u.id }, [JSON.stringify({ method: 'limit', values: [100] })]).memberships.map(membershipModel)
    const identities = ctx.services.auth.identities(u.id)
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

  router.post(`${USERS}/:id`, ({ ctx, path }) => {
    const f = ctx.form
    const labels = lines(f.labels)
    if (labels.some((l) => !/^[a-zA-Z0-9]{1,36}$/.test(l))) throw err('general_argument_invalid', 'Labels may only contain letters and digits.')
    ctx.services.auth.updateUser(path.id!, {
      name: String(f.name ?? '').slice(0, 128),
      email: f.email ? validEmail(f.email) : null,
      phone: f.phone ? validPhone(f.phone, 'phone') : null,
      labels: JSON.stringify([...new Set(labels)]),
      email_verification: checked(f.emailVerification) ? 1 : 0,
      phone_verification: checked(f.phoneVerification) ? 1 : 0,
    })
    return ctx.go(`${USERS}/${path.id}`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${USERS}/:id/prefs`, ({ ctx, path }) => {
    ctx.services.auth.updateUser(path.id!, { prefs: JSON.stringify(parseJsonObject(ctx.form.prefs, 'Preferences must be a JSON object.')) })
    return ctx.go(`${USERS}/${path.id}`, { tone: 'success', text: 'Preferences saved' })
  })

  router.post(`${USERS}/:id/status`, ({ ctx, path }) => {
    const active = checked(ctx.form.status)
    ctx.services.auth.updateUser(path.id!, { status: active ? 1 : 0 })
    return ctx.go(`${USERS}/${path.id}`, { tone: 'success', text: active ? 'User unblocked' : 'User blocked' })
  })

  router.post(`${USERS}/:id/password`, async ({ ctx, path }) => {
    await ctx.services.auth.setPassword(path.id!, ctx.form.password)
    return ctx.go(`${USERS}/${path.id}`, { tone: 'success', text: 'Password set' })
  })

  router.post(`${USERS}/:id/sessions/delete`, ({ ctx, path }) => {
    const sessionId = value(ctx.form, 'sessionId')
    if (sessionId) ctx.services.auth.deleteSession(path.id!, sessionId)
    else ctx.services.auth.deleteSessions(path.id!)
    return ctx.go(`${USERS}/${path.id}`, { tone: 'success', text: 'Signed out' })
  })

  router.post(`${USERS}/:id/delete`, ({ ctx, path }) => {
    ctx.services.auth.deleteUser(path.id!)
    return ctx.go(USERS, { tone: 'success', text: 'User deleted' })
  })
}
