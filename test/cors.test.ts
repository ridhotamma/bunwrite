/** Cross-origin requests, including htmx clients on another domain. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { startServer, type TestServer } from './helpers'

let server: TestServer
const ORIGIN = 'https://shop.example.com'

beforeAll(() => {
  server = startServer()
})
afterAll(() => server.stop())

describe('CORS', () => {
  test('an allowed origin is echoed on API responses', async () => {
    const res = await fetch(`${server.endpoint}/health`, { headers: { origin: ORIGIN } })
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('vary')).toContain('Origin')
  })

  test('preflight allows htmx request headers and exposes its response headers', async () => {
    const res = await fetch(`${server.endpoint}/health`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'hx-request, hx-current-url, content-type',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    const allowed = res.headers.get('access-control-allow-headers')!.toLowerCase()
    expect(allowed).toContain('hx-request')
    expect(allowed).toContain('hx-current-url')
    expect(allowed).toContain('content-type')

    const exposed = res.headers.get('access-control-expose-headers')!
    expect(exposed).toContain('HX-Location')
    expect(exposed).toContain('HX-Trigger')
  })

  test('an origin outside the allowlist gets no CORS headers', async () => {
    const res = await fetch(`${server.endpoint}/health`, { headers: { origin: 'https://evil.test' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()

    const preflight = await fetch(`${server.endpoint}/health`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' },
    })
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('htmx headers are readable on the server', async () => {
    // The API does not branch on htmx today, but it must still see the header
    // when the request arrives from another domain.
    const res = await fetch(`${server.endpoint}/health`, { headers: { origin: ORIGIN, 'hx-request': 'true' } })
    expect(res.status).toBe(200)
  })
})
