import { keyCaller } from '../../auth/caller'
import { aggregatePermissions } from '../../auth/permissions'
import { q } from '../../db/connection'
import { err } from '../../lib/errors'
import type { Collection } from '../../schema/types'
import { go, type ConsoleContext, type ConsoleRouter } from '../app'
import { html, type Html } from '../html'
import { badge, destroy, emptyState, header, when } from '../layout'

const DB = '/console/databases'
const lines = (v: unknown) => String(v ?? '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
const checked = (v: unknown) => v === 'on' || v === 'true' || v === '1'
const count = (ctx: ConsoleContext, c: Collection) => (ctx.services.db.sqlite.query(`SELECT count(*) AS n FROM ${q(c.table)}`).get() as { n: number }).n
const colUrl = (c: { databaseId: string; id: string }) => `${DB}/${encodeURIComponent(c.databaseId)}/collections/${encodeURIComponent(c.id)}`

function tabs(c: Collection, on: string): Html {
  const tab = (key: string, label: string) => html`<a href="${colUrl(c)}/${key}" class="${on === key ? 'on' : ''}">${label}</a>`
  return html`<nav class="tabs">${tab('documents', 'Documents')}${tab('attributes', 'Attributes')}${tab('indexes', 'Indexes')}${tab('settings', 'Settings')}</nav>`
}

function collectionHeader(ctx: ConsoleContext, c: Collection, actions?: Html): Html {
  const database = ctx.services.registry.databases.get(c.databaseId)!
  return html`<div class="subdued" style="margin:-4px 0 4px 40px"><a href="${DB}/${c.databaseId}" style="color:inherit">${database.name}</a></div>
    ${header(c.name, {
      back: `${DB}/${c.databaseId}`,
      badges: [c.enabled ? badge('Enabled', 'success') : badge('Disabled'), c.documentSecurity ? badge('Row security', 'info') : badge('Collection permissions')],
      actions,
    })}`
}

/** Parse the value typed for a default/document field into the attribute's type. */
function typedDefault(type: string, raw: unknown): unknown {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  if (type === 'integer') return Number.parseInt(text, 10)
  if (type === 'double') return Number(text)
  if (type === 'boolean') return text === 'true'
  return text
}

export function databasePages(router: ConsoleRouter): void {
  // ---------------------------------------------------------------- databases
  router.get(DB, ({ ctx }) => {
    const dbs = [...ctx.services.registry.databases.values()]
    const cols = [...ctx.services.registry.collections.values()]
    return ctx.render(
      'Databases',
      'databases',
      html`${header('Databases', { actions: html`<a class="btn primary" href="${DB}/new">Create database</a>` })}
      <div class="card flush">
        ${dbs.length
          ? html`<div class="scroll"><table><thead><tr><th>Name</th><th>ID</th><th class="num">Collections</th><th class="hide-sm">Status</th><th class="hide-sm">Created</th></tr></thead><tbody>
            ${dbs.map((d) => html`<tr class="row-link" onclick="location='${DB}/${d.id}'"><td><a href="${DB}/${d.id}">${d.name}</a></td><td class="mono">${d.id}</td>
              <td class="num">${cols.filter((c) => c.databaseId === d.id).length}</td><td class="hide-sm">${d.enabled ? badge('Enabled', 'success') : badge('Disabled')}</td><td class="hide-sm">${when(d.createdAt)}</td></tr>`)}
            </tbody></table></div>`
          : emptyState('No databases yet', 'Create one, or import appwrite.config.json from Schema.', html`<a class="btn primary" href="${DB}/new">Create database</a>`)}
      </div>`,
    )
  })

  router.get(`${DB}/new`, ({ ctx }) =>
    ctx.render(
      'Create database',
      'databases',
      html`${header('Create database', { back: DB })}
      <form method="post" action="${DB}" class="card">
        <div class="fields"><label>Name<input name="name" required></label><label>ID<input name="id" class="mono" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}" required><small>Apps use this ID. It cannot change later.</small></label></div>
        <div class="foot"><a class="btn" href="${DB}">Cancel</a><button class="primary">Create</button></div>
      </form>`,
    ),
  )

  router.post(DB, ({ ctx, request }) => {
    ctx.schema.createDatabase(String(ctx.form.id ?? '').trim(), String(ctx.form.name ?? '').trim())
    return go(request, `${DB}/${ctx.form.id}`, { tone: 'success', text: 'Database created' })
  })

  router.get(`${DB}/:db`, ({ ctx, path }) => {
    const d = ctx.services.registry.database(path.db!, true)
    const cols = [...ctx.services.registry.collections.values()].filter((c) => c.databaseId === d.id).sort((a, b) => a.name.localeCompare(b.name))
    return ctx.render(
      d.name,
      'databases',
      html`${header(d.name, { back: DB, badges: [d.enabled ? badge('Enabled', 'success') : badge('Disabled')], actions: html`<a class="btn primary" href="${DB}/${d.id}/new">Create collection</a>` })}
      <div class="card flush">
        ${cols.length
          ? html`<div class="toolbar"><input type="search" placeholder="Filter collections" oninput="for(const r of document.querySelectorAll('#cols tbody tr'))r.hidden=!r.dataset.k.includes(this.value.toLowerCase())"></div>
            <div class="scroll"><table id="cols"><thead><tr><th>Name</th><th class="hide-sm">ID</th><th class="num">Documents</th><th class="num hide-sm">Attributes</th><th class="hide-sm">Security</th></tr></thead><tbody>
            ${cols.map((c) => html`<tr class="row-link" data-k="${(c.name + ' ' + c.id).toLowerCase()}" onclick="location='${colUrl(c)}/documents'"><td><a href="${colUrl(c)}/documents">${c.name}</a></td>
              <td class="mono hide-sm">${c.id}</td><td class="num">${count(ctx, c).toLocaleString('en-US')}</td><td class="num hide-sm">${c.attributes.length}</td>
              <td class="hide-sm">${c.documentSecurity ? badge('Row', 'info') : badge('Collection')}</td></tr>`)}
            </tbody></table></div>`
          : emptyState('No collections yet', 'Collections hold your documents.', html`<a class="btn primary" href="${DB}/${d.id}/new">Create collection</a>`)}
      </div>
      <form method="post" action="${DB}/${d.id}" class="card">
        <h2>Database settings</h2>
        <div class="fields"><label>Name<input name="name" value="${d.name}" required></label></div>
        <label class="check"><input type="checkbox" name="enabled" ${d.enabled ? 'checked' : ''}>Enabled for apps</label>
        <div class="foot">${'' /* spacer */}<button class="primary">Save</button></div>
      </form>
      <div class="card"><h2>Delete database</h2><p class="hint">Removes every collection and document in it. This cannot be undone.</p>
        ${destroy(`${DB}/${d.id}/delete`, 'Delete database', `Delete ${d.name} and all ${cols.length} collections?`)}</div>`,
    )
  })

  router.post(`${DB}/:db`, ({ ctx, path, request }) => {
    ctx.schema.updateDatabase(path.db!, String(ctx.form.name ?? ''), checked(ctx.form.enabled))
    return go(request, `${DB}/${path.db}`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${DB}/:db/delete`, ({ ctx, path, request }) => {
    ctx.schema.deleteDatabase(path.db!)
    return go(request, DB, { tone: 'success', text: 'Database deleted' })
  })

  router.get(`${DB}/:db/new`, ({ ctx, path }) => {
    const d = ctx.services.registry.database(path.db!, true)
    return ctx.render(
      'Create collection',
      'databases',
      html`${header('Create collection', { back: `${DB}/${d.id}` })}
      <form method="post" action="${DB}/${d.id}/collections" class="card">
        <div class="fields"><label>Name<input name="name" required></label><label>ID<input name="id" class="mono" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}" required></label></div>
        <label class="check"><input type="checkbox" name="documentSecurity" checked>Row security<small>&nbsp;· each document carries its own permissions (Pesanle uses this everywhere)</small></label>
        <label>Collection permissions<textarea name="permissions" class="mono" placeholder='read("any")'></textarea><small>One per line. Leave empty so only API keys and row permissions apply.</small></label>
        <div class="foot"><a class="btn" href="${DB}/${d.id}">Cancel</a><button class="primary">Create</button></div>
      </form>`,
    )
  })

  router.post(`${DB}/:db/collections`, ({ ctx, path, request }) => {
    const id = String(ctx.form.id ?? '').trim()
    ctx.schema.createCollection(path.db!, id, String(ctx.form.name ?? '').trim(), checked(ctx.form.documentSecurity), aggregatePermissions(lines(ctx.form.permissions)) ?? [])
    return go(request, `${DB}/${path.db}/collections/${id}/attributes`, { tone: 'success', text: 'Collection created. Add its attributes next.' })
  })

  const collection = (ctx: ConsoleContext, path: Record<string, string>) => ctx.services.registry.collection(path.db!, path.col!, true)
  const COL = `${DB}/:db/collections/:col`

  router.get(COL, ({ ctx, path, request }) => go(request, `${colUrl(collection(ctx, path))}/documents`))

  // ---------------------------------------------------------------- documents
  router.get(`${COL}/documents`, ({ ctx, path, url }) => {
    const c = collection(ctx, path)
    const filter = url.searchParams.get('q') ?? ''
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
    const limit = 25
    const queries: string[] = [JSON.stringify({ method: 'limit', values: [limit] }), JSON.stringify({ method: 'offset', values: [(page - 1) * limit] })]
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
    const pages = Math.max(1, Math.ceil(result.total / limit))
    const cell = (v: unknown) => (v === null || v === undefined ? html`<span class="subdued">—</span>` : typeof v === 'object' ? JSON.stringify(v) : String(v))
    return ctx.render(
      c.name,
      'databases',
      html`${collectionHeader(ctx, c, html`<a class="btn primary" href="${colUrl(c)}/documents/new">Create document</a>`)}
      ${tabs(c, 'documents')}
      <div class="card flush" id="docs">
        <form class="toolbar" method="get" action="${colUrl(c)}/documents" hx-get="${colUrl(c)}/documents" hx-target="#docs" hx-select="#docs" hx-swap="outerHTML" hx-push-url="true" hx-trigger="submit, input changed delay:400ms from:find input">
          <input name="q" value="${filter}" placeholder='Filter by document ID or query JSON' title='e.g. {"method":"equal","attribute":"status","values":["active"]}' autocomplete="off" class="mono">
          <button>Filter</button>
        </form>
        ${filterError ? html`<div class="banner critical" style="margin:12px">${filterError}</div>` : ''}
        ${result.documents.length
          ? html`<div class="scroll"><table><thead><tr><th>ID</th>${shown.map((a, i) => html`<th class="${i > 1 ? 'hide-sm' : ''}">${a.key}</th>`)}<th class="hide-sm">Updated</th></tr></thead><tbody>
            ${result.documents.map((d) => html`<tr class="row-link" onclick="location='${colUrl(c)}/documents/${encodeURIComponent(String(d.$id))}'"><td class="mono"><a href="${colUrl(c)}/documents/${encodeURIComponent(String(d.$id))}">${d.$id}</a></td>
              ${shown.map((a, i) => html`<td class="clip ${i > 1 ? 'hide-sm' : ''}">${cell(d[a.key])}</td>`)}<td class="hide-sm">${when(d.$updatedAt as string)}</td></tr>`)}
            </tbody></table></div>
            <div class="pager">${page > 1 ? html`<a class="btn" href="?q=${encodeURIComponent(filter)}&page=${page - 1}">Previous</a>` : ''}
              <span class="subdued">Page ${page} of ${pages} · ${result.total.toLocaleString('en-US')}${result.total >= 5000 ? '+' : ''} documents</span>
              ${page < pages ? html`<a class="btn" href="?q=${encodeURIComponent(filter)}&page=${page + 1}">Next</a>` : ''}</div>`
          : emptyState(text ? 'No matching documents' : 'No documents yet', text ? 'Try a different filter.' : c.attributes.length ? 'Create one here, or let your apps write them.' : 'Add attributes first, then documents.')}
      </div>`,
    )
  })

  function documentForm(ctx: ConsoleContext, c: Collection, doc: Record<string, unknown> | null): Html {
    const data: Record<string, unknown> = {}
    for (const a of c.attributes) data[a.key] = doc ? doc[a.key] : (a.default ?? (a.array ? [] : null))
    const action = doc ? `${colUrl(c)}/documents/${encodeURIComponent(String(doc.$id))}` : `${colUrl(c)}/documents`
    return html`<form method="post" action="${action}" class="layout">
      <div class="card">
        <h2>Data</h2>
        ${doc ? '' : html`<label>Document ID<input name="id" class="mono" value="unique()"><small>Keep <code>unique()</code> to generate one.</small></label>`}
        <label>JSON<textarea name="data" class="mono tall" spellcheck="false">${JSON.stringify(data, null, 2)}</textarea></label>
        <div class="foot"><a class="btn" href="${colUrl(c)}/documents">Cancel</a><button class="primary">${doc ? 'Save' : 'Create'}</button></div>
      </div>
      <div>
        <div class="card"><h2>Permissions</h2>
          <textarea name="permissions" class="mono" placeholder='read("any")'>${((doc?.$permissions as string[]) ?? []).join('\n')}</textarea>
          <p class="help">One per line, e.g. <code>read("team:ID")</code>. Applies when row security is on.</p></div>
        ${doc ? html`<div class="card"><h2>Details</h2><ul class="list">
          <li><span class="subdued">ID</span><span class="mono">${doc.$id}</span></li>
          <li><span class="subdued">Sequence</span><span>${doc.$sequence}</span></li>
          <li><span class="subdued">Created</span><span>${when(doc.$createdAt as string)}</span></li>
          <li><span class="subdued">Updated</span><span>${when(doc.$updatedAt as string)}</span></li></ul></div>` : ''}
      </div>
    </form>`
  }

  const parseData = (raw: unknown): Record<string, unknown> => {
    try {
      const data = JSON.parse(String(raw ?? '{}'))
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
      return data
    } catch {
      throw err('general_argument_invalid', 'The data must be a JSON object.')
    }
  }

  router.get(`${COL}/documents/new`, ({ ctx, path }) => {
    const c = collection(ctx, path)
    return ctx.render('Create document', 'databases', html`${header('Create document', { back: `${colUrl(c)}/documents` })}${documentForm(ctx, c, null)}`)
  })

  router.post(`${COL}/documents`, ({ ctx, path, request }) => {
    const c = collection(ctx, path)
    const doc = ctx.services.store.createDocument(keyCaller(), c, { id: String(ctx.form.id || 'unique()'), data: parseData(ctx.form.data), permissions: lines(ctx.form.permissions) })
    ctx.services.realtime.publish(ctx.services.store.drainEvents())
    return go(request, `${colUrl(c)}/documents/${doc.$id}`, { tone: 'success', text: 'Document created' })
  })

  router.get(`${COL}/documents/:doc`, ({ ctx, path }) => {
    const c = collection(ctx, path)
    const doc = ctx.services.store.getDocument(keyCaller(), c, path.doc!)
    return ctx.render(
      String(doc.$id),
      'databases',
      html`${header(String(doc.$id), { back: `${colUrl(c)}/documents`, actions: destroy(`${colUrl(c)}/documents/${encodeURIComponent(doc.$id)}/delete`, 'Delete', 'Delete this document?') })}
      ${documentForm(ctx, c, doc)}`,
    )
  })

  router.post(`${COL}/documents/:doc`, ({ ctx, path, request }) => {
    const c = collection(ctx, path)
    ctx.services.store.updateDocument(keyCaller(), c, path.doc!, parseData(ctx.form.data), lines(ctx.form.permissions))
    ctx.services.realtime.publish(ctx.services.store.drainEvents())
    return go(request, `${colUrl(c)}/documents/${encodeURIComponent(path.doc!)}`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${COL}/documents/:doc/delete`, ({ ctx, path, request }) => {
    const c = collection(ctx, path)
    ctx.services.store.deleteDocument(keyCaller(), c, path.doc!)
    ctx.services.realtime.publish(ctx.services.store.drainEvents())
    return go(request, `${colUrl(c)}/documents`, { tone: 'success', text: 'Document deleted' })
  })

  // ---------------------------------------------------------------- attributes
  const TYPES = ['string', 'integer', 'double', 'boolean', 'datetime', 'email', 'url', 'enum']

  router.get(`${COL}/attributes`, ({ ctx, path }) => {
    const c = collection(ctx, path)
    const typeOf = (a: Collection['attributes'][number]) => (a.format && a.format !== '' ? a.format : a.type)
    return ctx.render(
      c.name,
      'databases',
      html`${collectionHeader(ctx, c, html`<a class="btn primary" href="${colUrl(c)}/attributes/new">Add attribute</a>`)}${tabs(c, 'attributes')}
      <div class="card flush">
        ${c.attributes.length
          ? html`<div class="scroll"><table><thead><tr><th>Key</th><th>Type</th><th class="hide-sm">Required</th><th class="hide-sm">Default</th><th class="hide-sm">Limits</th><th></th></tr></thead><tbody>
            ${c.attributes.map((a) => html`<tr><td class="mono"><a href="${colUrl(c)}/attributes/${encodeURIComponent(a.key)}">${a.key}</a></td>
              <td>${typeOf(a)}${a.array ? '[]' : ''}</td><td class="hide-sm">${a.required ? badge('Required', 'attention') : ''}</td>
              <td class="clip mono hide-sm">${a.default === null || a.default === undefined ? '' : JSON.stringify(a.default)}</td>
              <td class="subdued hide-sm">${a.type === 'string' && a.format !== 'enum' ? `≤ ${a.size}` : a.elements ? a.elements.join(', ') : a.min !== undefined || a.max !== undefined ? `${a.min ?? '−∞'} … ${a.max ?? '∞'}` : ''}</td>
              <td class="num">${destroy(`${colUrl(c)}/attributes/${encodeURIComponent(a.key)}/delete`, 'Delete', `Delete ${a.key}? Its data in every document is removed.`)}</td></tr>`)}
            </tbody></table></div>`
          : emptyState('No attributes yet', 'Attributes are the fields every document has.', html`<a class="btn primary" href="${colUrl(c)}/attributes/new">Add attribute</a>`)}
      </div>`,
    )
  })

  function attributeForm(c: Collection, a: Collection['attributes'][number] | null): Html {
    const type = a ? (a.format && a.format !== '' && a.format !== 'ip' ? a.format : a.type) : 'string'
    return html`<form method="post" action="${colUrl(c)}/attributes${a ? `/${encodeURIComponent(a.key)}` : ''}" class="card">
      <div class="fields">
        <label>Key<input name="key" class="mono" value="${a?.key ?? ''}" ${a ? 'readonly' : ''} required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}"></label>
        <label>Type<select name="type">${TYPES.map((t) => html`<option ${t === type ? 'selected' : ''}>${t}</option>`)}</select>${a ? html`<small>Changing the type rebuilds the table and keeps the data.</small>` : ''}</label>
      </div>
      <div class="fields">
        <label>Size<input name="size" type="number" min="1" value="${a?.size ?? 255}"><small>Characters, for text.</small></label>
        <label>Min<input name="min" type="number" step="any" value="${a?.min ?? ''}"></label>
        <label>Max<input name="max" type="number" step="any" value="${a?.max ?? ''}"></label>
      </div>
      <label>Enum values<input name="elements" value="${a?.elements?.join(', ') ?? ''}"><small>Comma-separated, for enum.</small></label>
      <label>Default<input name="default" class="mono" value="${a?.default === null || a?.default === undefined ? '' : String(a.default)}"><small>Not allowed on required attributes.</small></label>
      <label class="check"><input type="checkbox" name="required" ${a?.required ? 'checked' : ''}>Required</label>
      <label class="check"><input type="checkbox" name="array" ${a?.array ? 'checked' : ''}>Array</label>
      <div class="foot"><a class="btn" href="${colUrl(c)}/attributes">Cancel</a><button class="primary">${a ? 'Save' : 'Add'}</button></div>
    </form>`
  }

  const attributeFromForm = (form: Record<string, any>) => {
    const type = String(form.type ?? 'string')
    const base = ['email', 'url', 'enum'].includes(type) ? 'string' : type
    const num = (v: unknown) => (String(v ?? '').trim() === '' ? undefined : Number(v))
    return {
      key: String(form.key ?? '').trim(),
      type: base,
      format: base === type ? '' : type,
      required: checked(form.required),
      array: checked(form.array),
      size: base === 'string' ? num(form.size) ?? 255 : undefined,
      min: num(form.min),
      max: num(form.max),
      elements: type === 'enum' ? lines(form.elements) : undefined,
      default: checked(form.required) ? null : typedDefault(base, form.default),
    }
  }

  router.get(`${COL}/attributes/new`, ({ ctx, path }) => {
    const c = collection(ctx, path)
    return ctx.render('Add attribute', 'databases', html`${header('Add attribute', { back: `${colUrl(c)}/attributes` })}${attributeForm(c, null)}`)
  })

  router.post(`${COL}/attributes`, ({ ctx, path, request }) => {
    const c = collection(ctx, path)
    const changes = ctx.schema.saveAttribute(c.databaseId, c.id, attributeFromForm(ctx.form))
    return go(request, `${colUrl(c)}/attributes`, { tone: 'success', text: `Attribute added${changes.length ? '' : ' (no change)'}` })
  })

  router.get(`${COL}/attributes/:key`, ({ ctx, path }) => {
    const c = collection(ctx, path)
    const a = c.attributeMap.get(path.key!)
    if (!a) throw err('attribute_not_found', undefined, [path.key])
    return ctx.render(a.key, 'databases', html`${header(a.key, { back: `${colUrl(c)}/attributes` })}${attributeForm(c, a)}`)
  })

  router.post(`${COL}/attributes/:key`, ({ ctx, path, request }) => {
    const c = collection(ctx, path)
    ctx.schema.saveAttribute(c.databaseId, c.id, { ...attributeFromForm(ctx.form), key: path.key }, true)
    return go(request, `${colUrl(c)}/attributes`, { tone: 'success', text: 'Attribute saved' })
  })

  router.post(`${COL}/attributes/:key/delete`, ({ ctx, path, request }) => {
    const c = collection(ctx, path)
    ctx.schema.deleteAttribute(c.databaseId, c.id, path.key!)
    return go(request, `${colUrl(c)}/attributes`, { tone: 'success', text: 'Attribute deleted' })
  })

  // ---------------------------------------------------------------- indexes
  router.get(`${COL}/indexes`, ({ ctx, path }) => {
    const c = collection(ctx, path)
    const options = ['$id', '$createdAt', '$updatedAt', ...c.attributes.map((a) => a.key)]
    return ctx.render(
      c.name,
      'databases',
      html`${collectionHeader(ctx, c)}${tabs(c, 'indexes')}
      <div class="layout">
        <div class="card flush">
          ${c.indexes.length
            ? html`<div class="scroll"><table><thead><tr><th>Key</th><th>Type</th><th>Attributes</th><th></th></tr></thead><tbody>
              ${c.indexes.map((i) => html`<tr><td class="mono">${i.key}</td><td>${i.type === 'unique' ? badge('Unique', 'info') : i.type === 'fulltext' ? badge('Full text', 'attention') : badge('Key')}</td>
                <td class="mono">${i.attributes.map((a, n) => `${a}${i.orders[n] === 'DESC' ? ' ↓' : ''}`).join(', ')}</td>
                <td class="num">${destroy(`${colUrl(c)}/indexes/${encodeURIComponent(i.key)}/delete`, 'Delete', `Delete index ${i.key}?`)}</td></tr>`)}
              </tbody></table></div>`
            : emptyState('No indexes', 'Add one for the attributes your queries filter or sort on.')}
        </div>
        <form method="post" action="${colUrl(c)}/indexes" class="card">
          <h2>Add index</h2>
          <label>Key<input name="key" class="mono" required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}"></label>
          <label>Type<select name="type"><option value="key">Key</option><option value="unique">Unique</option><option value="fulltext">Full text (for search)</option></select></label>
          <label>Attributes<select name="attributes" multiple size="6" required>${options.map((o) => html`<option>${o}</option>`)}</select><small>Hold ⌘/Ctrl to pick several, in order.</small></label>
          <label class="check"><input type="checkbox" name="desc">Descending</label>
          <div class="foot"><button class="primary">Add index</button></div>
        </form>
      </div>`,
    )
  })

  router.post(`${COL}/indexes`, ({ ctx, path, request }) => {
    const c = collection(ctx, path)
    const attributes = ([] as unknown[]).concat(ctx.form.attributes ?? []).map(String)
    ctx.schema.saveIndex(c.databaseId, c.id, {
      key: String(ctx.form.key ?? '').trim(),
      type: String(ctx.form.type ?? 'key'),
      attributes,
      orders: attributes.map(() => (checked(ctx.form.desc) ? 'DESC' : 'ASC')),
    })
    return go(request, `${colUrl(c)}/indexes`, { tone: 'success', text: 'Index added' })
  })

  router.post(`${COL}/indexes/:key/delete`, ({ ctx, path, request }) => {
    const c = collection(ctx, path)
    ctx.schema.deleteIndex(c.databaseId, c.id, path.key!)
    return go(request, `${colUrl(c)}/indexes`, { tone: 'success', text: 'Index deleted' })
  })

  // ---------------------------------------------------------------- settings
  router.get(`${COL}/settings`, ({ ctx, path }) => {
    const c = collection(ctx, path)
    return ctx.render(
      c.name,
      'databases',
      html`${collectionHeader(ctx, c)}${tabs(c, 'settings')}
      <form method="post" action="${colUrl(c)}/settings" class="card">
        <div class="fields"><label>Name<input name="name" value="${c.name}" required></label><label>ID<input value="${c.id}" class="mono" readonly></label></div>
        <label class="check"><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}>Enabled for apps</label>
        <label class="check"><input type="checkbox" name="documentSecurity" ${c.documentSecurity ? 'checked' : ''}>Row security</label>
        <label>Collection permissions<textarea name="permissions" class="mono">${c.permissions.join('\n')}</textarea><small>One per line, e.g. <code>create("users")</code>.</small></label>
        <div class="foot"><button class="primary">Save</button></div>
      </form>
      <div class="card"><h2>Delete collection</h2><p class="hint">Removes the collection and all ${count(ctx, c).toLocaleString('en-US')} documents. This cannot be undone.</p>
        ${destroy(`${colUrl(c)}/delete`, 'Delete collection', `Delete ${c.name} and its documents?`)}</div>`,
    )
  })

  router.post(`${COL}/settings`, ({ ctx, path, request }) => {
    const c = collection(ctx, path)
    ctx.schema.updateCollection(c.databaseId, c.id, {
      name: String(ctx.form.name ?? c.name),
      enabled: checked(ctx.form.enabled),
      documentSecurity: checked(ctx.form.documentSecurity),
      permissions: aggregatePermissions(lines(ctx.form.permissions).filter((l) => l.includes('('))) ?? [],
    })
    return go(request, `${colUrl(c)}/settings`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${COL}/delete`, ({ ctx, path, request }) => {
    const c = collection(ctx, path)
    ctx.schema.deleteCollection(c.databaseId, c.id)
    return go(request, `${DB}/${c.databaseId}`, { tone: 'success', text: 'Collection deleted' })
  })
}
