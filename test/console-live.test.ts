/** Deployment cards update from server-sent events instead of polling. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { keyCaller } from '~/auth/caller'
import { ConsoleAuth } from '~/console/auth'
import { ConsoleEvents } from '~/realtime/console-events'
import { RealtimeHub } from '~/realtime/hub'
import { KEY, PROJECT, startServer, type TestServer } from './helpers'

let server: TestServer
let base: string
let cookie = ''

const api = (path: string, body: unknown) =>
  fetch(`${server.endpoint}${path}`, {
    method: 'POST',
    headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const get = (path: string, signal?: AbortSignal) => fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual', signal })

/** Read an event stream until `want` shows up, or give up after `ms`. */
async function readUntil(res: Response, want: string, ms = 3000): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + ms
  try {
    while (!text.includes(want) && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)])
      if (!next || next.done) break
      text += decoder.decode(next.value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return text
}

beforeAll(async () => {
  server = startServer()
  base = server.endpoint.replace(/\/v1$/, '')
  const auth = new ConsoleAuth(server.db)
  await auth.upsert('live@example.com', 'console-password')
  cookie = `bunwrite_console=${(await auth.login('live@example.com', 'console-password'))!}; console_project=${PROJECT}`
  expect((await api('/sites', { siteId: 'live-site', name: 'Live site', framework: 'other' })).status).toBe(201)
  expect((await api('/functions', { functionId: 'live-fn', name: 'Live function', runtime: 'node-22' })).status).toBe(201)
})
afterAll(() => server.stop())

describe('console events', () => {
  test('a burst on one topic is coalesced, and the last change always arrives', async () => {
    const events = new ConsoleEvents()
    const seen: unknown[] = []
    const off = events.subscribe('site:a', (data) => seen.push(data.n))
    events.subscribe('site:b', () => seen.push('other topic'))
    for (let n = 1; n <= 20; n++) events.emit('site:a', { n })
    expect(seen).toEqual([1])
    await Bun.sleep(400)
    expect(seen).toEqual([1, 20])
    off()
    events.emit('site:a', { n: 21 })
    expect(seen).toEqual([1, 20])
    events.stop()
  })

  test('events cross workers over the bus and never reach app WebSocket clients', async () => {
    const senderHub = new RealtimeHub(server.db, { projectId: PROJECT, bus: { projectId: PROJECT, pollMs: 20 } })
    const receiverHub = new RealtimeHub(server.db, { projectId: PROJECT, bus: { projectId: PROJECT, pollMs: 20 } })
    const wire = (hub: RealtimeHub) => {
      const events = new ConsoleEvents()
      events.relay = { publish: (topic, data) => hub.publishConsole(topic, data), listeners: (count) => hub.setConsoleListeners(count) }
      hub.onConsole = (event) => events.receive(event.topic, event.data)
      return events
    }
    const sender = wire(senderHub)
    const receiver = wire(receiverHub)
    const socketMessages: unknown[] = []
    const socket = {
      data: { caller: keyCaller(), subscriptions: new Map([['all', ['custom.public.deploys']]]), projectId: PROJECT },
      readyState: 1,
      send: (text: string) => socketMessages.push(JSON.parse(text)),
    } as never
    receiverHub.open(socket)
    const heard: unknown[] = []
    const off = receiver.subscribe('function:live-fn', (data) => heard.push(data))
    try {
      // Let the receiver register as a listener before the sender checks for one.
      await Bun.sleep(60)
      sender.emit('function:live-fn', { deploymentId: 'd1' })
      await Bun.sleep(250)
      expect(heard).toEqual([{ deploymentId: 'd1' }])
      expect(socketMessages.filter((m) => (m as { type: string }).type === 'event')).toEqual([])
    } finally {
      off()
      receiverHub.close(socket)
      sender.stop()
      receiver.stop()
      senderHub.stop()
      receiverHub.stop()
    }
  })
})

describe('console live endpoint', () => {
  test('rejects unknown topics and missing resources', async () => {
    expect((await get('/console/live?topic=user:me')).status).toBe(400)
    expect((await get('/console/live?topic=site:nope')).status).toBe(404)
    expect((await get('/console/live?topic=function:nope')).status).toBe(404)
  })

  test('streams a change when a site deploys', async () => {
    const abort = new AbortController()
    const res = await get('/console/live?topic=site:live-site', abort.signal)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reading = readUntil(res, 'event: changed')
    await Bun.sleep(50)
    const site = server.services.sites.site('live-site')
    const deployment = await server.services.sites.deployFiles(site, [{ path: 'index.html', content: '<h1>Hi</h1>' }], true)
    const text = await reading
    abort.abort()
    expect(text).toContain('retry: 3000')
    expect(text).toContain('event: changed')
    expect(text).toContain(deployment.id)
  })

  test('the deployment cards subscribe instead of polling', async () => {
    const sitePage = await (await get('/console/sites/live-site')).text()
    expect(sitePage).toContain('data-live="site:live-site"')
    expect(sitePage).toContain('hx-trigger="live"')
    expect(sitePage).not.toContain('hx-trigger="every')

    const fnPage = await (await get('/console/functions/live-fn/deployments')).text()
    expect(fnPage).toContain('data-live="function:live-fn"')
    expect(fnPage).not.toContain('hx-trigger="every 2s"')
  })
})
