/** Accessible dialog component plus the small client runtime for it. */
import { html, type Html } from './html'

export interface DialogOptions {
  id: string
  title: string
  body: Html
  actions: Html
  /** Open as soon as the page (or an htmx swap) renders it. */
  open?: boolean
  /** Wider than a plain confirmation: for forms with several fields side by side. */
  wide?: boolean
}

export function dialog({ id, title, body, actions, open = false, wide = false }: DialogOptions): Html {
  return html`<dialog id="${id}" class="dialog${wide ? ' dialog-wide' : ''}" ${open ? html`open data-open` : ''} aria-labelledby="${id}-title">
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
  const FLAG = "__bunwriteDialogs"
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
  function hideNavTooltip() {
    const tip = document.getElementById("nav-tooltip")
    if (tip) tip.hidden = true
  }
  function showNavTooltip(event) {
    if (!document.documentElement.classList.contains("nav-collapsed") || !window.matchMedia("(min-width: 769px)").matches) return
    const target = event.target instanceof Element ? event.target.closest("[data-tooltip]") : null
    if (!target || !target.closest(".nav")) return
    const tip = document.getElementById("nav-tooltip")
    if (!tip) return
    tip.textContent = target.getAttribute("data-tooltip") || ""
    tip.hidden = false
    const rect = target.getBoundingClientRect()
    const top = Math.max(8, Math.min(window.innerHeight - tip.offsetHeight - 8, rect.top + rect.height / 2 - tip.offsetHeight / 2))
    tip.style.left = rect.right + 10 + "px"
    tip.style.top = top + "px"
  }
  function fmtBytes(value) {
    if (!Number.isFinite(value) || value <= 0) return "0 B"
    const units = ["B", "KB", "MB", "GB", "TB"]
    let number = value
    let unit = 0
    while (number >= 1024 && unit < units.length - 1) {
      number /= 1024
      unit++
    }
    return (unit === 0 ? Math.round(number) : number.toFixed(number >= 10 ? 1 : 2)) + " " + units[unit]
  }
  function setupCharts() {
    for (const el of document.querySelectorAll("[data-chart]:not([data-chart-ready])")) {
      const svg = el.querySelector("svg")
      const tooltip = el.querySelector("[data-chart-tooltip]")
      const time = el.querySelector("[data-chart-time]")
      const rows = el.querySelector("[data-chart-rows]")
      const cursor = el.querySelector("[data-chart-cursor]")
      if (!svg || !tooltip || !time || !rows || !cursor) continue
      let chart
      try {
        chart = JSON.parse(el.getAttribute("data-chart") || "{}")
      } catch {
        continue
      }
      if (!chart.labels?.length || !chart.series?.length) continue
      el.setAttribute("data-chart-ready", "1")
      const width = chart.width
      const height = chart.height
      const pad = chart.pad
      const innerW = width - pad.left - pad.right
      const innerH = height - pad.top - pad.bottom
      const max = Math.max(1, ...chart.series.flatMap((series) => series.values))
      const xAt = (index) => pad.left + (index / Math.max(1, chart.labels.length - 1)) * innerW
      const yAt = (value) => pad.top + innerH - (value / max) * innerH
      const hide = () => {
        tooltip.hidden = true
        cursor.setAttribute("visibility", "hidden")
        for (const dot of el.querySelectorAll("[data-chart-cursor-dot]")) dot.setAttribute("visibility", "hidden")
      }
      svg.addEventListener("pointermove", (event) => {
        const rect = svg.getBoundingClientRect()
        if (!rect.width) return
        const viewX = ((event.clientX - rect.left) / rect.width) * width
        const index = Math.max(0, Math.min(chart.labels.length - 1, Math.round(((viewX - pad.left) / innerW) * (chart.labels.length - 1))))
        const x = xAt(index)
        cursor.setAttribute("x1", String(x))
        cursor.setAttribute("x2", String(x))
        cursor.setAttribute("y1", String(pad.top))
        cursor.setAttribute("y2", String(height - pad.bottom))
        cursor.setAttribute("visibility", "visible")
        for (const dot of el.querySelectorAll("[data-chart-cursor-dot]")) {
          const series = chart.series[Number(dot.getAttribute("data-chart-cursor-dot"))]
          if (!series) continue
          dot.setAttribute("cx", String(x))
          dot.setAttribute("cy", String(yAt(series.values[index] ?? 0)))
          dot.setAttribute("visibility", "visible")
        }
        time.textContent = chart.labels[index]
        const next = chart.series.map((series) => {
          const row = document.createElement("div")
          row.className = "chart-tooltip-row"
          const label = document.createElement("span")
          label.className = "chart-tooltip-label"
          const dot = document.createElement("span")
          dot.className = "chart-tooltip-dot"
          dot.style.background = series.color
          label.append(dot, document.createTextNode(series.label))
          const value = document.createElement("b")
          value.textContent = fmtBytes(series.values[index] ?? 0)
          row.append(label, value)
          return row
        })
        rows.replaceChildren(...next)
        tooltip.hidden = false
        const chartRect = el.getBoundingClientRect()
        const left = rect.left - chartRect.left + x * (rect.width / width)
        tooltip.style.top = (rect.top - chartRect.top + 8) + "px"
        const half = tooltip.offsetWidth / 2
        tooltip.style.left = Math.max(half + 4, Math.min(chartRect.width - half - 4, left)) + "px"
      })
      svg.addEventListener("pointerleave", hide)
    }
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
      const navToggle = target.closest("[data-nav-toggle]")
      if (navToggle) {
        const collapsed = document.documentElement.classList.toggle("nav-collapsed")
        try {
          localStorage.setItem("bunwrite-nav", collapsed ? "collapsed" : "expanded")
        } catch {}
        hideNavTooltip()
        return
      }
      const opener = target.closest("[data-dialog-open]")
      if (opener) {
        const selector = opener.getAttribute("data-dialog-open")
        const modal = selector ? document.querySelector(selector) : null
        if (modal) {
          // A link opener is the no-JavaScript fallback; with JavaScript, open the dialog instead.
          event.preventDefault()
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
    // On phones the tabs scroll sideways; bring the active one into view.
    const showActiveTab = () => {
      for (const tab of document.querySelectorAll(".tabs a.on")) {
        const bar = tab.parentElement
        if (bar && bar.scrollWidth > bar.clientWidth) bar.scrollLeft = tab.offsetLeft - bar.offsetLeft - (bar.clientWidth - tab.offsetWidth) / 2
      }
    }
    document.addEventListener("htmx:afterSwap", () => {
      showOpenDialogs()
      setupCharts()
      showActiveTab()
    })
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showActiveTab)
    else showActiveTab()
    document.addEventListener("pointerover", showNavTooltip)
    document.addEventListener("focusin", showNavTooltip)
    document.addEventListener("pointerout", (event) => {
      if (event.target instanceof Element && event.target.closest(".nav")) hideNavTooltip()
    })
    document.addEventListener("focusout", hideNavTooltip)
    window.addEventListener("scroll", hideNavTooltip, true)
    window.addEventListener("resize", hideNavTooltip)
  }
  showOpenDialogs()
  setupCharts()
})()
`
