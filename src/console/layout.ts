/**
 * Console chrome, after Shopify Polaris: light canvas, one light sidebar,
 * white cards, a page header with a single primary action, index tables,
 * tone badges and short sentence-case copy.
 */
import { confirmDialog, DIALOG_SCRIPT } from './dialog'
import { FORM_SCRIPT } from './form-script'
import { PERMISSIONS_SCRIPT } from './permissions'
import { html, raw, type Html } from './html'
import { MENU_SCRIPT } from './menu'
import { PROGRESS_SCRIPT } from './progress'
import { CONSOLE_CSS } from './styles'
import { alert, avatar, icon, menu, tile, type IconName } from './ui'

export interface Nav {
  section: string
  admin: string
  projectName: string
  /** The organization that owns every project, shown above the project name. */
  orgName: string
  projects: { id: string; name: string }[]
  currentProject: string
}

const MAIN: [string, string, string, IconName][] = [
  ['overview', 'Home', '/console/overview', 'house'],
  ['databases', 'Databases', '/console/databases', 'database'],
  ['users', 'Users', '/console/auth/users', 'users'],
  ['teams', 'Teams', '/console/auth/teams', 'users-three'],
  ['storage', 'Storage', '/console/storage', 'folder-simple'],
  ['functions', 'Functions', '/console/functions', 'lightning'],
  ['sites', 'Sites', '/console/sites', 'globe'],
]
const MANAGE: [string, string, string, IconName][] = [
  ['logs', 'Request logs', '/console/logs', 'list-bullets'],
  ['schema', 'Schema', '/console/schema', 'tree-structure'],
  ['api', 'API', '/console/api', 'key'],
  ['webhooks', 'Webhooks', '/console/webhooks', 'webhooks-logo'],
  ['settings', 'Settings', '/console/settings/general', 'gear-six'],
]

export type Flash = { tone: 'success' | 'critical' | 'warning' | 'info'; text: string } | null

/**
 * The sidebar's project switcher. Switching keeps you in the same section
 * (Databases stays Databases) rather than deep links that may not exist in
 * the other project.
 */
function projectSwitcher(nav: Nav): Html {
  const next = [...MAIN, ...MANAGE].find(([key]) => key === nav.section)?.[2] ?? '/console/overview'
  const items = html`<div class="menu-label">Projects</div>
    <div class="menu-scroll">
      ${nav.projects.map(
        (project) => html`<form method="post" action="/console/projects/select" hx-boost="false">
          <input type="hidden" name="project" value="${project.id}"><input type="hidden" name="next" value="${next}">
          <button type="submit" class="menu-item" ${project.id === nav.currentProject ? html`aria-current="true"` : ''}>${tile(project.name, project.id, 'sm')}<span class="menu-item-text">${project.name}</span>${project.id === nav.currentProject ? icon('check', 14, 'menu-check') : ''}</button>
        </form>`,
      )}
    </div>
    <hr>
    <a class="menu-item" href="/console">${icon('squares-four')}<span class="menu-item-text">All projects</span></a>
    <a class="menu-item" href="/console?create=1">${icon('plus')}<span class="menu-item-text">New project</span></a>
    <a class="menu-item" href="/console/organization/members">${icon('users')}<span class="menu-item-text">Members</span></a>`
  return menu(items, {
    label: 'Switch project',
    align: 'start',
    className: 'switcher',
    triggerClass: 'switcher-btn',
    trigger: html`${tile(nav.projectName, nav.currentProject)}<span class="switcher-text"><span class="switcher-org">${nav.orgName}</span><b>${nav.projectName}</b></span>${icon('caret-up-down', 14, 'switcher-caret')}`,
  })
}

const clearFlashScript = html`<script>{const u=new URL(location.href);u.searchParams.delete('ok');u.searchParams.delete('err');history.replaceState(history.state,'',u.pathname+u.search+u.hash)}</script>`

function flashParts(flash?: Flash) {
  return {
    banner: flash && flash.tone !== 'success' ? alert(flash.tone, html`${flash.text}`) : '',
    toast: flash?.tone === 'success' ? html`<div class="toast" role="status">${icon('check-circle')}<span>${flash.text}</span></div>` : '',
    clear: flash ? clearFlashScript : '',
  }
}

export function shell(title: string, nav: Nav, body: Html, flash?: Flash): Html {
  const link = ([key, label, href, name]: [string, string, string, IconName]) =>
    html`<a href="${href}" class="${nav.section === key ? 'on' : ''}" data-tooltip="${label}" aria-label="${label}">${icon(name)}<span>${label}</span></a>`
  const { banner, toast, clear } = flashParts(flash)
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/logo.svg"><link rel="icon" type="image/x-icon" href="/favicon.ico" sizes="any">
<title>${title} · ${nav.projectName}</title>
<style>${raw(CONSOLE_CSS)}</style>
<script>try{if(localStorage.getItem("bunwrite-nav")==="collapsed")document.documentElement.classList.add("nav-collapsed")}catch(e){}</script>
<script src="/console/assets/htmx.min.js"></script>
<script>${raw(PROGRESS_SCRIPT)}</script>
</head>
<body hx-boost="true">
<input type="checkbox" id="nav-toggle" aria-hidden="true">
<label for="nav-toggle" class="scrim" aria-hidden="true"></label>
<div class="topbar"><label for="nav-toggle" aria-label="Menu">${icon('list', 20)}</label><div class="brand">${tile(nav.projectName, nav.currentProject, 'sm')}<span>${nav.projectName}</span></div></div>
<div class="frame">
  <nav class="nav">
    <div class="nav-head">
      ${projectSwitcher(nav)}
      <button type="button" class="nav-toggle" data-nav-toggle data-tooltip="Toggle sidebar" aria-label="Toggle sidebar"><span class="nav-collapse-icon">${icon('caret-double-left')}</span><span class="nav-expand-icon">${icon('caret-double-right')}</span></button>
    </div>
    ${MAIN.map(link)}
    <div class="group">Manage</div>
    ${MANAGE.map(link)}
    <div class="foot">
      ${avatar(nav.admin)}<span class="nav-admin" title="${nav.admin}">${nav.admin}</span>
      <form method="post" action="/console/logout" class="inline"><button class="icon-btn" data-tooltip="Sign out" aria-label="Sign out">${icon('sign-out')}</button></form>
    </div>
  </nav>
  <main>
    ${banner}
    ${body}
    ${toast}
    ${clear}
  </main>
</div>
<div id="nav-tooltip" class="nav-tooltip" role="tooltip" hidden></div>
${confirmDialog()}
<script>${raw(DIALOG_SCRIPT)}</script>
<script>${raw(PERMISSIONS_SCRIPT)}</script>
<script>${raw(FORM_SCRIPT)}</script>
<script>${raw(MENU_SCRIPT)}</script>
</body>
</html>`
}

/** The organization shell for project selection, members and settings: no project navigation. */
export function projectShell(title: string, nav: { admin: string }, body: Html, flash?: Flash): Html {
  const { banner, toast, clear } = flashParts(flash)
  const account = menu(
    html`<div class="menu-head">Signed in as<b>${nav.admin}</b></div>
      <hr>
      <form method="post" action="/console/logout"><button type="submit" class="menu-item">${icon('sign-out')}<span class="menu-item-text">Sign out</span></button></form>`,
    { label: 'Account', triggerClass: 'account-btn', trigger: html`${avatar(nav.admin, 'md')}` },
  )
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/logo.svg"><link rel="icon" type="image/x-icon" href="/favicon.ico" sizes="any">
<title>${title} · Bunwrite</title>
<style>${raw(CONSOLE_CSS)}</style>
<script src="/console/assets/htmx.min.js"></script>
<script>${raw(PROGRESS_SCRIPT)}</script>
</head>
<body hx-boost="true">
<header class="select-topbar">
  <a class="select-brand" href="/console"><img src="/logo-dark.png" alt="" width="24" height="24"><span>Bunwrite</span></a>
  <div class="select-user">${account}</div>
</header>
<main class="select-main">
  ${banner}
  ${body}
  ${toast}
  ${clear}
</main>
${confirmDialog()}
<script>${raw(DIALOG_SCRIPT)}</script>
<script>${raw(FORM_SCRIPT)}</script>
<script>${raw(MENU_SCRIPT)}</script>
</body>
</html>`
}

export function bare(title: string, body: Html, projectName = 'Bunwrite'): Html {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/logo.svg"><link rel="icon" type="image/x-icon" href="/favicon.ico" sizes="any">
<title>${title} · ${projectName}</title><style>${raw(CONSOLE_CSS)}</style><script>${raw(PROGRESS_SCRIPT)}</script></head><body>${body}<script>${raw(DIALOG_SCRIPT)}</script><script>${raw(FORM_SCRIPT)}</script></body></html>`
}
