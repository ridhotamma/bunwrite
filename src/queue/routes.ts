/**
 * /v1/queue — the built-in job queue (a Bunwrite extension, not Appwrite).
 *
 *   POST   /queue/:queue/messages                        enqueue
 *   POST   /queue/:queue/claim                           claim 1..100 messages
 *   GET    /queue/:queue/messages                        list
 *   GET    /queue/:queue/messages/:messageId             read one
 *   DELETE /queue/:queue/messages/:messageId             delete one
 *   POST   /queue/:queue/messages/:messageId/ack         done
 *   POST   /queue/:queue/messages/:messageId/fail        error, retry with backoff
 *   POST   /queue/:queue/messages/:messageId/heartbeat   extend the lease
 *   GET    /queue/:queue/stats                           counts by status
 *   DELETE /queue/:queue                                 purge (optional ?status=)
 *
 * Workers claim a lease, run the handler in their own process, then ack or
 * fail. Everything needs an API key: the queue is for servers, not browsers.
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { err } from '~/lib/errors'
import { json, list, noContent, num, str } from '~/lib/http'
import type { Router } from '~/lib/router'
import { publicQueueName, queueModel } from './service'

function status(value: unknown): string | undefined {
  const text = str(value)
  if (!text) return undefined
  if (!['waiting', 'processing', 'completed', 'failed'].includes(text)) {
    throw err('general_argument_invalid', 'Param "status" must be waiting, processing, completed or failed.')
  }
  return text
}

/** System queues (`_render`, …) belong to Bunwrite and are not reachable here. */
const q = (value: string) => publicQueueName(value)

export function queueRoutes(router: Router<AppContext>): void {
  router.post('/queue/:queue/messages', ({ ctx, path, params }) => {
    requireKey(ctx, 'queue.write')
    const { message, created } = ctx.queue.enqueue(q(path.queue!), {
      data: params.data,
      id: params.messageId ?? params.id,
      delay: num(params.delay),
      maxAttempts: num(params.maxAttempts),
      idempotencyKey: str(params.idempotencyKey),
    })
    return json(queueModel(message), created ? 201 : 200)
  })

  router.post('/queue/:queue/claim', ({ ctx, path, params }) => {
    requireKey(ctx, 'queue.write')
    const messages = ctx.queue.claim(q(path.queue!), { count: num(params.count), lease: num(params.lease) })
    return json({ messages: messages.map(queueModel) })
  })

  router.get('/queue/:queue/messages', ({ ctx, path, params }) => {
    requireKey(ctx, 'queue.read')
    return json(ctx.queue.listMessages(q(path.queue!), list(params.queries), status(params.status)))
  })

  router.get('/queue/:queue/messages/:messageId', ({ ctx, path }) => {
    requireKey(ctx, 'queue.read')
    return json(queueModel(ctx.queue.getMessage(q(path.queue!), path.messageId!)))
  })

  router.delete('/queue/:queue/messages/:messageId', ({ ctx, path }) => {
    requireKey(ctx, 'queue.write')
    ctx.queue.deleteMessage(q(path.queue!), path.messageId!)
    return noContent()
  })

  router.post('/queue/:queue/messages/:messageId/ack', ({ ctx, path, params }) => {
    requireKey(ctx, 'queue.write')
    return json(queueModel(ctx.queue.ack(q(path.queue!), path.messageId!, params.result)))
  })

  router.post('/queue/:queue/messages/:messageId/fail', ({ ctx, path, params }) => {
    requireKey(ctx, 'queue.write')
    return json(queueModel(ctx.queue.fail(q(path.queue!), path.messageId!, str(params.error) ?? str(params.message), num(params.delay))))
  })

  router.post('/queue/:queue/messages/:messageId/heartbeat', ({ ctx, path, params }) => {
    requireKey(ctx, 'queue.write')
    return json(queueModel(ctx.queue.heartbeat(q(path.queue!), path.messageId!, num(params.lease) ?? 60)))
  })

  router.get('/queue/:queue/stats', ({ ctx, path }) => {
    requireKey(ctx, 'queue.read')
    return json(ctx.queue.stats(q(path.queue!)))
  })

  router.delete('/queue/:queue', ({ ctx, path, params }) => {
    requireKey(ctx, 'queue.write')
    return json({ deleted: ctx.queue.purge(q(path.queue!), status(params.status)) })
  })
}
