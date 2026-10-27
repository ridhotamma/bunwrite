import { keyCaller } from '~/auth/caller'
import { aggregatePermissions } from '~/auth/permissions'
import { requestEndpoint } from '~/lib/origins'
import { publiclyReadable, type BucketRow } from '~/storage/service'
import { fileToken } from '~/storage/tokens'
import type { ConsoleRouter } from '~/console/context'
import type { ConsoleContext } from '~/console/context'
import { dialog } from '~/console/dialog'
import { checked, lines, value } from '~/console/forms'
import { COLLECTION_ACTIONS, DOCUMENT_ACTIONS, permissionsField, securityChoice } from '~/console/permissions'
import { html, type Html } from '~/console/html'
import { listQueries, pageCount, pageParams } from '~/console/query'
import { badge, copyableId, destroy, emptyState, formatBytes, header, icon, listCard, pageFooter, pager, searchForm, settingsSection, tabs, when } from '~/console/ui'

const STORAGE = '/console/storage'
const bucketUrl = (id: string) => `${STORAGE}/${encodeURIComponent(id)}`

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`
const extensionsOf = (b: BucketRow): string[] => JSON.parse(b.allowed_file_extensions)
const megabytes = (b: BucketRow | null) => (b ? b.maximum_file_size / 1_000_000 : 10)

/**
 * The API view URL for a file, on the host this console was opened on
 * (localhost while developing, the public domain in production). Files that
 * are not public get a signed token, so they open without a console session.
 */
function fileViewUrl(ctx: ConsoleContext, bucketId: string, fileId: string, isPublic: boolean): string {
  const { config } = ctx.services
  const url = new URL(`${requestEndpoint(ctx.request, config.publicEndpoint)}/storage/buckets/${encodeURIComponent(bucketId)}/files/${encodeURIComponent(fileId)}/view`)
  url.searchParams.set('project', config.projectId)
  if (!isPublic) url.searchParams.set('token', fileToken(config.secret, bucketId, fileId))
  return url.toString()
}

type BucketInput = Parameters<ConsoleContext['services']['storage']['saveBucket']>[0]

// Settings sections. The create page shows them all in one form; the settings
// tab gives each its own form and Save button.

const SECTIONS = {
  general: { title: 'General', hint: 'The name shown here, and whether apps can use the bucket.' },
  uploads: { title: 'Uploads', hint: 'Checked on every upload, from apps and from this console.' },
  access: { title: 'Access', hint: 'Who can create, read, update and delete files. API keys and server functions always have full access.' },
} as const

type Section = keyof typeof SECTIONS

function generalFields(b: BucketRow | null): Html {
  return html`<label>Name<input name="name" value="${b?.name ?? ''}" required ${b ? '' : 'data-slug-source'}></label>
    ${b
      ? html`<label>ID<div class="copy-row"><input id="bucket-id" class="mono" readonly value="${b.id}"><button type="button" data-copy-target="#bucket-id">${icon('copy')}<span data-copy-label>Copy</span></button></div></label>`
      : html`<label>ID<input name="id" class="mono" required data-slug-from="name" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}"><small>Filled in from the name; it cannot change later.</small></label>`}
    <label class="check"><input type="checkbox" name="enabled" ${!b || b.enabled ? 'checked' : ''}>Enabled for apps</label>`
}

function uploadFields(b: BucketRow | null): Html {
  return html`<div class="fields"><label>Maximum file size (MB)<input name="maxMb" type="number" min="0.001" step="any" value="${megabytes(b)}"></label>
      <label>Allowed extensions<input name="extensions" value="${b ? extensionsOf(b).join(', ') : ''}" placeholder="jpg, png, webp"><small>Empty allows any.</small></label></div>
    <label class="check"><input type="checkbox" name="transformations" ${!b || b.transformations ? 'checked' : ''}>Image previews (resize and convert)</label>`
}

function accessFields(ctx: ConsoleContext, b: BucketRow | null): Html {
  return html`${securityChoice('fileSecurity', !b || Boolean(b.file_security), 'file')}
    <h3 class="field-heading">Bucket permissions</h3>
    ${permissionsField(ctx, { value: b ? JSON.parse(b.permissions) : [], actions: COLLECTION_ACTIONS, note: html`Applies to every file in the bucket.` })}`
}

function sectionFields(ctx: ConsoleContext, section: Section, b: BucketRow | null): Html {
  return section === 'general' ? generalFields(b) : section === 'uploads' ? uploadFields(b) : accessFields(ctx, b)
}

function settingsForm(ctx: ConsoleContext, b: BucketRow, section: Section): Html {
  const { title, hint } = SECTIONS[section]
  return settingsSection(
    title,
    hint,
    html`<form method="post" action="${bucketUrl(b.id)}/settings">
      <input type="hidden" name="section" value="${section}">
      ${sectionFields(ctx, section, b)}
      <div class="foot"><button class="primary">Save</button></div>
    </form>`,
  )
}

/** Every field, for the create page. */
const bucketInput = (form: Record<string, any>, id: string): BucketInput => ({
  id,
  name: value(form, 'name'),
  enabled: checked(form.enabled),
  fileSecurity: checked(form.fileSecurity),
  transformations: checked(form.transformations),
  permissions: aggregatePermissions(lines(form.permissions), COLLECTION_ACTIONS) ?? [],
  maximumFileSize: Math.round(Number(form.maxMb || 10) * 1_000_000),
  allowedFileExtensions: lines(form.extensions),
})

/** One section's fields over the bucket's current values, so saving one card leaves the others alone. */
function sectionInput(form: Record<string, any>, b: BucketRow): BucketInput {
  const all = bucketInput(form, b.id)
  const current: BucketInput = {
    id: b.id,
    name: b.name,
    enabled: Boolean(b.enabled),
    fileSecurity: Boolean(b.file_security),
    transformations: Boolean(b.transformations),
    permissions: JSON.parse(b.permissions),
    maximumFileSize: b.maximum_file_size,
    allowedFileExtensions: extensionsOf(b),
  }
  switch (form.section) {
    case 'general':
      return { ...current, name: all.name || b.name, enabled: all.enabled }
    case 'uploads':
      return { ...current, maximumFileSize: all.maximumFileSize, allowedFileExtensions: all.allowedFileExtensions, transformations: all.transformations }
    case 'access':
      return { ...current, fileSecurity: all.fileSecurity, permissions: all.permissions }
    default:
      return all
  }
}

function bucketHeader(b: BucketRow, actions?: Html): Html {
  return header(b.name, {
    back: STORAGE,
    subtitle: html`${copyableId(b.id, 'bucket-id-label')}<span class="dot" aria-hidden="true">·</span><span>${b.file_security ? 'File security' : 'Bucket permissions only'}</span>`,
    badges: [b.enabled ? badge('Enabled', 'success') : badge('Disabled')],
    actions,
  })
}

const bucketTabs = (b: BucketRow, on: 'files' | 'settings') =>
  tabs(
    [
      { key: 'files', label: 'Files', href: bucketUrl(b.id) },
      { key: 'settings', label: 'Settings', href: `${bucketUrl(b.id)}/settings` },
    ],
    on,
  )

/** The upload form. File permissions only show when file security is on, and stay folded away until asked for. */
function uploadForm(ctx: ConsoleContext, b: BucketRow, id: string): Html {
  const limits = [`Up to ${megabytes(b)} MB`, extensionsOf(b).join(', ') || 'any file type'].join(' · ')
  return html`<form id="${id}" method="post" action="${bucketUrl(b.id)}/files" enctype="multipart/form-data" hx-boost="false">
    <label>File<input type="file" name="file" required><small>${limits}</small></label>
    ${b.file_security
      ? html`<details class="disclosure"><summary>File permissions <span class="subdued">(optional)</span></summary>
          <p class="help" style="margin:0 0 10px">Give specific users or teams access to this file only. Bucket permissions still apply.</p>
          ${permissionsField(ctx, { value: [], actions: DOCUMENT_ACTIONS, empty: 'No extra roles, so the bucket permissions decide who can open this file.' })}
        </details>`
      : html`<p class="help" style="margin:0">File security is off, so the bucket permissions decide who can open this file. <a href="${bucketUrl(b.id)}/settings">Change</a></p>`}
  </form>`
}

function uploadDialog(ctx: ConsoleContext, b: BucketRow): Html {
  return dialog({
    id: 'upload-file',
    title: `Upload to ${b.name}`,
    body: uploadForm(ctx, b, 'upload-file-form'),
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="upload-file-form" class="primary">Upload</button>`,
  })
}

const uploadButton = (b: BucketRow, primary: boolean) =>
  html`<a class="btn ${primary ? 'primary' : ''}" href="${bucketUrl(b.id)}/upload" data-dialog-open="#upload-file" hx-boost="false">${icon('upload-simple')}<span>Upload file</span></a>`

export function storagePages(router: ConsoleRouter): void {
  router.get(STORAGE, ({ ctx }) => {
    const buckets = ctx.services.storage.buckets()
    const usage = ctx.services.storage.usageByBucket()
    const create = html`<a class="btn primary" href="${STORAGE}/new">${icon('plus')}<span>Create bucket</span></a>`
    return ctx.render(
      'Storage',
      'storage',
      html`${header('Storage', { actions: buckets.length ? create : undefined })}
      <div class="card flush">
        ${buckets.length
          ? html`<div class="scroll"><table><thead><tr><th>Bucket</th><th class="num">Files</th><th class="num">Size</th><th class="hide-sm">Access</th><th class="hide-sm">Status</th></tr></thead><tbody>
            ${buckets.map((b) => html`<tr class="row-link" onclick="location='${bucketUrl(b.id)}'">
              <td><a href="${bucketUrl(b.id)}">${b.name}</a><div class="mono subdued cell-sub">${b.id}</div></td>
              <td class="num">${(usage.get(b.id)?.files ?? 0).toLocaleString('en-US')}</td><td class="num">${formatBytes(usage.get(b.id)?.bytes ?? 0)}</td>
              <td class="hide-sm subdued">${b.file_security ? 'File security' : 'Bucket permissions'}</td>
              <td class="hide-sm">${b.enabled ? badge('Enabled', 'success') : badge('Disabled')}</td></tr>`)}
            </tbody></table></div>`
          : emptyState('No buckets yet', 'Buckets hold uploaded files, each with its own limits and permissions.', create)}
      </div>`,
    )
  })

  router.get(`${STORAGE}/new`, ({ ctx }) =>
    ctx.render(
      'Create bucket',
      'storage',
      html`${header('Create bucket', { back: STORAGE })}
      <form method="post" action="${STORAGE}">
        ${(Object.keys(SECTIONS) as Section[]).map((section) => settingsSection(SECTIONS[section].title, SECTIONS[section].hint, sectionFields(ctx, section, null)))}
        ${pageFooter(STORAGE, 'Create bucket')}
      </form>`,
    ),
  )

  router.post(STORAGE, ({ ctx }) => {
    const b = ctx.services.storage.saveBucket(bucketInput(ctx.form, value(ctx.form, 'id')), true)
    return ctx.go(bucketUrl(b.id), { tone: 'success', text: 'Bucket created' })
  })

  router.get(`${STORAGE}/:bucket`, ({ ctx, path, url }) => {
    const b = ctx.services.storage.bucket(path.bucket!, true)
    const search = url.searchParams.get('search') ?? ''
    const { page, limit } = pageParams(url)
    const { total, files } = ctx.services.storage.listFiles(keyCaller(), b.id, listQueries(page, limit), search || undefined)
    const pages = pageCount(total, limit)
    const body = files.length
      ? html`<div class="scroll"><table><thead><tr><th>Name</th><th class="hide-sm">Type</th><th class="num">Size</th><th class="hide-sm">Uploaded</th><th></th></tr></thead><tbody>
          ${files.map((f, i) => {
            const isPublic = publiclyReadable(b, f.$permissions)
            const viewUrl = fileViewUrl(ctx, b.id, f.$id, isPublic)
            return html`<tr><td class="clip"><a href="${viewUrl}" target="_blank" rel="noopener" hx-boost="false">${f.name}</a>${isPublic ? html` ${badge('Public', 'success')}` : ''}</td><td class="hide-sm subdued">${f.mimeType}</td>
            <td class="num">${formatBytes(f.sizeOriginal)}</td><td class="hide-sm subdued">${when(f.$createdAt)}</td>
            <td class="num"><div class="row-actions">
              <button type="button" class="small plain" data-copy-target="#file-url-${i}" title="${isPublic ? 'Anyone with this link can open the file' : 'Signed link: anyone with it can open the file for 24 hours'}">${icon('copy', 14)}<span data-copy-label>Copy link</span></button><span id="file-url-${i}" hidden>${viewUrl}</span>
              ${destroy(`${bucketUrl(b.id)}/files/${f.$id}/delete`, 'Delete', `Delete ${f.name}?`)}
            </div></td></tr>`
          })}
          </tbody></table></div>`
      : search
        ? emptyState('No files match', 'Try another name.', html`<a class="btn" href="${bucketUrl(b.id)}">Clear search</a>`)
        : emptyState('No files yet', 'Upload one here, or let your apps add them.', uploadButton(b, false))
    return ctx.render(
      b.name,
      'storage',
      html`${bucketHeader(b, uploadButton(b, true))}${bucketTabs(b, 'files')}
      ${listCard('files', {
        toolbar: searchForm({ action: bucketUrl(b.id), target: 'files', value: search, placeholder: 'Search files' }),
        body,
        footer: pager({ page, pages, params: { search }, always: total > 0, label: `Page ${page} of ${pages} · ${plural(total, 'file')}` }),
      })}
      ${uploadDialog(ctx, b)}`,
    )
  })

  // Without JavaScript the "Upload file" link lands here instead of opening the dialog.
  router.get(`${STORAGE}/:bucket/upload`, ({ ctx, path }) => {
    const b = ctx.services.storage.bucket(path.bucket!, true)
    return ctx.render(
      `Upload to ${b.name}`,
      'storage',
      html`${header(`Upload to ${b.name}`, { back: bucketUrl(b.id) })}
      <div class="card narrow">${uploadForm(ctx, b, 'upload-page-form')}
        <div class="foot" style="margin-top:12px"><a class="btn" href="${bucketUrl(b.id)}">Cancel</a><button type="submit" form="upload-page-form" class="primary">Upload</button></div></div>`,
    )
  })

  router.get(`${STORAGE}/:bucket/settings`, ({ ctx, path }) => {
    const b = ctx.services.storage.bucket(path.bucket!, true)
    const files = ctx.services.storage.usageByBucket().get(b.id)?.files ?? 0
    return ctx.render(
      b.name,
      'storage',
      html`${bucketHeader(b)}${bucketTabs(b, 'settings')}
      ${settingsForm(ctx, b, 'general')}
      ${settingsForm(ctx, b, 'uploads')}
      ${settingsForm(ctx, b, 'access')}
      ${settingsSection(
        'Delete bucket',
        'Permanently removes the bucket and its files. This cannot be undone.',
        html`<p class="hint" style="margin:0 0 12px">${plural(files, 'file')} will be deleted with it.</p>
          ${destroy(`${bucketUrl(b.id)}/delete`, 'Delete bucket', `Delete ${b.name} and its files?`)}`,
      )}`,
    )
  })

  router.post(`${STORAGE}/:bucket/settings`, ({ ctx, path }) => {
    const b = ctx.services.storage.bucket(path.bucket!, true)
    ctx.services.storage.saveBucket(sectionInput(ctx.form, b), false)
    return ctx.go(`${bucketUrl(b.id)}/settings`, { tone: 'success', text: 'Saved' })
  })

  router.post(`${STORAGE}/:bucket/delete`, async ({ ctx, path }) => {
    await ctx.services.storage.deleteBucket(path.bucket!)
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
    return ctx.go(bucketUrl(path.bucket!), { tone: 'success', text: 'Uploaded' })
  })

  // Opened in a new tab by an admin, so served with the admin's authority.
  router.get(`${STORAGE}/:bucket/files/:file/open`, ({ ctx, path, request }) => {
    const { file } = ctx.services.storage.file(keyCaller(), path.bucket!, path.file!, 'read', true)
    return ctx.services.storage.serve(request, path.bucket!, file, 'inline')
  })

  router.post(`${STORAGE}/:bucket/files/:file/delete`, async ({ ctx, path }) => {
    await ctx.services.storage.deleteFile(keyCaller(), path.bucket!, path.file!)
    return ctx.go(bucketUrl(path.bucket!), { tone: 'success', text: 'File deleted' })
  })
}
