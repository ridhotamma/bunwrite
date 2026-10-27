/** Small, reusable console UI pieces. Pages compose these instead of repeating markup. */
import { html, type Html } from './html'

/** Polaris page header: back link, title, status badges, then actions with at most one primary. */
export function header(title: string, opts: { back?: string; badges?: (Html | string)[]; actions?: Html } = {}): Html {
  return html`<div class="header">
    ${opts.back ? html`<a class="back" href="${opts.back}" aria-label="Back">←</a>` : ''}
    <h1>${title}</h1>
    ${opts.badges?.length ? html`<div class="meta">${opts.badges}</div>` : ''}
    ${opts.actions ? html`<div class="actions">${opts.actions}</div>` : ''}
  </div>`
}

export const badge = (text: string, tone = '') => html`<span class="badge ${tone}">${text}</span>`

export function statusBadge(status: string): Html {
  const tone = status === 'completed' ? 'success' : status === 'failed' ? 'critical' : status === 'processing' ? 'info' : 'attention'
  return html`<span class="badge ${tone}">${status[0]!.toUpperCase() + status.slice(1)}</span>`
}

export function emptyState(heading: string, text: string, action?: Html): Html {
  return html`<div class="empty"><h3>${heading}</h3><p>${text}</p>${action ?? ''}</div>`
}

export const hidden = (fields: Record<string, string>) =>
  Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)

/** A destructive action: a plain red button that POSTs after a confirm prompt. */
export const destroy = (action: string, label: string, confirm: string, fields: Record<string, string> = {}) =>
  html`<form method="post" action="${action}" class="inline" hx-confirm="${confirm}">${hidden(fields)}<button class="critical plain">${label}</button></form>`

export function formFooter(cancel: string | null, submit: string): Html {
  return html`<div class="foot">${cancel ? html`<a class="btn" href="${cancel}">Cancel</a>` : ''}<button class="primary">${submit}</button></div>`
}

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`

export const when = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—')

export function stat(label: string, value: string | number, href?: string): Html {
  return html`<div class="stat"><span>${label}</span><b>${href ? html`<a href="${href}" style="color:inherit">${value}</a>` : value}</b></div>`
}

export interface SearchOptions {
  action: string
  /** ID of the card the response should swap into. */
  target: string
  placeholder: string
  name?: string
  value?: string
  /** Debounce in milliseconds. */
  delay?: number
  submit?: string
  mono?: boolean
  title?: string
}

/**
 * A filter form that works without JavaScript and turns into a live,
 * URL-pushing htmx search when JavaScript is available.
 */
export function searchForm(options: SearchOptions): Html {
  const { action, target, placeholder, name = 'search', value = '', delay = 300, submit, mono, title } = options
  return html`<form class="toolbar" method="get" action="${action}" hx-get="${action}" hx-target="#${target}" hx-select="#${target}" hx-swap="outerHTML" hx-push-url="true" hx-trigger="submit, input changed delay:${delay}ms from:find input">
    <input type="search" name="${name}" value="${value}" placeholder="${placeholder}" autocomplete="off" ${mono ? html`class="mono"` : ''} ${title ? html`title="${title}"` : ''}>
    ${submit ? html`<button>${submit}</button>` : ''}
  </form>`
}

export interface PagerOptions {
  page: number
  pages: number
  /** Query parameters to keep across page links. */
  params?: Record<string, string>
  label?: Html | string
  /** Show the page label even when there is only one page. */
  always?: boolean
}

export function pager({ page, pages, params = {}, label, always = false }: PagerOptions): Html {
  if (pages <= 1 && !always) return html``
  const href = (n: number) => {
    const search = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== '') search.set(k, v)
    search.set('page', String(n))
    return `?${search.toString()}`
  }
  return html`<div class="pager">
    ${page > 1 ? html`<a class="btn" href="${href(page - 1)}">Previous</a>` : ''}
    <span class="subdued">${label ?? `Page ${page} of ${pages}`}</span>
    ${page < pages ? html`<a class="btn" href="${href(page + 1)}">Next</a>` : ''}
  </div>`
}

export interface ListCardParts {
  toolbar?: Html
  body: Html
  footer?: Html
}

/** The standard list surface: a flush card with toolbar, table and pager. */
export function listCard(id: string, parts: ListCardParts): Html {
  return html`<div class="card flush" id="${id}">${parts.toolbar ?? ''}${parts.body}${parts.footer ?? ''}</div>`
}

/** Attributes that make an element refresh itself on an interval. */
export function poll(url: string, target: string, seconds: number): Html {
  return html`hx-get="${url}" hx-select="#${target}" hx-target="#${target}" hx-swap="outerHTML" hx-trigger="every ${seconds}s"`
}
