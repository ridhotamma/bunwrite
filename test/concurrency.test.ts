import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { keyCaller } from '~/auth/caller'
import { openDb, q, type Db } from '~/db/connection'
import { pushConfig } from '~/schema/push'
import { createServices, type Services } from '~/services'
import { KEY, PROJECT, startServer, testConfig, testSchema, type TestServer } from './helpers'

const servers: TestServer[] = []
const services: Services[] = []
const databases: Db[] = []
const dirs: string[] = []

const product = (name = 'Original') => ({ tenantId: 't1', name })

function server(over: Parameters<typeof startServer>[1] = {}): TestServer {
  const created = startServer(testSchema, over)
  servers.push(created)
  return created
}

const auth = { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, 'content-type': 'application/json' }

async function create(srv: TestServer, id = 'doc'): Promise<Record<string, any>> {
  const response = await fetch(`${srv.endpoint}/databases/main/collections/products/documents`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ documentId: id, data: product() }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as Record<string, any>
}

const docUrl = (srv: TestServer, id = 'doc') => `${srv.endpoint}/databases/main/collections/products/documents/${id}`

afterEach(() => {
  for (const srv of servers.splice(0)) srv.stop()
  for (const created of services.splice(0)) created.realtime.stop()
  for (const db of databases.splice(0)) {
    try {
      db.sqlite.close()
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('document revisions', () => {
  test('every document exposes $revision and each write bumps it', async () => {
    const srv = server()
    const created = await create(srv)
    expect(created.$revision).toBe(1)

    const updated = await fetch(docUrl(srv), { method: 'PATCH', headers: auth, body: JSON.stringify({ data: { name: 'Second' } }) })
    expect(updated.status).toBe(200)
    expect(((await updated.json()) as any).$revision).toBe(2)

    const listed = await fetch(`${srv.endpoint}/databases/main/collections/products/documents`, { headers: auth })
    const body = (await listed.json()) as any
    expect(body.documents[0].$revision).toBe(2)
  })

  test('a no-op update leaves the revision alone', async () => {
    const srv = server()
    await create(srv)
    const same = await fetch(docUrl(srv), { method: 'PATCH', headers: auth, body: JSON.stringify({ data: product() }) })
    expect(same.status).toBe(200)
    expect(((await same.json()) as any).$revision).toBe(1)
  })
})

describe('If-Match', () => {
  test('a current revision writes, a stale one conflicts without changing anything', async () => {
    const srv = server()
    await create(srv)

    const stale = await fetch(docUrl(srv), {
      method: 'PATCH',
      headers: { ...auth, 'if-match': '"9"' },
      body: JSON.stringify({ data: { name: 'Stale' } }),
    })
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as any).type).toBe('document_update_conflict')

    const current = await fetch(docUrl(srv), {
      method: 'PATCH',
      headers: { ...auth, 'if-match': '"1"' },
      body: JSON.stringify({ data: { name: 'Fresh' } }),
    })
    expect(current.status).toBe(200)
    const body = (await current.json()) as any
    expect(body.name).toBe('Fresh')
    expect(body.$revision).toBe(2)
  })

  test('$revision inside data is the SDK-friendly form', async () => {
    const srv = server()
    await create(srv)

    const stale = await fetch(docUrl(srv), { method: 'PATCH', headers: auth, body: JSON.stringify({ data: { name: 'Nope', $revision: 4 } }) })
    expect(stale.status).toBe(409)

    const ok = await fetch(docUrl(srv), { method: 'PATCH', headers: auth, body: JSON.stringify({ data: { name: 'Yes', $revision: 1 } }) })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as any).$revision).toBe(2)
  })

  test('concurrent updates at the same revision: exactly one wins', async () => {
    for (const writeBatchMs of [0, 5]) {
      const srv = server({ writeBatchMs })
      await create(srv)

      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          fetch(docUrl(srv), { method: 'PATCH', headers: auth, body: JSON.stringify({ data: { name: `writer-${i}`, $revision: 1 } }) }),
        ),
      )
      const statuses = responses.map((response) => response.status).sort()
      expect(statuses.filter((status) => status === 200)).toHaveLength(1)
      expect(statuses.filter((status) => status === 409)).toHaveLength(9)

      const read = await fetch(docUrl(srv), { headers: auth })
      expect(((await read.json()) as any).$revision).toBe(2)
    }
  })

  test('If-Match "*" only requires existence', async () => {
    const srv = server()
    await create(srv)
    const ok = await fetch(docUrl(srv), { method: 'PATCH', headers: { ...auth, 'if-match': '*' }, body: JSON.stringify({ data: { name: 'Any' } }) })
    expect(ok.status).toBe(200)

    const missing = await fetch(docUrl(srv, 'nope'), { method: 'PATCH', headers: { ...auth, 'if-match': '*' }, body: JSON.stringify({ data: { name: 'Any' } }) })
    expect(missing.status).toBe(404)
  })

  test('delete and increment honour the revision', async () => {
    const srv = server()
    await create(srv)

    const staleDelete = await fetch(docUrl(srv), { method: 'DELETE', headers: { ...auth, 'if-match': '7' } })
    expect(staleDelete.status).toBe(409)

    const increment = await fetch(`${docUrl(srv)}/price/increment?value=5`, {
      method: 'PATCH',
      headers: { ...auth, 'if-match': '1' },
    })
    expect(increment.status).toBe(200)
    expect(((await increment.json()) as any).$revision).toBe(2)

    const staleIncrement = await fetch(`${docUrl(srv)}/price/increment?value=5`, {
      method: 'PATCH',
      headers: { ...auth, 'if-match': '1' },
    })
    expect(staleIncrement.status).toBe(409)

    const del = await fetch(docUrl(srv), { method: 'DELETE', headers: { ...auth, 'if-match': '2' } })
    expect(del.status).toBe(204)
  })

  test('upsert updates only with a matching revision and never creates behind one', async () => {
    const srv = server()
    await create(srv)

    const stale = await fetch(docUrl(srv), { method: 'PUT', headers: auth, body: JSON.stringify({ data: { name: 'Stale', $revision: 5 } }) })
    expect(stale.status).toBe(409)

    const ok = await fetch(docUrl(srv), { method: 'PUT', headers: auth, body: JSON.stringify({ data: { name: 'Updated', $revision: 1 } }) })
    expect(ok.status).toBe(201)
    expect(((await ok.json()) as any).$revision).toBe(2)

    const createBehind = await fetch(docUrl(srv, 'new-doc'), { method: 'PUT', headers: auth, body: JSON.stringify({ data: { tenantId: 't1', name: 'x', $revision: 1 } }) })
    expect(createBehind.status).toBe(409)
    expect(((await createBehind.json()) as any).type).toBe('document_update_conflict')
  })

  test('an invalid precondition is a 400, and transactions reject it', async () => {
    const srv = server()
    await create(srv)

    const invalid = await fetch(docUrl(srv), { method: 'PATCH', headers: { ...auth, 'if-match': 'not-a-revision' }, body: JSON.stringify({ data: { name: 'x' } }) })
    expect(invalid.status).toBe(400)
    expect(((await invalid.json()) as any).type).toBe('general_argument_invalid')

    const tx = await fetch(`${srv.endpoint}/databases/transactions`, { method: 'POST', headers: auth, body: '{}' })
    const transaction = (await tx.json()) as any
    const staged = await fetch(`${docUrl(srv)}?transactionId=${transaction.$id}`, {
      method: 'PATCH',
      headers: { ...auth, 'if-match': '1' },
      body: JSON.stringify({ data: { name: 'x' } }),
    })
    expect(staged.status).toBe(400)
  })
})

describe('upgrading an existing database', () => {
  test('tables created before $revision get the column with revision 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunwrite-rev-'))
    dirs.push(dir)
    const path = join(dir, 'bunwrite.sqlite')

    const first = openDb(path)
    databases.push(first)
    pushConfig(first, testSchema)
    const before = createServices(testConfig({ databasePath: path }), first)
    services.push(before)
    const collection = before.registry.collection('main', 'products', true)
    expect(before.store.createDocument(keyCaller(), collection, { id: 'legacy', data: product(), permissions: null }).$revision).toBe(1)

    // Simulate a table written by a Bunwrite version without revisions.
    first.sqlite.run(`ALTER TABLE ${q(collection.table)} DROP COLUMN _rev`)
    first.sqlite.close()

    const reopened = openDb(path)
    databases.push(reopened)
    const after = createServices(testConfig({ databasePath: path }), reopened)
    services.push(after)
    const upgraded = after.registry.collection('main', 'products', true)
    expect(after.store.getDocument(keyCaller(), upgraded, 'legacy').$revision).toBe(1)
  })
})
