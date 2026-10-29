/**
 * Long-lived streamed responses (a function's `res.start()` stream, SSE).
 *
 * Bun closes a connection that sends nothing for `idleTimeout` seconds (10 by
 * default), even mid-response. An LLM can easily pause that long between
 * tokens, so these responses turn the idle timeout off for their request.
 */
const streaming = new WeakSet<Response>()

export function markStreaming(response: Response): Response {
  streaming.add(response)
  return response
}

/** True for a function stream or any `text/event-stream` response. */
export function isStreaming(response: Response): boolean {
  return streaming.has(response) || /^text\/event-stream\b/i.test(response.headers.get('content-type') ?? '')
}
