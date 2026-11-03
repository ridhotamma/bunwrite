import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  forwardSticky,
  parseStickyMode,
  publicWorkerIndex,
  stickyCookieHeader,
  stickyPortFor,
  stickyTargetFor,
  stickyWorkerFor,
  withStickyCookie,
  type StickyConfig,
} from '~/cluster/sticky'
import { configFromEnv } from '~/config'
import { parseTrustedProxies, rememberClientIp } from '~/lib/client-ip'
import type { SiteSettings } from '~/sites/service'

import { startServer, testSchema, type TestServer } from './helpers'

const servers: Array<{ stop: (force?: boolean) => void }> = []

afterEach(() => {
  for (const server of servers.splice(0)) {
    try {
      server.stop(true)
    } catch {
      /* already stopped */
    }
  }
})

function config(over: Partial<StickyConfig> = {}): StickyConfig {
  return {
    stickySessions: 'cookie',
    stickyPort: 9000,
    stickyHost: '127.0.0.1',
    publicWorkers: 4,
    workers: 4,
    workerIndex: 0,
    publicEndpoint: 'https://example.com/v1',
    ...over,
  }
}

function request(path = '/', init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(`http://site.example.com${path}`, init)
}

describe('sticky configuration', () => {
  test('mode parsing accepts the documented values', () => {
    expect(parseStickyMode(undefined)).toBe('off')
    expect(parseStickyMode('')).toBe('off')
    expect(parseStickyMode('false')).toBe('off')
    expect(parseStickyMode('off')).toBe('off')
    expect(parseStickyMode('ip')).toBe('ip')
    expect(parseStickyMode('ip_hash')).toBe('ip')
    expect(parseStickyMode('cookie')).toBe('cookie')
    expect(parseStickyMode('on')).toBe('cookie')
    expect(parseStickyMode('auto')).toBe('cookie')
    expect(parseStickyMode('nonsense')).toBe('off')
  })

  test('configFromEnv reads STICKY_SESSIONS, STICKY_PORT and STICKY_HOST', () => {
    const parsed = configFromEnv({ PORT: '8080', STICKY_SESSIONS: 'ip', STICKY_PORT: '9100', STICKY_HOST: '0.0.0.0' })
    expect(parsed.stickySessions).toBe('ip')
    expect(parsed.stickyPort).toBe(9100)
    expect(parsed.stickyHost).toBe('0.0.0.0')
    expect(configFromEnv({ PORT: '8080' }).stickySessions).toBe('off')
    expect(configFromEnv({ PORT: '8080' }).stickyPort).toBe(8280)
    expect(configFromEnv({ PORT: '8080', STICKY_SESSIONS: 'on' }).stickySessions).toBe('cookie')
  })

  test('public worker indices ignore the writer processes', () => {
    expect(publicWorkerIndex({ ...config(), workers: 4, publicWorkers: 4, workerIndex: 0 })).toBe(0)
    expect(publicWorkerIndex({ ...config(), workers: 6, publicWorkers: 4, workerIndex: 2 })).toBe(0)
    expect(publicWorkerIndex({ ...config(), workers: 6, publicWorkers: 4, workerIndex: 5 })).toBe(3)
    expect(stickyPortFor(config({ stickyPort: 9100 }), 3)).toBe(9103)
  })
})

describe('sticky target selection', () => {
  test('a valid cookie wins in cookie mode, but not in ip mode', () => {
    const host = 'site.example.com'
    expect(stickyWorkerFor(host, '203.0.113.5', '2', 4, 'cookie')).toBe(2)
    expect(stickyWorkerFor(host, '203.0.113.5', '99', 4, 'cookie')).not.toBe(99)
    expect(stickyWorkerFor(host, '203.0.113.5', '2', 4, 'ip')).toBe(stickyWorkerFor(host, '203.0.113.5', undefined, 4, 'ip'))
    expect(stickyWorkerFor(host, '203.0.113.5', undefined, 1, 'cookie')).toBeUndefined()
    expect(stickyWorkerFor(host, '203.0.113.5', undefined, 4, 'off')).toBeUndefined()
  })

  test('ip plus host hashing is stable and in range', () => {
    for (const ip of ['203.0.113.5', '2001:db8::1', '198.51.100.9']) {
      const first = stickyWorkerFor('site.example.com', ip, undefined, 8, 'ip')
      expect(first).toBeGreaterThanOrEqual(0)
      expect(first).toBeLessThan(8)
      expect(stickyWorkerFor('site.example.com', ip, undefined, 8, 'ip')).toBe(first)
    }
  })

  test('stickyTargetFor uses the forwarded client ip and ignores WebSocket upgrades', () => {
    const req = request('/', {
      headers: {
        'x-forwarded-for': '203.0.113.5',
        cookie: 'bw_sticky=2; other=1',
      },
    })
    rememberClientIp(req, '127.0.0.1', parseTrustedProxies('private'))
    expect(stickyTargetFor(req, config())).toBe(2)

    const ipOnly = request('/', { headers: { 'x-forwarded-for': '203.0.113.5', cookie: 'bw_sticky=2' } })
    rememberClientIp(ipOnly, '127.0.0.1', parseTrustedProxies('private'))
    expect(stickyTargetFor(ipOnly, config({ stickySessions: 'ip' }))).toBe(stickyWorkerFor('site.example.com', '203.0.113.5', undefined, 4, 'ip'))

    const upgrade = request('/', {
      headers: { 'x-forwarded-for': '203.0.113.5', upgrade: 'websocket', cookie: 'bw_sticky=2' },
    })
    rememberClientIp(upgrade, '127.0.0.1', parseTrustedProxies('private'))
    expect(stickyTargetFor(upgrade, config())).toBeUndefined()
  })
})

describe('sticky cookie', () => {
  test('adds the affinity cookie without dropping the app cookie', async () => {
    const response = new Response('ok', { headers: { 'set-cookie': 'app=1; Path=/' } })
    const pinned = withStickyCookie(response, config(), 2)
    expect(await pinned.text()).toBe('ok')
    expect(pinned.headers.getSetCookie()).toHaveLength(2)
    expect(pinned.headers.getSetCookie().join('\n')).toContain('app=1; Path=/')
    expect(pinned.headers.getSetCookie().join('\n')).toContain('bw_sticky=2')
    expect(stickyCookieHeader(config(), 2)).toContain('Secure')
    expect(stickyCookieHeader(config({ publicEndpoint: 'http://localhost/v1' }), 2)).not.toContain('Secure')
  })

  test('ip mode does not add a cookie', () => {
    const response = new Response('ok')
    expect(withStickyCookie(response, config({ stickySessions: 'ip' }), 2)).toBe(response)
  })
})

describe('loopback forwarding', () => {
  test('streams method, body, headers and cookies to the target worker', async () => {
    let seen: Record<string, string> = {}
    const target = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        seen = {
          method: req.method,
          path: url.pathname,
          search: url.search,
          host: req.headers.get('x-forwarded-host') ?? '',
          proto: req.headers.get('x-forwarded-proto') ?? '',
          cookie: req.headers.get('cookie') ?? '',
          body: req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text(),
        }
        return Response.json(seen, { headers: { 'set-cookie': 'app=1; Path=/' } })
      },
    })
    servers.push(target)

    const req = request('/hello?x=1', {
      method: 'POST',
      headers: { cookie: 'a=1', 'content-type': 'text/plain' },
      body: 'payload',
    })
    const response = await forwardSticky(config({ stickyPort: target.port!, stickyHost: '127.0.0.1' }), req, 'site.example.com', 0)

    expect(response).not.toBeNull()
    expect(response!.status).toBe(200)
    expect(await response!.json()).toEqual({
      method: 'POST',
      path: '/hello',
      search: '?x=1',
      host: 'site.example.com',
      proto: 'http',
      cookie: 'a=1',
      body: 'payload',
    })
    expect(response!.headers.getSetCookie().join('\n')).toContain('app=1; Path=/')
  })

  test('preserves a streaming response', async () => {
    const encoder = new TextEncoder()
    const target = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('one'))
              controller.enqueue(encoder.encode('two'))
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/plain', 'set-cookie': 'app=1; Path=/' } },
        )
      },
    })
    servers.push(target)

    const response = await forwardSticky(config({ stickyPort: target.port!, stickyHost: '127.0.0.1' }), request('/stream'), 'site.example.com', 0)
    expect(response).not.toBeNull()
    expect(await response!.text()).toBe('onetwo')
    expect(response!.headers.getSetCookie().join('\n')).toContain('app=1; Path=/')
  })

  test('returns null for WebSocket upgrades and unavailable targets', async () => {
    const upgrade = request('/', { headers: { upgrade: 'websocket' } })
    expect(await forwardSticky(config(), upgrade, 'site.example.com', 0)).toBeNull()

    const unavailable = config({ stickyPort: 1, stickyHost: '127.0.0.1' })
    expect(await forwardSticky(unavailable, request('/'), 'site.example.com', 0)).toBeNull()
  })
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until<T>(what: string, fn: () => T | Promise<T>, ok: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await sleep(50)
  }
}

function archive(dir: string, files: Record<string, string>): Blob {
  const src = mkdtempSync(join(dir, 'src-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(src, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  const out = join(src, `../${Math.random().toString(36).slice(2)}.tar.gz`)
  const tar = Bun.spawnSync(['tar', '-czf', out, '-C', src, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString())
  return new Blob([readFileSync(out)], { type: 'application/gzip' })
}

function siteSettings(): SiteSettings {
  return {
    name: 'Sticky',
    enabled: true,
    framework: 'other',
    outputDirectory: '',
    fallbackFile: '',
    domains: [],
    apiFunctionId: '',
    installCommand: '',
    buildCommand: '',
    startCommand: 'bun server.js',
    buildRuntime: '',
    adapter: 'ssr',
    pruneMode: 'auto',
  }
}

describe('sticky routing through the app', () => {
  test('SSE-style requests from two public workers reach one SSR process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunwrite-sticky-'))
    const dbPath = join(dir, 'bunwrite.sqlite')
    // Keep the private sticky ports out of the OS ephemeral range, which is
    // where the public test servers bind when they ask for port 0.
    let base = 18_000
    for (; base < 19_000; base += 2) {
      try {
        const one = Bun.serve({ hostname: '127.0.0.1', port: base, fetch: () => new Response(null) })
        const two = Bun.serve({ hostname: '127.0.0.1', port: base + 1, fetch: () => new Response(null) })
        one.stop(true)
        two.stop(true)
        break
      } catch {
        /* busy; try the next pair */
      }
    }

    let a: TestServer | undefined
    let b: TestServer | undefined
    let stickyA: ReturnType<typeof Bun.serve> | undefined
    let stickyB: ReturnType<typeof Bun.serve> | undefined

    try {
      const shared = {
        workers: 2,
        publicWorkers: 2,
        workerPorts: false,
        stickySessions: 'cookie' as const,
        stickyPort: base,
        stickyHost: '127.0.0.1',
        instanceKey: 'sticky-test',
        sitesSsrIdleMs: 0,
        sitesSsrMaxProcesses: 2,
      }
      a = startServer(testSchema, { ...shared, workerIndex: 0 }, dir, {}, dbPath)
      b = startServer(testSchema, { ...shared, workerIndex: 1 }, dir, {}, dbPath)

      stickyA = Bun.serve({
        hostname: '127.0.0.1',
        port: base,
        fetch: a.app.fetchLocal,
        websocket: a.app.websocket,
        idleTimeout: 30,
      })
      stickyB = Bun.serve({
        hostname: '127.0.0.1',
        port: base + 1,
        fetch: b.app.fetchLocal,
        websocket: b.app.websocket,
        idleTimeout: 30,
      })

      await a.services.sites.create('sticky', siteSettings())
      const upload = await a.services.sites.upload(a.services.sites.site('sticky'), {
        code: archive(dir, {
          'server.js': `let count = 0
Bun.serve({
  hostname: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT),
  fetch() {
    count += 1
    return Response.json({ pid: process.pid, count })
  },
})`,
        }),
        activate: true,
        contentRange: null,
        uploadId: null,
      })
      const deployment = await until(
        'sticky deployment',
        () => a!.services.sites.deployment('sticky', upload.id),
        (value) => value.status === 'ready' || value.status === 'failed',
      )
      expect(deployment.status).toBe('ready')

      const hit = async (port: number, ip: string, cookie?: string) => {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          headers: {
            host: 'sticky.sites.localhost',
            'x-forwarded-for': ip,
            ...(cookie ? { cookie } : {}),
          },
          redirect: 'manual',
        })
        const setCookie = [...res.headers]
          .filter(([name]) => name.toLowerCase() === 'set-cookie')
          .map(([, value]) => value)
          .join('; ')
        const body = (await res.json()) as { pid: number; count: number }
        return { res, body, cookie: setCookie }
      }

      const first = await hit(a.config.port, '203.0.113.5')
      expect(first.res.status).toBe(200)
      expect(first.body.count).toBe(1)
      const pinned = /bw_sticky=(\d+)/.exec(first.cookie)?.[1]
      expect(pinned).toBeDefined()

      // A second request through the other public worker, with no cookie,
      // must fall back to the same IP hash and reach the same SSR process.
      const second = await hit(b.config.port, '203.0.113.5')
      expect(second.body.pid).toBe(first.body.pid)
      expect(second.body.count).toBe(2)

      // The cookie wins even when the client IP changes.
      const third = await hit(a.config.port, '198.51.100.7', `bw_sticky=${pinned}`)
      expect(third.body.pid).toBe(first.body.pid)
      expect(third.body.count).toBe(3)

      const fourth = await hit(b.config.port, '198.51.100.7', `bw_sticky=${pinned}`)
      expect(fourth.body.pid).toBe(first.body.pid)
      expect(fourth.body.count).toBe(4)

      // Only the target worker started an SSR app; the other forwarded.
      expect(a.services.sites.ssr.running('sticky') + b.services.sites.ssr.running('sticky')).toBe(1)
    } finally {
      stickyA?.stop(true)
      stickyB?.stop(true)
      try {
        await a?.services.sites.remove('sticky')
      } catch {
        /* already removed */
      }
      for (const server of [a, b]) {
        if (!server) continue
        server.stop()
        server.services.realtime.stop()
        server.services.sites.stop()
        await server.services.writes.drain()
        await server.services.requestLogs.flush()
        await server.services.observability.close()
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
