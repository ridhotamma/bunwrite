import { dialog } from '~/console/dialog'
import { html, type Html } from '~/console/html'
import { alert, avatar, badge, day, destroy, emptyState, icon, menu, settingsSection, tabs } from '~/console/ui'
import type { InviteResult, OrganizationInfo, OrganizationMember } from '~/organizations/service'
import { displayName } from '~/organizations/service'

export interface OrganizationCounts {
  projects: number
  /** Active members; pending invitations are not counted. */
  members: number
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Organization title and its Projects / Members / Settings tabs. */
export function organizationHeader(
  org: OrganizationInfo,
  counts: OrganizationCounts,
  active: 'projects' | 'members' | 'settings',
  canManage: boolean,
  actions?: Html,
): Html {
  return html`<div class="org-head">
    <span class="org-mark" aria-hidden="true">${(org.name.trim()[0] ?? 'O').toUpperCase()}</span>
    <div class="org-title">
      <h1>${org.name}</h1>
      <p class="subdued">${plural(counts.projects, 'project')} · ${plural(counts.members, 'member')}</p>
    </div>
    ${actions ? html`<div class="org-head-actions">${actions}</div>` : ''}
  </div>
  ${tabs(
    [
      { key: 'projects', label: 'Projects', href: '/console' },
      { key: 'members', label: 'Members', href: '/console/organization/members' },
      ...(canManage ? [{ key: 'settings', label: 'Settings', href: '/console/organization' }] : []),
    ],
    active,
  )}`
}

export function organizationGeneralView(org: OrganizationInfo): Html {
  return html`${settingsSection(
      'Organization name',
      'Shown to every member and in invitation emails.',
      html`<form method="post" action="/console/organization">
        <label>Name<input name="name" value="${org.name}" required maxlength="128"></label>
        <div class="foot"><button class="primary">Save</button></div>
      </form>`,
    )}
    ${settingsSection(
      'Organization ID',
      'Use this ID with the API, webhooks or SDKs. Support may ask for it.',
      html`<div class="copy-row"><input id="organization-id" class="mono" readonly value="${org.id}" aria-label="Organization ID"><button type="button" data-copy-target="#organization-id">${icon('copy')}<span data-copy-label>Copy</span></button></div>`,
    )}`
}

const roleLabel = (role: string) => (role === 'owner' ? 'Owner' : 'Developer')

function roleControl(member: OrganizationMember, ownerCount: number): Html {
  const id = encodeURIComponent(member.id)
  const lastOwner = member.role === 'owner' && ownerCount <= 1
  if (lastOwner) return html`<span title="An organization needs at least one owner">${roleLabel(member.role)}</span>`
  return html`<form method="post" action="/console/organization/members/${id}/role" class="role-form">
    <select name="role" aria-label="Role for ${member.name || member.email}" onchange="this.form.requestSubmit()">
      <option value="developer" ${member.role === 'developer' ? 'selected' : ''}>Developer</option>
      <option value="owner" ${member.role === 'owner' ? 'selected' : ''}>Owner</option>
    </select>
    <noscript><button class="small">Save</button></noscript>
  </form>`
}

function memberMenu(member: OrganizationMember, ownerCount: number): Html {
  if (member.role === 'owner' && ownerCount <= 1) return html``
  return menu(
    destroy(
      `/console/organization/members/${encodeURIComponent(member.id)}/delete`,
      'Remove member',
      `Remove ${member.name || member.email} from the organization? They lose console access straight away.`,
    ),
    { label: `Actions for ${member.name || member.email}` },
  )
}

function inviteRow(): Html {
  return html`<div class="invite-row" data-row>
    <input type="email" name="email" placeholder="email@example.com" required>
    <select name="role" aria-label="Role"><option value="developer">Developer</option><option value="owner">Owner</option></select>
    <button type="button" class="icon-btn" data-remove-row aria-label="Remove row" title="Remove">${icon('x')}</button>
  </div>`
}

function inviteDialog(open: boolean): Html {
  return dialog({
    id: 'invite-members',
    title: 'Invite members',
    open,
    body: html`<p class="dialog-message">Each person gets an email with a link to join.</p>
      <form id="invite-members-form" method="post" action="/console/organization/members/invite" hx-boost="false" data-busy-label="Sending…">
        <div class="invite-rows" id="invite-rows">${inviteRow()}</div>
        <button type="button" class="small" data-add-row="#invite-row-template" data-row-target="#invite-rows">${icon('plus')}<span>Add another</span></button>
        <p class="help">Owners manage members, settings and every project. Developers work in every project.</p>
      </form>
      <template id="invite-row-template">${inviteRow()}</template>`,
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="invite-members-form" class="primary">Send invitations</button>`,
  })
}

function inviteLinksDialog(results: InviteResult[]): Html {
  return dialog({
    id: 'invite-links',
    title: 'Invitation links',
    open: true,
    body: html`<p class="dialog-message">Email is not configured, so share these links directly. Each link can be used once.</p>
      ${results.map(
        (result) => html`<label>${result.member.email}<div class="copy-row"><input id="invite-link-${result.member.id}" class="mono" readonly value="${result.link}"><button type="button" data-copy-target="#invite-link-${result.member.id}">${icon('copy')}<span data-copy-label>Copy</span></button></div></label>`,
      )}`,
    actions: html`<button type="button" class="primary" data-dialog-close>Done</button>`,
  })
}

/** The link for one pending invitation, minted on demand. The previous link stops working. */
function invitationLinkDialog(result: InviteResult): Html {
  return dialog({
    id: 'invitation-link',
    title: 'Invitation link',
    open: true,
    body: html`<p class="dialog-message">Send this link to ${result.member.email}. It replaces the previous link, which stops working.</p>
      <label>Invitation link<div class="copy-row"><input id="invitation-link-value" class="mono" readonly value="${result.link}"><button type="button" data-copy-target="#invitation-link-value">${icon('copy')}<span data-copy-label>Copy</span></button></div></label>`,
    actions: html`<button type="button" class="primary" data-dialog-close>Done</button>`,
  })
}

export interface InviteAcceptOptions {
  orgName: string
  email: string
  token: string
  existing?: boolean
  /** What the visitor typed before a failed submit. */
  name?: string
  error?: string
}

export function inviteAcceptContent(options: InviteAcceptOptions): Html {
  return html`<div class="auth">
    <div class="brand"><img src="/logo-dark.png" alt="" width="28" height="28"><span>Bunwrite console</span></div>
    <div class="card">
      <h2>Join ${options.orgName}</h2>
      ${options.error ? alert('critical', html`${options.error}`) : ''}
      <p class="hint">
        ${options.existing
          ? 'Your account already exists. Sign in to accept this invitation.'
          : `Create your account to join ${options.orgName}.`}
      </p>
      <form method="post" action="/console/invite/${options.token}">
        <label>Email<input type="email" value="${options.email}" readonly></label>
        ${options.existing
          ? html`<label>Password<input type="password" name="password" autocomplete="current-password" required autofocus></label>
              <button class="primary" style="width:100%;justify-content:center">Sign in and join</button>`
          : html`<label>Name<input name="name" value="${options.name ?? ''}" autocomplete="name" required autofocus></label>
              <label>Password<input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
              <button class="primary" style="width:100%;justify-content:center">Join organization</button>`}
      </form>
    </div>
  </div>`
}

export function inviteUnavailableContent(message: string): Html {
  return html`<div class="auth">
    <div class="brand"><img src="/logo-dark.png" alt="" width="28" height="28"><span>Bunwrite console</span></div>
    <div class="card">
      <h2>Invitation unavailable</h2>
      ${alert('critical', html`${message}`)}
      <a class="btn primary" style="width:100%;justify-content:center" href="/console/login">Go to sign in</a>
    </div>
  </div>`
}

export interface MembersViewOptions {
  members: OrganizationMember[]
  /** Active owners across the whole organization, not just the filtered list. */
  ownerCount: number
  canManage: boolean
  currentEmail: string
  query: string
  inviteOpen: boolean
  inviteResults?: InviteResult[]
  /** A freshly minted link for the console to show, with no email sent. */
  copiedLink?: InviteResult
}

function membersTable(options: MembersViewOptions, active: OrganizationMember[]): Html {
  const { ownerCount, canManage, currentEmail } = options
  return html`<div class="card flush"><div class="scroll"><table class="member-table"><thead><tr><th>Member</th><th class="role-col">Role</th><th class="hide-sm date-col">Joined</th>${canManage ? html`<th class="actions-col"><span class="visually-hidden">Actions</span></th>` : ''}</tr></thead><tbody>
    ${active.map((member) => {
      const self = member.email === currentEmail.toLowerCase()
      return html`<tr>
        <td><div class="member-cell">${avatar(member.name || member.email, 'md')}<div><b>${member.name || displayName(member.email)}${self ? html` ${badge('You')}` : ''}</b><div class="subdued">${member.email}</div></div></div></td>
        <td class="role-col">${canManage && !self ? roleControl(member, ownerCount) : roleLabel(member.role)}</td>
        <td class="subdued hide-sm">${day(member.joinedAt ?? member.invitedAt)}</td>
        ${canManage ? html`<td class="num">${self ? '' : memberMenu(member, ownerCount)}</td>` : ''}
      </tr>`
    })}
  </tbody></table></div></div>`
}

function invitationsTable(options: MembersViewOptions, invited: OrganizationMember[]): Html {
  return html`<div class="section-head"><h2>Pending invitations</h2><span class="subdued">${invited.length}</span></div>
    <div class="card flush"><div class="scroll"><table class="member-table"><thead><tr><th>Email</th><th class="role-col">Role</th><th class="hide-sm date-col">Sent</th>${options.canManage ? html`<th class="actions-col"><span class="visually-hidden">Actions</span></th>` : ''}</tr></thead><tbody>
    ${invited.map((member) => {
      const id = encodeURIComponent(member.id)
      return html`<tr>
        <td><div class="member-cell">${avatar(member.email, 'md')}<div><b>${member.email}</b><div class="subdued">Waiting for them to accept</div></div></div></td>
        <td class="role-col">${roleLabel(member.role)}</td>
        <td class="subdued hide-sm">${day(member.invitedAt)}</td>
        ${options.canManage
          ? html`<td class="num">${menu(
              html`<form method="post" action="/console/organization/members/${id}/invite-link"><button type="submit">Copy invitation link</button></form>
                <form method="post" action="/console/organization/members/${id}/resend"><button type="submit">Resend invitation</button></form>
                <hr>
                ${destroy(`/console/organization/members/${id}/delete`, 'Revoke invitation', `Revoke the invitation for ${member.email}? The link stops working.`)}`,
              { label: `Actions for ${member.email}` },
            )}</td>`
          : ''}
      </tr>`
    })}
  </tbody></table></div></div>`
}

export function membersView(options: MembersViewOptions): Html {
  const { members, canManage, query } = options
  const unsent = (options.inviteResults ?? []).filter((result) => !result.sent)
  const active = members.filter((member) => member.status === 'active')
  const invited = members.filter((member) => member.status === 'invited')
  const toolbar = html`<div class="page-toolbar">
    <form
      class="search-field"
      method="get"
      action="/console/organization/members"
      hx-get="/console/organization/members"
      hx-target="#members-list"
      hx-select="#members-list"
      hx-swap="outerHTML"
      hx-push-url="true"
      hx-trigger="submit, input changed delay:300ms from:find input">
      <span class="search-field-icon">${icon('magnifying-glass')}</span>
      <input type="search" name="q" value="${query}" placeholder="Search by name or email..." autocomplete="off" aria-label="Search members">
      <noscript><button class="small">Search</button></noscript>
    </form>
  </div>`
  const body = members.length
    ? html`${active.length ? membersTable(options, active) : ''}${invited.length ? invitationsTable(options, invited) : ''}`
    : html`<div class="card">${emptyState(
        query ? 'No matching members' : 'No members yet',
        query ? `Nothing matches “${query}”.` : 'Invite someone to this organization.',
        query ? html`<a class="btn" href="/console/organization/members">Clear search</a>` : undefined,
      )}</div>`
  return html`${options.inviteResults?.length
      ? options.inviteResults.every((result) => result.sent)
        ? html`<div class="toast" role="status">${icon('check-circle')}<span>Invitations sent</span></div>`
        : alert('warning', html`Some invitations could not be emailed. Copy their links below.`)
      : ''}
    ${toolbar}
    <p class="page-note subdued"><b>Owners</b> manage members, settings and every project. <b>Developers</b> work in every project.</p>
    <div id="members-list">${body}</div>
    ${canManage ? inviteDialog(options.inviteOpen && !unsent.length) : ''}
    ${unsent.length ? inviteLinksDialog(unsent) : ''}
    ${options.copiedLink ? invitationLinkDialog(options.copiedLink) : ''}`
}
