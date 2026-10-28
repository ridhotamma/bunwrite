/**
 * A thin bar at the top of the window while a console page loads or a form
 * is sent. Boosted links and forms fetch the next page in the background, so
 * without it a click shows nothing until the response arrives.
 *
 * The bar lives on <html>, outside <body>, because a boosted navigation
 * replaces everything in <body>. It appears only after a short wait, so fast
 * responses do not flash it.
 */
export const PROGRESS_CSS = `
.nav-progress{position:fixed;top:0;left:0;right:0;height:3px;z-index:1000;pointer-events:none;background:var(--focus);transform-origin:0 50%;transform:scaleX(0);opacity:0}
.nav-progress.run{opacity:1;transition:opacity .1s linear .12s;animation:nav-progress 10s cubic-bezier(.1,.6,.2,1) .12s forwards}
.nav-progress.done{opacity:0;transform:scaleX(1);transition:transform .15s ease-out,opacity .2s linear .15s}
@keyframes nav-progress{from{transform:scaleX(0)}to{transform:scaleX(.92)}}
button[aria-busy="true"],input[aria-busy="true"]{cursor:progress}
button[aria-busy="true"]::before{content:"";flex:none;display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:busy-spin .7s linear infinite;vertical-align:-2px}
.icon-btn[aria-busy="true"]>svg{display:none}
@keyframes busy-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.nav-progress.run{animation:none;transform:scaleX(.5)}.nav-progress.done{transition:none}button[aria-busy="true"]::before{animation-duration:2s}}
`

export const PROGRESS_SCRIPT = `
(() => {
  if (window.__bunwriteProgress) return
  window.__bunwriteProgress = true
  const SHOW_AFTER = 120
  const bar = document.createElement("div")
  bar.className = "nav-progress"
  bar.setAttribute("aria-hidden", "true")
  document.documentElement.append(bar)
  let pending = 0
  let startedAt = 0
  let fade = 0

  // Page loads only: boosted links and forms, the page an HX-Location redirect loads
  // into <body>, and filters that update the address bar. Live previews and other
  // small updates do not show the bar.
  const isNavigation = (d) => Boolean(d && (
    d.boosted ||
    d.target === document.body ||
    (d.elt && d.elt.closest && d.elt.closest('[hx-push-url]:not([hx-push-url="false"])'))
  ))
  // These responses send the browser to another page, which keeps loading.
  const leaving = (xhr) => Boolean(xhr && (xhr.getResponseHeader("HX-Redirect") || xhr.getResponseHeader("HX-Refresh") === "true"))

  function start() {
    pending++
    if (pending > 1) return
    clearTimeout(fade)
    startedAt = performance.now()
    bar.classList.remove("done", "run")
    void bar.offsetWidth
    bar.classList.add("run")
  }
  function finish() {
    if (pending === 0) return
    pending--
    if (pending > 0) return
    // Done before the bar appeared: nothing to animate.
    if (performance.now() - startedAt < SHOW_AFTER) {
      bar.classList.remove("run")
      return
    }
    // Hold the bar where it is, then grow it to full width and fade it out.
    bar.style.transform = getComputedStyle(bar).transform
    bar.classList.replace("run", "done")
    void bar.offsetWidth
    bar.style.transform = ""
    fade = setTimeout(() => bar.classList.remove("done"), 400)
  }

  // beforeSend, not beforeRequest: a request a handler cancels (a form already sending) never starts the bar.
  document.addEventListener("htmx:beforeSend", (e) => {
    const d = e.detail
    if (!isNavigation(d) || !d.xhr) return
    d.xhr.__navProgress = true
    start()
  })
  // Forms the browser sends itself (uploads, hx-boost="false", pages without htmx):
  // run until the next page replaces this one.
  document.addEventListener("submit", (e) => {
    const form = e.target
    setTimeout(() => {
      if (e.defaultPrevented || !(form instanceof HTMLFormElement)) return
      const target = (e.submitter && e.submitter.getAttribute("formtarget")) || form.getAttribute("target")
      if (target && target !== "_self") return
      start()
      // A download leaves this page in place: stop after a while.
      setTimeout(finish, 30000)
    }, 0)
  })
  document.addEventListener("htmx:afterRequest", (e) => {
    const xhr = e.detail && e.detail.xhr
    if (!xhr || !xhr.__navProgress) return
    xhr.__navProgress = false
    if (leaving(xhr)) return
    finish()
  })
  for (const name of ["htmx:abort", "htmx:sendError", "htmx:timeout"]) {
    document.addEventListener(name, (e) => {
      const xhr = e.detail && e.detail.xhr
      if (xhr && xhr.__navProgress) { xhr.__navProgress = false; finish() }
    })
  }
  // Back/forward restored from the browser cache: nothing in flight.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return
    pending = 0
    bar.classList.remove("run", "done")
  })
})()
`
