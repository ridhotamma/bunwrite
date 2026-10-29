/**
 * The built-in job queue: enqueue, claim with a lease, ack/fail, retries,
 * idempotency, and the SDK worker helper.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { BunwriteException, Client, createQueueWorker, Query, Queue } from '../packages/sdk/src'
import { KEY, PROJECT, startServer, type TestServer } from './helpers'

let server: TestServer
const client = () => new Client().setEndpoint(server.endpoint).setProject(PROJECT).setKey(KEY)
const queue = () => new Queue(client())
const guest = () => new Queue(new Client().setEndpoint(server.endpoint).setProject(PROJECT))

beforeAll(() => {
  server = startServer()
})

afterAll(() => server.stop())

describe('queue', () => {
  test('a message is enqueued, claimed, then acked', async () => {
    const created = await queue().createMessage({ queue: 'email', data: { to: 'a@example.com' } })
    expect(created).toMatchObject({ queue: 'email', status: 'waiting', attempts: 0, data: { to: 'a@example.com' } })

    const { messages } = await queue().claimMessages({ queue: 'email', count: 5, lease: 60 })
    expect(messages.map((m) => m.$id)).toEqual([created.$id])
    expect(messages[0]).toMatchObject({ status: 'processing', attempts: 1 })
    expect(messages[0]!.leaseUntil).toBeTruthy()

    const done = await queue().ackMessage({ queue: 'email', messageId: created.$id, result: { sent: true } })
    expect(done.status).toBe('completed')
    expect(done.result).toBe('{"sent":true}')
    expect(done.leaseUntil).toBeNull()

    // Nothing left to claim.
    expect((await queue().claimMessages({ queue: 'email' })).messages).toEqual([])
    expect(await queue().getStats({ queue: 'email' })).toMatchObject({ waiting: 0, processing: 0, completed: 1, failed: 0, total: 1 })
  })

  test('a delayed message is not claimable until its time', async () => {
    const delayed = await queue().createMessage({ queue: 'delayed', data: 'later', delay: 3600 })
    expect(delayed.status).toBe('waiting')
    expect((await queue().claimMessages({ queue: 'delayed' })).messages).toEqual([])

    // Move it into the past, as if an hour had passed.
    server.db.sqlite.query('UPDATE _queue_messages SET available_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000+00:00', delayed.$id)
    const { messages } = await queue().claimMessages({ queue: 'delayed' })
    expect(messages.map((m) => m.data)).toEqual(['later'])
  })

  test('a failure retries with backoff, then stays failed after maxAttempts', async () => {
    const created = await queue().createMessage({ queue: 'retry', data: 1, maxAttempts: 2 })

    expect((await queue().claimMessages({ queue: 'retry' })).messages).toHaveLength(1)
    const first = await queue().failMessage({ queue: 'retry', messageId: created.$id, error: 'boom' })
    expect(first).toMatchObject({ status: 'waiting', attempts: 1, errors: 'boom' })
    expect((await queue().claimMessages({ queue: 'retry' })).messages).toEqual([])

    // Retry immediately instead of waiting for the backoff.
    server.db.sqlite.query('UPDATE _queue_messages SET available_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000+00:00', created.$id)
    expect((await queue().claimMessages({ queue: 'retry' })).messages).toHaveLength(1)
    const second = await queue().failMessage({ queue: 'retry', messageId: created.$id, error: 'again' })
    expect(second).toMatchObject({ status: 'failed', attempts: 2, errors: 'again' })
    expect(second.completedAt).toBeTruthy()

    // A failed message is never claimed again, and cannot be acked.
    expect((await queue().claimMessages({ queue: 'retry' })).messages).toEqual([])
    expect((await queue().ackMessage({ queue: 'retry', messageId: created.$id }).catch((e) => e)) instanceof BunwriteException).toBe(true)
  })

  test('an expired lease requeues the message; heartbeat keeps it', async () => {
    const created = await queue().createMessage({ queue: 'lease', data: 'x', maxAttempts: 3 })
    const [claimed] = (await queue().claimMessages({ queue: 'lease', lease: 60 })).messages

    // Heartbeat extends the claim.
    const beaten = await queue().heartbeatMessage({ queue: 'lease', messageId: claimed!.$id, lease: 120 })
    expect(Date.parse(beaten.leaseUntil!)).toBeGreaterThan(Date.parse(claimed!.leaseUntil!))

    // Expire it without an ack: the reaper returns it to waiting.
    server.db.sqlite.query('UPDATE _queue_messages SET lease_until = ? WHERE id = ?').run('2000-01-01T00:00:00.000+00:00', created.$id)
    expect(server.services.queue.reap()).toEqual([created.$id])
    expect((await queue().getMessage({ queue: 'lease', messageId: created.$id })).status).toBe('waiting')
    expect((await queue().claimMessages({ queue: 'lease' })).messages[0]!.attempts).toBe(2)
  })

  test('idempotencyKey returns the first message', async () => {
    const first = await queue().createMessage({ queue: 'idem', data: 1, idempotencyKey: 'order-42' })
    const second = await queue().createMessage({ queue: 'idem', data: 2, idempotencyKey: 'order-42' })
    expect(second.$id).toBe(first.$id)
    expect(second.data).toBe(1)
    expect(await queue().getStats({ queue: 'idem' })).toMatchObject({ total: 1 })
  })

  test('lists, pages and purges messages', async () => {
    for (const n of [1, 2, 3]) await queue().createMessage({ queue: 'list', data: n })
    const page = await queue().listMessages({ queue: 'list', queries: [Query.limit(2), Query.orderDesc('$createdAt')] })
    expect(page.total).toBe(3)
    expect(page.messages).toHaveLength(2)

    await queue().deleteMessage({ queue: 'list', messageId: page.messages[0]!.$id })
    expect((await queue().purgeQueue({ queue: 'list' })).deleted).toBe(2)
    expect(await queue().getStats({ queue: 'list' })).toMatchObject({ total: 0 })
  })

  test('needs an API key, and validates arguments', async () => {
    const denied = await guest().createMessage({ queue: 'auth', data: 1 }).catch((e) => e)
    expect(denied).toMatchObject({ code: 401 })
    expect(await queue().createMessage({ queue: 'bad name!', data: 1 }).catch((e) => e)).toMatchObject({ code: 400 })
    expect(await queue().claimMessages({ queue: 'auth', count: 0 }).catch((e) => e)).toMatchObject({ code: 400 })
    await queue().createMessage({ queue: 'auth', id: 'same-id', data: 1 })
    expect(await queue().createMessage({ queue: 'auth', id: 'same-id', data: 2 }).catch((e) => e)).toMatchObject({ code: 400 })
  })

  test('system queues such as _render are not reachable from the API', async () => {
    server.services.queue.enqueue('_render', { data: { secret: true } })
    expect(await queue().claimMessages({ queue: '_render' }).catch((e) => e)).toMatchObject({ code: 400 })
    expect(await queue().listMessages({ queue: '_render' }).catch((e) => e)).toMatchObject({ code: 400 })
    expect(await queue().purgeQueue({ queue: '_render' }).catch((e) => e)).toMatchObject({ code: 400 })
    server.services.queue.purge('_render')
  })

  test('the SDK worker refills a free slot at once instead of waiting for the next poll', async () => {
    for (let n = 0; n < 12; n++) await queue().createMessage({ queue: 'refill', data: n })
    const worker = createQueueWorker<number>(client(), {
      queue: 'refill',
      concurrency: 2,
      // Far longer than the test: only finishing jobs can trigger new claims.
      pollInterval: 10_000,
      handler: async () => Bun.sleep(5),
    })
    worker.start()
    for (let i = 0; i < 100 && (await queue().getStats({ queue: 'refill' })).completed < 12; i++) await Bun.sleep(20)
    await worker.stop()
    expect(await queue().getStats({ queue: 'refill' })).toMatchObject({ completed: 12, waiting: 0, processing: 0 })
  })

  test('the SDK worker processes messages and stops cleanly', async () => {
    for (const n of [1, 2, 3]) await queue().createMessage({ queue: 'worker', data: n })

    const seen: number[] = []
    const worker = createQueueWorker<number>(client(), {
      queue: 'worker',
      concurrency: 2,
      pollInterval: 50,
      handler: async (message) => {
        seen.push(message.data)
        return message.data * 2
      },
    })
    worker.start()
    for (let i = 0; i < 100 && (await queue().getStats({ queue: 'worker' })).completed < 3; i++) await Bun.sleep(20)
    await worker.stop()

    expect(seen.sort()).toEqual([1, 2, 3])
    expect(await queue().getStats({ queue: 'worker' })).toMatchObject({ completed: 3, total: 3 })
    expect((await queue().listMessages({ queue: 'worker' })).messages.map((m) => m.result).sort()).toEqual(['2', '4', '6'])
  })

  test('a throwing handler fails the message', async () => {
    await queue().createMessage({ queue: 'throws', data: 1, maxAttempts: 1 })
    const worker = createQueueWorker(client(), {
      queue: 'throws',
      pollInterval: 50,
      handler: () => {
        throw new Error('nope')
      },
    })
    worker.start()
    for (let i = 0; i < 100 && (await queue().getStats({ queue: 'throws' })).failed < 1; i++) await Bun.sleep(20)
    await worker.stop()
    const [message] = (await queue().listMessages({ queue: 'throws' })).messages
    expect(message).toMatchObject({ status: 'failed', attempts: 1, errors: 'nope' })
  })
})
