import { existsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { checked, value } from '~/console/forms'
import { SCHEMA } from '~/console/schema-meta'
import { configurationView, exportView, importReviewView, importView, previewView } from '~/console/views/schema'
import { configFileName } from '~/lib/compat'
import { err } from '~/lib/errors'

/** Keep only databases and collections; the console import skips functions, buckets, sites and the rest. */
function collectionsOnly(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw err('general_argument_invalid', 'The file must be a project config JSON object.')
  const source = config as Record<string, unknown>
  const kept: Record<string, unknown> = {}
  for (const key of ['tablesDB', 'databases', 'tables', 'collections']) if (key in source) kept[key] = source[key]
  return kept
}

const destructive = (changes: string[]) => changes.some((change) => change.startsWith('-') || change.includes(': - '))

/** The schema in project config shape (bunwrite.config.json), merged into the existing file so its other keys survive. */
async function exported(ctx: ConsoleContext): Promise<Record<string, unknown>> {
  const path = ctx.services.config.schemaPath
  const base = path && existsSync(path) ? ((await Bun.file(path).json()) as Record<string, unknown>) : {}
  return { ...base, ...ctx.schema.export() }
}

async function readUpload(ctx: ConsoleContext): Promise<{ config: unknown; baseDir?: string; label: string }> {
  const file = ctx.form.file
  if (file instanceof Blob && file.size > 0) {
    try {
      return { config: JSON.parse(await file.text()), baseDir: ctx.services.config.functionsDir, label: (file as File).name || 'uploaded file' }
    } catch {
      throw err('general_argument_invalid', 'That file is not valid JSON.')
    }
  }
  const path = ctx.services.config.schemaPath
  if (!path) throw err('general_argument_invalid', 'Choose a file, or set SCHEMA_PATH on the server.')
  return { config: await Bun.file(path).json(), baseDir: dirname(resolve(path)), label: path }
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

/** Schema handlers. Page markup lives in console/views/schema. */
export function schemaPages(router: ConsoleRouter): void {
  router.get(SCHEMA, ({ ctx }) => ctx.render('Schema', 'schema', configurationView({ schemaPath: ctx.services.config.schemaPath, fileName: configFileName(ctx.services.config) })))

  // Export collections: checkbox changes re-render the list and JSON panel.
  router.get(`${SCHEMA}/export`, ({ ctx, url }) => {
    const { all, selected, explicit } = selectedCollections(ctx, url)
    return ctx.render('Schema', 'schema', exportView({ all, selected, download: collectionsUrl(selected, explicit), databases: new Map([...ctx.services.registry.databases.values()].map((database) => [database.id, database.name])) }))
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

  router.get(`${SCHEMA}/import`, ({ ctx }) => ctx.render('Schema', 'schema', importView()))

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
        importReviewView({ changes, names, collectionsJson: JSON.stringify(collections), prune, danger: destructive(changes) }),
      )
    } catch (error) {
      return ctx.render('Schema', 'schema', importView({ json: raw, prune, error: error instanceof Error ? error.message : String(error) }))
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
        headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${configFileName(ctx.services.config)}"`, 'cache-control': 'no-store' },
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
    const { config: uploaded, baseDir, label } = await readUpload(ctx)
    const config = collectionsOnly(uploaded)
    const prune = checked(ctx.form.prune)
    const changes = ctx.schema.importConfig(config, { baseDir, prune, dryRun: true })
    return ctx.render(
      'Preview import',
      'schema',
      previewView({ changes, label, configJson: JSON.stringify(config), baseDir, prune, danger: destructive(changes) }),
    )
  })

  router.post(`${SCHEMA}/apply`, ({ ctx }) => {
    let config: unknown
    try {
      config = JSON.parse(value(ctx.form, 'config'))
    } catch {
      throw err('general_argument_invalid', 'The import was lost. Preview it again.')
    }
    config = collectionsOnly(config)
    const changes = ctx.schema.importConfig(config, { baseDir: String(ctx.form.baseDir || '') || undefined, prune: checked(ctx.form.prune) })
    return ctx.go(SCHEMA, { tone: 'success', text: `Applied ${changes.length} change${changes.length === 1 ? '' : 's'}` })
  })
}
