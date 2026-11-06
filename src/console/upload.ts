/** A file picker with a drop zone, used everywhere the console uploads a file. */
import { html, type Html } from './html'
import { icon } from './ui'

export interface FileFieldOptions {
  /** The input's name, which the server reads from the form. */
  name: string
  /** Label above the drop zone, such as "Archive". */
  label: string
  id?: string
  accept?: string
  required?: boolean
  multiple?: boolean
  /** Main line inside the drop zone. */
  title?: string
  /** Formats, limits or a short note under the title. */
  hint?: Html | string
  /** Help text under the drop zone. */
  help?: Html | string
  /** Extra attributes for the file input. */
  attrs?: Html
}

/**
 * A file input styled as a drop zone. The input itself fills the zone and is
 * transparent, so clicking anywhere opens the picker, dragging a file onto it
 * works without JavaScript, and native validation points at the zone.
 * `FILE_UPLOAD_SCRIPT` adds the hover state, the chosen file's name and size,
 * and the Remove button.
 */
export function fileField(options: FileFieldOptions): Html {
  const id = options.id ?? `upload-input-${options.name.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  return html`<div class="upload-field" data-upload>
    <label class="upload-label" for="${id}">${options.label}</label>
    <label class="upload-zone" data-upload-zone>
      <input
        id="${id}"
        class="upload-input"
        type="file"
        name="${options.name}"
        ${options.accept ? html`accept="${options.accept}"` : ''}
        ${options.required ? 'required' : ''}
        ${options.multiple ? 'multiple' : ''}
        data-upload-input
        ${options.attrs ?? ''}
      >
      <span class="upload-icon" aria-hidden="true">${icon('upload-simple', 20)}</span>
      <span class="upload-copy">
        <span class="upload-empty">
          <span class="upload-title">${options.title ?? 'Drag and drop a file here'}</span>
          ${options.hint ? html`<span class="upload-sub">${options.hint}</span>` : ''}
        </span>
        <span class="upload-picked" data-upload-picked hidden aria-live="polite">
          <span class="upload-file-name" data-upload-name></span>
          <span class="upload-file-meta" data-upload-meta></span>
        </span>
      </span>
      <span class="upload-browse" aria-hidden="true">Browse</span>
    </label>
    <div class="upload-foot">
      ${options.help ? html`<small class="upload-help">${options.help}</small>` : ''}
      <button type="button" class="upload-clear" data-upload-clear hidden>Remove</button>
    </div>
    <span class="upload-error" data-upload-error role="alert" hidden></span>
  </div>`
}

/**
 * Drag and drop for `fileField` zones: highlights the zone while a file is
 * over it, copies dropped files into the input (dropping a .zip on a plain
 * input otherwise types the path into it in some browsers), and keeps the
 * chosen file's name, size and Remove button in step with the input.
 */
export const FILE_UPLOAD_SCRIPT = `
(() => {
  if (window.__bunwriteUploads) return
  window.__bunwriteUploads = true

  const size = (n) =>
    n < 1024 ? n + " B"
      : n < 1048576 ? (n / 1024).toFixed(1) + " KB"
        : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB"
          : (n / 1073741824).toFixed(2) + " GB"

  const zoneOf = (el) => (el instanceof Element ? el.closest("[data-upload-zone]") : null)
  const inputOf = (zone) => zone.querySelector("[data-upload-input]")
  const fieldOf = (el) => (el instanceof Element ? el.closest("[data-upload]") : null)

  function setError(zone, text) {
    const field = fieldOf(zone)
    const box = field && field.querySelector("[data-upload-error]")
    if (!box) return
    box.textContent = text || ""
    box.hidden = !text
  }

  function sync(zone) {
    const input = inputOf(zone)
    if (!input) return
    const files = input.files ? [...input.files] : []
    const file = files[0]
    zone.classList.toggle("has-file", files.length > 0)
    const field = fieldOf(zone)
    const picked = zone.querySelector("[data-upload-picked]")
    const name = zone.querySelector("[data-upload-name]")
    const meta = zone.querySelector("[data-upload-meta]")
    if (picked) picked.hidden = files.length === 0
    if (name) {
      name.textContent = files.length > 1 ? files.length + " files selected" : file ? file.name : ""
      name.title = file ? file.name : ""
    }
    if (meta) {
      meta.textContent = files.length > 1 ? size(files.reduce((sum, f) => sum + f.size, 0)) : file ? size(file.size) : ""
    }
    const clear = field && field.querySelector("[data-upload-clear]")
    if (clear) clear.hidden = files.length === 0
    setError(zone, "")
  }

  /** Whether a dropped file matches the input's accept attribute. */
  function accepted(file, accept) {
    if (!accept) return true
    const name = file.name.toLowerCase()
    const type = (file.type || "").toLowerCase()
    return accept.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean).some((rule) => {
      if (rule.startsWith(".")) return name.endsWith(rule)
      if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1))
      return type === rule
    })
  }

  function acceptedLabel(accept) {
    const extensions = accept.split(",").map((part) => part.trim()).filter((part) => part.startsWith("."))
    return extensions.length ? extensions.join(", ") : ""
  }

  function assign(zone, files) {
    const input = inputOf(zone)
    if (!input || input.disabled || !files.length) return
    if (!input.multiple && files.length > 1) {
      setError(zone, "Only one file can be uploaded here. Drop a single file.")
      return
    }
    const accept = input.getAttribute("accept") || ""
    const bad = files.find((file) => !accepted(file, accept))
    if (bad) {
      const types = acceptedLabel(accept)
      setError(zone, types ? "Only " + types + " files can be uploaded here." : "That file type is not accepted here.")
      return
    }
    try {
      const transfer = new DataTransfer()
      for (const file of files) transfer.items.add(file)
      input.files = transfer.files
      input.dispatchEvent(new Event("change", { bubbles: true }))
    } catch {
      setError(zone, "Could not read that file. Use Browse to choose it instead.")
    }
  }

  for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
    document.addEventListener(type, (event) => {
      const zone = zoneOf(event.target)
      if (!zone) return
      // A dropped file must not open in the tab, and dragover must allow a drop.
      event.preventDefault()
      if (type === "dragenter" || type === "dragover") {
        zone.classList.add("is-dragover")
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
        return
      }
      zone.classList.remove("is-dragover")
      if (type === "dragleave") return
      const data = event.dataTransfer
      if (!data) return
      if (!data.files || !data.files.length) {
        // Some browsers expose a dropped folder as an item with no File, so
        // say why nothing happened instead of leaving the zone unchanged.
        const items = [...(data.items || [])]
        const folder = items.some((item) => {
          try {
            const entry = item.kind === "file" && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null
            return Boolean(entry && entry.isDirectory)
          } catch {
            return false
          }
        })
        if (folder) setError(zone, "Folders cannot be dropped directly. Zip the folder, then drop the archive.")
        return
      }
      assign(zone, [...data.files])
    })
  }
  // Leaving the window (or the drag ending anywhere) clears any highlighted zone.
  document.addEventListener("dragend", () => {
    for (const zone of document.querySelectorAll("[data-upload-zone].is-dragover")) zone.classList.remove("is-dragover")
  })
  window.addEventListener("blur", () => {
    for (const zone of document.querySelectorAll("[data-upload-zone].is-dragover")) zone.classList.remove("is-dragover")
  })

  document.addEventListener("change", (event) => {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || input.type !== "file" || !input.matches("[data-upload-input]")) return
    const zone = zoneOf(input)
    if (zone) sync(zone)
  })

  document.addEventListener("click", (event) => {
    const clear = event.target instanceof Element ? event.target.closest("[data-upload-clear]") : null
    if (!clear) return
    const field = fieldOf(clear)
    const input = field && field.querySelector("[data-upload-input]")
    if (!input) return
    // Clearing the input also drops the old file from the submission.
    input.value = ""
    input.dispatchEvent(new Event("change", { bubbles: true }))
    input.focus()
  })

  function setup() {
    for (const zone of document.querySelectorAll("[data-upload-zone]")) sync(zone)
  }
  document.addEventListener("htmx:afterSwap", setup)
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup)
  else setup()
})()
`
