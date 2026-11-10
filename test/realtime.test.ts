import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { keyCaller, sessionCaller } from '~/auth/caller'
import { RealtimeHub } from '~/realtime/hub'
import { addMembership, adminClient, DB, KEY, makeUser, PROJECT, startServer, type TestServer } from './helpers'

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

async function publish(
  server: TestServer,
  body: unknown,
  headers: Record<string, string> = { 'X-Appwrite-Key': KEY },
): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${server.endpoint}/realtime/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Appwrite-Project': PROJECT, ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: any = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    /* not JSON */
  }
  return { response, body: parsed }
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

  test('publishes a custom event to a matching public subscriber', async () => {
    const socket = await openSocket(server, {})
    try {
      await subscribe(socket, ['custom.public.news'])
      const { response, body } = await publish(server, {
        channels: ['custom.public.news'],
        events: ['news.created'],
        payload: { title: 'hello' },
      })
      expect(response.status).toBe(200)
      expect(body.channels).toEqual(['custom.public.news'])
      const event = await socket.waitFor((message) =>
        message.type === 'event' && message.data?.payload?.title === 'hello' ? message : undefined,
      )
      expect(event.data.channels).toEqual(['custom.public.news'])
      expect(event.data.events).toEqual(['news.created'])
      expect(event.data.subscriptions).toContain('sub-1')
    } finally {
      socket.close()
    }
  })

  test('custom events are stored and can be replayed after a sequence', async () => {
    const first = await publish(server, {
      channels: ['custom.public.replay'],
      events: ['replay.first'],
      payload: { step: 1 },
    })
    expect(first.response.status).toBe(200)
    expect(first.body.seq).toBeNumber()
    const second = await publish(server, {
      channels: ['custom.public.replay'],
      events: ['replay.second'],
      payload: { step: 2 },
    })
    expect(second.body.seq).toBeGreaterThan(first.body.seq)

    const replay = await fetch(`${server.endpoint}/realtime/events?channels=custom.public.replay&after=${first.body.seq}&limit=10`, {
      headers: { 'X-Appwrite-Project': PROJECT, 'X-Appwrite-Key': KEY },
    })
    expect(replay.status).toBe(200)
    const body = (await replay.json()) as { events: any[] }
    const seqs = body.events.map((event: any) => event.seq)
    expect(seqs).toContain(second.body.seq)
    expect(seqs).not.toContain(first.body.seq)
    expect(body.events.find((event: any) => event.seq === second.body.seq).payload).toEqual({ step: 2 })
  })

  test('custom history applies the channel ACL', async () => {
    const alice = makeUser(server.db)
    const bob = makeUser(server.db)
    const event = await publish(server, {
      channels: [`custom.user.${alice.id}`],
      events: ['private.event'],
      payload: { secret: true },
    })
    expect(event.response.status).toBe(200)

    const guest = await fetch(`${server.endpoint}/realtime/events?channels=custom.user.${alice.id}`, {
      headers: { 'X-Appwrite-Project': PROJECT },
    })
    expect(((await guest.json()) as { events: any[] }).events).toHaveLength(0)

    const owner = await fetch(`${server.endpoint}/realtime/events?channels=custom.user.${alice.id}`, {
      headers: { 'X-Appwrite-Project': PROJECT, 'X-Appwrite-Session': alice.secret },
    })
    expect(((await owner.json()) as { events: any[] }).events.map((entry: any) => entry.seq)).toContain(event.body.seq)

    const other = await fetch(`${server.endpoint}/realtime/events?channels=custom.user.${alice.id}`, {
      headers: { 'X-Appwrite-Project': PROJECT, 'X-Appwrite-Session': bob.secret },
    })
    expect(((await other.json()) as { events: any[] }).events).toHaveLength(0)
  })

  test('expired custom history is pruned', async () => {
    const stamp = new Date(Date.now() - 120_000).toISOString().replace('Z', '+00:00')
    server.db.sqlite
      .query(
        `INSERT INTO _realtime_custom_events (project_id, channels, events, payload, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(PROJECT, JSON.stringify(['custom.public.expired']), JSON.stringify(['expired.event']), JSON.stringify({ old: true }), stamp, stamp)
    server.services.realtime.pruneBus()
    await Bun.sleep(50)
    const row = server.db.sqlite
      .query<{ one: number }, [string, string]>(
        'SELECT 1 AS one FROM _realtime_custom_events WHERE project_id = ? AND channels = ?',
      )
      .get(PROJECT, JSON.stringify(['custom.public.expired']))
    expect(row).toBeNull()
  })

  test('custom publishing is rate limited per project', async () => {
    const limited = startServer(undefined, { realtimePublishRate: 3 })
    try {
      for (let i = 0; i < 3; i++) {
        const { response } = await publish(limited, { channels: ['custom.public.limit'], payload: { i } })
        expect(response.status).toBe(200)
      }
      const { response, body } = await publish(limited, { channels: ['custom.public.limit'], payload: { i: 4 } })
      expect(response.status).toBe(429)
      expect(body.type).toBe('general_rate_limit_exceeded')
    } finally {
      limited.stop()
    }
  })

  test('only large outgoing events are compressed', async () => {
    const hub = new RealtimeHub(server.db, {
      projectId: PROJECT,
      realtimeEventRetentionSeconds: 0,
      websocketCompression: true,
    })
    const calls: Array<{ text: string; compress?: boolean }> = []
    const socket = {
      data: {
        caller: keyCaller(),
        subscriptions: new Map([['compress', ['custom.public.compress']]]),
        projectId: PROJECT,
      },
      readyState: 1,
      send: (text: string, compress?: boolean) => calls.push({ text, compress }),
    } as never
    hub.open(socket)
    try {
      await hub.publishCustom(['custom.public.compress'], { text: 'x'.repeat(2000) })
      await Bun.sleep(50)
      expect(calls.find((call) => call.text.includes('x'.repeat(20)))?.compress).toBe(true)

      calls.length = 0
      await hub.publishCustom(['custom.public.compress'], { text: 'small' })
      await Bun.sleep(50)
      expect(calls.find((call) => call.text.includes('"small"'))?.compress).toBe(false)
    } finally {
      hub.close(socket)
      hub.stop()
    }
  })

  test('custom publishing requires an API key', async () => {
    const { response } = await publish(server, { channels: ['custom.public.news'], payload: {} }, {})
    expect(response.status).toBe(401)
  })

  test('custom publishing requires the realtime.write scope', async () => {
    const scoped = await server.services.settings.createKey('realtime-reader', null, ['realtime.read'])
    const { response, body } = await publish(
      server,
      { channels: ['custom.public.news'], payload: {} },
      { 'X-Appwrite-Key': scoped.secret },
    )
    expect(response.status).toBe(401)
    expect(body.type).toBe('general_unauthorized_scope')
  })

  test('rejects a custom channel that belongs to another user', async () => {
    const socket = await openSocket(server, {})
    try {
      await socket.waitFor((message) => (message.type === 'connected' ? message : undefined))
      socket.send({ type: 'subscribe', data: [{ subscriptionId: 'x', channels: ['custom.user.someone-else'] }] })
      const error = await socket.waitFor((message) => (message.type === 'error' ? message : undefined))
      expect(error.data).toMatchObject({ code: 1008 })
    } finally {
      socket.close()
    }
  })

  test('custom.user channels keep dots in the user id', async () => {
    const user = makeUser(server.db, 'user.with.dot')
    const socket = await openSocket(server, { 'X-Appwrite-Session': user.secret })
    try {
      await subscribe(socket, ['custom.user.user.with.dot'])
      const { response } = await publish(server, {
        channels: ['custom.user.user.with.dot'],
        payload: { ok: true },
      })
      expect(response.status).toBe(200)
      const event = await socket.waitFor((message) =>
        message.type === 'event' && message.data?.payload?.ok === true ? message : undefined,
      )
      expect(event.data.channels).toEqual(['custom.user.user.with.dot'])
    } finally {
      socket.close()
    }
  })

  test('presence broadcasts create, update and delete to subscribers', async () => {
    const alice = makeUser(server.db)
    const bob = makeUser(server.db)
    const a = await openSocket(server, { 'X-Appwrite-Session': alice.secret })
    const b = await openSocket(server, { 'X-Appwrite-Session': bob.secret })
    try {
      await subscribe(a, ['presences'], 'alice')
      await subscribe(b, ['presences'], 'bob')

      a.send({ type: 'presence', data: { status: 'online', presenceId: 'p1', metadata: { typing: false } } })
      const created = await b.waitFor((message) =>
        message.type === 'event' && message.data?.payload?.$id === 'p1' && message.data?.events?.includes('presences.p1.create')
          ? message
          : undefined,
      )
      expect(created.data.payload).toMatchObject({
        $id: 'p1',
        userId: alice.id,
        status: 'online',
        metadata: { typing: false },
      })

      a.send({ type: 'presence', data: { status: 'typing', presenceId: 'p1' } })
      const updated = await b.waitFor((message) =>
        message.type === 'event' && message.data?.payload?.$id === 'p1' && message.data?.payload?.status === 'typing'
          ? message
          : undefined,
      )
      expect(updated.data.events).toContain('presences.p1.update')

      a.close()
      const deleted = await b.waitFor((message) =>
        message.type === 'event' && message.data?.events?.includes('presences.p1.delete') ? message : undefined,
      )
      expect(deleted.data.payload.$id).toBe('p1')
    } finally {
      a.close()
      b.close()
    }
  })

  test('a late subscriber gets the current presence snapshot', async () => {
    const alice = makeUser(server.db)
    const a = await openSocket(server, { 'X-Appwrite-Session': alice.secret })
    let b: RtSocket | undefined
    try {
      await subscribe(a, ['presences'], 'alice')
      a.send({ type: 'presence', data: { status: 'online', presenceId: 'snap-1' } })
      await a.waitFor((message) => (message.type === 'event' && message.data?.payload?.$id === 'snap-1' ? message : undefined))

      const bob = makeUser(server.db)
      b = await openSocket(server, { 'X-Appwrite-Session': bob.secret })
      await subscribe(b, ['presences'], 'bob')
      const snapshot = await b.waitFor((message) =>
        message.type === 'event' && message.data?.payload?.$id === 'snap-1' ? message : undefined,
      )
      expect(snapshot.data.events).toContain('presences.snap-1.create')
    } finally {
      a.close()
      b?.close()
    }
  })

  test('presence permissions hide a row from other users', async () => {
    const alice = makeUser(server.db)
    const bob = makeUser(server.db)
    const a = await openSocket(server, { 'X-Appwrite-Session': alice.secret })
    const b = await openSocket(server, { 'X-Appwrite-Session': bob.secret })
    try {
      await subscribe(b, ['presences'], 'bob')
      a.send({
        type: 'presence',
        data: { status: 'secret', presenceId: 'private-1', permissions: [`read("user:${alice.id}")`] },
      })
      await Bun.sleep(300)
      expect(b.messages.filter((message) => message.type === 'event' && message.data?.payload?.$id === 'private-1')).toHaveLength(0)
    } finally {
      a.close()
      b.close()
    }
  })

  test('another user cannot take a presence id', async () => {
    const alice = makeUser(server.db)
    const bob = makeUser(server.db)
    const a = await openSocket(server, { 'X-Appwrite-Session': alice.secret })
    const b = await openSocket(server, { 'X-Appwrite-Session': bob.secret })
    try {
      a.send({ type: 'presence', data: { status: 'online', presenceId: 'owned-1' } })
      await a.waitFor((message) => (message.type === 'response' && message.data?.to === 'presence' ? message : undefined))

      b.send({ type: 'presence', data: { status: 'online', presenceId: 'owned-1' } })
      const error = await b.waitFor((message) => (message.type === 'error' ? message : undefined))
      expect(error.data).toMatchObject({ code: 1008 })
    } finally {
      a.close()
      b.close()
    }
  })

  test('presence requires a user session', async () => {
    const socket = await openSocket(server, {})
    try {
      socket.send({ type: 'presence', data: { status: 'online', presenceId: 'guest-1' } })
      const error = await socket.waitFor((message) => (message.type === 'error' ? message : undefined))
      expect(error.data).toMatchObject({ code: 1008 })
    } finally {
      socket.close()
    }
  })

  test('custom events cross workers through the realtime bus', async () => {
    const sender = new RealtimeHub(server.db, { projectId: PROJECT, bus: { projectId: PROJECT, pollMs: 20 } })
    const receiver = new RealtimeHub(server.db, { projectId: PROJECT, bus: { projectId: PROJECT, pollMs: 20 } })
    const received: RtMessage[] = []
    const socket = {
      data: {
        caller: keyCaller(),
        subscriptions: new Map([['bus', ['custom.public.bus']]]),
        projectId: PROJECT,
      },
      readyState: 1,
      send: (text: string) => received.push(JSON.parse(text) as RtMessage),
    } as never
    receiver.open(socket)
    try {
      const published = await sender.publishCustom(['custom.public.bus'], { hello: 'bus' })
      await Bun.sleep(200)
      const event = received.find((message) => message.type === 'event' && message.data?.payload?.hello === 'bus')
      expect(event).toBeDefined()
      expect(event?.data?.seq).toBe(published.seq)
      expect(event?.data?.seq).toBeGreaterThan(0)
    } finally {
      receiver.close(socket)
      sender.stop()
      receiver.stop()
    }
  })

  test('custom channels enforce authenticated, team and label ACLs', async () => {
    const guest = await openSocket(server, {})
    try {
      await guest.waitFor((message) => (message.type === 'connected' ? message : undefined))
      guest.send({ type: 'subscribe', data: [{ subscriptionId: 'g', channels: ['custom.authenticated.news'] }] })
      const error = await guest.waitFor((message) => (message.type === 'error' ? message : undefined))
      expect(error.data).toMatchObject({ code: 1008 })
    } finally {
      guest.close()
    }

    const member = makeUser(server.db)
    addMembership(server.db, 'team-rt', member.id)
    const memberSocket = await openSocket(server, { 'X-Appwrite-Session': member.secret })
    try {
      await subscribe(memberSocket, ['custom.authenticated.news', 'custom.team.team-rt'], 'member')
    } finally {
      memberSocket.close()
    }

    const outsider = makeUser(server.db)
    const outsiderSocket = await openSocket(server, { 'X-Appwrite-Session': outsider.secret })
    try {
      await outsiderSocket.waitFor((message) => (message.type === 'connected' ? message : undefined))
      outsiderSocket.send({ type: 'subscribe', data: [{ subscriptionId: 'o', channels: ['custom.team.team-rt'] }] })
      const error = await outsiderSocket.waitFor((message) => (message.type === 'error' ? message : undefined))
      expect(error.data).toMatchObject({ code: 1008 })
    } finally {
      outsiderSocket.close()
    }

    const staff = makeUser(server.db, 'staff-user', { labels: ['staff'] })
    const staffSocket = await openSocket(server, { 'X-Appwrite-Session': staff.secret })
    try {
      await subscribe(staffSocket, ['custom.label.staff'], 'staff')
    } finally {
      staffSocket.close()
    }
  })

  test('custom publish validates channels, events and payload', async () => {
    const invalid = [
      { channels: [], payload: {} },
      { channels: ['documents'], payload: {} },
      { channels: ['custom.user.'], payload: {} },
      { channels: ['custom.unknown.topic'], payload: {} },
      { channels: ['custom.public.topic'], payload: 'not-an-object' },
      { channels: ['custom.public.topic'], events: [''], payload: {} },
      { channels: Array.from({ length: 101 }, (_, i) => `custom.public.topic-${i}`), payload: {} },
      { channels: ['custom.public.topic'], payload: { big: 'x'.repeat(70 * 1024) } },
    ]
    for (const body of invalid) {
      const { response } = await publish(server, body)
      expect(response.status).toBe(400)
    }

    const duplicates = await publish(server, { channels: ['custom.public.same', 'custom.public.same'], payload: {} })
    expect(duplicates.response.status).toBe(200)
    expect(duplicates.body.channels).toEqual(['custom.public.same'])
    expect(duplicates.body.events).toEqual(['custom.public.same'])
  })

  test('custom channels require realtime.read for API keys', async () => {
    const reader = await server.services.settings.createKey('realtime-custom-reader', null, ['realtime.read'])
    const socket = await openSocket(server, { 'X-Appwrite-Key': reader.secret })
    try {
      await subscribe(socket, ['custom.public.keyed'])
      const { response } = await publish(server, { channels: ['custom.public.keyed'], payload: { via: 'key' } })
      expect(response.status).toBe(200)
      const event = await socket.waitFor((message) =>
        message.type === 'event' && message.data?.payload?.via === 'key' ? message : undefined,
      )
      expect(event.data.subscriptions).toContain('sub-1')
    } finally {
      socket.close()
    }

    const other = await server.services.settings.createKey('realtime-documents-only', null, ['documents.read'])
    const denied = await openSocket(server, { 'X-Appwrite-Key': other.secret })
    try {
      await denied.waitFor((message) => (message.type === 'connected' ? message : undefined))
      denied.send({ type: 'subscribe', data: [{ subscriptionId: 'x', channels: ['custom.public.keyed'] }] })
      const error = await denied.waitFor((message) => (message.type === 'error' ? message : undefined))
      expect(error.data).toMatchObject({ code: 1008 })
    } finally {
      denied.close()
    }
  })

  test('presence validates its payload', async () => {
    const user = makeUser(server.db)
    const socket = await openSocket(server, { 'X-Appwrite-Session': user.secret })
    try {
      const invalid = [
        { status: 'online' },
        { presenceId: 'missing-status' },
        { presenceId: 'x'.repeat(129), status: 'online' },
        { presenceId: 'long-status', status: 'x'.repeat(129) },
        { presenceId: 'bad-metadata', status: 'online', metadata: [] },
        { presenceId: 'big-metadata', status: 'online', metadata: { text: 'x'.repeat(5000) } },
        { presenceId: 'bad-permissions', status: 'online', permissions: ['nope'] },
      ]
      for (const data of invalid) {
        socket.messages.length = 0
        socket.send({ type: 'presence', data })
        const error = await socket.waitFor((message) => (message.type === 'error' ? message : undefined))
        expect(error.data).toMatchObject({ code: 1008 })
      }
    } finally {
      socket.close()
    }

    const keySocket = await openSocket(server)
    try {
      keySocket.send({ type: 'presence', data: { presenceId: 'key-presence', status: 'online' } })
      const error = await keySocket.waitFor((message) => (message.type === 'error' ? message : undefined))
      expect(error.data).toMatchObject({ code: 1008 })
    } finally {
      keySocket.close()
    }
  })

  test('a socket can hold at most ten presences', async () => {
    const user = makeUser(server.db)
    const socket = await openSocket(server, { 'X-Appwrite-Session': user.secret })
    try {
      for (let i = 0; i < 10; i++) {
        socket.messages.length = 0
        socket.send({ type: 'presence', data: { presenceId: `limit-${i}`, status: 'online' } })
        await socket.waitFor((message) => (message.type === 'response' && message.data?.to === 'presence' ? message : undefined))
      }
      socket.messages.length = 0
      socket.send({ type: 'presence', data: { presenceId: 'limit-10', status: 'online' } })
      const error = await socket.waitFor((message) => (message.type === 'error' ? message : undefined))
      expect(error.data).toMatchObject({ code: 1008 })
    } finally {
      socket.close()
    }
  })

  test('a socket is limited in presence updates', async () => {
    const user = makeUser(server.db)
    const socket = await openSocket(server, { 'X-Appwrite-Session': user.secret })
    try {
      for (let i = 0; i < 60; i++) {
        socket.messages.length = 0
        socket.send({ type: 'presence', data: { presenceId: 'presence-rate', status: `status-${i}` } })
        await socket.waitFor((message) => (message.type === 'response' && message.data?.to === 'presence' ? message : undefined))
      }
      socket.messages.length = 0
      socket.send({ type: 'presence', data: { presenceId: 'presence-rate', status: 'too-many' } })
      const error = await socket.waitFor((message) => (message.type === 'error' ? message : undefined))
      expect(error.data.message).toContain('Too many presence updates')
    } finally {
      socket.close()
    }
  })

  test('a socket is disconnected after a WebSocket message flood', async () => {
    const socket = await openSocket(server, {})
    try {
      for (let i = 0; i <= 300; i++) socket.send({ type: 'noop' })
      const error = await socket.waitFor((message) => (message.type === 'error' && message.data?.code === 1008 ? message : undefined))
      expect(error.data.message).toContain('Too many WebSocket messages')
    } finally {
      socket.close()
    }
  })

  test('a client ping extends the presence TTL', async () => {
    const user = makeUser(server.db)
    const socket = await openSocket(server, { 'X-Appwrite-Session': user.secret })
    try {
      socket.send({ type: 'presence', data: { presenceId: 'ttl-1', status: 'online' } })
      await socket.waitFor((message) => (message.type === 'response' && message.data?.to === 'presence' ? message : undefined))
      const first = server.db.sqlite
        .query<{ expires_at: string }, [string, string]>(
          'SELECT expires_at FROM _realtime_presence WHERE project_id = ? AND presence_id = ?',
        )
        .get(PROJECT, 'ttl-1')
      expect(first).not.toBeNull()

      await Bun.sleep(20)
      socket.send({ type: 'ping' })
      await socket.waitFor((message) => (message.type === 'pong' ? message : undefined))
      await Bun.sleep(50)
      const second = server.db.sqlite
        .query<{ expires_at: string }, [string, string]>(
          'SELECT expires_at FROM _realtime_presence WHERE project_id = ? AND presence_id = ?',
        )
        .get(PROJECT, 'ttl-1')
      expect(new Date(second!.expires_at).getTime()).toBeGreaterThan(new Date(first!.expires_at).getTime())
    } finally {
      socket.close()
    }
  })

  test('a presence with read("any") is visible to a guest', async () => {
    const alice = makeUser(server.db)
    const guest = await openSocket(server, {})
    const aliceSocket = await openSocket(server, { 'X-Appwrite-Session': alice.secret })
    try {
      await subscribe(guest, ['presences'], 'guest')
      aliceSocket.send({
        type: 'presence',
        data: { presenceId: 'public-1', status: 'online', permissions: ['read("any")'] },
      })
      const event = await guest.waitFor((message) =>
        message.type === 'event' && message.data?.payload?.$id === 'public-1' ? message : undefined,
      )
      expect(event.data.payload.userId).toBe(alice.id)
    } finally {
      guest.close()
      aliceSocket.close()
    }
  })

  test('presences.<id> only receives that presence', async () => {
    const alice = makeUser(server.db)
    const bob = makeUser(server.db)
    const aliceSocket = await openSocket(server, { 'X-Appwrite-Session': alice.secret })
    const bobSocket = await openSocket(server, { 'X-Appwrite-Session': bob.secret })
    try {
      await subscribe(bobSocket, ['presences.only-1'], 'bob')
      aliceSocket.send({ type: 'presence', data: { presenceId: 'only-1', status: 'online' } })
      aliceSocket.send({ type: 'presence', data: { presenceId: 'only-2', status: 'online' } })
      await bobSocket.waitFor((message) => (message.type === 'event' && message.data?.payload?.$id === 'only-1' ? message : undefined))
      await Bun.sleep(300)
      expect(bobSocket.messages.filter((message) => message.data?.payload?.$id === 'only-2')).toHaveLength(0)
    } finally {
      aliceSocket.close()
      bobSocket.close()
    }
  })

  test('the same user can update a presence from two sockets without an early delete', async () => {
    const alice = makeUser(server.db)
    const bob = makeUser(server.db)
    const first = await openSocket(server, { 'X-Appwrite-Session': alice.secret })
    const second = await openSocket(server, { 'X-Appwrite-Session': alice.secret })
    const watcher = await openSocket(server, { 'X-Appwrite-Session': bob.secret })
    try {
      await subscribe(watcher, ['presences'], 'bob')
      first.send({ type: 'presence', data: { presenceId: 'shared-1', status: 'online' } })
      await first.waitFor((message) => (message.type === 'response' && message.data?.to === 'presence' ? message : undefined))
      second.send({ type: 'presence', data: { presenceId: 'shared-1', status: 'busy' } })
      await second.waitFor((message) => (message.type === 'response' && message.data?.to === 'presence' ? message : undefined))

      watcher.messages.length = 0
      first.close()
      await Bun.sleep(300)
      expect(watcher.messages.filter((message) => message.data?.events?.includes('presences.shared-1.delete'))).toHaveLength(0)

      second.close()
      const deleted = await watcher.waitFor((message) =>
        message.data?.events?.includes('presences.shared-1.delete') ? message : undefined,
      )
      expect(deleted.data.payload.$id).toBe('shared-1')
    } finally {
      first.close()
      second.close()
      watcher.close()
    }
  })

  test('the presence sweep deletes expired rows', async () => {
    const bob = makeUser(server.db)
    const stamp = new Date(Date.now() - 120_000).toISOString().replace('Z', '+00:00')
    server.db.sqlite
      .query(
        `INSERT INTO _realtime_presence
           (project_id, presence_id, user_id, user_internal_id, socket_id, status, metadata, permissions, source, created_at, updated_at, expires_at)
         VALUES (?, 'expired-1', ?, '1', 'gone', 'online', NULL, ?, 'client', ?, ?, ?)`,
      )
      .run(PROJECT, bob.id, JSON.stringify(['read("users")']), stamp, stamp, stamp)

    const watcher = await openSocket(server, { 'X-Appwrite-Session': bob.secret })
    try {
      await subscribe(watcher, ['presences'], 'bob')
      server.services.realtime.pruneBus()
      const deleted = await watcher.waitFor((message) =>
        message.data?.events?.includes('presences.expired-1.delete') ? message : undefined,
      )
      expect(deleted.data.payload.$id).toBe('expired-1')
    } finally {
      watcher.close()
    }
  })

  test('switching accounts clears the previous presence', async () => {
    const alice = makeUser(server.db)
    const carol = makeUser(server.db)
    const bob = makeUser(server.db)
    const aliceSocket = await openSocket(server, { 'X-Appwrite-Session': alice.secret })
    const watcher = await openSocket(server, { 'X-Appwrite-Session': bob.secret })
    try {
      await subscribe(watcher, ['presences'], 'bob')
      aliceSocket.send({ type: 'presence', data: { presenceId: 'switch-1', status: 'online' } })
      await watcher.waitFor((message) => (message.type === 'event' && message.data?.payload?.$id === 'switch-1' ? message : undefined))

      watcher.messages.length = 0
      aliceSocket.send({ type: 'authentication', data: { session: carol.secret } })
      await aliceSocket.waitFor((message) => (message.type === 'response' && message.data?.to === 'authentication' ? message : undefined))
      const deleted = await watcher.waitFor((message) =>
        message.data?.events?.includes('presences.switch-1.delete') ? message : undefined,
      )
      expect(deleted.data.payload.userId).toBe(alice.id)

      aliceSocket.send({ type: 'presence', data: { presenceId: 'switch-2', status: 'online' } })
      const created = await watcher.waitFor((message) =>
        message.data?.events?.includes('presences.switch-2.create') ? message : undefined,
      )
      expect(created.data.payload.userId).toBe(carol.id)
    } finally {
      aliceSocket.close()
      watcher.close()
    }
  })

  test('presence crosses workers through the realtime bus', async () => {
    const alice = makeUser(server.db)
    const caller = await sessionCaller(server.db, alice.secret)
    expect(caller).not.toBeNull()

    const sender = new RealtimeHub(server.db, { projectId: PROJECT, bus: { projectId: PROJECT, pollMs: 20 } })
    const receiver = new RealtimeHub(server.db, { projectId: PROJECT, bus: { projectId: PROJECT, pollMs: 20 } })
    const received: RtMessage[] = []
    const ownerSocket = {
      data: { caller: caller!, subscriptions: new Map(), projectId: PROJECT },
      readyState: 1,
      send: () => {},
    } as never
    const watcherSocket = {
      data: { caller: keyCaller(), subscriptions: new Map([['bus', ['presences']]]), projectId: PROJECT },
      readyState: 1,
      send: (text: string) => received.push(JSON.parse(text) as RtMessage),
    } as never
    sender.open(ownerSocket)
    receiver.open(watcherSocket)
    try {
      await sender.message(ownerSocket, JSON.stringify({ type: 'presence', data: { presenceId: 'bus-presence', status: 'online' } }))
      await Bun.sleep(250)
      const event = received.find(
        (message) => message.type === 'event' && message.data?.payload?.$id === 'bus-presence',
      )
      expect(event?.data.payload.userId).toBe(alice.id)
      expect(event?.data.events).toContain('presences.bus-presence.create')
    } finally {
      sender.close(ownerSocket)
      receiver.close(watcherSocket)
      sender.stop()
      receiver.stop()
    }
  })

  test('legacy document bus rows without kind are still delivered', async () => {
    const hub = new RealtimeHub(server.db, {
      projectId: PROJECT,
      bus: { projectId: PROJECT, pollMs: 20 },
      collectionOf: (databaseId, collectionId) => server.services.registry.collections.get(`${databaseId}/${collectionId}`) ?? null,
    })
    const received: RtMessage[] = []
    const socket = {
      data: {
        caller: keyCaller(),
        subscriptions: new Map([['legacy', [`databases.${DB}.collections.products.documents`]]]),
        projectId: PROJECT,
      },
      readyState: 1,
      send: (text: string) => received.push(JSON.parse(text) as RtMessage),
    } as never
    hub.open(socket)
    try {
      server.db.sqlite
        .query('INSERT INTO _realtime_events (origin, project_id, payload, created_at) VALUES (?, ?, ?, ?)')
        .run(
          'legacy-worker',
          PROJECT,
          JSON.stringify([
            {
              databaseId: DB,
              collectionId: 'products',
              action: 'create',
              document: { $id: 'legacy-1', $permissions: [] },
            },
          ]),
          new Date().toISOString().replace('Z', '+00:00'),
        )
      await Bun.sleep(250)
      expect(received.some((message) => message.type === 'event' && message.data?.payload?.$id === 'legacy-1')).toBe(true)
    } finally {
      hub.close(socket)
      hub.stop()
    }
  })

  test('realtime enforces the Origin allowlist', async () => {
    const allowed = await openSocket(server, { origin: 'https://shop.example.com' })
    try {
      await allowed.waitFor((message) => (message.type === 'connected' ? message : undefined))
    } finally {
      allowed.close()
    }

    const denied = new WebSocket(realtimeUrl(server), { headers: { origin: 'https://evil.test' } } as never)
    const rejected = await Promise.race([
      new Promise<boolean>((resolve) => {
        denied.onopen = () => resolve(false)
        denied.onerror = () => resolve(true)
      }),
      Bun.sleep(2000).then(() => false),
    ])
    denied.close()
    expect(rejected).toBe(true)
  })

  test('a publish burst is handled without taking the server down', async () => {
    const socket = await openSocket(server, {})
    try {
      await subscribe(socket, ['custom.public.flood'], 'flood')
      // Ten batches of 20 concurrent requests. Hundreds of *simultaneous new
      // TCP connections* can overflow the local listen backlog; that is a
      // connection-accept limit, not a rate limit or a fan-out failure.
      for (let batch = 0; batch < 10; batch++) {
        const responses = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            publish(server, { channels: ['custom.public.flood'], payload: { burst: batch * 20 + i } }),
          ),
        )
        expect(responses.every((entry) => entry.response.status === 200)).toBe(true)
      }
      for (let i = 0; i < 40 && socket.messages.filter((message) => message.data?.payload?.burst !== undefined).length < 200; i++) {
        await Bun.sleep(25)
      }
      expect(socket.messages.filter((message) => message.data?.payload?.burst !== undefined)).toHaveLength(200)
      expect((await fetch(`${server.endpoint}/health`)).status).toBe(200)
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

  // Opt-in: waits for the real 60-second TTL and the 30-second sweep timer.
  // Run with BUNWRITE_TEST_SLOW=1 bun test test/realtime.test.ts
  test.skipIf(process.env.BUNWRITE_TEST_SLOW !== '1')(
    'presence expires after the real 60-second TTL',
    async () => {
      const alice = makeUser(server.db)
      const bob = makeUser(server.db)
      const owner = await openSocket(server, { 'X-Appwrite-Session': alice.secret })
      const watcher = await openSocket(server, { 'X-Appwrite-Session': bob.secret })
      try {
        await subscribe(watcher, ['presences'], 'bob')
        owner.send({ type: 'presence', data: { presenceId: 'real-ttl-1', status: 'online' } })
        await watcher.waitFor((message) =>
          message.type === 'event' && message.data?.events?.includes('presences.real-ttl-1.create') ? message : undefined,
        )
        // No pings from here. The row expires at 60s and the sweep runs every
        // 30s, so the delete can arrive on the 90s sweep.
        const deleted = await watcher.waitFor(
          (message) => (message.data?.events?.includes('presences.real-ttl-1.delete') ? message : undefined),
          100_000,
        )
        expect(deleted.data.payload.$id).toBe('real-ttl-1')
      } finally {
        owner.close()
        watcher.close()
      }
    },
    120_000,
  )
})
