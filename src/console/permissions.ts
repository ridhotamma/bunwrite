/**
 * Permission picker for collections, documents, buckets and files: a table of
 * roles × actions with checkboxes, an "Add role" row that finds users and
 * teams by name or email, and a plain-language summary.
 *
 * The submitted value is still the hidden `permissions` textarea (one
 * `read("any")` per line), so form handlers are unchanged. The script keeps
 * the table and the textarea in sync; "Edit as text" shows the textarea.
 */
import type { PermissionType } from '~/auth/permissions'
import type { ConsoleContext } from './context'
import { html, type Html } from './html'

export type PermissionAction = Exclude<PermissionType, 'write'>

export const COLLECTION_ACTIONS: PermissionAction[] = ['create', 'read', 'update', 'delete']
export const DOCUMENT_ACTIONS: PermissionAction[] = ['read', 'update', 'delete']

export interface PermissionsFieldOptions {
  /** Form field name. @default 'permissions' */
  name?: string
  value: string[]
  actions: PermissionAction[]
  /** Shown under the table, e.g. how this level combines with row security. */
  note?: Html
}

interface Directory {
  users: { id: string; name: string; email: string }[]
  teams: { id: string; name: string }[]
  labels: string[]
  teamRoles: string[]
}

/** Users, teams, labels and team roles to suggest, newest first, capped so the page stays small. */
function directory(ctx: ConsoleContext): Directory {
  const users = ctx.services.auth.userDirectory()
  const teams = ctx.services.teams.directory()
  const labels = ctx.services.auth.userLabels()
  const roles = ctx.services.teams.memberRoles()
  return {
    users: users.map((u) => ({ id: u.id, name: u.name, email: u.email ?? '' })),
    teams,
    labels,
    teamRoles: [...new Set(['owner', ...roles])],
  }
}

/** Names for user:/team: roles already in the list, even when they are not among the suggestions. */
function knownNames(ctx: ConsoleContext, value: string[], dir: Directory): Record<string, string> {
  const names: Record<string, string> = {}
  for (const u of dir.users) names[`user:${u.id}`] = u.name || u.email || u.id
  for (const t of dir.teams) names[`team:${t.id}`] = t.name
  for (const p of value) {
    const m = /"(user|team):([^"/]+)/.exec(p)
    if (!m || names[`${m[1]}:${m[2]}`]) continue
    if (m[1] === 'user') {
      const user = ctx.services.auth.findUser(m[2]!)
      if (user) names[`user:${m[2]}`] = user.name || user.email || user.id
    } else {
      const team = ctx.services.teams.findTeam(m[2]!)
      if (team) names[`team:${m[2]}`] = team.name
    }
  }
  return names
}

let fieldCount = 0

export function permissionsField(ctx: ConsoleContext, options: PermissionsFieldOptions): Html {
  const { name = 'permissions', value, actions, note } = options
  const dir = directory(ctx)
  const id = `perm-${++fieldCount}`
  const config = { actions, names: knownNames(ctx, value, dir), users: dir.users, teams: dir.teams }
  const canCreate = actions.includes('create')
  return html`<div class="perm" data-perm="${JSON.stringify(config)}">
    <div class="perm-presets">
      <span class="subdued">Quick add:</span>
      <button type="button" class="small" data-perm-preset="any:read">Anyone can read</button>
      <button type="button" class="small" data-perm-preset="users:read">Signed-in users can read</button>
      ${canCreate ? html`<button type="button" class="small" data-perm-preset="users:create">Signed-in users can create</button>` : ''}
    </div>
    <div class="scroll"><table class="perm-table">
      <thead><tr><th>Role</th>${actions.map((a) => html`<th class="perm-col">${a[0]!.toUpperCase() + a.slice(1)}</th>`)}<th></th></tr></thead>
      <tbody></tbody>
    </table></div>
    <p class="perm-empty subdued">No roles yet, so only API keys and server functions have access.</p>
    <div class="perm-add">
      <select data-perm-kind aria-label="Role type">
        <optgroup label="Groups">
          <option value="any">Anyone (signed in or not)</option>
          <option value="users">All signed-in users</option>
          <option value="users/verified">Signed-in users with a verified email</option>
          <option value="users/unverified">Signed-in users without a verified email</option>
          <option value="guests">Guests (not signed in)</option>
        </optgroup>
        <optgroup label="Specific">
          <option value="user">A user</option>
          <option value="team">Members of a team</option>
          <option value="team-role">Team members with a role</option>
          <option value="label">Users with a label</option>
        </optgroup>
      </select>
      <input data-perm-user list="${id}-users" placeholder="Name, email or user ID" hidden aria-label="User">
      <input data-perm-team list="${id}-teams" placeholder="Team name or ID" hidden aria-label="Team">
      <input data-perm-role list="${id}-roles" placeholder="Role, e.g. owner" hidden aria-label="Team role">
      <input data-perm-label list="${id}-labels" placeholder="Label, e.g. admin" hidden aria-label="Label">
      <button type="button" data-perm-add>Add role</button>
    </div>
    <p class="perm-error" hidden></p>
    <div class="perm-summary"></div>
    ${note ? html`<p class="help">${note}</p>` : ''}
    <details class="perm-text"><summary>Edit as text</summary>
      <textarea name="${name}" class="mono" spellcheck="false" placeholder='read("any")'>${value.join('\n')}</textarea>
      <small class="help">One per line, e.g. <code>read("any")</code>, <code>update("team:ID/owner")</code>. The table updates as you type.</small>
    </details>
    <datalist id="${id}-users">${dir.users.map((u) => html`<option value="${u.id}" label="${[u.name, u.email].filter(Boolean).join(' · ') || u.id}"></option>`)}</datalist>
    <datalist id="${id}-teams">${dir.teams.map((t) => html`<option value="${t.id}" label="${t.name}"></option>`)}</datalist>
    <datalist id="${id}-roles">${dir.teamRoles.map((r) => html`<option value="${r}"></option>`)}</datalist>
    <datalist id="${id}-labels">${dir.labels.map((l) => html`<option value="${l}"></option>`)}</datalist>
  </div>`
}

/** Client side of the picker. Event handlers live on document, so htmx swaps need no rebinding. */
export const PERMISSIONS_SCRIPT = `
(() => {
  if (window.__bunwritePermissions) return
  window.__bunwritePermissions = true
  const LINE = /^(read|create|update|delete|write)\\("([^"]+)"\\)$/
  const ROLE = /^(any|guests|users(\\/(verified|unverified))?|user:[a-zA-Z0-9._-]+(\\/(verified|unverified))?|team:[a-zA-Z0-9._-]+(\\/[a-zA-Z0-9._-]+)?|member:[a-zA-Z0-9._-]+|label:[a-zA-Z0-9]+)$/
  const GROUPS = { any: "Anyone", users: "All signed-in users", "users/verified": "Verified users", "users/unverified": "Unverified users", guests: "Guests" }
  const ACTION_WORDS = { create: "create", read: "read", update: "update", delete: "delete" }
  const cfg = (root) => root.__cfg || (root.__cfg = JSON.parse(root.dataset.perm))
  const text = (root) => root.querySelector("textarea")
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

  function label(root, role) {
    if (GROUPS[role]) return { title: GROUPS[role], sub: role }
    const names = cfg(root).names
    let m
    if ((m = /^user:([^/]+)(?:\\/(verified|unverified))?$/.exec(role))) return { title: "User · " + (names["user:" + m[1]] || m[1]), sub: role }
    if ((m = /^team:([^/]+)\\/(.+)$/.exec(role))) return { title: "Team · " + (names["team:" + m[1]] || m[1]) + " · " + m[2] + " role", sub: role }
    if ((m = /^team:([^/]+)$/.exec(role))) return { title: "Team · " + (names["team:" + m[1]] || m[1]), sub: role }
    if ((m = /^member:(.+)$/.exec(role))) return { title: "Team membership · " + m[1], sub: role }
    if ((m = /^label:(.+)$/.exec(role))) return { title: "Users labelled " + m[1], sub: role }
    return { title: role, sub: "" }
  }

  // Parse the textarea: ordered roles, each with its set of actions. "write" means every non-read action.
  function parse(root) {
    const actions = cfg(root).actions
    const roles = new Map()
    const bad = []
    for (const raw of text(root).value.split(/[\\n,]/)) {
      const line = raw.trim()
      if (!line) continue
      const m = LINE.exec(line)
      if (!m || !ROLE.test(m[2])) { bad.push(line); continue }
      if (!roles.has(m[2])) roles.set(m[2], new Set())
      const set = roles.get(m[2])
      if (m[1] === "write") actions.filter((a) => a !== "read").forEach((a) => set.add(a))
      else set.add(m[1])
    }
    return { roles, bad }
  }

  // The table's rows, including roles with nothing ticked yet: they stay until removed.
  const rowsOf = (root) => root.__rows || (root.__rows = parse(root).roles)

  function write(root) {
    const actions = cfg(root).actions
    const lines = []
    for (const [role, set] of rowsOf(root)) for (const a of actions) if (set.has(a)) lines.push(a + '("' + role + '")')
    // Keep lines the table cannot show, so nothing typed in the textarea is lost.
    const bad = parse(root).bad
    text(root).value = lines.concat(bad).join("\\n")
  }

  function render(root) {
    const { actions } = cfg(root)
    const roles = rowsOf(root)
    const { bad } = parse(root)
    const body = root.querySelector("tbody")
    body.innerHTML = [...roles].map(([role, set]) => {
      const l = label(root, role)
      return '<tr data-role="' + esc(role) + '"><td><div class="perm-role">' + esc(l.title) + '</div>' + (l.sub && l.sub !== l.title ? '<div class="mono subdued perm-sub">' + esc(l.sub) + '</div>' : '') + (set.size ? '' : '<div class="perm-sub subdued">Nothing ticked, so this role gets no access</div>') + '</td>' +
        actions.map((a) => '<td class="perm-col"><input type="checkbox" aria-label="' + esc(a + ' for ' + l.title) + '" data-perm-action="' + a + '"' + (set.has(a) ? " checked" : "") + '></td>').join("") +
        '<td class="num"><button type="button" class="plain critical" data-perm-remove aria-label="Remove ' + esc(l.title) + '">Remove</button></td></tr>'
    }).join("")
    root.querySelector(".perm-table").hidden = roles.size === 0
    root.querySelector(".perm-empty").hidden = roles.size !== 0
    // Plain-language summary: who can do each action.
    root.querySelector(".perm-summary").innerHTML = '<ul class="list">' + actions.map((a) => {
      const who = [...roles].filter(([, s]) => s.has(a)).map(([r]) => label(root, r).title)
      return '<li><span class="subdued">Who can ' + ACTION_WORDS[a] + '</span><span>' + (who.length ? esc(who.join(", ")) : '<span class="subdued">API keys only</span>') + '</span></li>'
    }).join("") + '</ul>'
    const error = root.querySelector(".perm-error")
    error.hidden = bad.length === 0
    error.textContent = bad.length ? "Not understood, will be rejected on save: " + bad.join(", ") : ""
  }

  function toggle(root, role, action, on) {
    const set = rowsOf(root).get(role)
    if (!set) return
    if (on) set.add(action)
    else set.delete(action)
    write(root)
    render(root)
  }

  function addRole(root, role, action) {
    const rows = rowsOf(root)
    if (!rows.has(role)) rows.set(role, new Set())
    rows.get(role).add(action || "read")
    write(root)
    render(root)
  }

  function showKindInputs(root) {
    const kind = root.querySelector("[data-perm-kind]").value
    root.querySelector("[data-perm-user]").hidden = kind !== "user"
    root.querySelector("[data-perm-team]").hidden = kind !== "team" && kind !== "team-role"
    root.querySelector("[data-perm-role]").hidden = kind !== "team-role"
    root.querySelector("[data-perm-label]").hidden = kind !== "label"
  }

  // Accept an ID, an email, or a name for users and teams.
  function resolve(list, typed, fields) {
    const t = typed.trim().toLowerCase()
    if (!t) return ""
    const hit = list.find((x) => x.id.toLowerCase() === t) || list.find((x) => fields.some((f) => (x[f] || "").toLowerCase() === t))
    return hit ? hit.id : typed.trim()
  }

  function roleFromInputs(root) {
    const c = cfg(root)
    const kind = root.querySelector("[data-perm-kind]").value
    const val = (sel) => root.querySelector(sel).value.trim()
    if (GROUPS[kind]) return kind
    if (kind === "user") { const id = resolve(c.users, val("[data-perm-user]"), ["email", "name"]); return id && "user:" + id }
    if (kind === "team") { const id = resolve(c.teams, val("[data-perm-team]"), ["name"]); return id && "team:" + id }
    if (kind === "team-role") { const id = resolve(c.teams, val("[data-perm-team]"), ["name"]); const r = val("[data-perm-role]"); return id && r && "team:" + id + "/" + r }
    if (kind === "label") { const l = val("[data-perm-label]"); return l && "label:" + l }
    return ""
  }

  function setup() {
    for (const root of document.querySelectorAll(".perm:not([data-ready])")) {
      root.dataset.ready = "1"
      showKindInputs(root)
      render(root)
    }
  }

  document.addEventListener("change", (e) => {
    const root = e.target.closest && e.target.closest(".perm")
    if (!root) return
    if (e.target.matches("[data-perm-action]")) toggle(root, e.target.closest("tr").dataset.role, e.target.dataset.permAction, e.target.checked)
    if (e.target.matches("[data-perm-kind]")) showKindInputs(root)
  })
  document.addEventListener("input", (e) => {
    const root = e.target.closest && e.target.closest(".perm")
    // Typing in the textarea rebuilds the rows from it.
    if (root && e.target.matches("textarea")) { root.__rows = parse(root).roles; render(root) }
  })
  document.addEventListener("keydown", (e) => {
    const root = e.target.closest && e.target.closest(".perm-add")
    if (root && e.key === "Enter" && e.target.matches("input")) { e.preventDefault(); root.querySelector("[data-perm-add]").click() }
  })
  document.addEventListener("click", (e) => {
    const t = e.target.closest && e.target.closest("[data-perm-add],[data-perm-remove],[data-perm-preset]")
    if (!t) return
    const root = t.closest(".perm")
    const error = root.querySelector(".perm-error")
    if (t.matches("[data-perm-remove]")) { rowsOf(root).delete(t.closest("tr").dataset.role); write(root); render(root); return }
    if (t.matches("[data-perm-preset]")) { const [role, action] = t.dataset.permPreset.split(":"); addRole(root, role, action); return }
    const role = roleFromInputs(root)
    if (!role || !ROLE.test(role)) {
      error.hidden = false
      error.textContent = role ? "That is not a valid role: " + role + ". IDs and labels use letters, numbers, . _ and -." : "Fill in who this role is for."
      return
    }
    const c = cfg(root)
    const m = /^(user|team):([^/]+)/.exec(role)
    if (m && !c.names[m[1] + ":" + m[2]]) {
      const hit = (m[1] === "user" ? c.users : c.teams).find((x) => x.id === m[2])
      if (hit) c.names[m[1] + ":" + m[2]] = hit.name || hit.email || hit.id
    }
    addRole(root, role, "read")
    error.hidden = true
    // Clear and blur, so the browser's suggestion list closes and does not catch the next click.
    for (const input of root.querySelectorAll(".perm-add input")) input.value = ""
    if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur()
  })
  document.addEventListener("htmx:afterSwap", setup)
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup)
  else setup()
})()
`

/** Row (or file) security as two explained choices instead of a bare checkbox. */
export function securityChoice(name: string, on: boolean, kind: 'document' | 'file'): Html {
  const parent = kind === 'document' ? 'collection' : 'bucket'
  return html`<div class="choice" role="radiogroup" aria-label="${kind === 'document' ? 'Row security' : 'File security'}">
    <label><input type="radio" name="${name}" value="" ${on ? '' : 'checked'}><span><b>${parent[0]!.toUpperCase() + parent.slice(1)} permissions only</b><span>Everyone allowed below gets the same access to every ${kind}.</span></span></label>
    <label><input type="radio" name="${name}" value="on" ${on ? 'checked' : ''}><span><b>${kind === 'document' ? 'Row' : 'File'} security</b><span>Each ${kind} can also grant access to specific users or teams, for example "only the owner can read it".</span></span></label>
  </div>`
}
