import { keyCaller } from '../../auth/caller'
import { aggregatePermissions } from '../../auth/permissions'
import type { BucketRow } from '../../storage/service'
import type { ConsoleRouter } from '../context'
import { checked, lines, value } from '../forms'
import { html, type Html } from '../html'
import { listQueries, pageCount, pageParams } from '../query'
import { badge, destroy, emptyState, formatBytes, header, listCard, pager, searchForm, when } from '../ui'

const STORAGE = '/console/storage'

function bucketForm(b: BucketRow | null): Html {
  const mb = b ? b.maximum_file_size / 1_000_000 : 10
  return html`<form method="post" action="${b ? `${STORAGE}/${b.id}/settings` : STORAGE}" class="card">
    ${b ? html`<h2>Bucket settings</h2>` : ''}
    <div class="fields"><label>Name<input name="name" value="${b?.name ?? ''}" required></label>
      <label>ID<input name="id" class="mono" value="${b?.id ?? ''}" ${b ? 'readonly' : 'required'} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}"></label></div>
    <div class="fields"><label>Maximum file size (MB)<input name="maxMb" type="number" min="0.001" step="any" value="${mb}"></label>
      <label>Allowed extensions<input name="extensions" value="${b ? JSON.parse(b.allowed_file_extensions).join(', ') : ''}" placeholder="jpg, png, webp"><small>Empty allows any.</small></label></div>
    <label class="check"><input type="checkbox" name="enabled" ${!b || b.enabled ? 'checked' : ''}>Enabled for apps</label>
    <label class="check"><input type="checkbox" name="fileSecurity" ${!b || b.file_security ? 'checked' : ''}>File security<small>&nbsp;· each file carries its own permissions</small></label>
    <label class="check"><input type="checkbox" name="transformations" ${!b || b.transformations ? 'checked' : ''}>Image previews (resize and convert)</label>
    <label>Bucket permissions<textarea name="permissions" class="mono">${b ? JSON.parse(b.permissions).join('\n') : ''}</textarea><small>One per line. Empty means only API keys and file permissions apply.</small></label>
    <div class="foot">${b ? '' : html`<a class="btn" href="${STORAGE}">Cancel</a>`}<button class="primary">${b ? 'Save' : 'Create'}</button></div>
  </form>`
}

const bucketInput = (form: Record<string, any>, id: string) => ({
  id,
  name: value(form, 'name'),
  enabled: checked(form.enabled),
  fileSecurity: checked(form.fileSecurity),
  transformations: checked(form.transformations),
  permissions: aggregatePermissions(lines(form.permissions)) ?? [],
  maximumFileSize: Math.round(Number(form.maxMb || 10) * 1_000_000),
  allowedFileExtensions: lines(form.extensions),
})

export function storagePages(router: ConsoleRouter): void {
  router.get(STORAGE, ({ ctx }) => {
    const buckets = ctx.services.storage.buckets()
    const usage = new Map(
      ctx.services.db.sqlite
        .query<{ bucket_id: string; n: number; bytes: number }, []>('SELECT bucket_id, count(*) AS n, coalesce(sum(size_original),0) AS bytes FROM _files GROUP BY bucket_id')
        .all()
        .map((r) => [r.bucket_id, r]),
    )
    return ctx.render(
      'Storage',
      'storage',
      html`${header('Storage', { actions: html`<a class="btn primary" href="${STORAGE}/new">Create bucket</a>` })}
      <div class="card flush">
        ${buckets.length
          ? html`<div class="scroll"><table><thead><tr><th>Bucket</th><th class="hide-sm">ID</th><th class="num">Files</th><th class="num">Size</th><th class="hide-sm">Status</th></tr></thead><tbody>
            ${buckets.map((b) => html`<tr class="row-link" onclick="location='${STORAGE}/${b.id}'"><td><a href="${STORAGE}/${b.id}">${b.name}</a></td><td class="mono hide-sm">${b.id}</td>
              <td class="num">${usage.get(b.id)?.n ?? 0}</td><td class="num">${formatBytes(usage.get(b.id)?.bytes ?? 0)}</td><td class="hide-sm">${b.enabled ? badge('Enabled', 'success') : badge('Disabled')}</td></tr>`)}
            </tbody></table></div>`
          : emptyState('No buckets yet', 'Buckets hold uploaded files.', html`<a class="btn primary" href="${STORAGE}/new">Create bucket</a>`)}
      </div>`,
    )
  })

  router.get(`${STORAGE}/new`, ({ ctx }) => ctx.render('Create bucket', 'storage', html`${header('Create bucket', { back: STORAGE })}${bucketForm(null)}`))

  router.post(STORAGE, ({ ctx }) => {
    const b = ctx.services.storage.saveBucket(bucketInput(ctx.form, value(ctx.form, 'id')), true)
    return ctx.go(`${STORAGE}/${b.id}`, { tone: 'success', text: 'Bucket created' })
  })

  router.get(`${STORAGE}/:bucket`, ({ ctx, path, url }) => {
    const b = ctx.services.storage.bucket(path.bucket!, true)
    const search = url.searchParams.get('search') ?? ''
    const { page, limit } = pageParams(url)
    const { total, files } = ctx.services.storage.listFiles(keyCaller(), b.id, listQueries(page, limit), search || undefined)
    const pages = pageCount(total, limit)
    const body = files.length
      ? html`<div class="scroll"><table><thead><tr><th>Name</th><th class="hide-sm">Type</th><th class="num">Size</th><th class="hide-sm">Uploaded</th><th></th></tr></thead><tbody>
          ${files.map((f) => html`<tr><td class="clip"><a href="${STORAGE}/${b.id}/files/${f.$id}/open" target="_blank" hx-boost="false">${f.name}</a></td><td class="hide-sm subdued">${f.mimeType}</td>
            <td class="num">${formatBytes(f.sizeOriginal)}</td><td class="hide-sm">${when(f.$createdAt)}</td>
            <td class="num">${destroy(`${STORAGE}/${b.id}/files/${f.$id}/delete`, 'Delete', `Delete ${f.name}?`)}</td></tr>`)}
          </tbody></table></div>`
      : emptyState(search ? 'No files match' : 'No files yet', search ? 'Try another name.' : 'Upload one here, or let your apps add them.')
    return ctx.render(
      b.name,
      'storage',
      html`${header(b.name, { back: STORAGE, badges: [b.enabled ? badge('Enabled', 'success') : badge('Disabled')] })}
      <div class="layout">
        ${listCard('files', {
          toolbar: searchForm({ action: `${STORAGE}/${b.id}`, target: 'files', value: search, placeholder: 'Search files' }),
          body,
          footer: pager({ page, pages, params: { search }, label: `Page ${page} of ${pages} · ${total} files` }),
        })}
        <div>
          <form method="post" action="${STORAGE}/${b.id}/files" enctype="multipart/form-data" class="card" hx-boost="false">
            <h2>Upload</h2>
            <label>File<input type="file" name="file" required></label>
            <label>Permissions<textarea name="permissions" class="mono" placeholder='read("any")'></textarea><small>One per line. <code>read("any")</code> makes it public.</small></label>
            <div class="foot"><button class="primary">Upload</button></div>
          </form>
          ${bucketForm(b)}
          <div class="card"><h2>Delete bucket</h2><p class="hint">Removes the bucket and all ${total} files.</p>${destroy(`${STORAGE}/${b.id}/delete`, 'Delete bucket', `Delete ${b.name} and its files?`)}</div>
        </div>
      </div>`,
    )
  })

  router.post(`${STORAGE}/:bucket/settings`, ({ ctx, path }) => {
    ctx.services.storage.saveBucket(bucketInput(ctx.form, path.bucket!), false)
    return ctx.go(`${STORAGE}/${path.bucket}`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${STORAGE}/:bucket/delete`, ({ ctx, path }) => {
    ctx.services.storage.deleteBucket(path.bucket!)
    return ctx.go(STORAGE, { tone: 'success', text: 'Bucket deleted' })
  })

  router.post(`${STORAGE}/:bucket/files`, async ({ ctx, path }) => {
    await ctx.services.storage.createFile(keyCaller(), path.bucket!, {
      fileId: 'unique()',
      file: ctx.form.file,
      permissions: lines(ctx.form.permissions),
      contentRange: null,
      uploadId: null,
    })
    return ctx.go(`${STORAGE}/${path.bucket}`, { tone: 'success', text: 'Uploaded' })
  })

  // Opened in a new tab by an admin, so served with the admin's authority.
  router.get(`${STORAGE}/:bucket/files/:file/open`, ({ ctx, path, request }) => {
    const { file } = ctx.services.storage.file(keyCaller(), path.bucket!, path.file!, 'read', true)
    return ctx.services.storage.serve(request, path.bucket!, file, 'inline')
  })

  router.post(`${STORAGE}/:bucket/files/:file/delete`, ({ ctx, path }) => {
    ctx.services.storage.deleteFile(keyCaller(), path.bucket!, path.file!)
    return ctx.go(`${STORAGE}/${path.bucket}`, { tone: 'success', text: 'File deleted' })
  })
}
