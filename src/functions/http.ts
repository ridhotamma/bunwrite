import type { Caller } from '~/auth/caller'
import type { Services } from '~/services'
import type { FunctionRow } from './service'

const HOP_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection'])

/**
 * Run a function for a plain HTTP request and turn its result into the
 * response: the function's own endpoint (`/v1/functions/<id>/http/*`) and a
 * site's `/api/*` both use this. `path` is what the function sees as
 * `req.path`, with the query string.
 */
export async function functionHttpResponse(services: Services, f: FunctionRow, caller: Caller, request: Request, path: string): Promise<Response> {
  services.functions.assertCanExecute(caller, f)
  // Keep the bytes: an upload (multipart, images, PDFs) is not valid UTF-8.
  const bytes = request.method === 'GET' || request.method === 'HEAD' ? null : new Uint8Array(await request.arrayBuffer())
  const { result } = await services.functions.execute(
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
  )
  const headers = Object.fromEntries(Object.entries(result!.headers).filter(([k]) => !HOP_HEADERS.has(k.toLowerCase())))
  const binary = !/json|text|xml|javascript/i.test(headers['content-type'] ?? headers['Content-Type'] ?? 'text')
  const payload = binary ? Buffer.from(result!.body, 'latin1') : result!.body
  if (result!.statusCode !== 204) {
    headers['content-length'] = String(typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length)
  }
  return new Response(result!.statusCode === 204 ? null : payload, { status: result!.statusCode || 500, headers })
}
