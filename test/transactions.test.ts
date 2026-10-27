import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Query } from 'node-appwrite'

import { adminClient, DB, failure, startServer, type TestServer } from './helpers'

let server: TestServer
let db: ReturnType<typeof adminClient>['databases']
const base = { databaseId: DB, collectionId: 'products' }
const product = (over: Record<string, unknown> = {}) => ({ tenantId: 'tx', name: 'Item', ...over })

beforeAll(() => {
  server = startServer()
  db = adminClient(server.endpoint).databases
})
afterAll(() => server.stop())

describe('transactions', () => {
  test('create returns the Appwrite model', async () => {
    const tx = await db.createTransaction({ ttl: 120 })
    expect(Object.keys(tx)).toEqual(['$id', '$createdAt', '$updatedAt', 'status', 'operations', 'expiresAt'])
    expect(tx.status).toBe('pending')
    expect(tx.operations).toBe(0)
    const bad = await failure(db.createTransaction({ ttl: 10 }))
    expect(bad.code).toBe(400)
  })

  test('staged writes are invisible until commit, but visible inside the transaction', async () => {
    await db.createDocument({ ...base, documentId: 'stock1', data: product({ price: 10 }) })
    const tx = await db.createTransaction()
    const staged = await db.createDocument({ ...base, documentId: 'new1', data: product({ price: 1 }), transactionId: tx.$id })
    expect(staged.$id).toBe('new1')
    expect(staged.$sequence).toBe('')
    const update = await db.updateDocument({ ...base, documentId: 'stock1', data: { price: 9 }, transactionId: tx.$id })
    expect(update.price).toBe(9)
    expect(update.name).toBe('Item')
    await db.incrementDocumentAttribute({ ...base, documentId: 'stock1', attribute: 'price', value: 5, transactionId: tx.$id })

    expect((await failure(db.getDocument({ ...base, documentId: 'new1' }))).code).toBe(404)
    expect((await db.getDocument({ ...base, documentId: 'stock1' })).price).toBe(10)

    expect((await db.getDocument({ ...base, documentId: 'stock1', transactionId: tx.$id })).price).toBe(14)
    const inside = await db.listDocuments({ ...base, queries: [Query.equal('tenantId', 'tx')], transactionId: tx.$id })
    expect(inside.documents.map((d: any) => d.$id).sort()).toEqual(['new1', 'stock1'])

    expect((await db.getTransaction({ transactionId: tx.$id })).operations).toBe(3)
    const done = await db.updateTransaction({ transactionId: tx.$id, commit: true })
    expect(done.status).toBe('committed')
    expect((await db.getDocument({ ...base, documentId: 'stock1' })).price).toBe(14)
    expect((await db.getDocument({ ...base, documentId: 'new1' })).price).toBe(1)
  })

  test('a document changed after staging makes commit fail with transaction_conflict', async () => {
    await db.createDocument({ ...base, documentId: 'stock2', data: product({ price: 10 }) })
    const tx = await db.createTransaction()
    await db.createDocument({ ...base, documentId: 'side2', data: product(), transactionId: tx.$id })
    await db.updateDocument({ ...base, documentId: 'stock2', data: { price: 8 }, transactionId: tx.$id })
    await Bun.sleep(3)
    await db.updateDocument({ ...base, documentId: 'stock2', data: { price: 7 } }) // someone else wins the race

    const conflict = await failure(db.updateTransaction({ transactionId: tx.$id, commit: true }))
    expect(conflict).toEqual({
      code: 409,
      type: 'transaction_conflict',
      message: 'The transaction has a conflict. Please resolve the conflict and try again.',
    })
    // Nothing from the transaction landed.
    expect((await db.getDocument({ ...base, documentId: 'stock2' })).price).toBe(7)
    expect((await failure(db.getDocument({ ...base, documentId: 'side2' }))).code).toBe(404)
    expect((await db.getTransaction({ transactionId: tx.$id })).status).toBe('failed')
    // Rolling back an aborted transaction is allowed.
    expect((await db.updateTransaction({ transactionId: tx.$id, rollback: true })).status).toBe('rolledBack')
  })

  test('writes to the same document inside one transaction do not conflict with each other', async () => {
    await db.createDocument({ ...base, documentId: 'stock3', data: product({ price: 10 }) })
    const tx = await db.createTransaction()
    await db.updateDocument({ ...base, documentId: 'stock3', data: { price: 9 }, transactionId: tx.$id })
    await Bun.sleep(3)
    await db.updateDocument({ ...base, documentId: 'stock3', data: { price: 8 }, transactionId: tx.$id })
    await db.updateTransaction({ transactionId: tx.$id, commit: true })
    expect((await db.getDocument({ ...base, documentId: 'stock3' })).price).toBe(8)
  })

  test('rollback discards staged writes', async () => {
    const tx = await db.createTransaction()
    await db.createDocument({ ...base, documentId: 'gone', data: product(), transactionId: tx.$id })
    const rolled = await db.updateTransaction({ transactionId: tx.$id, rollback: true })
    expect(rolled.status).toBe('rolledBack')
    expect((await failure(db.getDocument({ ...base, documentId: 'gone' }))).code).toBe(404)
    const again = await failure(db.updateTransaction({ transactionId: tx.$id, commit: true }))
    expect(again.type).toBe('transaction_not_ready')
  })

  test('staging validates structure and existence up front', async () => {
    const tx = await db.createTransaction()
    const bad = await failure(db.createDocument({ ...base, documentId: 'x1', data: { tenantId: 'tx' }, transactionId: tx.$id }))
    expect(bad.type).toBe('document_invalid_structure')
    const missing = await failure(db.updateDocument({ ...base, documentId: 'nope', data: { price: 1 }, transactionId: tx.$id }))
    expect(missing.type).toBe('document_not_found')
    const unknown = await failure(db.createDocument({ ...base, documentId: 'x2', data: product(), transactionId: 'nope' }))
    expect([unknown.code, unknown.type]).toEqual([404, 'transaction_not_found'])
  })

  test('a unique-index clash at commit is a conflict', async () => {
    const tx = await db.createTransaction()
    await db.createDocument({ ...base, documentId: 'u-a', data: product({ slug: 'same' }), transactionId: tx.$id })
    await db.createDocument({ ...base, documentId: 'u-b', data: product({ slug: 'same' }) })
    const e = await failure(db.updateTransaction({ transactionId: tx.$id, commit: true }))
    expect(e.type).toBe('transaction_conflict')
  })

  test('delete and bulk operations commit together', async () => {
    await db.createDocuments({ ...base, documents: [{ $id: 'k1', ...product({ tenantId: 'bulk-tx' }) }, { $id: 'k2', ...product({ tenantId: 'bulk-tx' }) }] })
    const tx = await db.createTransaction()
    await db.deleteDocument({ ...base, documentId: 'k1', transactionId: tx.$id })
    await db.updateDocuments({ ...base, data: { price: 99 }, queries: [Query.equal('tenantId', 'bulk-tx')], transactionId: tx.$id })
    await db.updateTransaction({ transactionId: tx.$id, commit: true })
    const left = await db.listDocuments({ ...base, queries: [Query.equal('tenantId', 'bulk-tx')] })
    expect(left.documents.map((d: any) => [d.$id, d.price])).toEqual([['k2', 99]])
  })

  test('createOperations stages a batch', async () => {
    const tx = await db.createTransaction()
    const res = await db.createOperations({
      transactionId: tx.$id,
      operations: [
        { action: 'create', databaseId: DB, collectionId: 'products', documentId: 'op1', data: product({ price: 3 }) },
        { action: 'update', databaseId: DB, collectionId: 'products', documentId: 'op1', data: { price: 4 } },
      ],
    })
    expect(res.operations).toBe(2)
    await db.updateTransaction({ transactionId: tx.$id, commit: true })
    expect((await db.getDocument({ ...base, documentId: 'op1' })).price).toBe(4)
  })
})
