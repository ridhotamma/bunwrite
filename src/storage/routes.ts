import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { bool, json, list, noContent, str } from '~/lib/http'
import type { Router } from '~/lib/router'
import { bucketModel, fileModel } from './service'

const FILES = '/storage/buckets/:bucketId/files'

export function storageRoutes(router: Router<AppContext>): void {
  router.get('/storage/buckets', ({ ctx }) => {
    requireKey(ctx, 'buckets.read')
    const buckets = ctx.storage.buckets().map(bucketModel)
    return json({ total: buckets.length, buckets })
  })

  router.get('/storage/buckets/:bucketId', ({ ctx, path }) => {
    requireKey(ctx, 'buckets.read')
    return json(bucketModel(ctx.storage.bucket(path.bucketId!, true)))
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
        uploadId: request.headers.get('x-appwrite-id'),
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

  router.delete(`${FILES}/:fileId`, ({ ctx, path }) => {
    ctx.storage.deleteFile(ctx.caller, path.bucketId!, path.fileId!)
    return noContent()
  })

  router.get(`${FILES}/:fileId/view`, ({ ctx, path, request }) => {
    const { file } = ctx.storage.file(ctx.caller, path.bucketId!, path.fileId!, 'read', true)
    return ctx.storage.serve(request, path.bucketId!, file, 'inline')
  })

  router.get(`${FILES}/:fileId/download`, ({ ctx, path, request }) => {
    const { file } = ctx.storage.file(ctx.caller, path.bucketId!, path.fileId!, 'read', true)
    return ctx.storage.serve(request, path.bucketId!, file, 'attachment')
  })

  router.get(`${FILES}/:fileId/preview`, ({ ctx, path, request, url }) => {
    const { bucket, file } = ctx.storage.file(ctx.caller, path.bucketId!, path.fileId!, 'read', true)
    return ctx.storage.preview(request, url, bucket, file)
  })
}
