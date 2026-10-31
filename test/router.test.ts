import { describe, expect, test } from 'bun:test'

import { Router } from '~/lib/router'

const response = () => new Response(null)

describe('router index', () => {
  test('matches static, parameter and wildcard routes', () => {
    const router = new Router<null>()
    router.get('/health', response)
    router.get('/databases/:databaseId/collections/:collectionId/documents/:id', response)
    router.get('/files/*', response)

    expect(router.match('GET', '/health')).toMatchObject({ path: {} })
    expect(router.match('GET', '/health/')).toMatchObject({ path: {} })
    expect(router.match('GET', '/databases/main/collections/products/documents/doc-1')).toMatchObject({
      path: { databaseId: 'main', collectionId: 'products', id: 'doc-1' },
    })
    expect(router.match('GET', '/files/a/b.txt')).toMatchObject({ path: { rest: 'a/b.txt' } })
    expect(router.match('GET', '/missing')).toBeNull()
    expect(router.match('POST', '/health')).toBeNull()
  })

  test('HEAD falls back to GET', () => {
    const router = new Router<null>()
    router.get('/health', response)
    expect(router.match('HEAD', '/health')).toMatchObject({ path: {} })
  })

  test('keeps registration order when a generic route overlaps a static one', () => {
    const generic = () => new Response('generic')
    const exact = () => new Response('exact')

    const first = new Router<null>()
    first.get('/:id', generic)
    first.get('/health', exact)
    // The earlier `/:id` wins, exactly like the previous linear scan.
    expect(first.match('GET', '/health')?.handler).toBe(generic)
    expect(first.match('GET', '/health')?.path).toEqual({ id: 'health' })

    const second = new Router<null>()
    second.get('/health', exact)
    second.get('/:id', generic)
    expect(second.match('GET', '/health')?.handler).toBe(exact)
    expect(second.match('GET', '/health')?.path).toEqual({})
  })

  test('expands ANY routes for every method', () => {
    const router = new Router<null>()
    router.on('ANY', '/functions/:id/http/*', response, { raw: true })
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(router.match(method, '/functions/fn/http/path')).toMatchObject({ raw: true })
    }
  })
})
