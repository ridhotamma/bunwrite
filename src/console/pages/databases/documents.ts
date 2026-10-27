import { keyCaller } from '~/auth/caller'
import type { Collection } from '~/schema/types'
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { lines, parseJsonObject, value } from '~/console/forms'
import { pageCount, pageParams } from '~/console/query'
import { documentFormView, documentsListView } from '~/console/views/databases/documents'
import { COL, collectionUrl, loadCollection } from './shared'

const documentUrl = (c: Collection, id: unknown) => `${collectionUrl(c)}/documents/${encodeURIComponent(String(id))}`

const parseData = (raw: unknown) => parseJsonObject(raw, 'The data must be a JSON object.')

function publish(ctx: ConsoleContext): void {
  ctx.services.realtime.publish(ctx.services.store.drainEvents())
}

/** Document list and form handlers. Markup lives in console/views. */
export function documentPages(router: ConsoleRouter): void {
  router.get(`${COL}/documents`, ({ ctx, path, url }) => {
    const c = loadCollection(ctx, path)
    const filter = url.searchParams.get('q') ?? ''
    const { page, limit, offset } = pageParams(url)
    const queries: string[] = [JSON.stringify({ method: 'limit', values: [limit] }), JSON.stringify({ method: 'offset', values: [offset] })]
    let filterError = ''
    const text = filter.trim()
    if (text) {
      if (text.startsWith('{') || text.startsWith('[')) {
        try {
          const parsed = JSON.parse(text.startsWith('{') ? `[${text.replace(/}\s*\n\s*{/g, '},{')}]` : text)
          queries.push(...(parsed as unknown[]).map((x) => JSON.stringify(x)))
        } catch {
          filterError = 'That filter is not valid JSON.'
        }
      } else queries.push(JSON.stringify({ method: 'equal', attribute: '$id', values: [text] }))
    }
    queries.push(JSON.stringify({ method: 'orderDesc', attribute: '$sequence' }))
    let result = { total: 0, documents: [] as Record<string, unknown>[] }
    try {
      if (!filterError) result = ctx.services.store.listDocuments(keyCaller(), c, queries)
    } catch (error) {
      filterError = error instanceof Error ? error.message : String(error)
    }
    const pages = pageCount(result.total, limit)
    return ctx.render(
      c.name,
      'databases',
      documentsListView(ctx, {
        collection: c,
        documents: result.documents,
        total: result.total,
        page,
        pages,
        filter,
        filterError,
      }),
    )
  })

  router.get(`${COL}/documents/new`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    return ctx.render('Create document', 'databases', documentFormView(ctx, c, null))
  })

  router.post(`${COL}/documents`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    const doc = ctx.services.store.createDocument(keyCaller(), c, {
      id: value(ctx.form, 'id') || 'unique()',
      data: parseData(ctx.form.data),
      permissions: lines(ctx.form.permissions),
    })
    publish(ctx)
    return ctx.go(documentUrl(c, doc.$id), { tone: 'success', text: 'Document created' })
  })

  router.get(`${COL}/documents/:doc`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    const doc = ctx.services.store.getDocument(keyCaller(), c, path.doc!)
    return ctx.render(String(doc.$id), 'databases', documentFormView(ctx, c, doc))
  })

  router.post(`${COL}/documents/:doc`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    ctx.services.store.updateDocument(keyCaller(), c, path.doc!, parseData(ctx.form.data), lines(ctx.form.permissions))
    publish(ctx)
    return ctx.go(documentUrl(c, path.doc!), { tone: 'success', text: 'Saved' })
  })

  router.post(`${COL}/documents/:doc/delete`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    ctx.services.store.deleteDocument(keyCaller(), c, path.doc!)
    publish(ctx)
    return ctx.go(`${collectionUrl(c)}/documents`, { tone: 'success', text: 'Document deleted' })
  })
}
