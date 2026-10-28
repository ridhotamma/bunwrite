import type { AppContext } from '~/app'
import { keyCaller } from '~/auth/caller'
import { requireKey } from '~/auth/routes'
import { apiHeader } from '~/lib/compat'
import { bool, json, list, noContent, num, str, type Params } from '~/lib/http'
import type { Router } from '~/lib/router'
import { uniqueId } from '~/lib/ids'
import { page } from '~/lib/paging'
import { bucketModel, fileModel, type BucketRow } from './service'
import { validFileToken } from './tokens'

const FILES = '/storage/buckets/:bucketId/files'

/** Bucket settings from a create or update call, with Appwrite's defaults for what is left out. */
function bucketInput(p: Params, id: string, current: BucketRow | null) {
  const strings = (value: unknown, fallback: string[]) => (value === undefined || value === null ? fallback : list(value).map(String))
  return {
    id,
    name: str(p.name) ?? current?.name ?? '',
    permissions: strings(p.permissions, current ? JSON.parse(current.permissions) : []),
    fileSecurity: bool(p.fileSecurity, current ? Boolean(current.file_security) : false),
    enabled: bool(p.enabled, current ? Boolean(current.enabled) : true),
    maximumFileSize: num(p.maximumFileSize, current?.maximum_file_size ?? 30_000_000)!,
    allowedFileExtensions: strings(p.allowedFileExtensions, current ? JSON.parse(current.allowed_file_extensions) : []),
    compression: str(p.compression) ?? current?.compression ?? 'none',
    encryption: bool(p.encryption, current ? Boolean(current.encryption) : true),
    antivirus: bool(p.antivirus, current ? Boolean(current.antivirus) : true),
    transformations: bool(p.transformations, current ? Boolean(current.transformations) : true),
  }
}

/** A signed `token=` link opens that one file for anyone holding it. */
function readerFor(ctx: AppContext, url: URL, bucketId: string, fileId: string) {
  return validFileToken(url.searchParams.get('token'), ctx.config.secret, bucketId, fileId) ? keyCaller() : ctx.caller
}

export function storageRoutes(router: Router<AppContext>): void {
  router.get('/storage/buckets', ({ ctx, params }) => {
    requireKey(ctx, 'buckets.read')
    const { total, items } = page(ctx.storage.buckets().map(bucketModel), list(params.queries), { search: str(params.search), searchFields: ['$id', 'name'] })
    return json({ total, buckets: items })
  })

  router.post('/storage/buckets', ({ ctx, params }) => {
    requireKey(ctx, 'buckets.write')
    const bucketId = params.bucketId === 'unique()' ? uniqueId() : String(params.bucketId ?? '')
    return json(bucketModel(ctx.storage.saveBucket(bucketInput(params, bucketId, null), true)), 201)
  })

  router.get('/storage/buckets/:bucketId', ({ ctx, path }) => {
    requireKey(ctx, 'buckets.read')
    return json(bucketModel(ctx.storage.bucket(path.bucketId!, true)))
  })

  router.put('/storage/buckets/:bucketId', ({ ctx, path, params }) => {
    requireKey(ctx, 'buckets.write')
    const current = ctx.storage.bucket(path.bucketId!, true)
    return json(bucketModel(ctx.storage.saveBucket(bucketInput(params, current.id, current), false)))
  })

  router.delete('/storage/buckets/:bucketId', async ({ ctx, path }) => {
    requireKey(ctx, 'buckets.write')
    await ctx.storage.deleteBucket(path.bucketId!)
    return noContent()
  })

  router.get(FILES, ({ ctx, path, params }) =>
    json(ctx.storage.listFiles(ctx.caller, path.bucketId!, list(params.queries), str(params.search), bool(params.total, true))),
  )

  router.post(FILES, async ({ ctx, path, params, request }) =>
    json(
      await ctx.storage.createFile(ctx.caller, path.bucketId!, {
        fileId: params.fileId,
        file: params.file,
        permissions: params.permissions ?? null,
        contentRange: request.headers.get('content-range'),
        uploadId: apiHeader(request, 'id'),
      }),
      201,
    ),
  )

  router.get(`${FILES}/:fileId`, ({ ctx, path }) => {
    const { bucket, file } = ctx.storage.file(ctx.caller, path.bucketId!, path.fileId!)
    return json(fileModel(file, bucket))
  })

  router.put(`${FILES}/:fileId`, ({ ctx, path, params }) =>
    json(ctx.storage.updateFile(ctx.caller, path.bucketId!, path.fileId!, params.name, params.permissions)),
  )

  router.delete(`${FILES}/:fileId`, async ({ ctx, path }) => {
    await ctx.storage.deleteFile(ctx.caller, path.bucketId!, path.fileId!)
    return noContent()
  })

  router.get(`${FILES}/:fileId/view`, ({ ctx, path, request, url }) => {
    const { file } = ctx.storage.file(readerFor(ctx, url, path.bucketId!, path.fileId!), path.bucketId!, path.fileId!, 'read', true)
    return ctx.storage.serve(request, path.bucketId!, file, 'inline')
  })

  router.get(`${FILES}/:fileId/download`, ({ ctx, path, request, url }) => {
    const { file } = ctx.storage.file(readerFor(ctx, url, path.bucketId!, path.fileId!), path.bucketId!, path.fileId!, 'read', true)
    return ctx.storage.serve(request, path.bucketId!, file, 'attachment')
  })

  router.get(`${FILES}/:fileId/preview`, ({ ctx, path, request, url }) => {
    const { bucket, file } = ctx.storage.file(readerFor(ctx, url, path.bucketId!, path.fileId!), path.bucketId!, path.fileId!, 'read', true)
    return ctx.storage.preview(request, url, bucket, file)
  })
}
