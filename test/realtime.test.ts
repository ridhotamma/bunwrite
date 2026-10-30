import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { keyCaller } from '~/auth/caller'
import { adminClient, DB, KEY, PROJECT, startServer, type TestServer } from './helpers'

interface RtMessage {
  type: string
  data?: any
}

interface RtSocket {
  messages: RtMessage[]
  send(message: unknown): void
  waitFor(check: (message: RtMessage) => unknown, timeoutMs?: number): Promise<RtMessage>
  close(): void
}

function realtimeUrl(server: TestServer): string {
  return `${server.endpoint.replace('http', 'ws')}/realtime?project=${PROJECT}`
}

function openSocket(server: TestServer, headers: Record<string, string> = { 'X-Appwrite-Key': KEY }): Promise<RtSocket> {
  const ws = new WebSocket(realtimeUrl(server), { headers } as never)
  const messages: RtMessage[] = []
  ws.onmessage = (event) => {
    try {
      messages.push(JSON.parse(String(event.data)) as RtMessage)
    } catch {
      /* ignore non-JSON */
    }
  }
  const socket: RtSocket = {
    messages,
    send: (message) => ws.send(JSON.stringify(message)),
    waitFor: (check, timeoutMs = 3000) =>
      new Promise<RtMessage>((resolve, reject) => {
        const started = Date.now()
        const timer = setInterval(() => {
          const found = messages.find((message) => Boolean(check(message)))
          if (found) {
            clearInterval(timer)
            resolve(found)
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(timer)
            reject(new Error('timed out waiting for a realtime message'))
          }
        }, 10)
      }),
    close: () => ws.close(),
  }
  return new Promise<RtSocket>((resolve, reject) => {
    ws.onopen = () => resolve(socket)
    ws.onerror = () => reject(new Error('websocket failed to open'))
  })
}

async function subscribe(socket: RtSocket, channels: string[], subscriptionId = 'sub-1'): Promise<void> {
  await socket.waitFor((message) => (message.type === 'connected' ? message : undefined))
  socket.send({ type: 'subscribe', data: [{ subscriptionId, channels }] })
  await socket.waitFor((message) => (message.type === 'response' && message.data?.to === 'subscribe' ? message : undefined))
}

const PRODUCT_CHANNEL = `databases.${DB}.collections.products.documents`
const NOTE_CHANNEL = `databases.${DB}.collections.notes.documents`

describe('Realtime', () => {
  let server: TestServer
  let admin: ReturnType<typeof adminClient>
  beforeAll(() => {
    server = startServer()
    admin = adminClient(server.endpoint)
  })
  afterAll(() => server.stop())

  test('delivers a create event to a matching subscriber', async () => {
    const socket = await openSocket(server)
    try {
      await subscribe(socket, [PRODUCT_CHANNEL])
      await admin.databases.createDocument(DB, 'products', 'rt-create', { tenantId: 't1', name: 'Realtime product' })
      const event = await socket.waitFor((message) =>
        message.type === 'event' && message.data?.payload?.$id === 'rt-create' ? message : undefined,
      )
      expect(event.data.channels).toContain(PRODUCT_CHANNEL)
      expect(event.data.subscriptions).toContain('sub-1')
      expect(event.data.events).toContain(`databases.${DB}.collections.products.documents.rt-create.create`)
    } finally {
      socket.close()
    }
  })

  test('does not send unrelated events or events after unsubscribe', async () => {
    const socket = await openSocket(server)
    try {
      await subscribe(socket, [NOTE_CHANNEL], 'notes')
      await admin.databases.createDocument(DB, 'products', 'rt-unrelated', { tenantId: 't1', name: 'Unrelated' })
      await Bun.sleep(300)
      expect(socket.messages.filter((message) => message.type === 'event')).toHaveLength(0)

      socket.send({ type: 'unsubscribe', data: [{ subscriptionId: 'notes' }] })
      await socket.waitFor((message) => (message.type === 'response' && message.data?.to === 'unsubscribe' ? message : undefined))
      await admin.databases.createDocument(DB, 'notes', 'rt-after-unsub', { text: 'not subscribed' })
      await Bun.sleep(300)
      expect(socket.messages.filter((message) => message.type === 'event')).toHaveLength(0)
    } finally {
      socket.close()
    }
  })

  test('filters events by collection read permission', async () => {
    // Products use document security with no grants, so a guest must not see them.
    const guest = await openSocket(server, {})
    try {
      await subscribe(guest, [PRODUCT_CHANNEL])
      await admin.databases.createDocument(DB, 'products', 'rt-private', { tenantId: 't1', name: 'Private' })
      await Bun.sleep(300)
      expect(guest.messages.filter((message) => message.type === 'event')).toHaveLength(0)
    } finally {
      guest.close()
    }
  })

  test('rejects a subscription with too many channels', async () => {
    const socket = await openSocket(server)
    try {
      await socket.waitFor((message) => (message.type === 'connected' ? message : undefined))
      socket.send({
        type: 'subscribe',
        data: [{ subscriptionId: 'too-big', channels: Array.from({ length: 1001 }, (_, index) => `channel-${index}`) }],
      })
      const error = await socket.waitFor((message) => (message.type === 'error' ? message : undefined))
      expect(error.data).toMatchObject({ code: 1008 })
    } finally {
      socket.close()
    }
  })

  test('a socket without subscriptions receives nothing', async () => {
    const socket = await openSocket(server)
    try {
      await socket.waitFor((message) => (message.type === 'connected' ? message : undefined))
      await admin.databases.createDocument(DB, 'products', 'rt-no-sub', { tenantId: 't1', name: 'No subscription' })
      await Bun.sleep(300)
      expect(socket.messages.filter((message) => message.type === 'event')).toHaveLength(0)
    } finally {
      socket.close()
    }
  })

  test('publish is decoupled from the request path', async () => {
    const received: RtMessage[] = []
    const socket = {
      data: {
        caller: keyCaller(),
        subscriptions: new Map([['sub-1', [PRODUCT_CHANNEL]]]),
        projectId: PROJECT,
      },
      readyState: 1,
      send: (text: string) => {
        received.push(JSON.parse(text) as RtMessage)
      },
    } as never
    server.services.realtime.open(socket)
    try {
      const collection = server.services.registry.collection(DB, 'products', true)
      server.services.realtime.publish([{ collection, action: 'create', document: { $id: 'rt-async', $permissions: [] } }])
      // The HTTP response path must not wait for fan-out.
      expect(received.filter((message) => message.type === 'event')).toHaveLength(0)
      await Bun.sleep(30)
      expect(received.filter((message) => message.type === 'event')).toHaveLength(1)
    } finally {
      server.services.realtime.close(socket)
    }
  })
})
