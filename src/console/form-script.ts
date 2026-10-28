/**
 * Small helpers for the database forms, as one delegated script:
 * - documents: typed fields and the JSON tab stay in sync; JSON is what is submitted
 * - `data-slug-from`: an ID input follows a name input until edited by hand
 * - `data-show-for`: show a block only for some values of a `data-show-by` select
 * - `data-disable-when`: disable an input while a checkbox is ticked
 * - `data-follow`: a field takes its value from another field's choice until edited by hand
 * - submit once: every POST form disables its submit buttons (with a spinner) from the first
 *   submit until the response, so a second click cannot send it again. `data-busy-label`
 *   also swaps the button text; `data-busy="off"` opts a form out
 */
export const FORM_SCRIPT = `
(() => {
  if (window.__bunwriteForms) return
  window.__bunwriteForms = true

  // ---- Documents ----
  const schemaOf = (root) => root.__schema || (root.__schema = JSON.parse(root.dataset.docform))
  const jsonBox = (root) => root.querySelector('textarea[name="data"]')
  const fieldOf = (root, key) => root.querySelector('[name="field:' + CSS.escape(key) + '"]')

  function parseOne(type, raw) {
    const v = String(raw).trim()
    if (v === "") return null
    if (type === "integer") return /^-?\\d+$/.test(v) ? Number(v) : v
    if (type === "double") return Number.isFinite(Number(v)) ? Number(v) : v
    if (type === "boolean") return v === "true" ? true : v === "false" ? false : v
    if (type === "datetime") { const d = new Date(v.endsWith("Z") ? v : v + "Z"); return Number.isNaN(d.getTime()) ? v : d.toISOString() }
    return String(raw)
  }
  function showOne(type, v) {
    if (v === null || v === undefined) return ""
    if (type === "datetime") { const d = new Date(v); return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 19) }
    return String(v)
  }
  function readJson(root) {
    try { const v = JSON.parse(jsonBox(root).value || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : null } catch { return null }
  }
  function fieldsToJson(root) {
    const data = readJson(root) || {}
    for (const a of schemaOf(root)) {
      const el = fieldOf(root, a.key)
      if (!el) continue
      data[a.key] = a.array
        ? el.value.split("\\n").map((s) => s.trim()).filter(Boolean).map((s) => parseOne(a.type, s))
        : parseOne(a.type, el.value)
    }
    jsonBox(root).value = JSON.stringify(data, null, 2)
  }
  function jsonToFields(root) {
    const data = readJson(root)
    const error = root.querySelector(".doc-error")
    if (!data) { error.hidden = false; error.textContent = "The JSON is not a valid object. Fix it to go back to the form."; return false }
    error.hidden = true
    for (const a of schemaOf(root)) {
      const el = fieldOf(root, a.key)
      if (!el) continue
      const v = data[a.key]
      el.value = a.array ? (Array.isArray(v) ? v.map((x) => showOne(a.type, x)).join("\\n") : "") : showOne(a.type, v)
    }
    return true
  }
  function setTab(root, tab) {
    if (tab === "form" && !jsonToFields(root)) return
    if (tab === "json") fieldsToJson(root)
    root.querySelector(".doc-fields").hidden = tab !== "form"
    root.querySelector(".doc-json").hidden = tab !== "json"
    for (const b of root.querySelectorAll("[data-doc-tab]")) {
      const on = b.dataset.docTab === tab
      b.classList.toggle("on", on)
      b.setAttribute("aria-selected", String(on))
    }
  }

  // ---- Generic helpers ----
  const slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "").slice(0, 36)
  function showFor(scope) {
    for (const select of scope.querySelectorAll("[data-show-by]")) {
      if (select.type === "radio" && !select.checked) continue
      const form = select.form || document
      for (const el of form.querySelectorAll('[data-show-for][data-for-select="' + select.name + '"]')) {
        el.hidden = !el.dataset.showFor.split(" ").includes(select.value)
        // Inputs in hidden blocks are disabled so they are not submitted.
        for (const input of el.querySelectorAll("input,select,textarea")) input.disabled = el.hidden
      }
    }
  }
  function disableWhen(scope) {
    for (const el of scope.querySelectorAll("[data-disable-when]")) {
      const box = (el.form || document).querySelector('[name="' + el.dataset.disableWhen + '"]')
      if (box) el.disabled = box.checked || Boolean(el.closest("[hidden]"))
    }
  }

  document.addEventListener("input", (e) => {
    const t = e.target
    const doc = t.closest && t.closest("[data-docform]")
    if (doc && t.name && t.name.startsWith("field:")) fieldsToJson(doc)
    if (t.matches && t.matches("[data-slug-source]")) {
      const target = (t.form || document).querySelector('[data-slug-from="' + t.name + '"]')
      if (target && !target.dataset.touched) target.value = slug(t.value)
    }
    if (t.matches && t.matches("[data-slug-from]")) t.dataset.touched = t.value ? "1" : ""
    if (t.matches && t.matches("[data-follow]")) t.dataset.touched = "1"
  })
  // Fields with data-follow="<name>" take a value from data-follow-values
  // (keyed by the part before "-", or "*") whenever <name> changes, until edited by hand.
  function follow(t) {
    const form = t.form
    if (!form || !t.name) return
    let toggled = false
    for (const el of form.querySelectorAll('[data-follow="' + t.name + '"]')) {
      if (el.dataset.touched) continue
      const values = JSON.parse(el.dataset.followValues || "{}")
      const key = String(t.value)
      const next = key in values ? values[key] : key.split("-")[0] in values ? values[key.split("-")[0]] : values["*"]
      if (next !== undefined) {
        el.value = next
        if (el.matches("[data-show-by]")) toggled = true
      }
    }
    // A followed select may control which blocks are visible (the site adapter).
    if (toggled) { showFor(form); disableWhen(form) }
  }
  document.addEventListener("change", (e) => {
    const t = e.target
    const doc = t.closest && t.closest("[data-docform]")
    if (doc && t.name && t.name.startsWith("field:")) fieldsToJson(doc)
    if (t.matches && t.matches("[data-show-by]")) { showFor(t.form || document); disableWhen(t.form || document) }
    if (t.type === "checkbox") disableWhen(t.form || document)
    if (t.matches && t.matches("[data-follow]")) t.dataset.touched = "1"
    follow(t)
  })
  document.addEventListener("click", (e) => {
    const tab = e.target.closest && e.target.closest("[data-doc-tab]")
    if (tab) setTab(tab.closest("[data-docform]"), tab.dataset.docTab)
    const now = e.target.closest && e.target.closest("[data-doc-now]")
    if (now) {
      const input = now.parentElement.querySelector("input")
      input.value = new Date().toISOString().slice(0, 19)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    }
    const add = e.target.closest && e.target.closest("[data-add-row]")
    if (add) {
      const template = document.querySelector(add.dataset.addRow)
      const target = add.dataset.rowTarget ? document.querySelector(add.dataset.rowTarget) : add.parentElement
      if (template && target) {
        const row = template.content.firstElementChild.cloneNode(true)
        target.append(row)
        const input = row.querySelector("input")
        if (input) input.focus()
      }
    }
    const remove = e.target.closest && e.target.closest("[data-remove-row]")
    if (remove) {
      const row = remove.closest("[data-row]")
      if (row.parentElement.querySelectorAll("[data-row]").length > 1) row.remove()
      else row.querySelector("input")?.focus()
    }
  })
  document.addEventListener("submit", (e) => {
    const doc = e.target.querySelector && e.target.querySelector("[data-docform]")
    if (doc && !doc.querySelector(".doc-fields").hidden) fieldsToJson(doc)
  }, true)

  // ---- Submit once ----
  // Every POST form: from the first submit until the response, its submit buttons are
  // disabled and show a spinner (and data-busy-label, when set), and further submits
  // are dropped. data-busy="off" opts a form out. GET forms (filters, search) are live
  // and left alone.
  const guarded = (form) =>
    form instanceof HTMLFormElement && (form.getAttribute("method") || "").toLowerCase() === "post" && form.dataset.busy !== "off"
  const submitButtons = (form) => {
    // getAttribute, not form.id: a field named "id" shadows the property.
    const id = form.getAttribute("id")
    return [
      ...form.querySelectorAll("button:not([type]),button[type=submit],input[type=submit]"),
      // Buttons outside the form (a dialog footer) that point at it with form="…".
      ...(id ? document.querySelectorAll(['button:not([type])', 'button[type=submit]', 'input[type=submit]'].map((s) => s + '[form="' + CSS.escape(id) + '"]').join(",")) : []),
    ]
  }
  function setBusy(form, busy) {
    form.__busy = busy
    clearTimeout(form.__busyTimer)
    for (const button of submitButtons(form)) {
      const label = form.dataset.busyLabel
      if (busy && label && button.tagName === "BUTTON") {
        if (button.__label == null) button.__label = button.textContent
        button.textContent = label
      } else if (!busy && button.__label != null) {
        button.textContent = button.__label
        button.__label = null
      }
      button.disabled = busy
      if (busy) button.setAttribute("aria-busy", "true")
      else button.removeAttribute("aria-busy")
    }
  }
  // The form a request is for: the form itself, or the submit button that sent it.
  const formOf = (el) => (el instanceof HTMLFormElement ? el : el instanceof Element && el.matches("[type=submit]") ? el.form : null)
  // Keep the buttons disabled while the next page loads; give them back if it never does.
  function holdBusy(form, ms) {
    setBusy(form, true)
    form.__busyTimer = setTimeout(() => setBusy(form, false), ms)
  }
  const redirects = (xhr) => xhr.status < 400 && Boolean(xhr.getResponseHeader("HX-Location") || xhr.getResponseHeader("HX-Redirect") || xhr.getResponseHeader("HX-Refresh"))

  // Forms htmx sends (boosted or hx-post): busy while the request is out.
  document.addEventListener("htmx:beforeRequest", (e) => {
    const form = formOf(e.detail && e.detail.elt)
    if (!guarded(form)) return
    if (form.__busy) { e.preventDefault(); return }
    // htmx has already read the form's values, so disabling now keeps the submitter's value.
    setBusy(form, true)
    if (e.detail.xhr) e.detail.xhr.__busyForm = form
  })
  const release = (e) => {
    const xhr = e.detail && e.detail.xhr
    const form = xhr && xhr.__busyForm
    if (!form) return
    xhr.__busyForm = null
    // Saved, and the console is moving on to the next page: stay disabled until it arrives.
    if (e.type === "htmx:afterRequest" && redirects(xhr)) holdBusy(form, 30000)
    else setBusy(form, false)
  }
  for (const name of ["htmx:afterRequest", "htmx:abort", "htmx:sendError", "htmx:timeout"]) document.addEventListener(name, release)

  // Forms the browser sends itself (hx-boost="false", pages without htmx): busy until the next page loads.
  document.addEventListener("submit", (e) => {
    const form = e.target
    if (!guarded(form)) return
    if (form.__busy) { e.preventDefault(); return }
    // htmx or another handler took this submit; htmx:beforeRequest covers it.
    if (e.defaultPrevented) return
    form.__busy = true
    // A form that opens another tab, or a response that is a download, leaves this page here.
    const target = (e.submitter && e.submitter.getAttribute("formtarget")) || form.getAttribute("target")
    // Disable after the browser has collected the form data, so the submitter's value is still sent.
    setTimeout(() => { if (form.__busy) holdBusy(form, target && target !== "_self" ? 1500 : 30000) }, 0)
  })
  // Leaving with the back button can restore the page from cache with the buttons still disabled.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) for (const form of document.querySelectorAll("form")) if (form.__busy) setBusy(form, false)
  })

  function setup() { showFor(document); disableWhen(document) }
  document.addEventListener("htmx:afterSwap", setup)
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup)
  else setup()
})()
`
