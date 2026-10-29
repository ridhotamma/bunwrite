/**
 * Keeps what was typed in a form when the server sends its page back after an
 * error.
 *
 * A failed POST redirects to the page the form was on with an `err` flash, so
 * the browser renders that page from scratch and every field starts over. This
 * script keeps a copy of the form's controls in sessionStorage as the form is
 * submitted, and puts them back on the page the error returns to. Passwords and
 * files are never kept: a file input cannot be restored, and a password should
 * not outlive its form.
 *
 * The flash script marks <html> with `data-form-error` because it removes the
 * query parameters before this script runs.
 */
export const FORM_STATE_SCRIPT = `
(() => {
  if (window.__bunwriteFormState) return
  window.__bunwriteFormState = true

  const PREFIX = "bw-form:"
  const TTL = 10 * 60 * 1000

  function storage() {
    try { return window.sessionStorage } catch { return null }
  }

  // The page the form was on, without the flash parameters, so the page the
  // error returns to has the same key.
  function pageKey() {
    const url = new URL(location.href)
    url.searchParams.delete("ok")
    url.searchParams.delete("err")
    return url.pathname + url.search
  }
  const keyFor = () => PREFIX + pageKey()

  // A form that changes something: method="post", or an htmx verb. GET forms
  // (filters and search) are live requests and have nothing to keep.
  const posts = (form) =>
    ["hx-post", "hx-put", "hx-patch", "hx-delete"].some((name) => form.hasAttribute(name)) ||
    (form.getAttribute("method") || "").toLowerCase() === "post"

  // One record per named control, grouped by name in form.elements order. A
  // control the request would not send (disabled, a password, a file) leaves an
  // empty record, so the controls after it still line up on the way back.
  const restorable = (el) =>
    Boolean(el.name) &&
    (el instanceof HTMLInputElement
      ? el.type !== "password" && el.type !== "file"
      : el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)

  function record(el) {
    if (!restorable(el)) return null
    if (el instanceof HTMLInputElement) {
      if (el.disabled) return {}
      if (el.type === "checkbox" || el.type === "radio") return { v: el.value, c: el.checked }
      return { v: el.value }
    }
    if (el instanceof HTMLSelectElement) {
      if (el.disabled) return {}
      return { v: [...el.options].filter((option) => option.selected).map((option) => option.value) }
    }
    return el.disabled ? {} : { v: el.value }
  }

  function save(form) {
    const store = storage()
    const index = [...document.forms].indexOf(form)
    if (!store || index < 0) return
    const fields = Object.create(null)
    for (const el of form.elements) {
      const rec = record(el)
      if (rec) (fields[el.name] || (fields[el.name] = [])).push(rec)
    }
    try { store.setItem(keyFor(), JSON.stringify({ at: Date.now(), index, fields })) } catch {}
  }

  function apply(form, fields) {
    const seen = Object.create(null)
    for (const el of form.elements) {
      if (!restorable(el)) continue
      const records = fields[el.name]
      if (!records) continue
      const at = seen[el.name] = seen[el.name] === undefined ? 0 : seen[el.name] + 1
      const rec = records[at]
      if (!rec) continue
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        if ("c" in rec) el.checked = rec.c === true
        continue
      }
      if (!("v" in rec)) continue
      if (el instanceof HTMLSelectElement) {
        const chosen = Array.isArray(rec.v) ? rec.v : []
        if (el.multiple) for (const option of el.options) option.selected = chosen.includes(option.value)
        else el.value = chosen.length ? chosen[0] : ""
      } else {
        el.value = rec.v
      }
    }
  }

  // A value that came back was a choice, so the helpers that fill an ID from the
  // name and commands from the framework leave it alone.
  function keepChoices(form) {
    for (const el of form.querySelectorAll("[data-slug-from],[data-follow]")) {
      if (el.value) el.dataset.touched = "1"
    }
  }

  function sweep(store) {
    const now = Date.now()
    for (let i = store.length - 1; i >= 0; i--) {
      const key = store.key(i)
      if (!key || !key.startsWith(PREFIX)) continue
      try {
        const saved = JSON.parse(store.getItem(key) || "{}")
        if (!saved.at || now - saved.at > TTL) store.removeItem(key)
      } catch {
        store.removeItem(key)
      }
    }
  }

  // The error page: put the saved form back, and open its dialog when it has
  // one, so the user is where they left off. Other pages forget the copy a
  // successful submission left behind.
  function restore() {
    const root = document.documentElement
    const failed = root.dataset.formError === "1"
    delete root.dataset.formError
    const store = storage()
    if (!store) return
    sweep(store)
    const key = keyFor()
    if (!failed) {
      try { store.removeItem(key) } catch {}
      return
    }
    let saved = null
    try { saved = JSON.parse(store.getItem(key) || "null") } catch {}
    try { store.removeItem(key) } catch {}
    if (!saved || !saved.fields || Date.now() - saved.at > TTL) return
    const form = document.forms[saved.index]
    if (!form) return
    apply(form, saved.fields)
    keepChoices(form)
    const modal = form.closest("dialog")
    if (modal && !modal.open && modal.showModal) modal.showModal()
  }

  document.addEventListener("submit", (event) => {
    const form = event.target
    if (form instanceof HTMLFormElement && posts(form)) save(form)
  }, true)

  document.addEventListener("htmx:afterSwap", restore)
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", restore)
  else restore()
})()
`
