/** Schema page and panels markup. The page loads, validates and applies changes. */
import { html, type Html } from '~/console/html'
import { alert, badge, emptyState, header, settingsSection, tabs as tabList } from '~/console/ui'
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
  return html`<div id="export-panel">
    <div class="card">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <h2 style="margin:0">JSON · ${selected.length} selected</h2>
        ${selected.length
          ? html`<div style="margin-left:auto;display:flex;gap:8px"><button type="button" class="small" data-copy-target="#export-json">Copy</button><a class="btn small primary" href="${download}" hx-boost="false" download="collections.json">Download as JSON</a></div>`
          : ''}
      </div>
      ${selected.length ? html`<pre id="export-json" style="max-height:520px">${json}</pre>` : emptyState('No collections selected', 'Pick at least one collection to export.')}
    </div>
  </div>`
}

export function configurationView(options: { schemaPath?: string; fileName: string }): Html {
  const path = options.schemaPath
  const file = options.fileName
  return html`${header('Schema')}${schemaTabs('configuration')}
  ${alert('info', html`Databases, collections, buckets and functions can be described in <code>${file}</code>, the file your project keeps in its repo. Edits made in this console change the database directly; export them to keep the file in step.`)}
  ${settingsSection(
    'Import from a file',
    'Creates and alters exactly what the file describes. Preview first; nothing changes until you apply.',
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
}

export function exportView(options: ExportView): Html {
  const { all, selected, download } = options
  const selectedKeys = new Set(selected.map((collection) => `${collection.databaseId}/${collection.$id}`))
  return html`${header('Schema')}${schemaTabs('export')}
  <p class="subdued" style="margin:-8px 0 16px">Select collections to export. The JSON can be imported on another instance from <a href="${SCHEMA}/import">Import collections</a>.</p>
  <form method="get" action="${SCHEMA}/export" hx-get="${SCHEMA}/export" hx-target="#export-page" hx-select="#export-page" hx-swap="outerHTML" hx-push-url="true" hx-trigger="change, submit">
    <input type="hidden" name="selected" value="1">
    <div id="export-page"><div class="split-sidebar">
      <div class="card flush">
        <div class="toolbar"><h2 style="margin:0">Collections</h2></div>
        <div style="padding:8px 12px">
          <div style="display:flex;gap:12px;align-items:center;margin-bottom:8px">
            <button type="button" class="plain" data-select-all="all">Select all</button>
            <button type="button" class="plain" data-select-all="none">Clear</button>
            <noscript><button class="small" style="margin-left:auto">Preview</button></noscript>
          </div>
          ${all.length
            ? all.map(
                (collection) =>
                  html`<label class="check" style="margin:4px 0"><input type="checkbox" name="ids" value="${collection.databaseId}/${collection.$id}" ${selectedKeys.has(`${collection.databaseId}/${collection.$id}`) ? 'checked' : ''}><span>${collection.name} <span class="subdued mono">${collection.databaseId}/${collection.$id}</span></span></label>`,
              )
            : emptyState('No collections', 'Create a collection first.')}
        </div>
      </div>
      ${exportPanel(selected, download)}
    </div></div>
  </form>`
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
