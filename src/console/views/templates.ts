/**
 * Settings → Email templates: the templates on the left, the chosen one on
 * the right with its subject, sender, reply-to and HTML message. Preview asks
 * the server to render the unsaved form with sample values, so it shows
 * exactly what the mailer sends, inside a sandboxed frame.
 */
import type { ConsoleContext } from '~/console/context'
import { html, raw, type Html } from '~/console/html'
import { SETTINGS } from '~/console/settings-meta'
import { alert, badge, icon } from '~/console/ui'
import { TEMPLATES, templateInfo, type TemplateFields, type TemplateId } from '~/mail/templates'
import type { Mail } from '~/mail/mailer'

export const templatePath = (id: TemplateId) => `${SETTINGS}/templates/${id}`

/** Source/Preview switching and click-to-copy variables. Listeners sit on the document, so htmx page swaps keep working. */
const TEMPLATE_SCRIPT = `
(() => {
  if (window.__bunwriteTemplates) return
  window.__bunwriteTemplates = true
  const show = (form, pane) => {
    for (const b of form.querySelectorAll("[data-template-tab]")) {
      const on = b.dataset.templateTab === pane
      b.classList.toggle("on", on)
      b.setAttribute("aria-selected", String(on))
    }
    for (const p of form.querySelectorAll("[data-template-pane]")) p.hidden = p.dataset.templatePane !== pane
  }
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null
    const tab = target && target.closest("[data-template-tab]")
    if (tab) show(tab.closest("form"), tab.dataset.templateTab)
    const reset = target && target.closest("[data-reset-template]")
    if (reset && !confirm("Reset this template to the default? Your changes to it are lost.")) event.preventDefault()
    const chip = target && target.closest("[data-copy-var]")
    if (chip) {
      const text = chip.dataset.copyVar
      const done = () => { const label = chip.querySelector("span"); const old = label.textContent; label.textContent = "Copied"; setTimeout(() => { label.textContent = old }, 1200) }
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => {})
      else {
        const area = document.createElement("textarea")
        area.value = text
        document.body.appendChild(area)
        area.select()
        try { document.execCommand("copy"); done() } catch (e) {}
        area.remove()
      }
    }
  })
})()
`

/**
 * The rendered email in a sandboxed frame: no scripts, forms, pop-ups or
 * top-level navigation. Without allow-scripts, allow-same-origin only lets the
 * frame render in-page; nothing inside it can run.
 */
export function templatePreview(mail: Mail): Html {
  const from = mail.from ? html`<div><span class="subdued">From</span> ${mail.from.name ? `${mail.from.name} <${mail.from.address}>` : mail.from.address}</div>` : ''
  const replyTo = mail.replyTo ? html`<div><span class="subdued">Reply to</span> ${mail.replyTo.name ? `${mail.replyTo.name} <${mail.replyTo.address}>` : mail.replyTo.address}</div>` : ''
  return html`<div class="template-meta"><div><span class="subdued">Subject</span> <strong>${mail.subject}</strong></div>${from}${replyTo}</div>
    <iframe class="template-frame" sandbox="allow-same-origin" referrerpolicy="no-referrer" title="Email preview" srcdoc="${mail.html}"></iframe>`
}

export function templatesView(ctx: ConsoleContext, id: TemplateId, fields: TemplateFields = ctx.services.templates.get(id)): Html {
  const info = templateInfo(id)
  const smtp = ctx.services.config.smtp
  const templates = ctx.services.templates
  const customized = templates.customized(id)
  const list = html`<nav class="card flush template-list" aria-label="Email templates">
    <div class="template-list-head"><h2>Email templates</h2><span class="subdued">${TEMPLATES.length} templates</span></div>
    ${TEMPLATES.map(
      (t) => html`<a href="${templatePath(t.id)}" class="template-item ${t.id === id ? 'on' : ''}" ${t.id === id ? html`aria-current="page"` : ''}>
        ${raw(ENVELOPE)}
        <span class="template-item-text"><span class="template-item-name">${t.name}${templates.customized(t.id) ? html` ${badge('Custom', 'info')}` : ''}</span><span class="subdued">${t.description}</span></span>
      </a>`,
    )}
  </nav>`

  const editor = html`<div class="card template-card">
    <form method="post" action="${templatePath(id)}" id="template-form">
      ${smtp
        ? ''
        : alert('warning', html`SMTP is not set up, so these emails are not sent yet. <a href="${SETTINGS}/email">Set up SMTP</a>.`)}
      <div class="card-head"><h2>${info.name}</h2>${customized ? html`<div class="card-head-actions">${badge('Custom', 'info')}</div>` : ''}</div>
      <label>Subject<input name="subject" value="${fields.subject}" maxlength="255" required></label>
      <div class="fields">
        <label>Sender name<input name="senderName" value="${fields.senderName}" placeholder="${smtp?.senderName || 'From SMTP settings'}"></label>
        <label>Sender email<input name="senderEmail" type="email" value="${fields.senderEmail}" placeholder="${smtp?.senderEmail || 'From SMTP settings'}"></label>
      </div>
      <div class="fields">
        <label>Reply-to name<input name="replyToName" value="${fields.replyToName}"></label>
        <label>Reply-to email<input name="replyToEmail" type="email" value="${fields.replyToEmail}"></label>
      </div>
      <div class="template-message-head">
        <h3>Message</h3>
        <div class="seg" role="tablist" aria-label="Message view">
          <button type="button" class="on" data-template-tab="source" role="tab" aria-selected="true">Source</button>
          <button type="button" data-template-tab="preview" role="tab" aria-selected="false" hx-post="${templatePath(id)}/preview" hx-include="#template-form" hx-target="#template-preview" hx-swap="innerHTML">Preview</button>
        </div>
      </div>
      <div class="template-vars">
        <div><strong>Available variables</strong> <span class="subdued">Use them in the subject or message. Click one to copy it.</span></div>
        <div class="template-chips">${info.variables.map((v) => html`<button type="button" class="chip" data-copy-var="{{${v}}}" title="Copy {{${v}}}">${icon('copy', 14)}<span class="mono">{{${v}}}</span></button>`)}</div>
      </div>
      <div data-template-pane="source">
        <textarea name="message" class="mono template-source" spellcheck="false" aria-label="Message HTML">${fields.message}</textarea>
        <small class="subdued">HTML. It is placed inside the email layout; variable values are escaped.</small>
      </div>
      <div data-template-pane="preview" hidden><div id="template-preview" class="template-preview">${templatePreview(templates.preview(id, fields))}</div></div>
      <div class="foot template-foot">
        ${customized ? html`<button type="submit" formaction="${templatePath(id)}/reset" formnovalidate class="plain" data-reset-template>Reset to default</button>` : html`<span></span>`}
        <button class="primary">Update template</button>
      </div>
    </form>
  </div>`

  return html`<div class="split-sidebar template-layout">${list}${editor}</div><script>${raw(TEMPLATE_SCRIPT)}</script>`
}

/** Phosphor "envelope" (regular). */
const ENVELOPE = `<svg class="icon" viewBox="0 0 256 256" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48Zm-96,85.15L52.57,64H203.43ZM98.71,128,40,181.81V74.19Zm11.84,10.85,12,11.05a8,8,0,0,0,10.82,0l12-11.05,58,53.15H52.57ZM157.29,128,216,74.18V181.82Z"/></svg>`
