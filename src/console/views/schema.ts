/** Schema page and panels markup. The page loads, validates and applies changes. */
import { html, raw, type Html } from '~/console/html'
import { alert, badge, emptyState, header, icon, settingsSection, tabs as tabList } from '~/console/ui'
import { SCHEMA } from '~/console/schema-meta'

const SCHEMA_TABS = [
  { key: 'configuration', label: 'Configuration', href: SCHEMA },
  { key: 'export', label: 'Export collections', href: `${SCHEMA}/export` },
  { key: 'import', label: 'Import collections', href: `${SCHEMA}/import` },
] as const

type SchemaTab = (typeof SCHEMA_TABS)[number]['key']

const schemaTabs = (active: SchemaTab) => tabList(SCHEMA_TABS, active)

function changeList(changes: string[]): Html {
  if (!changes.length) return html`<p class="subdued" style="margin:0">No changes. The database already matches.</p>`
  return html`<ul class="list">${changes.map((c) => html`<li><span class="mono">${c}</span>${c.startsWith('+') ? badge('Add', 'success') : c.startsWith('-') ? badge('Remove', 'critical') : badge('Change', 'attention')}</li>`)}</ul>`
}

function exportPanel(selected: Record<string, any>[], download: string): Html {
  const json = JSON.stringify(selected, null, 2)
  const columns = selected.reduce((sum, collection) => sum + (collection.columns?.length ?? 0), 0)
  const indexes = selected.reduce((sum, collection) => sum + (collection.indexes?.length ?? 0), 0)
  const bytes = new TextEncoder().encode(json).length
  const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
  return html`<div id="export-panel">
    <div class="card">
      <div class="card-head">
        <h2>JSON preview</h2>
        ${selected.length
          ? html`<div class="card-head-actions"><button type="button" class="small" data-copy-target="#export-json">Copy</button><a class="btn small primary" href="${download}" hx-boost="false" download="collections.json">Download</a></div>`
          : ''}
      </div>
      ${selected.length
        ? html`<div class="export-stats">
            <span><b>${selected.length}</b> ${selected.length === 1 ? 'collection' : 'collections'}</span>
            <span><b>${columns}</b> ${columns === 1 ? 'column' : 'columns'}</span>
            <span><b>${indexes}</b> ${indexes === 1 ? 'index' : 'indexes'}</span>
            <span class="subdued">${size}</span>
          </div>
          <pre id="export-json" class="export-json">${json}</pre>`
        : emptyState('No collections selected', 'Tick collections on the left to preview and download their JSON.')}
    </div>
  </div>`
}

/** Search, group checkboxes and the selected count. The form only refreshes the JSON panel. */
const EXPORT_SCRIPT = `
(() => {
  const rows = (root) => [...root.querySelectorAll("[data-export-row]")]
  const visible = (row) => !row.hidden && !row.closest("[data-export-group]").hidden
  const sync = (form) => {
    if (!form) return
    let picked = 0
    let total = 0
    for (const group of form.querySelectorAll("[data-export-group]")) {
      const boxes = rows(group).filter((row) => !row.hidden).map((row) => row.querySelector("input[name='ids']"))
      const on = boxes.filter((box) => box.checked).length
      const toggle = group.querySelector("[data-export-toggle]")
      toggle.checked = boxes.length > 0 && on === boxes.length
      toggle.indeterminate = on > 0 && on < boxes.length
      const all = rows(group).map((row) => row.querySelector("input[name='ids']"))
      group.querySelector("[data-export-count]").textContent = all.filter((box) => box.checked).length + "/" + all.length
    }
    for (const box of form.querySelectorAll("input[name='ids']")) {
      total++
      if (box.checked) picked++
    }
    const count = form.querySelector("[data-export-total]")
    if (count) count.textContent = picked + " of " + total + " selected"
  }
  const filter = (input) => {
    const form = input.closest("form")
    const query = input.value.trim().toLowerCase()
    let shown = 0
    for (const group of form.querySelectorAll("[data-export-group]")) {
      let any = false
      for (const row of rows(group)) {
        row.hidden = Boolean(query) && !row.dataset.exportRow.includes(query)
        if (!row.hidden) any = true
      }
      group.hidden = !any
      if (any) shown++
    }
    const none = form.querySelector("[data-export-none]")
    if (none) none.hidden = shown > 0
    sync(form)
  }
  window.__bunwriteExportSync = sync
  if (window.__bunwriteExport) return
  window.__bunwriteExport = true
  // Typing in the search box filters rows; it must not refresh the panel.
  document.addEventListener("change", (event) => {
    if (event.target instanceof Element && event.target.matches("[data-export-filter]")) event.stopPropagation()
  }, true)
  document.addEventListener("input", (event) => {
    if (event.target instanceof Element && event.target.matches("[data-export-filter]")) filter(event.target)
  })
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target instanceof Element && event.target.matches("[data-export-filter]")) event.preventDefault()
  })
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    // The checkbox has already flipped; its change event submits after this.
    const toggle = target.closest("[data-export-toggle]")
    if (toggle) {
      const group = toggle.closest("[data-export-group]")
      for (const row of rows(group)) if (!row.hidden) row.querySelector("input[name='ids']").checked = toggle.checked
      sync(toggle.closest("form"))
      return
    }
    const bulk = target.closest("[data-export-bulk]")
    if (bulk) {
      const form = bulk.closest("form")
      const checked = bulk.dataset.exportBulk === "all"
      for (const row of rows(form)) if (visible(row)) row.querySelector("input[name='ids']").checked = checked
      sync(form)
      form.requestSubmit()
    }
  })
  document.addEventListener("change", (event) => {
    if (event.target instanceof Element && event.target.matches("#export-form input[name='ids']")) sync(event.target.closest("form"))
  })
})()
window.__bunwriteExportSync(document.getElementById("export-form"))
`

function exportGroups(all: Record<string, any>[], databases: Map<string, string>) {
  const groups = new Map<string, Record<string, any>[]>()
  for (const collection of all) {
    const list = groups.get(collection.databaseId) ?? []
    list.push(collection)
    groups.set(collection.databaseId, list)
  }
  return [...groups].map(([id, collections]) => ({ id, name: databases.get(id) ?? id, collections }))
}

export function configurationView(options: { schemaPath?: string; fileName: string }): Html {
  const path = options.schemaPath
  const file = options.fileName
  return html`${header('Schema')}${schemaTabs('configuration')}
  ${alert('info', html`Databases, collections, buckets and functions can be described in <code>${file}</code>, the file your project keeps in its repo. Edits made in this console change the database directly; export them to keep the file in step.`)}
  ${settingsSection(
    'Import from a file',
    'Creates and alters the databases and collections the file describes. Functions, buckets and sites in the file are skipped. Preview first; nothing changes until you apply.',
    html`<form method="post" action="${SCHEMA}/preview" enctype="multipart/form-data" hx-boost="false">
      <label>File<input type="file" name="file" accept=".json,application/json"><small>${path ? html`Leave empty to use <code>${path}</code>.` : html`${file}, bunwrite.json or appwrite.config.json`}</small></label>
      <label class="check"><input type="checkbox" name="prune">Also delete collections missing from the file</label>
      <div class="foot"><button class="primary">Preview changes</button></div>
    </form>`,
  )}
  ${settingsSection(
    'Export the current schema',
    `The current schema as ${file}${path ? ', with the rest of your file kept as is' : ''}.`,
    html`<div class="foot" style="justify-content:flex-start"><a class="btn" href="${SCHEMA}/export.json" hx-boost="false" download="${file}">Download</a>
      ${path
        ? html`<form method="post" action="${SCHEMA}/save" class="inline" data-confirm="Overwrite ${path} with the current schema?" data-confirm-label="Overwrite" data-confirm-tone="critical"><button>Save to ${path.split('/').pop()}</button></form>`
        : ''}</div>`,
  )}`
}

export interface ExportView {
  all: Record<string, any>[]
  selected: Record<string, any>[]
  download: string
  /** Database id to display name, for the group headers. */
  databases: Map<string, string>
}

export function exportView(options: ExportView): Html {
  const { all, selected, download, databases } = options
  const key = (collection: Record<string, any>) => `${collection.databaseId}/${collection.$id}`
  const selectedKeys = new Set(selected.map(key))
  const list = all.length
    ? html`<div class="export-list">
        ${exportGroups(all, databases).map((group) => {
          const on = group.collections.filter((collection) => selectedKeys.has(key(collection))).length
          return html`<section class="export-group" data-export-group>
            <label class="export-group-head">
              <input type="checkbox" data-export-toggle aria-label="Select every collection in ${group.name}" ${on === group.collections.length ? 'checked' : ''}>
              ${icon('database', 14)}
              <span class="export-group-name">${group.name}</span>
              ${group.name !== group.id ? html`<span class="mono subdued export-clip">${group.id}</span>` : ''}
              <span class="export-count subdued" data-export-count>${on}/${group.collections.length}</span>
            </label>
            ${group.collections.map((collection) => {
              const columns = collection.columns?.length ?? 0
              return html`<label class="export-row" data-export-row="${`${collection.name} ${collection.$id}`.toLowerCase()}">
                <input type="checkbox" name="ids" value="${key(collection)}" ${selectedKeys.has(key(collection)) ? 'checked' : ''}>
                <span class="export-row-text">
                  <span class="export-row-name">${collection.name}</span>
                  <span class="mono subdued export-clip">${collection.$id}</span>
                </span>
                <span class="export-count subdued">${columns} ${columns === 1 ? 'column' : 'columns'}</span>
              </label>`
            })}
          </section>`
        })}
        <div class="empty" data-export-none hidden><h3>No matches</h3><p>No collection name or ID matches your search.</p></div>
      </div>`
    : emptyState('No collections', 'Create a collection first.')
  return html`${header('Schema')}${schemaTabs('export')}
  <p class="subdued" style="margin:-8px 0 16px">Pick the collections to export. The JSON can be imported on another instance from <a href="${SCHEMA}/import">Import collections</a>.</p>
  <form id="export-form" method="get" action="${SCHEMA}/export" hx-get="${SCHEMA}/export" hx-target="#export-panel" hx-select="#export-panel" hx-swap="outerHTML" hx-push-url="true" hx-trigger="change, submit">
    <input type="hidden" name="selected" value="1">
    <div id="export-page" class="split-sidebar export-layout">
      <div class="card flush">
        <div class="export-head">
          <div class="export-head-title">
            <h2>Collections</h2>
            <span class="subdued" data-export-total>${selected.length} of ${all.length} selected</span>
          </div>
          ${all.length
            ? html`<div class="export-tools">
                <div class="search-field">
                  <span class="search-field-icon">${icon('magnifying-glass')}</span>
                  <input type="search" data-export-filter placeholder="Search collections..." autocomplete="off" aria-label="Search collections">
                </div>
                <button type="button" class="small" data-export-bulk="all">Select all</button>
                <button type="button" class="small" data-export-bulk="none">Clear</button>
                <noscript><button class="small primary">Preview</button></noscript>
              </div>`
            : ''}
        </div>
        ${list}
      </div>
      ${exportPanel(selected, download)}
    </div>
  </form>
  <script>${raw(EXPORT_SCRIPT)}</script>`
}

export function importView(values: { json?: string; error?: string; prune?: boolean } = {}): Html {
  const prune = values.prune ?? true
  return html`${header('Schema')}${schemaTabs('import')}
  ${values.error ? alert('critical', html`${values.error}`) : ''}
  ${settingsSection(
    'Import collections',
    'Paste an array of collections exported from this console, or choose a JSON file. Target databases must already exist.',
    html`<form method="post" action="${SCHEMA}/import/preview" enctype="multipart/form-data" hx-boost="false">
      <label>Collections JSON<textarea name="json" class="mono tall" spellcheck="false" placeholder='[{"$id":"collection","databaseId":"main","name":"Collection","columns":[]}]'>${values.json ?? ''}</textarea><small>Files replace the pasted text when both are provided.</small></label>
      <label>Load from JSON file<input type="file" name="file" accept=".json,application/json"></label>
      <label class="check"><input type="checkbox" name="prune" ${prune ? 'checked' : ''}>Delete collections and fields missing from the import<small>&nbsp;· related document data is removed</small></label>
      <div class="foot"><button class="primary">Review changes</button></div>
    </form>`,
  )}`
}

export interface ImportReviewView {
  changes: string[]
  names: string
  collectionsJson: string
  prune: boolean
  danger: boolean
}

export function importReviewView(options: ImportReviewView): Html {
  const { changes, names, collectionsJson, prune, danger } = options
  return html`${header('Schema')}${schemaTabs('import')}
  ${settingsSection(
    `${changes.length} change${changes.length === 1 ? '' : 's'} to import`,
    names,
    changeList(changes),
  )}
  ${changes.length
    ? settingsSection(
        'Apply the import',
        danger ? 'This removes data. Review the changes above before applying.' : 'The changes above are applied together.',
        html`<form method="post" action="${SCHEMA}/import/apply" ${danger ? html`data-confirm="This removes data. Import anyway?" data-confirm-label="Import" data-confirm-tone="critical"` : ''}>
          <input type="hidden" name="collections" value="${collectionsJson}">${prune ? html`<input type="hidden" name="prune" value="on">` : ''}
          <div class="foot"><a class="btn" href="${SCHEMA}/import">Cancel</a><button class="primary">Apply changes</button></div>
        </form>`,
      )
    : html`<div class="card"><a class="btn" href="${SCHEMA}/import">Import another file</a></div>`}`
}

export interface PreviewView {
  changes: string[]
  label: string
  configJson: string
  baseDir?: string
  prune: boolean
  danger: boolean
}

export function previewView(options: PreviewView): Html {
  const { changes, label, configJson, baseDir, prune, danger } = options
  return html`${header('Preview import', { back: SCHEMA })}${schemaTabs('configuration')}
  ${settingsSection(
    `${changes.length} change${changes.length === 1 ? '' : 's'} from ${label}`,
    'Review what will change before applying. Nothing has been saved yet.',
    changeList(changes),
  )}
  ${changes.length
    ? settingsSection(
        'Apply the import',
        danger ? 'This removes data. Review the changes above before applying.' : 'The changes above are applied together.',
        html`<form method="post" action="${SCHEMA}/apply" ${danger ? html`data-confirm="This removes data. Apply anyway?" data-confirm-label="Apply" data-confirm-tone="critical"` : ''}>
          <input type="hidden" name="config" value="${configJson}"><input type="hidden" name="baseDir" value="${baseDir ?? ''}">${prune ? html`<input type="hidden" name="prune" value="on">` : ''}
          <div class="foot"><a class="btn" href="${SCHEMA}">Cancel</a><button class="primary">Apply ${changes.length} change${changes.length === 1 ? '' : 's'}</button></div>
        </form>`,
      )
    : ''}`
}
