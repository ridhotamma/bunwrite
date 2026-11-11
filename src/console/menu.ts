/**
 * Client runtime for `menu()` dropdowns: one open at a time, placed inside the
 * viewport, closed by outside clicks and Escape, and animated in and out.
 *
 * Opening is done here rather than by the browser so the menu is placed in the
 * same frame it appears; the CSS keeps an unplaced menu hidden, so it never
 * shows at its default spot first. Closing plays the out animation before the
 * menu is hidden.
 */
export const MENU_SCRIPT = `
(() => {
  if (window.__bunwriteMenus) return
  window.__bunwriteMenus = true
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)")
  const openMenus = () => document.querySelectorAll("details.menu-root[open]")
  const menuOf = (root) => root.querySelector(":scope > .menu")
  // Inside the expanded sidebar (and the phone drawer, which slides with a
  // transform) the menu fits, so it drops down in place instead.
  const inPlace = (root) =>
    root.closest(".nav") && (matchMedia("(max-width: 768px)").matches || !document.documentElement.classList.contains("nav-collapsed"))
  function place(root) {
    const button = root.querySelector(":scope > summary")
    const menu = menuOf(root)
    if (!button || !menu) return
    if (inPlace(root)) {
      menu.classList.remove("menu-fixed")
      menu.style.left = menu.style.top = ""
      menu.dataset.side = "bottom"
    } else {
      menu.classList.add("menu-fixed")
      const r = button.getBoundingClientRect()
      const w = menu.offsetWidth
      const h = menu.offsetHeight
      let left = root.dataset.align === "start" ? r.left : r.right - w
      left = Math.max(8, Math.min(left, innerWidth - w - 8))
      let top = r.bottom + 4
      const above = top + h > innerHeight - 8 && r.top - h - 4 > 8
      if (above) top = r.top - h - 4
      menu.style.left = left + "px"
      menu.style.top = top + "px"
      menu.dataset.side = above ? "top" : "bottom"
    }
    menu.dataset.placed = ""
  }
  function open(root) {
    root.open = true
    place(root)
  }
  function finish(root) {
    const menu = menuOf(root)
    if (menu) { delete menu.dataset.closing; delete menu.dataset.placed }
    root.open = false
  }
  function close(root) {
    const menu = menuOf(root)
    if (!root.open || (menu && "closing" in menu.dataset)) return
    if (!menu || reduceMotion.matches || !("placed" in menu.dataset)) return finish(root)
    menu.dataset.closing = ""
    let done = false
    const end = () => { if (!done) { done = true; finish(root) } }
    menu.addEventListener("animationend", end, { once: true })
    setTimeout(end, 200)
  }
  const closeAll = (except) => { for (const root of openMenus()) if (root !== except) close(root) }
  // Opened some other way (script, keyboard on an older browser): place it now.
  // Closed some other way: forget the placement so the next open animates.
  document.addEventListener("toggle", (event) => {
    const root = event.target
    if (!(root instanceof HTMLDetailsElement) || !root.classList.contains("menu-root")) return
    const menu = menuOf(root)
    if (!menu) return
    if (root.open && !("placed" in menu.dataset)) { closeAll(root); place(root) }
    if (!root.open) { delete menu.dataset.closing; delete menu.dataset.placed }
  }, true)
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null
    const summary = target && target.closest("details.menu-root > summary")
    const own = summary ? summary.parentElement : null
    for (const root of openMenus()) if (root !== own && !(target && root.contains(target))) close(root)
    if (own) {
      event.preventDefault()
      if (own.open) close(own)
      else open(own)
      return
    }
    const item = target && target.closest(".menu a, .menu button")
    if (item) { const root = item.closest("details.menu-root"); if (root) setTimeout(() => close(root), 0) }
  })
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return
    for (const root of openMenus()) { close(root); const s = root.querySelector("summary"); if (s) s.focus() }
  })
  addEventListener("resize", () => closeAll())
  addEventListener("scroll", (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (target && target.closest(".menu")) return
    closeAll()
  }, true)
})()
`
