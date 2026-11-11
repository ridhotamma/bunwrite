/**
 * Server-sent events for console cards that change on their own, such as a
 * deployment list while a build runs. The stream only says "this changed";
 * the page re-fetches the card, so HTML is still rendered in one place.
 */
import type { ConsoleRouter } from '~/console/context'
import { LIVE_PATH } from '~/console/live-script'
import { markStreaming } from '~/lib/streaming'

/** Topics a console tab may watch: one site's or one function's deployments. */
const TOPIC = /^(site|function):([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/
/** Comments keep proxies from closing a quiet stream. */
const HEARTBEAT_MS = 20_000

export function livePages(router: ConsoleRouter): void {
  router.get(LIVE_PATH, async ({ ctx, url, request }) => {
    const topic = url.searchParams.get('topic') ?? ''
    const match = TOPIC.exec(topic)
    if (!match) return new Response('Unknown topic', { status: 400 })
    const [, kind, id] = match
    const exists = kind === 'site' ? ctx.services.sites.has(id!) : await ctx.services.functions.has(id!)
    if (!exists) return new Response('Not found', { status: 404 })

    const events = ctx.services.consoleEvents
    const encoder = new TextEncoder()
    let stop = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false
        const write = (text: string) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(text))
          } catch {
            stop()
          }
        }
        const unsubscribe = events.subscribe(topic, (data) => write(`event: changed\ndata: ${JSON.stringify(data)}\n\n`))
        const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS)
        stop = () => {
          if (closed) return
          closed = true
          unsubscribe()
          clearInterval(heartbeat)
          request.signal.removeEventListener('abort', stop)
          try {
            controller.close()
          } catch {
            // Already closed by the client.
          }
        }
        request.signal.addEventListener('abort', stop, { once: true })
        // `retry` sets the browser's reconnect delay; the comment flushes headers at once.
        write('retry: 3000\n: connected\n\n')
      },
      cancel() {
        stop()
      },
    })
    return markStreaming(
      new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        },
      }),
    )
  })
}
