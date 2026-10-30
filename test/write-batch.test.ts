import { afterEach, describe, expect, test } from 'bun:test'

import { keyCaller } from '~/auth/caller'
import { openDb, type Db } from '~/db/connection'
import { pushConfig } from '~/schema/push'
import { createServices, type Services } from '~/services'
import { KEY, PROJECT, startServer, testConfig, testSchema, type TestServer } from './helpers'

const databases: Db[] = []
const services: Services[] = []
const servers: TestServer[] = []

function setup(writeBatchMs: number): { services: Services; collection: ReturnType<Services['registry']['collection']> } {
  const db = openDb(':memory:')
  databases.push(db)
  pushConfig(db, testSchema)
  const created = createServices(testConfig({ writeBatchMs }), db)
  services.push(created)
  return { services: created, collection: created.registry.collection('main', 'products', true) }
}

const product = (id: string) => ({ tenantId: 't1', name: `Product ${id}` })

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
  for (const created of services.splice(0)) created.realtime.stop()
  for (const db of databases.splice(0)) {
    try {
      db.sqlite.close()
    } catch {
      /* already closed */
    }
  }
})

describe('write batching', () => {
  test('writes that arrive together share one transaction', async () => {
    const { services, collection } = setup(10)
    const caller = keyCaller()
    const ids = Array.from({ length: 25 }, (_, i) => `batch-${i}`)

    const results = await Promise.all(
      ids.map((id) =>
        services.writes.submit((events) =>
          services.store.createDocumentInTx(caller, collection, { id, data: product(id), permissions: null }, { events }),
        ),
      ),
    )

    expect(services.writes.batches).toBe(1)
    expect(services.writes.writes).toBe(25)
    expect(services.store.countDocuments(caller, collection)).toBe(25)
    // Every request gets exactly its own document and event.
    expect(results.map((result) => result.value.$id).sort()).toEqual([...ids].sort())
    expect(results.every((result) => result.events.length === 1)).toBe(true)
    expect(results.map((result) => result.events[0]!.document.$id).sort()).toEqual([...ids].sort())
  })

  test('one failing write rolls back only itself', async () => {
    const { services, collection } = setup(10)
    const caller = keyCaller()
    await services.store.createDocument(caller, collection, { id: 'taken', data: product('taken'), permissions: null })

    const attempts = ['first', 'taken', 'after'].map((id) =>
      services.writes
        .submit((events) =>
          services.store.createDocumentInTx(caller, collection, { id, data: product(id), permissions: null }, { events }),
        )
        .then((result) => result.value.$id),
    )
    const settled = await Promise.allSettled(attempts)

    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(services.store.countDocuments(caller, collection)).toBe(3)
    expect(services.store.getDocument(caller, collection, 'after').$id).toBe('after')
  })

  test('a duplicate unique index fails alone too', async () => {
    const { services, collection } = setup(10)
    const caller = keyCaller()
    const data = (slug: string) => ({ ...product(slug), slug })

    await services.store.createDocument(caller, collection, { id: 'a', data: data('same'), permissions: null })
    const settled = await Promise.allSettled([
      services.writes.submit((events) =>
        services.store.createDocumentInTx(caller, collection, { id: 'b', data: data('same'), permissions: null }, { events }),
      ),
      services.writes.submit((events) =>
        services.store.createDocumentInTx(caller, collection, { id: 'c', data: data('other'), permissions: null }, { events }),
      ),
    ])

    expect(settled[0]!.status).toBe('rejected')
    expect(settled[1]!.status).toBe('fulfilled')
    expect(services.store.getDocument(caller, collection, 'c').slug).toBe('other')
  })

  test('disable with WRITE_BATCH_MS=0 and still apply each write', async () => {
    const { services, collection } = setup(0)
    const caller = keyCaller()

    expect(services.writes.enabled).toBe(false)
    const result = await services.writes.submit((events) =>
      services.store.createDocumentInTx(caller, collection, { id: 'single', data: product('single'), permissions: null }, { events }),
    )

    expect(result.value.$id).toBe('single')
    expect(result.events).toHaveLength(1)
    expect(services.writes.batches).toBe(1)
  })

  test('drain commits without waiting for the window', async () => {
    const { services, collection } = setup(60_000)
    const caller = keyCaller()

    const pending = services.writes.submit((events) =>
      services.store.createDocumentInTx(caller, collection, { id: 'drained', data: product('drained'), permissions: null }, { events }),
    )
    expect(services.writes.pending).toBe(1)
    services.writes.drain()
    const result = await pending

    expect(result.value.$id).toBe('drained')
    expect(services.store.getDocument(caller, collection, 'drained').$id).toBe('drained')
  })

  test('concurrent HTTP creates share one transaction', async () => {
    const server = startServer(testSchema, { writeBatchMs: 10 })
    servers.push(server)
    const url = `${server.endpoint}/databases/main/collections/products/documents`
    const headers = { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, 'content-type': 'application/json' }

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        fetch(url, { method: 'POST', headers, body: JSON.stringify({ documentId: `http-${i}`, data: product(`http-${i}`) }) }),
      ),
    )

    expect(responses.every((response) => response.status === 201)).toBe(true)
    expect(server.services.writes.batches).toBe(1)
    expect(server.services.writes.writes).toBe(12)
  })
})
