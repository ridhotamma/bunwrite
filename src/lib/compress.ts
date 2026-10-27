/**
 * Response compression for every route: JSON, console HTML, scripts, text
 * files and SVG. Small bodies are compressed in one go (Brotli when the client
 * accepts it, else gzip); large or streamed bodies are gzipped as they stream,
 * so big downloads never sit in memory. Already-compressed types such as
 * images, video, zip and PDF are left alone.
 */
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

export type Encoding = 'br' | 'gzip'

/** Bodies below this are sent as they are: headers would eat the saving. */
export const MIN_COMPRESS_BYTES = 1024
/** Bodies up to this size are buffered and compressed in one go. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

const COMPRESSIBLE =
  /^(text\/(?!event-stream)|application\/(json|javascript|ecmascript|xml|x-javascript|manifest\+json|ld\+json|graphql|x-ndjson|wasm|[a-z0-9.+-]*\+(json|xml))|image\/(svg\+xml|x-icon|vnd\.microsoft\.icon|bmp)|font\/(ttf|otf)|application\/(x-font-ttf|vnd\.ms-fontobject))/i

export const isCompressible = (contentType: string | null) => Boolean(contentType && COMPRESSIBLE.test(contentType))

/** The `offered` encoding the client prefers by q-value (Brotli wins ties). `q=0` means "not this one". */
export function pickEncoding(acceptEncoding: string | null, offered: Encoding[] = ['br', 'gzip']): Encoding | null {
  if (!acceptEncoding) return null
  const q = new Map<string, number>()
  for (const part of acceptEncoding.toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';')
    if (!name) continue
    const weight = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)).find(Boolean)
    q.set(name.trim(), weight ? Number(weight[1]) : 1)
  }
  let best: Encoding | null = null
  let bestQ = 0
  for (const encoding of offered) {
    const weight = q.get(encoding) ?? (q.has('*') ? q.get('*')! : 0)
    if (weight > bestQ) {
      best = encoding
      bestQ = weight
    }
  }
  return best
}

export function addVary(headers: Headers, value: string): void {
  const current = headers.get('vary')
  if (!current) headers.set('vary', value)
  else if (current.trim() !== '*' && !current.toLowerCase().split(',').some((v) => v.trim() === value.toLowerCase())) headers.set('vary', `${current}, ${value}`)
}

/** Brotli quality 5 and gzip level 6: most of the saving for little CPU on dynamic responses. */
export function compressBytes(bytes: Uint8Array, encoding: Encoding): Uint8Array {
  return encoding === 'br'
    ? brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } })
    : gzipSync(bytes, { level: 6 })
}

/**
 * Compress `response` for `request` when it helps. Returns the same response
 * when it should go out untouched (wrong type, too small, ranged, already
 * encoded, `no-transform`, or the client accepts no encoding we offer).
 */
export async function compressResponse(request: Request, response: Response): Promise<Response> {
  const status = response.status
  if (request.method === 'HEAD' || !response.body || status < 200 || status === 204 || status === 206 || status === 304) return response
  const headers = response.headers
  if (headers.has('content-encoding') || headers.has('content-range')) return response
  if (!isCompressible(headers.get('content-type'))) return response
  if (/\bno-transform\b/i.test(headers.get('cache-control') ?? '')) return response

  // Caches must keep compressed and plain copies apart, even when this client gets plain.
  addVary(headers, 'Accept-Encoding')
  const declared = headers.get('content-length')
  const length = declared === null ? null : Number(declared)
  if (length !== null && length < MIN_COMPRESS_BYTES) return response
  const buffered = length !== null && length <= MAX_BUFFERED_BYTES
  // Streaming Brotli runs at its slowest setting, so streamed bodies are gzipped.
  const encoding = pickEncoding(request.headers.get('accept-encoding'), buffered ? ['br', 'gzip'] : ['gzip'])
  if (!encoding) return response

  const out = new Headers(headers)
  out.set('content-encoding', encoding)
  out.delete('content-length')
  // Byte ranges would refer to the uncompressed file; this copy has none.
  out.delete('accept-ranges')
  const etag = out.get('etag')
  if (etag && !etag.startsWith('W/')) out.set('etag', `W/${etag}`)
  const init = { status, statusText: response.statusText, headers: out }

  if (buffered) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    const compressed = compressBytes(bytes, encoding)
    // Rare, but some text does not shrink; send it plain then.
    if (compressed.length >= bytes.length) return new Response(bytes, { status, statusText: response.statusText, headers })
    out.set('content-length', String(compressed.length))
    return new Response(compressed, init)
  }

  // Unknown or large size: compress as it streams.
  return new Response(response.body.pipeThrough(new CompressionStream('gzip')), init)
}
