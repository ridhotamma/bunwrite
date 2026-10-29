import type { Caller } from '~/auth/caller'
import { markStreaming } from '~/lib/streaming'
import type { Services } from '~/services'
import type { ExecutionStream, FunctionRow } from './service'

const HOP_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection'])

const responseHeaders = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP_HEADERS.has(k.toLowerCase())))

/**
 * Run a function for a plain HTTP request and turn its result into the
 * response: the function's own endpoint (`/v1/functions/<id>/http/*`) and a
 * site's `/api/*` both use this. `path` is what the function sees as
 * `req.path`, with the query string.
 *
 * A function that calls `res.start()` gets its response sent right away, and
 * each `res.write*()` reaches the client as it happens (LLM tokens, SSE,
 * progress). Otherwise the response goes out once the function returns.
 */
export async function functionHttpResponse(services: Services, f: FunctionRow, caller: Caller, request: Request, path: string): Promise<Response> {
  services.functions.assertCanExecute(caller, f)
  // Keep the bytes: an upload (multipart, images, PDFs) is not valid UTF-8.
  const bytes = request.method === 'GET' || request.method === 'HEAD' ? null : new Uint8Array(await request.arrayBuffer())

  let started = false
  let resolveHead!: (response: Response) => void
  const head = new Promise<Response>((resolve) => (resolveHead = resolve))
  const abort = new AbortController()
  let body!: ReadableStreamDefaultController<Uint8Array>
  // Calls on a stream the client already cancelled would throw; nobody is listening then.
  const quietly = (call: () => void) => {
    try {
      call()
    } catch {}
  }
  const stream: ExecutionStream = {
    signal: abort.signal,
    start({ statusCode, headers }) {
      started = true
      const out = responseHeaders(headers)
      // Proxies such as nginx otherwise hold the chunks back.
      if (!Object.keys(out).some((k) => k.toLowerCase() === 'x-accel-buffering')) out['x-accel-buffering'] = 'no'
      const empty = statusCode === 204 || statusCode === 304 || request.method === 'HEAD'
      const readable = new ReadableStream<Uint8Array>({
        start: (controller) => void (body = controller),
        cancel: () => abort.abort(),
      })
      resolveHead(markStreaming(new Response(empty ? null : readable, { status: statusCode || 200, headers: out })))
    },
    write: (chunk) => quietly(() => body.enqueue(chunk)),
    end: () => quietly(() => body.close()),
    fail: (reason) => quietly(() => body.error(reason)),
  }

  const finished = services.functions
    .execute(
      f,
      {
        trigger: 'http',
        method: request.method,
        path,
        headers: Object.fromEntries(request.headers),
        body: bytes ? new TextDecoder().decode(bytes) : '',
        ...(bytes && bytes.length > 0 ? { bodyBytes: bytes } : {}),
        userId: caller.user?.id ?? null,
      },
      'sync',
      stream,
    )
    .then(({ result }) => (started ? head : bufferedResponse(result!)))
  return Promise.race([head, finished])
}

function bufferedResponse(result: { statusCode: number; headers: Record<string, string>; body: string }): Response {
  const headers = responseHeaders(result.headers)
  const binary = !/json|text|xml|javascript/i.test(headers['content-type'] ?? headers['Content-Type'] ?? 'text')
  const payload = binary ? Buffer.from(result.body, 'latin1') : result.body
  if (result.statusCode !== 204) {
    headers['content-length'] = String(typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length)
  }
  return new Response(result.statusCode === 204 ? null : payload, { status: result.statusCode || 500, headers })
}
