/** Accessible dialog component plus the small client runtime for it. */
import { html, type Html } from './html'

export interface DialogOptions {
  id: string
  title: string
  body: Html
  actions: Html
  /** Open as soon as the page (or an htmx swap) renders it. */
  open?: boolean
}

export function dialog({ id, title, body, actions, open = false }: DialogOptions): Html {
  return html`<dialog id="${id}" class="dialog" ${open ? html`open data-open` : ''} aria-labelledby="${id}-title">
    <div class="dialog-body">
      <h2 id="${id}-title">${title}</h2>
      ${body}
      <div class="dialog-actions">${actions}</div>
    </div>
  </dialog>`
}

export function confirmDialog(): Html {
  return dialog({
    id: 'confirm-dialog',
    title: 'Confirm',
    body: html`<p id="confirm-message" class="dialog-message"></p>`,
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="button" class="primary" data-confirm-action>Confirm</button>`,
  })
}

export const DIALOG_SCRIPT = `
(() => {
  const FLAG = "__pesanleDialogs"
  function closeDialog(modal) {
    if (!modal || !modal.open || modal.classList.contains("dialog-closing")) return
    modal.classList.add("dialog-closing")
    setTimeout(() => {
      modal.classList.remove("dialog-closing")
      if (modal.open) modal.close()
    }, 150)
  }
  function bindDialog(modal) {
    if (!modal || modal.dataset.cancelBound) return
    modal.dataset.cancelBound = "1"
    modal.addEventListener("cancel", (event) => {
      event.preventDefault()
      closeDialog(modal)
    })
  }
  function showOpenDialogs() {
    for (const el of document.querySelectorAll("dialog[data-open]")) {
      el.removeAttribute("data-open")
      bindDialog(el)
      if (el.open) el.close()
      el.showModal()
      const input = el.querySelector("input[readonly]")
      if (input) input.select()
    }
  }
  async function copyValue(button, source) {
    const text = source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement ? source.value : source.textContent || ""
    let ok = false
    try { await navigator.clipboard.writeText(text); ok = true } catch {}
    if (!ok) {
      const area = document.createElement("textarea")
      area.value = text
      area.setAttribute("readonly", "")
      area.style.position = "fixed"
      area.style.opacity = "0"
      document.body.appendChild(area)
      area.select()
      try { ok = document.execCommand("copy") } catch {}
      area.remove()
    }
    const label = button.querySelector("[data-copy-label]") || button
    const old = label.textContent
    label.textContent = ok ? "Copied" : "Copy failed"
    setTimeout(() => { label.textContent = old }, 2000)
  }
  if (!window[FLAG]) {
    window[FLAG] = true
    const approved = new WeakSet()
    let pending = null
    document.addEventListener("submit", (event) => {
      const form = event.target instanceof Element ? event.target.closest("form[data-confirm]") : null
      if (!form || approved.has(form)) return
      const modal = document.getElementById("confirm-dialog")
      if (!modal) return
      event.preventDefault()
      event.stopPropagation()
      pending = { form, submitter: event.submitter }
      const message = document.getElementById("confirm-message")
      if (message) message.textContent = form.dataset.confirm || "Are you sure?"
      const button = modal.querySelector("[data-confirm-action]")
      if (button) {
        button.textContent = form.dataset.confirmLabel || "Confirm"
        button.className = form.dataset.confirmTone === "critical" ? "destructive" : "primary"
      }
      bindDialog(modal)
      if (!modal.open) modal.showModal()
      if (button) button.focus()
    }, true)
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      const opener = target.closest("[data-dialog-open]")
      if (opener) {
        const selector = opener.getAttribute("data-dialog-open")
        const modal = selector ? document.querySelector(selector) : null
        if (modal) {
          bindDialog(modal)
          if (!modal.open) modal.showModal()
          const field = modal.querySelector("textarea, input:not([type='hidden']), select")
          if (field) setTimeout(() => field.focus(), 0)
        }
        return
      }
      const dismiss = target.closest("[data-dismiss-alert]")
      if (dismiss) {
        const box = dismiss.closest(".banner")
        if (box) {
          box.classList.add("banner-out")
          setTimeout(() => box.remove(), 180)
        }
        return
      }
      const close = target.closest("[data-dialog-close]")
      if (close) {
        closeDialog(close.closest("dialog"))
        return
      }
      const confirm = target.closest("[data-confirm-action]")
      if (confirm) {
        const action = pending
        pending = null
        closeDialog(confirm.closest("dialog"))
        if (action) {
          approved.add(action.form)
          action.form.requestSubmit(action.submitter || undefined)
          setTimeout(() => approved.delete(action.form), 0)
        }
        return
      }
      const copy = target.closest("[data-copy-target]")
      if (copy) {
        const selector = copy.getAttribute("data-copy-target")
        const source = selector ? document.querySelector(selector) : null
        if (source) copyValue(copy, source)
      }
    })
    document.addEventListener("htmx:afterSwap", showOpenDialogs)
  }
  showOpenDialogs()
})()
`
