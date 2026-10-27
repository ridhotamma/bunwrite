import { existsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { checked, value } from '~/console/forms'
import { html, type Html } from '~/console/html'
import { alert, badge, emptyState, header, tabs as tabList } from '~/console/ui'
import { err } from '~/lib/errors'

const SCHEMA = '/console/schema'

const SCHEMA_TABS = [
  { key: 'configuration', label: 'Configuration', href: SCHEMA },
  { key: 'export', label: 'Export collections', href: `${SCHEMA}/export` },
  { key: 'import', label: 'Import collections', href: `${SCHEMA}/import` },
] as const

type SchemaTab = (typeof SCHEMA_TABS)[number]['key']

const schemaTabs = (active: SchemaTab) => tabList(SCHEMA_TABS, active)
const destructive = (changes: string[]) => changes.some((change) => change.startsWith('-') || change.includes(': - '))

/** The schema in appwrite.config.json shape, merged into the existing file so its other keys survive. */
async function exported(ctx: ConsoleContext): Promise<Record<string, unknown>> {
  const path = ctx.services.config.schemaPath
  const base = path && existsSync(path) ? ((await Bun.file(path).json()) as Record<string, unknown>) : {}
  return { ...base, ...ctx.schema.export() }
}

async function readUpload(ctx: ConsoleContext): Promise<{ config: unknown; baseDir?: string; label: string }> {
  const file = ctx.form.file
  if (file instanceof Blob && file.size > 0) {
    try {
      return { config: JSON.parse(await file.text()), label: (file as File).name || 'uploaded file' }
    } catch {
      throw err('general_argument_invalid', 'That file is not valid JSON.')
    }
  }
  const path = ctx.services.config.schemaPath
  if (!path) throw err('general_argument_invalid', 'Choose a file, or set SCHEMA_PATH on the server.')
  return { config: await Bun.file(path).json(), baseDir: dirname(resolve(path)), label: path }
}

function changeList(changes: string[]): Html {
  if (!changes.length) return html`<p class="subdued" style="margin:0">No changes. The database already matches.</p>`
  return html`<ul class="list">${changes.map((c) => html`<li><span class="mono">${c}</span>${c.startsWith('+') ? badge('Add', 'success') : c.startsWith('-') ? badge('Remove', 'critical') : badge('Change', 'attention')}</li>`)}</ul>`
}

function selectedCollections(ctx: ConsoleContext, url: URL) {
  const all = ctx.schema.collectionDefinitions()
  const explicit = url.searchParams.get('selected') === '1'
  const ids = new Set(url.searchParams.getAll('ids'))
  return { all, explicit, selected: explicit ? all.filter((c) => ids.has(`${c.databaseId}/${c.$id}`)) : all }
}

function collectionsUrl(selected: Record<string, any>[], explicit: boolean): string {
  if (!explicit) return `${SCHEMA}/collections.json`
  const params = new URLSearchParams({ selected: '1' })
  for (const collection of selected) params.append('ids', `${collection.databaseId}/${collection.$id}`)
  return `${SCHEMA}/collections.json?${params.toString()}`
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

async function importText(ctx: ConsoleContext): Promise<string> {
  const file = ctx.form.file
  if (file instanceof Blob && file.size > 0) return file.text()
  return String(ctx.form.json ?? '')
}

function parseCollections(raw: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw err('general_argument_invalid', 'That is not valid JSON.')
  }
  const collections =
    Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as any).tables)
        ? (parsed as any).tables
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as any).collections)
          ? (parsed as any).collections
          : null
  if (!collections) throw err('general_argument_invalid', 'The import must be a JSON array of collections.')
  return collections
}

function importPage(ctx: ConsoleContext, values: { json?: string; error?: string; prune?: boolean } = {}): Response {
  const prune = values.prune ?? true
  return ctx.render(
    'Schema',
    'schema',
    html`${header('Schema')}${schemaTabs('import')}
    ${values.error ? alert('critical', html`${values.error}`) : ''}
    <form method="post" action="${SCHEMA}/import/preview" enctype="multipart/form-data" class="card" hx-boost="false">
      <h2>Import collections</h2>
      <p class="hint">Paste an array of collections exported from this console, or choose a JSON file. Target databases must already exist.</p>
      <label>Collections JSON<textarea name="json" class="mono tall" spellcheck="false" placeholder='[{"$id":"collection","databaseId":"main","name":"Collection","columns":[]}]'>${values.json ?? ''}</textarea><small>Files replace the pasted text when both are provided.</small></label>
      <label>Load from JSON file<input type="file" name="file" accept=".json,application/json"></label>
      <label class="check"><input type="checkbox" name="prune" ${prune ? 'checked' : ''}>Delete collections and fields missing from the import<small>&nbsp;· related document data is removed</small></label>
      <div class="foot"><button class="primary">Review changes</button></div>
    </form>`,
  )
}

export function schemaPages(router: ConsoleRouter): void {
  router.get(SCHEMA, ({ ctx }) => {
    const path = ctx.services.config.schemaPath
    return ctx.render(
      'Schema',
      'schema',
      html`${header('Schema')}${schemaTabs('configuration')}
      ${alert('info', html`Databases, collections, buckets and functions can be described in <code>appwrite.config.json</code>, the file your project keeps in its repo. Edits made in this console change the database directly; export them to keep the file in step.`)}
      <div class="layout">
        <form method="post" action="${SCHEMA}/preview" enctype="multipart/form-data" class="card" hx-boost="false">
          <h2>Import</h2>
          <p class="hint">Creates and alters what the file describes. Preview first; nothing changes until you apply.</p>
          <label>File<input type="file" name="file" accept=".json,application/json"><small>${path ? html`Leave empty to use <code>${path}</code>.` : 'appwrite.config.json'}</small></label>
          <label class="check"><input type="checkbox" name="prune">Also delete collections missing from the file</label>
          <div class="foot"><button class="primary">Preview changes</button></div>
        </form>
        <div class="card">
          <h2>Export</h2>
          <p class="hint">The current schema as appwrite.config.json${path ? ', with the rest of your file kept as is' : ''}.</p>
          <div class="foot" style="justify-content:flex-start"><a class="btn" href="${SCHEMA}/export.json" hx-boost="false" download="appwrite.config.json">Download</a>
            ${path
              ? html`<form method="post" action="${SCHEMA}/save" class="inline" data-confirm="Overwrite ${path} with the current schema?" data-confirm-label="Overwrite" data-confirm-tone="critical"><button>Save to ${path.split('/').pop()}</button></form>`
              : ''}</div>
        </div>
      </div>`,
    )
  })

  // Export collections: checkbox changes re-render the list and JSON panel.
  router.get(`${SCHEMA}/export`, ({ ctx, url }) => {
    const { all, selected, explicit } = selectedCollections(ctx, url)
    const selectedKeys = new Set(selected.map((collection) => `${collection.databaseId}/${collection.$id}`))
    const download = collectionsUrl(selected, explicit)
    return ctx.render(
      'Schema',
      'schema',
      html`${header('Schema')}${schemaTabs('export')}
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
      </form>`,
    )
  })

  router.get(`${SCHEMA}/collections.json`, ({ ctx, url }) => {
    const { selected } = selectedCollections(ctx, url)
    return new Response(JSON.stringify(selected, null, 2), {
      headers: {
        'content-type': 'application/json',
        'content-disposition': 'attachment; filename="collections.json"',
        'cache-control': 'no-store',
      },
    })
  })

  router.get(`${SCHEMA}/import`, ({ ctx }) => importPage(ctx))

  router.post(`${SCHEMA}/import/preview`, async ({ ctx }) => {
    const raw = await importText(ctx)
    const prune = checked(ctx.form.prune)
    try {
      if (!raw.trim()) throw err('general_argument_invalid', 'Paste collections JSON or choose a JSON file.')
      const collections = parseCollections(raw)
      const changes = ctx.schema.importCollections(collections, { prune, dryRun: true })
      const names = collections
        .map((collection: any) => `${collection.name ?? collection.$id ?? collection.id} (${collection.databaseId}/${collection.$id ?? collection.id})`)
        .join(' · ')
      return ctx.render(
        'Schema',
        'schema',
        html`${header('Schema')}${schemaTabs('import')}
        <div class="card"><h2>${changes.length} change${changes.length === 1 ? '' : 's'} to import</h2><p class="hint">${names}</p>${changeList(changes)}</div>
        ${changes.length
          ? html`<form method="post" action="${SCHEMA}/import/apply" class="card" ${destructive(changes) ? html`data-confirm="This removes data. Import anyway?" data-confirm-label="Import" data-confirm-tone="critical"` : ''}>
              <input type="hidden" name="collections" value="${JSON.stringify(collections)}">${prune ? html`<input type="hidden" name="prune" value="on">` : ''}
              <div class="foot"><a class="btn" href="${SCHEMA}/import">Cancel</a><button class="primary">Apply changes</button></div>
            </form>`
          : html`<div class="card"><a class="btn" href="${SCHEMA}/import">Import another file</a></div>`}`,
      )
    } catch (error) {
      return importPage(ctx, { json: raw, prune, error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post(`${SCHEMA}/import/apply`, ({ ctx }) => {
    let collections: unknown
    try {
      collections = JSON.parse(value(ctx.form, 'collections'))
    } catch {
      throw err('general_argument_invalid', 'The import was lost. Review it again.')
    }
    const changes = ctx.schema.importCollections(collections, { prune: checked(ctx.form.prune) })
    return ctx.go(`${SCHEMA}/import`, { tone: 'success', text: `Applied ${changes.length} change${changes.length === 1 ? '' : 's'}` })
  })

  router.get(
    `${SCHEMA}/export.json`,
    async ({ ctx }) =>
      new Response(JSON.stringify(await exported(ctx), null, 4), {
        headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="appwrite.config.json"', 'cache-control': 'no-store' },
      }),
  )

  router.post(`${SCHEMA}/save`, async ({ ctx }) => {
    const path = ctx.services.config.schemaPath
    if (!path) throw err('general_argument_invalid', 'SCHEMA_PATH is not set.')
    writeFileSync(path, `${JSON.stringify(await exported(ctx), null, 4)}\n`)
    return ctx.go(SCHEMA, { tone: 'success', text: `Saved to ${path}` })
  })

  // Dry run: apply inside a savepoint, list the changes, roll back. The file goes back as a hidden field.
  router.post(`${SCHEMA}/preview`, async ({ ctx }) => {
    const { config, baseDir, label } = await readUpload(ctx)
    const prune = checked(ctx.form.prune)
    const changes = ctx.schema.importConfig(config, { baseDir, prune, dryRun: true })
    return ctx.render(
      'Preview import',
      'schema',
      html`${header('Preview import', { back: SCHEMA })}${schemaTabs('configuration')}
      <div class="card"><h2>${changes.length} change${changes.length === 1 ? '' : 's'} from ${label}</h2>${changeList(changes)}</div>
      ${changes.length
        ? html`<form method="post" action="${SCHEMA}/apply" class="card" ${destructive(changes) ? html`data-confirm="This removes data. Apply anyway?" data-confirm-label="Apply" data-confirm-tone="critical"` : ''}>
            <input type="hidden" name="config" value="${JSON.stringify(config)}"><input type="hidden" name="baseDir" value="${baseDir ?? ''}">${prune ? html`<input type="hidden" name="prune" value="on">` : ''}
            <div class="foot"><a class="btn" href="${SCHEMA}">Cancel</a><button class="primary">Apply ${changes.length} change${changes.length === 1 ? '' : 's'}</button></div>
          </form>`
        : ''}`,
    )
  })

  router.post(`${SCHEMA}/apply`, ({ ctx }) => {
    let config: unknown
    try {
      config = JSON.parse(value(ctx.form, 'config'))
    } catch {
      throw err('general_argument_invalid', 'The import was lost. Preview it again.')
    }
    const changes = ctx.schema.importConfig(config, { baseDir: String(ctx.form.baseDir || '') || undefined, prune: checked(ctx.form.prune) })
    return ctx.go(SCHEMA, { tone: 'success', text: `Applied ${changes.length} change${changes.length === 1 ? '' : 's'}` })
  })
}
