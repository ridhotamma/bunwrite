import { describe, expect, test } from 'bun:test'

import { busyResponse, isHealthPath, isRealtimePath, withInflightLimit } from '~/http/load-shed'

const request = (path = '/v1/databases/main/collections/products/documents') => new Request(`http://localhost${path}`)

describe('load shedding', () => {
  test('health paths are always allowed', () => {
    expect(isHealthPath('/v1/health')).toBe(true)
    expect(isHealthPath('/health')).toBe(true)
    expect(isHealthPath('/v1/health/version')).toBe(true)
    expect(isHealthPath('/v1/databases/main/collections/products/documents')).toBe(false)
  })

  test('realtime upgrades are recognised as bypass paths', () => {
    expect(isRealtimePath('/v1/realtime')).toBe(true)
    expect(isRealtimePath('/realtime')).toBe(true)
    expect(isRealtimePath('/v1/databases/main/collections/products/documents')).toBe(false)
  })

  test('realtime upgrades bypass a full REST in-flight cap', async () => {
    let release!: (value: Response) => void
    const pending = new Promise<Response>((resolve) => {
      release = resolve
    })
    const handler = withInflightLimit(
      (request) => (request.url.includes('/realtime') ? new Response('upgraded') : pending),
      1,
    )
    const rest = handler(request())
    const realtime = handler(request('/v1/realtime?project=test-project'))
    expect(realtime).toBeInstanceOf(Response)
    expect((realtime as Response).status).toBe(200)
    release(new Response('ok'))
    await rest
  })

  test('rejects above the limit with a retryable 503 and recovers afterwards', async () => {
    let release!: (value: Response) => void
    const pending = new Promise<Response>((resolve) => {
      release = resolve
    })
    const handler = withInflightLimit(() => pending, 2)

    const first = handler(request())
    const second = handler(request())
    const rejected = handler(request())

    expect(rejected).toBeInstanceOf(Response)
    expect((rejected as Response).status).toBe(503)
    expect((rejected as Response).headers.get('retry-after')).toBe('1')

    release(new Response('ok'))
    await Promise.all([first, second])

    const after = await handler(request())
    expect(after).toBeInstanceOf(Response)
    expect((after as Response).status).toBe(200)
  })

  test('a synchronous handler releases its slot immediately', () => {
    const handler = withInflightLimit(() => new Response('ok'), 1)
    for (let index = 0; index < 5; index++) {
      const response = handler(request())
      expect((response as Response).status).toBe(200)
    }
  })

  test('a throwing handler does not leak a slot', () => {
    let calls = 0
    const handler = withInflightLimit(() => {
      calls++
      throw new Error('boom')
    }, 1)
    expect(() => handler(request())).toThrow('boom')
    expect(() => handler(request())).toThrow('boom')
    expect(calls).toBe(2)
  })

  test('a non-positive limit disables the wrapper', () => {
    const inner = () => new Response('ok')
    expect(withInflightLimit(inner, 0)).toBe(inner)
    expect(busyResponse().status).toBe(503)
  })
})
