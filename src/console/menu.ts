/** Client runtime for `menu()` dropdowns: one open at a time, placed inside the viewport, closed by outside clicks and Escape. */
export const MENU_SCRIPT = `
(() => {
  if (window.__bunwriteMenus) return
  window.__bunwriteMenus = true
  const openMenus = () => document.querySelectorAll("details.menu-root[open]")
  const closeAll = (except) => { for (const root of openMenus()) if (root !== except) root.open = false }
  // Inside the expanded sidebar (and the phone drawer, which slides with a
  // transform) the menu fits, so it drops down in place instead.
  const inPlace = (root) =>
    root.closest(".nav") && (matchMedia("(max-width: 768px)").matches || !document.documentElement.classList.contains("nav-collapsed"))
  function place(root) {
    const button = root.querySelector(":scope > summary")
    const menu = root.querySelector(":scope > .menu")
    if (!button || !menu) return
    if (inPlace(root)) {
      menu.classList.remove("menu-fixed")
      menu.style.left = menu.style.top = ""
      return
    }
    menu.classList.add("menu-fixed")
    menu.style.visibility = "hidden"
    const r = button.getBoundingClientRect()
    const w = menu.offsetWidth
    const h = menu.offsetHeight
    let left = root.dataset.align === "start" ? r.left : r.right - w
    left = Math.max(8, Math.min(left, innerWidth - w - 8))
    let top = r.bottom + 4
    if (top + h > innerHeight - 8 && r.top - h - 4 > 8) top = r.top - h - 4
    menu.style.left = left + "px"
    menu.style.top = top + "px"
    menu.style.visibility = ""
  }
  document.addEventListener("toggle", (event) => {
    const root = event.target
    if (!(root instanceof HTMLDetailsElement) || !root.classList.contains("menu-root") || !root.open) return
    closeAll(root)
    place(root)
  }, true)
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null
    for (const root of openMenus()) if (!target || !root.contains(target)) root.open = false
    const item = target && target.closest(".menu a, .menu button")
    if (item) { const root = item.closest("details.menu-root"); if (root) setTimeout(() => { root.open = false }, 0) }
  })
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return
    for (const root of openMenus()) { root.open = false; const s = root.querySelector("summary"); if (s) s.focus() }
  })
  addEventListener("resize", () => closeAll())
  addEventListener("scroll", (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (target && target.closest(".menu")) return
    closeAll()
  }, true)
})()
`
