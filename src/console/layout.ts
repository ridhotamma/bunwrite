/**
 * Console chrome, after Shopify Polaris: light canvas, one light sidebar,
 * white cards, a page header with a single primary action, index tables,
 * tone badges and short sentence-case copy.
 */
import { confirmDialog, DIALOG_SCRIPT } from './dialog'
import { FORM_SCRIPT } from './form-script'
import { PERMISSIONS_SCRIPT } from './permissions'
import { html, raw, type Html } from './html'
import { CONSOLE_CSS } from './styles'
import { alert, icon, type IconName } from './ui'

export interface Nav {
  section: string
  admin: string
  projectName: string
}

const MAIN: [string, string, string, IconName][] = [
  ['overview', 'Home', '/console', 'house'],
  ['databases', 'Databases', '/console/databases', 'database'],
  ['users', 'Users', '/console/auth/users', 'users'],
  ['teams', 'Teams', '/console/auth/teams', 'users-three'],
  ['storage', 'Storage', '/console/storage', 'folder-simple'],
  ['functions', 'Functions', '/console/functions', 'function'],
]
const MANAGE: [string, string, string, IconName][] = [
  ['logs', 'Request logs', '/console/logs', 'list-bullets'],
  ['schema', 'Schema', '/console/schema', 'tree-structure'],
  ['settings', 'Settings', '/console/settings/general', 'gear-six'],
]

export type Flash = { tone: 'success' | 'critical' | 'warning' | 'info'; text: string } | null

export function shell(title: string, nav: Nav, body: Html, flash?: Flash): Html {
  const link = ([key, label, href, name]: [string, string, string, IconName]) =>
    html`<a href="${href}" class="${nav.section === key ? 'on' : ''}" data-tooltip="${label}" aria-label="${label}">${icon(name)}<span>${label}</span></a>`
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<title>${title} · ${nav.projectName}</title>
<style>${raw(CONSOLE_CSS)}</style>
<script>try{if(localStorage.getItem("bunwrite-nav")==="collapsed")document.documentElement.classList.add("nav-collapsed")}catch(e){}</script>
<script src="/console/assets/htmx.min.js"></script>
</head>
<body hx-boost="true">
<input type="checkbox" id="nav-toggle" aria-hidden="true">
<label for="nav-toggle" class="scrim" aria-hidden="true"></label>
<div class="topbar"><label for="nav-toggle" aria-label="Menu">${icon('list', 20)}</label><div class="brand">${nav.projectName}</div></div>
<div class="frame">
  <nav class="nav">
    <div class="brand"><span class="brand-text">${nav.projectName}</span><button type="button" class="nav-toggle" data-nav-toggle data-tooltip="Toggle sidebar" aria-label="Toggle sidebar"><span class="nav-collapse-icon">${icon('caret-double-left')}</span><span class="nav-expand-icon">${icon('caret-double-right')}</span></button></div>
    ${MAIN.map(link)}
    <div class="group">Manage</div>
    ${MANAGE.map(link)}
    <div class="foot"><span class="nav-admin">${nav.admin}</span><br><form method="post" action="/console/logout" class="inline"><button data-tooltip="Sign out" aria-label="Sign out">${icon('sign-out')}<span>Sign out</span></button></form></div>
  </nav>
  <main>
    ${flash && flash.tone !== 'success' ? alert(flash.tone, html`${flash.text}`) : ''}
    ${body}
    ${flash?.tone === 'success' ? html`<div class="toast" role="status">${icon('check-circle')}<span>${flash.text}</span></div>` : ''}
    ${flash ? html`<script>{const u=new URL(location.href);u.searchParams.delete('ok');u.searchParams.delete('err');history.replaceState(history.state,'',u.pathname+u.search+u.hash)}</script>` : ''}
  </main>
</div>
<div id="nav-tooltip" class="nav-tooltip" role="tooltip" hidden></div>
${confirmDialog()}
<script>${raw(DIALOG_SCRIPT)}</script>
<script>${raw(PERMISSIONS_SCRIPT)}</script>
<script>${raw(FORM_SCRIPT)}</script>
</body>
</html>`
}

export function bare(title: string, body: Html, projectName = 'Bunwrite'): Html {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<title>${title} · ${projectName}</title><style>${raw(CONSOLE_CSS)}</style></head><body>${body}<script>${raw(DIALOG_SCRIPT)}</script></body></html>`
}
