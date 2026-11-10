/** Cross-origin requests, including htmx clients on another domain. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { adminClient, PROJECT, startServer, type TestServer } from './helpers'

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

  test('a wildcard origin permits non-credentialed reads only', async () => {
    await server.services.settings.set('project', {
      projectName: 'Test Project',
      allowedOrigins: ['*'],
      sessionDuration: 31_536_000,
      sessionsLimit: 10,
    })
    const origin = 'https://anywhere.test'

    const preflight = await fetch(`${server.endpoint}/health`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'GET' },
    })
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull()

    const response = await fetch(`${server.endpoint}/health`, { headers: { origin } })
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()

    await server.services.settings.set('project', {
      projectName: 'Test Project',
      allowedOrigins: ['*.example.com', 'localhost'],
      sessionDuration: 31_536_000,
      sessionsLimit: 10,
    })
  })

  test('preflight allows the API auth headers an external SPA sends', async () => {
    const res = await fetch(`${server.endpoint}/health`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, x-appwrite-project, x-appwrite-key, x-appwrite-jwt, x-bunwrite-project, x-bunwrite-key',
      },
    })
    const allowed = res.headers.get('access-control-allow-headers')!.toLowerCase()
    for (const header of ['authorization', 'x-appwrite-project', 'x-appwrite-key', 'x-appwrite-jwt', 'x-bunwrite-project', 'x-bunwrite-key']) {
      expect(allowed).toContain(header)
    }
  })

  test('an allowed external origin can make a state-changing request', async () => {
    const res = await fetch(`${server.endpoint}/account/sessions/email`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'X-Appwrite-Project': PROJECT },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password' }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  test('an untrusted external origin is refused on state-changing requests', async () => {
    const res = await fetch(`${server.endpoint}/account/sessions/email`, {
      method: 'POST',
      headers: { origin: 'https://evil.test', 'content-type': 'application/json', 'X-Appwrite-Project': PROJECT },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password' }),
    })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { type?: string }).type).toBe('general_unauthorized_scope')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('the session cookie is host-only and switches SameSite for HTTPS APIs', async () => {
    const admin = adminClient(server.endpoint)
    await admin.users.create({
      userId: 'cookie-matrix-user',
      email: 'cookie-matrix@example.com',
      password: 'correct horse',
      name: 'Cookie Matrix',
    })

    const login = () =>
      fetch(`${server.endpoint}/account/sessions/email`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', 'X-Appwrite-Project': PROJECT },
        body: JSON.stringify({ email: 'cookie-matrix@example.com', password: 'correct horse' }),
      })

    const http = await login()
    const httpCookie = http.headers.get('set-cookie')!
    expect(httpCookie).toContain('HttpOnly')
    expect(httpCookie).toContain('Path=/')
    expect(httpCookie).toContain('SameSite=Lax')
    expect(httpCookie).not.toContain('Secure')
    expect(httpCookie.toLowerCase()).not.toContain('domain=')

    const previous = server.config.publicEndpoint
    server.config.publicEndpoint = 'https://api.example.com/v1'
    try {
      const https = await login()
      const httpsCookie = https.headers.get('set-cookie')!
      expect(httpsCookie).toContain('HttpOnly')
      expect(httpsCookie).toContain('Path=/')
      expect(httpsCookie).toContain('SameSite=None')
      expect(httpsCookie).toContain('Secure')
      expect(httpsCookie.toLowerCase()).not.toContain('domain=')
    } finally {
      server.config.publicEndpoint = previous
    }
  })
})
