import { membershipModel, userModel, type UserRowFull } from '~/auth/models'
import { validEmail, validPhone } from '~/auth/service'
import { err } from '~/lib/errors'
import type { ConsoleRouter } from '~/console/context'
import { checked, lines, parseJsonObject, value } from '~/console/forms'
import { html, type Html } from '~/console/html'
import { listQueries, pageCount, pageParams } from '~/console/query'
import { avatar, badge, copyableId, destroy, emptyState, header, icon, listCard, pageFooter, pager, searchForm, settingsSection, tabs, when } from '~/console/ui'

const USERS = '/console/auth/users'
const TEAMS = '/console/auth/teams'

const userUrl = (id: string) => `${USERS}/${encodeURIComponent(id)}`
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

function userStatus(u: UserRowFull) {
  return [u.status ? badge('Active', 'success') : badge('Blocked', 'critical'), u.email && !u.email_verification ? badge('Unverified', 'attention') : '']
}

function userHeader(u: UserRowFull): Html {
  return header(u.name || u.email || u.id, { back: USERS })
}

const userTabs = (id: string, on: 'profile' | 'settings') =>
  tabs(
    [
      { key: 'profile', label: 'Profile', href: userUrl(id) },
      { key: 'settings', label: 'Settings', href: `${userUrl(id)}/settings` },
    ],
    on,
  )

export function userPages(router: ConsoleRouter): void {
  router.get(USERS, ({ ctx, url }) => {
    const search = url.searchParams.get('search') ?? ''
    const { page, limit } = pageParams(url)
    const { total, users } = ctx.services.auth.listUsers(listQueries(page, limit), search || undefined)
    const pages = pageCount(total, limit)
    const create = html`<a class="btn primary" href="${USERS}/new">${icon('plus')}<span>Create user</span></a>`
    const body = users.length
      ? html`<div class="scroll"><table><thead><tr><th>User</th><th class="hide-sm">Phone</th><th>Status</th><th class="hide-sm">Joined</th></tr></thead><tbody>
          ${users.map((u) => html`<tr class="row-link" onclick="location='${userUrl(u.id)}'"><td><div class="member-cell">${avatar(u.name || u.email || u.id)}<div><a href="${userUrl(u.id)}"><b>${u.name || html`<span class="subdued">No name</span>`}</b></a><div class="subdued">${u.email ?? u.phone ?? u.id}</div></div></div></td>
            <td class="hide-sm">${u.phone ?? html`<span class="subdued">—</span>`}</td><td>${userStatus(u)}</td><td class="hide-sm subdued">${when(u.registration)}</td></tr>`)}
          </tbody></table></div>`
      : search
        ? emptyState('No users match', 'Try another name, email, phone or ID.', html`<a class="btn" href="${USERS}">Clear search</a>`)
        : emptyState('No users yet', 'People appear here when they sign up in your apps, or when you create one.', create)
    return ctx.render(
      'Users',
      'users',
      html`${header('Users', { actions: users.length || search ? create : undefined })}
      ${listCard('users', {
        toolbar: searchForm({ action: USERS, target: 'users', value: search, placeholder: 'Search name, email, phone or ID' }),
        body,
        footer: pager({ page, pages, params: { search }, always: total > 0, label: `Page ${page} of ${pages} · ${plural(total, 'user')}` }),
      })}`,
    )
  })

  router.get(`${USERS}/new`, ({ ctx }) =>
    ctx.render(
      'Create user',
      'users',
      html`${header('Create user', { back: USERS })}
      <form method="post" action="${USERS}">
        ${settingsSection(
          'Profile',
          'The person can change these details later. At least an email or phone number is needed to sign in.',
          html`<div class="fields"><label>Name<input name="name"></label><label>Email<input name="email" type="email"></label></div>
            <div class="fields"><label>Phone<input name="phone" placeholder="+62…"></label><label>Password<input name="password" type="password" minlength="8"><small>Optional. At least 8 characters.</small></label></div>`,
        )}
        ${pageFooter(USERS, 'Create user')}
      </form>`,
    ),
  )

  router.post(USERS, async ({ ctx }) => {
    const f = ctx.form
    const user = await ctx.services.auth.createUser({ email: f.email || undefined, phone: f.phone || undefined, password: f.password || undefined, name: f.name })
    return ctx.go(userUrl(user.id), { tone: 'success', text: 'User created' })
  })

  router.get(`${USERS}/:id`, ({ ctx, path }) => {
    const u = ctx.services.auth.user(path.id!)
    const sessions = ctx.services.auth.sessions(u.id)
    const model = userModel(u) as Record<string, any>
    const base = userUrl(u.id)
    return ctx.render(
      u.name || u.email || u.id,
      'users',
      html`${userHeader(u)}${userTabs(u.id, 'profile')}
      ${settingsSection(
        'Profile',
        'The name and contact details shown across the console and in your apps.',
        html`<form method="post" action="${base}">
          <div class="fields"><label>Name<input name="name" value="${u.name}"></label><label>Email<input name="email" type="email" value="${u.email ?? ''}"></label></div>
          <div class="fields"><label>Phone<input name="phone" value="${u.phone ?? ''}"></label><label>Labels<input name="labels" value="${model.labels.join(', ')}"><small>Comma-separated. Grant <code>label:…</code> roles.</small></label></div>
          <div class="fields"><label class="check"><input type="checkbox" name="emailVerification" ${u.email_verification ? 'checked' : ''}>Email verified</label>
            <label class="check"><input type="checkbox" name="phoneVerification" ${u.phone_verification ? 'checked' : ''}>Phone verified</label></div>
          <div class="foot"><button class="primary">Save</button></div>
        </form>`,
        { id: 'user-profile' },
      )}
      ${settingsSection(
        'Preferences',
        'App-specific settings stored as JSON. Your apps read these values for this user.',
        html`<form method="post" action="${base}/prefs">
          <textarea name="prefs" class="mono" spellcheck="false">${JSON.stringify(model.prefs, null, 2)}</textarea>
          <div class="foot"><button class="primary">Save preferences</button></div>
        </form>`,
      )}
      ${listCard('sessions', {
        toolbar: html`<div class="toolbar"><h2 style="margin:0">Sessions</h2>${sessions.length ? html`<span style="margin-left:auto">${destroy(`${base}/sessions/delete`, 'Sign out everywhere', 'End every session of this user?')}</span>` : ''}</div>`,
        body: sessions.length
          ? html`<div class="scroll"><table><thead><tr><th>Provider</th><th class="hide-sm">IP</th><th>Created</th><th class="hide-sm">Expires</th><th></th></tr></thead><tbody>
            ${sessions.map((s) => html`<tr><td>${s.provider}</td><td class="hide-sm mono">${s.ip || '—'}</td><td>${when(s.created_at)}</td><td class="hide-sm subdued">${when(s.expire)}</td>
              <td class="num">${destroy(`${base}/sessions/delete`, 'End', 'End this session?', { sessionId: s.id })}</td></tr>`)}</tbody></table></div>`
          : emptyState('No active sessions', 'The user is signed out everywhere.'),
      })}`,
    )
  })

  router.get(`${USERS}/:id/settings`, ({ ctx, path }) => {
    const u = ctx.services.auth.user(path.id!)
    const memberships = ctx.services.teams.listMemberships({ userId: u.id }, [JSON.stringify({ method: 'limit', values: [100] })]).memberships.map(membershipModel)
    const identities = ctx.services.auth.identities(u.id)
    const base = userUrl(u.id)
    return ctx.render(
      u.name || u.email || u.id,
      'users',
      html`${userHeader(u)}${userTabs(u.id, 'settings')}
      ${settingsSection(
        'Status',
        u.status ? 'The user can sign in and use their existing sessions.' : 'Blocked users cannot sign in or use existing sessions.',
        html`<form method="post" action="${base}/status"><input type="hidden" name="status" value="${u.status ? '' : 'on'}"><button class="${u.status ? 'critical' : ''}">${u.status ? 'Block user' : 'Unblock user'}</button></form>`,
      )}
      ${settingsSection(
        'Password',
        'Set a new password for this user. They can sign in with it straight away.',
        html`<form method="post" action="${base}/password"><label>New password<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
          <div class="foot"><button class="primary">Set password</button></div></form>`,
      )}
      ${settingsSection(
        'Teams',
        'Teams this user belongs to, and the roles they get from each one.',
        memberships.length
          ? html`<ul class="list">${memberships.map((m) => html`<li><a href="${TEAMS}/${encodeURIComponent(m.teamId)}">${m.teamName}</a><span class="subdued">${m.roles.join(', ') || 'member'}</span></li>`)}</ul>`
          : html`<p class="subdued" style="margin:0">Not in any team.</p>`,
      )}
      ${settingsSection(
        'Account details',
        'Read-only information about this account and how it signs in.',
        html`<ul class="list">
          <li><span class="subdued">ID</span>${copyableId(u.id, 'user-id-label')}</li>
          <li><span class="subdued">Joined</span><span>${when(u.registration)}</span></li>
          <li><span class="subdued">Last seen</span><span>${when(u.accessed_at)}</span></li>
          <li><span class="subdued">Password</span><span>${u.password ? 'Set' : 'None'}</span></li>
          ${identities.map((i) => html`<li><span class="subdued">${i.provider}</span><span>${i.provider_email}</span></li>`)}
        </ul>`,
      )}
      ${settingsSection(
        'Delete user',
        'Permanently removes the account, its sessions and its team memberships. This cannot be undone.',
        destroy(`${base}/delete`, 'Delete user', 'Delete this user? This cannot be undone.'),
      )}`,
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
    return ctx.go(userUrl(path.id!), { tone: 'success', text: 'Saved' })
  })

  router.post(`${USERS}/:id/prefs`, ({ ctx, path }) => {
    ctx.services.auth.updateUser(path.id!, { prefs: JSON.stringify(parseJsonObject(ctx.form.prefs, 'Preferences must be a JSON object.')) })
    return ctx.go(userUrl(path.id!), { tone: 'success', text: 'Preferences saved' })
  })

  router.post(`${USERS}/:id/status`, ({ ctx, path }) => {
    const active = checked(ctx.form.status)
    ctx.services.auth.updateUser(path.id!, { status: active ? 1 : 0 })
    return ctx.go(`${userUrl(path.id!)}/settings`, { tone: 'success', text: active ? 'User unblocked' : 'User blocked' })
  })

  router.post(`${USERS}/:id/password`, async ({ ctx, path }) => {
    await ctx.services.auth.setPassword(path.id!, ctx.form.password)
    return ctx.go(`${userUrl(path.id!)}/settings`, { tone: 'success', text: 'Password set' })
  })

  router.post(`${USERS}/:id/sessions/delete`, ({ ctx, path }) => {
    const sessionId = value(ctx.form, 'sessionId')
    if (sessionId) ctx.services.auth.deleteSession(path.id!, sessionId)
    else ctx.services.auth.deleteSessions(path.id!)
    return ctx.go(userUrl(path.id!), { tone: 'success', text: 'Signed out' })
  })

  router.post(`${USERS}/:id/delete`, ({ ctx, path }) => {
    ctx.services.auth.deleteUser(path.id!)
    return ctx.go(USERS, { tone: 'success', text: 'User deleted' })
  })
}
