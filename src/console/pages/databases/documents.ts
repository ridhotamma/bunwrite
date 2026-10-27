import { keyCaller } from '~/auth/caller'
import type { Collection } from '~/schema/types'
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { lines, parseJsonObject, value } from '~/console/forms'
import { html, type Html } from '~/console/html'
import { pageCount, pageParams } from '~/console/query'
import { alert, destroy, emptyState, header, listCard, pager, searchForm, when } from '~/console/ui'
import { COL, collectionHeader, collectionUrl, loadCollection, tabs } from './shared'

const documentUrl = (c: Collection, id: unknown) => `${collectionUrl(c)}/documents/${encodeURIComponent(String(id))}`

const parseData = (raw: unknown) => parseJsonObject(raw, 'The data must be a JSON object.')

function publish(ctx: ConsoleContext): void {
  ctx.services.realtime.publish(ctx.services.store.drainEvents())
}

function documentForm(c: Collection, doc: Record<string, unknown> | null): Html {
  const data: Record<string, unknown> = {}
  for (const a of c.attributes) data[a.key] = doc ? doc[a.key] : (a.default ?? (a.array ? [] : null))
  const action = doc ? documentUrl(c, doc.$id) : `${collectionUrl(c)}/documents`
  return html`<form method="post" action="${action}" class="layout">
    <div class="card">
      <h2>Data</h2>
      ${doc ? '' : html`<label>Document ID<input name="id" class="mono" value="unique()"><small>Keep <code>unique()</code> to generate one.</small></label>`}
      <label>JSON<textarea name="data" class="mono tall" spellcheck="false">${JSON.stringify(data, null, 2)}</textarea></label>
      <div class="foot"><a class="btn" href="${collectionUrl(c)}/documents">Cancel</a><button class="primary">${doc ? 'Save' : 'Create'}</button></div>
    </div>
    <div>
      <div class="card"><h2>Permissions</h2>
        <textarea name="permissions" class="mono" placeholder='read("any")'>${((doc?.$permissions as string[]) ?? []).join('\n')}</textarea>
        <p class="help">One per line, e.g. <code>read("team:ID")</code>. Applies when row security is on.</p></div>
      ${doc ? html`<div class="card"><h2>Details</h2><ul class="list">
        <li><span class="subdued">ID</span><span class="mono">${doc.$id}</span></li>
        <li><span class="subdued">Sequence</span><span>${doc.$sequence}</span></li>
        <li><span class="subdued">Created</span><span>${when(doc.$createdAt as string | null)}</span></li>
        <li><span class="subdued">Updated</span><span>${when(doc.$updatedAt as string | null)}</span></li></ul></div>` : ''}
    </div>
  </form>`
}

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
    const shown = c.attributes.slice(0, 4)
    const pages = pageCount(result.total, limit)
    const cell = (v: unknown) => (v === null || v === undefined ? html`<span class="subdued">—</span>` : typeof v === 'object' ? JSON.stringify(v) : String(v))
    const toolbar = searchForm({
      action: `${collectionUrl(c)}/documents`,
      target: 'docs',
      name: 'q',
      value: filter,
      placeholder: 'Filter by document ID or query JSON',
      title: 'e.g. {"method":"equal","attribute":"status","values":["active"]}',
      delay: 400,
      submit: 'Filter',
      mono: true,
    })
    const body = html`${filterError ? alert('critical', html`${filterError}`, { style: 'margin:12px' }) : ''}
      ${result.documents.length
        ? html`<div class="scroll"><table><thead><tr><th>ID</th>${shown.map((a, i) => html`<th class="${i > 1 ? 'hide-sm' : ''}">${a.key}</th>`)}<th class="hide-sm">Updated</th></tr></thead><tbody>
          ${result.documents.map((d) => html`<tr class="row-link" onclick="location='${documentUrl(c, d.$id)}'"><td class="mono"><a href="${documentUrl(c, d.$id)}">${d.$id}</a></td>
            ${shown.map((a, i) => html`<td class="clip ${i > 1 ? 'hide-sm' : ''}">${cell(d[a.key])}</td>`)}<td class="hide-sm">${when(d.$updatedAt as string | null)}</td></tr>`)}
          </tbody></table></div>`
        : emptyState(
            text ? 'No matching documents' : 'No documents yet',
            text ? 'Try a different filter.' : c.attributes.length ? 'Create one here, or let your apps write them.' : 'Add attributes first, then documents.',
          )}`
    const footer = result.documents.length
      ? pager({
          page,
          pages,
          params: { q: filter },
          always: true,
          label: html`Page ${page} of ${pages} · ${result.total.toLocaleString('en-US')}${result.total >= 5000 ? '+' : ''} documents`,
        })
      : html``
    return ctx.render(
      c.name,
      'databases',
      html`${collectionHeader(ctx, c, html`<a class="btn primary" href="${collectionUrl(c)}/documents/new">Create document</a>`)}
      ${tabs(c, 'documents')}
      ${listCard('docs', { toolbar, body, footer })}`,
    )
  })

  router.get(`${COL}/documents/new`, ({ ctx, path }) => {
    const c = loadCollection(ctx, path)
    return ctx.render('Create document', 'databases', html`${header('Create document', { back: `${collectionUrl(c)}/documents` })}${documentForm(c, null)}`)
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
    return ctx.render(
      String(doc.$id),
      'databases',
      html`${header(String(doc.$id), { back: `${collectionUrl(c)}/documents`, actions: destroy(`${documentUrl(c, doc.$id)}/delete`, 'Delete', 'Delete this document?') })}
      ${documentForm(c, doc)}`,
    )
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
