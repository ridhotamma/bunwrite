import { existsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { err } from '../../lib/errors'
import type { ConsoleContext, ConsoleRouter } from '../context'
import { checked, value } from '../forms'
import { html, type Html } from '../html'
import { badge, header } from '../ui'

const SCHEMA = '/console/schema'

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

export function schemaPages(router: ConsoleRouter): void {
  router.get(SCHEMA, ({ ctx }) => {
    const path = ctx.services.config.schemaPath
    return ctx.render(
      'Schema',
      'schema',
      html`${header('Schema')}
      <div class="banner info">Databases, collections, buckets and functions can be described in <code>appwrite.config.json</code>, the file Pesanle keeps in its repo. Edits made in this console change the database directly; export them to keep the file in step.</div>
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
            ${path ? html`<form method="post" action="${SCHEMA}/save" class="inline" hx-confirm="Overwrite ${path} with the current schema?"><button>Save to ${path.split('/').pop()}</button></form>` : ''}</div>
        </div>
      </div>`,
    )
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
      html`${header('Preview import', { back: SCHEMA })}
      <div class="card"><h2>${changes.length} change${changes.length === 1 ? '' : 's'} from ${label}</h2>${changeList(changes)}</div>
      ${changes.length
        ? html`<form method="post" action="${SCHEMA}/apply" class="card" ${changes.some((c) => c.startsWith('-')) ? html`hx-confirm="This removes data. Apply anyway?"` : ''}>
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
