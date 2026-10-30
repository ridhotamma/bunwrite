import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { SchemaAdmin } from '~/schema/admin'
import { adminClient, KEY, PROJECT, startServer, type TestServer } from './helpers'

let server: TestServer
let databases: ReturnType<typeof adminClient>['databases']
let base = ''
const headers = () => ({ 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY })

beforeAll(async () => {
  server = startServer()
  databases = adminClient(server.endpoint).databases
  base = `${server.endpoint}/databases/main/collections/products/documents`
  await databases.createDocument({ databaseId: 'main', collectionId: 'products', documentId: 'c1', data: { tenantId: 't', name: 'One' } })
})

afterAll(() => server.stop())

describe('HTTP caching', () => {
  test('lists and point reads carry ETags; a matching If-None-Match is a 304', async () => {
    const list = await fetch(base, { headers: headers() })
    expect(list.status).toBe(200)
    const listEtag = list.headers.get('etag')!
    expect(listEtag).toStartWith('W/"')
    expect(list.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate')

    const cached = await fetch(base, { headers: { ...headers(), 'if-none-match': listEtag } })
    expect(cached.status).toBe(304)
    expect(await cached.text()).toBe('')

    const point = await fetch(`${base}/c1`, { headers: headers() })
    const pointEtag = point.headers.get('etag')!
    expect(pointEtag).toStartWith('W/"')
    expect((await fetch(`${base}/c1`, { headers: { ...headers(), 'if-none-match': pointEtag } })).status).toBe(304)
  })

  test('a write changes the collection version and invalidates both ETags', async () => {
    const listEtag = (await fetch(base, { headers: headers() })).headers.get('etag')!
    const pointEtag = (await fetch(`${base}/c1`, { headers: headers() })).headers.get('etag')!

    await databases.createDocument({ databaseId: 'main', collectionId: 'products', documentId: 'c2', data: { tenantId: 't', name: 'Two' } })

    expect((await fetch(base, { headers: { ...headers(), 'if-none-match': listEtag } })).status).toBe(200)
    expect((await fetch(`${base}/c1`, { headers: { ...headers(), 'if-none-match': pointEtag } })).status).toBe(200)
  })

  test('a collection readable by any may be cached publicly when enabled', async () => {
    server.config.cache.publicMaxAge = 60
    new SchemaAdmin(server.db, server.services.registry).updateCollection('main', 'products', { permissions: ['read("any")'] })

    const guest = await fetch(base, { headers: { 'x-appwrite-project': PROJECT } })
    expect(guest.status).toBe(200)
    expect(guest.headers.get('cache-control')).toBe('public, max-age=60')

    const key = await fetch(base, { headers: headers() })
    expect(key.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate')
  })
})
