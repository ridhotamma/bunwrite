/**
 * A filterable combobox for long selects, after the native select pattern:
 * every `select[data-combobox]` keeps its place in the form and its htmx
 * attributes, and a text input in front of it filters the options. Picking an
 * option sets the select's value and dispatches `change`, so htmx requests
 * and the form's other listeners see it. Without JavaScript the select is a
 * normal select, so every form still works.
 */
export const COMBOBOX_SCRIPT = `
(() => {
  if (window.__bunwriteCombobox) return
  window.__bunwriteCombobox = true

  const ACTIVE = "is-active"
  const MAX_HEIGHT = 320
  let seq = 0

  const labelOf = (select) => (select.selectedOptions[0]?.textContent || "").trim()

  // The list lives on <body> so a card's overflow cannot clip it and the
  // label it opened from keeps only the field's own text. It is fixed to the
  // viewport and put back under its field on every scroll and resize, so it
  // never drifts from the input, whatever moves the page.
  function place(input, list) {
    const box = input.getBoundingClientRect()
    // A hidden field has no box; keep the list where it is.
    if (!box.width && !box.height) return
    const max = Math.min(MAX_HEIGHT, innerHeight - 16)
    list.style.maxHeight = max + "px"
    list.style.left = box.left + "px"
    list.style.width = box.width + "px"
    const height = Math.min(list.scrollHeight, max)
    const below = box.bottom + 4
    const above = box.top - height - 4
    const flip = box.bottom + 4 + height > innerHeight - 8 && box.top - height - 4 > 8
    list.dataset.side = flip ? "above" : "below"
    list.style.top = (flip ? above : below) + "px"
  }

  function enhance(select) {
    if (select.dataset.comboboxReady === "1" || select.multiple) return
    select.dataset.comboboxReady = "1"
    const id = "combo-" + (++seq)
    const name = select.dataset.combobox || "Options"
    const items = [...select.options].map((option) => ({ value: option.value, label: (option.textContent || "").trim() }))

    const wrap = document.createElement("span")
    wrap.className = "combobox"
    const input = document.createElement("input")
    input.type = "text"
    input.className = "combobox-input"
    input.autocomplete = "off"
    input.spellcheck = false
    input.setAttribute("role", "combobox")
    input.setAttribute("aria-expanded", "false")
    input.setAttribute("aria-autocomplete", "list")
    input.setAttribute("aria-controls", id)
    const list = document.createElement("div")
    list.className = "combobox-list"
    list.id = id
    list.setAttribute("role", "listbox")
    list.setAttribute("aria-label", name)
    list.__select = select

    const nodes = []
    let shown = []
    let active = -1

    const labelFor = (value) => {
      const match = items.find((item) => item.value === value)
      return match ? match.label : value
    }
    const sync = () => {
      input.value = labelFor(select.value)
      input.disabled = select.disabled
    }

    function build() {
      if (nodes.length || !items.length) return
      for (let i = 0; i < items.length; i++) {
        const node = document.createElement("div")
        node.className = "combobox-option"
        node.id = id + "-" + i
        node.setAttribute("role", "option")
        node.textContent = items[i].label
        node.addEventListener("mousedown", (event) => {
          // Keep the input focused, so the click does not blur the list shut first.
          event.preventDefault()
          choose(i)
        })
        list.append(node)
        nodes.push(node)
      }
    }
    function mark() {
      for (let i = 0; i < nodes.length; i++) nodes[i].setAttribute("aria-selected", String(items[i].value === select.value))
    }
    function filter(query) {
      build()
      const needle = query.trim().toLowerCase()
      const empty = list.querySelector(".combobox-empty")
      if (empty) empty.remove()
      shown = []
      for (let i = 0; i < nodes.length; i++) {
        const match = !needle || items[i].label.toLowerCase().includes(needle)
        nodes[i].hidden = !match
        nodes[i].classList.remove(ACTIVE)
        if (match) shown.push(i)
      }
      active = -1
      input.removeAttribute("aria-activedescendant")
      if (!shown.length) {
        const none = document.createElement("div")
        none.className = "combobox-empty"
        none.textContent = "No matches"
        list.append(none)
      }
    }
    function setActive(index) {
      for (const node of nodes) node.classList.remove(ACTIVE)
      active = index
      const node = nodes[index]
      if (!node) {
        input.removeAttribute("aria-activedescendant")
        return
      }
      node.classList.add(ACTIVE)
      input.setAttribute("aria-activedescendant", node.id)
      node.scrollIntoView({ block: "nearest" })
    }
    const isOpen = () => list.classList.contains("is-open")
    // Scroll, resize and a swap above the field all move the input: put the
    // list back under it instead of letting it drift or dropping it.
    let frame = 0
    let last = ""
    const reposition = () => {
      if (!isOpen()) return
      last = ""
      place(input, list)
    }
    list.__place = reposition
    // A field that moved after opening (focus scrolling, a swap, fonts) would
    // leave a one-off measurement behind. Watch it every frame while open, and
    // only write when it actually moved, so the list is always under the field.
    function track() {
      if (!isOpen()) return
      frame = requestAnimationFrame(track)
      const box = input.getBoundingClientRect()
      const key = box.top + ":" + box.left + ":" + box.width + ":" + innerHeight + ":" + list.scrollHeight
      if (key === last) return
      last = key
      place(input, list)
    }
    function outside(event) {
      if (event.target instanceof Node && (wrap.contains(event.target) || list.contains(event.target))) return
      close()
    }
    function open() {
      if (input.disabled || isOpen()) return
      // The label is not a filter: focusing shows every option first.
      filter(input.value === labelFor(select.value) ? "" : input.value)
      mark()
      place(input, list)
      list.classList.add("is-open")
      input.setAttribute("aria-expanded", "true")
      document.addEventListener("mousedown", outside, true)
      addEventListener("resize", reposition)
      document.addEventListener("scroll", reposition, { capture: true, passive: true })
      last = ""
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(track)
    }
    function close() {
      if (!isOpen()) return
      list.classList.remove("is-open")
      input.setAttribute("aria-expanded", "false")
      input.removeAttribute("aria-activedescendant")
      active = -1
      cancelAnimationFrame(frame)
      frame = 0
      document.removeEventListener("mousedown", outside, true)
      removeEventListener("resize", reposition)
      document.removeEventListener("scroll", reposition, true)
      sync()
    }
    function choose(index) {
      const item = items[index]
      if (!item) return
      const before = select.value
      select.value = item.value
      sync()
      close()
      input.focus()
      // Like a native select: only a different option is a change.
      if (select.value !== before) select.dispatchEvent(new Event("change", { bubbles: true }))
    }

    input.addEventListener("focus", () => {
      open()
      input.select()
    })
    input.addEventListener("blur", close)
    input.addEventListener("input", () => {
      open()
      filter(input.value)
      // Fewer options can change the height, and with it the side it fits on.
      if (isOpen()) place(input, list)
    })
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        if (!isOpen()) return open()
        if (!shown.length) return
        const at = shown.indexOf(active)
        const next = event.key === "ArrowDown" ? (at + 1) % shown.length : at <= 0 ? shown.length - 1 : at - 1
        setActive(shown[next])
      } else if (event.key === "Enter") {
        if (isOpen() && active >= 0) {
          event.preventDefault()
          choose(active)
        }
      } else if (event.key === "Escape") {
        if (isOpen()) {
          event.preventDefault()
          close()
        }
      } else if (event.key === "Tab") {
        close()
      } else if ((event.key === "Home" || event.key === "End") && isOpen() && shown.length) {
        event.preventDefault()
        setActive(shown[event.key === "Home" ? 0 : shown.length - 1])
      }
    })
    select.addEventListener("change", sync)

    select.parentNode.insertBefore(wrap, select)
    wrap.append(input, select)
    document.body.append(list)
    select.classList.add("combobox-native")
    select.tabIndex = -1
    select.setAttribute("aria-hidden", "true")
    sync()
  }

  // A swap replaces the select, so its list goes with it.
  function clean() {
    for (const list of document.querySelectorAll(".combobox-list")) {
      if (!list.__select || !list.__select.isConnected) list.remove()
    }
  }
  function setup(root) {
    if (!root || !root.querySelectorAll) return
    clean()
    if (root.matches && root.matches("select[data-combobox]")) enhance(root)
    for (const select of root.querySelectorAll("select[data-combobox]")) enhance(select)
    for (const list of document.querySelectorAll(".combobox-list.is-open")) if (list.__place) list.__place()
  }
  document.addEventListener("htmx:afterSwap", () => setup(document))
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setup(document))
  else setup(document)
})()
`
