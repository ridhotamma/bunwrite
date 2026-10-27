/**
 * Console chrome, after Shopify Polaris: light canvas, one light sidebar,
 * white cards, a page header with a single primary action, index tables,
 * tone badges and short sentence-case copy.
 */
import { html, raw, type Html } from './html'
import { CONSOLE_CSS } from './styles'

export interface Nav {
  section: string
  admin: string
}

const MAIN: [string, string, string][] = [
  ['overview', 'Home', '/console'],
  ['databases', 'Databases', '/console/databases'],
  ['users', 'Users', '/console/auth/users'],
  ['teams', 'Teams', '/console/auth/teams'],
  ['storage', 'Storage', '/console/storage'],
  ['functions', 'Functions', '/console/functions'],
]
const MANAGE: [string, string, string][] = [
  ['schema', 'Schema', '/console/schema'],
  ['settings', 'Settings', '/console/settings'],
]

export type Flash = { tone: 'success' | 'critical' | 'warning' | 'info'; text: string } | null

export function shell(title: string, nav: Nav, body: Html, flash?: Flash): Html {
  const link = ([key, label, href]: [string, string, string]) => html`<a href="${href}" class="${nav.section === key ? 'on' : ''}">${label}</a>`
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Console</title>
<style>${raw(CONSOLE_CSS)}</style>
<script src="/console/assets/htmx.min.js"></script>
</head>
<body hx-boost="true">
<input type="checkbox" id="nav-toggle" aria-hidden="true">
<label for="nav-toggle" class="scrim" aria-hidden="true"></label>
<div class="topbar"><label for="nav-toggle" aria-label="Menu">☰</label><div class="brand">Pesanle</div></div>
<div class="frame">
  <nav class="nav">
    <div class="brand">Pesanle</div>
    ${MAIN.map(link)}
    <div class="group">Manage</div>
    ${MANAGE.map(link)}
    <div class="foot">${nav.admin}<br><form method="post" action="/console/logout" class="inline"><button>Sign out</button></form></div>
  </nav>
  <main>
    ${flash && flash.tone !== 'success' ? html`<div class="banner ${flash.tone}">${flash.text}</div>` : ''}
    ${body}
    ${flash?.tone === 'success' ? html`<div class="toast" role="status">${flash.text}</div>` : ''}
    ${flash ? html`<script>{const u=new URL(location.href);u.searchParams.delete('ok');u.searchParams.delete('err');history.replaceState(history.state,'',u.pathname+u.search+u.hash)}</script>` : ''}
  </main>
</div>
</body>
</html>`
}

export function bare(title: string, body: Html): Html {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Console</title><style>${raw(CONSOLE_CSS)}</style></head><body>${body}</body></html>`
}
