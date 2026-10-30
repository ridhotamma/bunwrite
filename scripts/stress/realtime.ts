/**
 * Realtime WebSocket stress test for Bunwrite.
 *
 * Two phases:
 *   connect  — open many sockets, subscribe to channels, hold them, ping.
 *   fanout   — open N listeners, write M documents over REST, and measure how
 *              many events each socket receives, plus delivery latency and loss.
 *
 * The server speaks the Appwrite realtime protocol:
 *   wss://<host>/v1/realtime?project=<id>
 *   -> { type: 'connected' }
 *   <- { type: 'subscribe', data: [{ subscriptionId, channels }] }
 *   <- { type: 'ping' } / -> { type: 'pong' }
 *   -> { type: 'event', data: { events, channels, payload, ... } }
 *
 * Examples:
 *   export STRESS_API_KEY=...
 *   bun run stress:realtime connect \
 *     --base https://bunwrite.example.com/v1 --project social-media-app \
 *     --connections 100,500,1000 --duration 30
 *   bun run stress:realtime fanout \
 *     --manifest data/stress/social-soc-20261030.json \
 *     --fanout-connections 100,500 --writes 200 --write-concurrency 20
 *
 * This is a development tool. Use it against a disposable project.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  createCli,
  deferred,
  env,
  errorText,
  ms,
  normalizeBase,
  pad,
  pct,
  required,
  sleep,
  stats,
  withTimeout,
  type Deferred,
  type Stats,
} from './lib'

const DEFAULT_DATABASE = 'social_stress'
const DEFAULT_COLLECTION = 'posts'
const DEFAULT_PREFIX = 'soc-20261030'
const DEFAULT_CONNECTIONS = '100,500,1000'
const DEFAULT_FANOUT_CONNECTIONS = '100,500'
const DEFAULT_DURATION = 30
const DEFAULT_PING_INTERVAL = 5
const DEFAULT_WRITES = 200
const DEFAULT_WRITE_CONCURRENCY = 20
const DEFAULT_DELIVERY_TIMEOUT = 30
const DEFAULT_TIMEOUT = 15
const DEFAULT_CONNECT_BATCH = 100
const DEFAULT_CONNECT_DELAY = 0

const argv = process.argv.slice(2)
const command = argv[0] ?? 'all'
if (command === '--help' || command === '-h' || command === 'help') {
  usage()
  process.exit(0)
}
if (!['connect', 'fanout', 'all'].includes(command)) {
  usage()
  process.exit(1)
}
if (argv.includes('--help') || argv.includes('-h')) {
  usage()
  process.exit(0)
}

const { flag, has, integerFlag, levels } = createCli(argv)

/** One Appwrite realtime client with deferred connect/subscribe/ping events. */
class RtClient {
  readonly ws: WebSocket
  connected = false
  subscribed = false
  closed = false
  connectMs = 0
  subscribeMs = 0
  messages = 0
  events = 0
  bytes = 0
  errors: string[] = []
  onEvent?: (data: any, receivedAt: number) => void

  private readonly startedAt = performance.now()
  private readonly timeoutMs: number
  private readonly channels: string[]
  private readonly subscriptionId: string
  private readonly connectD = deferred<boolean>()
  private readonly connectTimer: ReturnType<typeof setTimeout>
  private subscribeD: Deferred<boolean> | null = null
  private authD: Deferred<boolean> | null = null
  private pongD: Deferred<number | null> | null = null
  private subscribeStarted = 0
  private pingStarted = 0

  constructor(url: string, headers: Record<string, string>, channels: string[], timeoutMs: number, subscriptionId = 'sub-1') {
    this.timeoutMs = timeoutMs
    this.channels = channels
    this.subscriptionId = subscriptionId
    this.ws = new WebSocket(url, { headers } as never)
    this.connectTimer = setTimeout(() => {
      this.errors.push('connect timeout')
      this.connectD.resolve(false)
      this.close()
    }, timeoutMs)
    this.ws.onmessage = (event) => this.handle(event)
    this.ws.onerror = (event) => {
      this.errors.push(errorText(event))
      this.connectD.resolve(false)
      this.subscribeD?.resolve(false)
      this.authD?.resolve(false)
      this.pongD?.resolve(null)
    }
    this.ws.onclose = () => {
      this.closed = true
      this.connectD.resolve(false)
      this.subscribeD?.resolve(false)
      this.authD?.resolve(false)
      this.pongD?.resolve(null)
    }
  }

  async connect(): Promise<boolean> {
    const ok = await this.connectD.promise
    clearTimeout(this.connectTimer)
    return ok
  }

  subscribe(): Promise<boolean> {
    if (this.subscribed) return Promise.resolve(true)
    if (!this.connected || this.closed) return Promise.resolve(false)
    this.subscribeD = deferred<boolean>()
    this.subscribeStarted = performance.now()
    try {
      this.ws.send(
        JSON.stringify({
          type: 'subscribe',
          data: [{ subscriptionId: this.subscriptionId, channels: this.channels }],
        }),
      )
    } catch (error) {
      this.errors.push(errorText(error))
      return Promise.resolve(false)
    }
    return withTimeout(this.subscribeD.promise, this.timeoutMs, false)
  }

  authenticate(secret: string): Promise<boolean> {
    if (!this.connected || this.closed) return Promise.resolve(false)
    this.authD = deferred<boolean>()
    try {
      this.ws.send(JSON.stringify({ type: 'authentication', data: { session: secret } }))
    } catch (error) {
      this.errors.push(errorText(error))
      return Promise.resolve(false)
    }
    return withTimeout(this.authD.promise, this.timeoutMs, false)
  }

  ping(): Promise<number | null> {
    if (!this.connected || this.closed) return Promise.resolve(null)
    this.pongD = deferred<number | null>()
    this.pingStarted = performance.now()
    try {
      this.ws.send(JSON.stringify({ type: 'ping' }))
    } catch (error) {
      this.errors.push(errorText(error))
      return Promise.resolve(null)
    }
    return withTimeout(this.pongD.promise, this.timeoutMs, null)
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* already closed */
    }
  }

  private handle(event: MessageEvent): void {
    const raw =
      typeof event.data === 'string'
        ? event.data
        : new TextDecoder().decode(event.data instanceof ArrayBuffer ? event.data : new Uint8Array(event.data))
    this.messages++
    this.bytes += raw.length
    let message: { type?: string; data?: any }
    try {
      message = JSON.parse(raw) as { type?: string; data?: any }
    } catch {
      this.errors.push('invalid JSON from server')
      return
    }
    switch (message.type) {
      case 'connected':
        if (!this.connected) {
          this.connected = true
          this.connectMs = performance.now() - this.startedAt
          this.connectD.resolve(true)
        }
        break
      case 'response':
        if (message.data?.to === 'subscribe') {
          this.subscribed = Boolean(message.data.success)
          this.subscribeMs = performance.now() - this.subscribeStarted
          this.subscribeD?.resolve(this.subscribed)
        } else if (message.data?.to === 'authentication') {
          this.authD?.resolve(Boolean(message.data.success))
        }
        break
      case 'pong':
        this.pongD?.resolve(performance.now() - this.pingStarted)
        break
      case 'event':
        this.events++
        this.onEvent?.(message.data, performance.now())
        break
      case 'error':
        this.errors.push(`${message.data?.code ?? 'error'}: ${message.data?.message ?? ''}`)
        this.subscribeD?.resolve(false)
        this.authD?.resolve(false)
        this.pongD?.resolve(null)
        break
    }
  }
}

interface OpenOptions {
  url: string
  headers: Record<string, string>
  channels: string[]
  timeoutSec: number
  connectBatch: number
  connectDelayMs: number
  authMessage: boolean
  uniqueSubscriptions: boolean
  sessionSecret?: string
}

interface OpenResult {
  clients: RtClient[]
  attempted: number
  connected: number
  subscribed: number
  failed: number
  connectMs: number[]
  subscribeMs: number[]
  errors: Record<string, number>
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

async function openClients(count: number, options: OpenOptions, label: string): Promise<OpenResult> {
  const clients: RtClient[] = []
  const connectMs: number[] = []
  const subscribeMs: number[] = []
  const errors: Record<string, number> = {}
  let attempted = 0
  let connected = 0
  let subscribed = 0
  let failed = 0
  const batch = Math.max(1, options.connectBatch)
  const recordErrors = (client: RtClient, fallback: string): void => {
    if (client.errors.length === 0) bump(errors, fallback)
    else for (const error of client.errors) bump(errors, error)
  }

  for (let start = 0; start < count; start += batch) {
    const size = Math.min(batch, count - start)
    await Promise.all(
      Array.from({ length: size }, async () => {
        attempted++
        const subscriptionId = options.uniqueSubscriptions ? `sub-${attempted}` : 'sub-1'
        const client = new RtClient(options.url, options.headers, options.channels, options.timeoutSec * 1000, subscriptionId)
        const opened = await client.connect()
        if (!opened) {
          failed++
          recordErrors(client, 'connect failed')
          client.close()
          return
        }
        connected++
        connectMs.push(client.connectMs)
        if (options.authMessage && options.sessionSecret) {
          const authenticated = await client.authenticate(options.sessionSecret)
          if (!authenticated) {
            failed++
            recordErrors(client, 'authentication failed')
            client.close()
            return
          }
        }
        const ok = await client.subscribe()
        if (!ok) {
          failed++
          recordErrors(client, 'subscribe failed')
          client.close()
          return
        }
        subscribed++
        subscribeMs.push(client.subscribeMs)
        clients.push(client)
      }),
    )
    const done = Math.min(count, start + batch)
    console.log(`  ${label}: attempted ${done}/${count}, subscribed ${subscribed}, failed ${failed}`)
    if (options.connectDelayMs > 0 && done < count) await sleep(options.connectDelayMs)
  }

  return { clients, attempted, connected, subscribed, failed, connectMs, subscribeMs, errors }
}

interface HoldResult {
  pingRtts: number[]
  pings: number
  pongs: number
  closedDuringHold: number
}

async function holdAndPing(clients: RtClient[], durationSec: number, pingIntervalSec: number): Promise<HoldResult> {
  const pingRtts: number[] = []
  let pings = 0
  let pongs = 0
  const deadline = performance.now() + durationSec * 1000

  const pingBatch = async (): Promise<void> => {
    const live = clients.filter((client) => !client.closed)
    const results = await Promise.allSettled(live.map((client) => client.ping()))
    for (const result of results) {
      pings++
      if (result.status === 'fulfilled' && result.value !== null) {
        pongs++
        pingRtts.push(result.value)
      }
    }
  }

  if (pingIntervalSec > 0) await pingBatch()
  while (performance.now() < deadline) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) break
    const wait = pingIntervalSec > 0 ? Math.min(pingIntervalSec * 1000, remaining) : remaining
    await sleep(wait)
    if (performance.now() >= deadline) break
    if (pingIntervalSec > 0) await pingBatch()
  }

  return {
    pingRtts,
    pings,
    pongs,
    closedDuringHold: clients.filter((client) => client.closed).length,
  }
}

interface ConnectOptions {
  base: string
  project: string
  key?: string
  session?: string
  database: string
  collection: string
  channels: string[]
  auth: 'key' | 'session' | 'guest'
  authMessage: boolean
  uniqueSubscriptions: boolean
  timeoutSec: number
  connectBatch: number
  connectDelayMs: number
  durationSec: number
  pingIntervalSec: number
  out: string
}

interface ConnectLevel {
  connections: number
  attempted: number
  connected: number
  subscribed: number
  failed: number
  errors: Record<string, number>
  closedDuringHold: number
  stillOpen: number
  connect: Stats
  subscribe: Stats
  ping: Stats
  pingAttempts: number
  pongs: number
  messages: number
  events: number
  bytes: number
  durationSec: number
}

interface FanoutOptions extends ConnectOptions {
  writes: number
  writeConcurrency: number
  deliveryTimeoutSec: number
  prefix: string
  firstProfileId: string
  secondProfileId: string
  firstPostId: string
  firstCommentId: string
  authorUsername: string
}

interface FanoutLevel {
  listeners: number
  attempted: number
  connected: number
  subscribed: number
  failed: number
  errors: Record<string, number>
  writes: number
  writeOk: number
  writeFail: number
  writeRps: number
  writeLatency: Stats
  writeErrors: Record<string, number>
  expectedPerListener: number
  expectedTotal: number
  delivered: number
  missing: number
  lossPct: number
  duplicates: number
  unexpected: number
  deliveryLatency: Stats
  receivedPerListener: Stats
  listenersWithAll: number
  timedOut: boolean
  permissionFiltered: boolean
}

function realtimeUrl(base: string, project: string): string {
  const url = new URL(base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/realtime`
  url.searchParams.set('project', project)
  return url.toString()
}

function channelFor(database: string, collection: string): string {
  return `databases.${database}.collections.${collection}.documents`
}

function resolveChannels(raw: string | undefined, database: string, collection: string): string[] {
  if (!raw) return [channelFor(database, collection)]
  if (raw === 'all') return ['documents']
  if (raw === 'social') {
    return ['posts', 'comments', 'post_likes', 'comment_likes', 'reposts', 'follows'].map((name) =>
      channelFor(database, name),
    )
  }
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (value.includes('.') ? value : channelFor(database, value)))
}

interface SocialManifest {
  database?: string
  prefix?: string
  firstProfileId?: string
  secondProfileId?: string
  firstPostId?: string
  firstCommentId?: string
}

function readManifestIfPresent(explicit: string | undefined, prefix: string): SocialManifest | null {
  const path = explicit ? resolve(explicit) : resolve('data/stress', `social-${prefix}.json`)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as SocialManifest
}

function authHeaders(auth: 'key' | 'session' | 'guest', key: string | undefined, session: string | undefined): Record<string, string> {
  if (auth === 'key') {
    if (!key) throw new Error('--key (or STRESS_API_KEY) is required for --auth key')
    return { 'X-Appwrite-Key': key }
  }
  if (auth === 'session') {
    if (!session) throw new Error('Session auth needs a signed-in user.')
    return { 'X-Appwrite-Session': session }
  }
  return {}
}

async function signIn(base: string, project: string, timeoutSec: number, email: string): Promise<string> {
  const password = process.env.STRESS_SESSION_PASSWORD ?? 'stress-social-password-123'
  const response = await fetch(`${base}/account/sessions/email`, {
    method: 'POST',
    headers: { 'X-Appwrite-Project': project, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(timeoutSec * 1000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`session login failed: HTTP ${response.status} ${text.slice(0, 1000)}`)
  const fallback = response.headers.get('x-fallback-cookies')
  if (fallback) {
    try {
      const secret = Object.values(JSON.parse(fallback) as Record<string, string>)[0]
      if (secret) return secret
    } catch {
      /* fall through */
    }
  }
  const cookie = /(?:^|;\s*)[^=]+=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')
  if (cookie?.[1]) return decodeURIComponent(cookie[1])
  try {
    const body = JSON.parse(text) as { secret?: string }
    if (body.secret) return body.secret
  } catch {
    /* not JSON */
  }
  throw new Error('session login did not return a secret')
}

interface Context {
  options: ConnectOptions
  manifest: SocialManifest | null
}

function context(): Context {
  const prefix = flag('prefix') ?? DEFAULT_PREFIX
  const manifest = readManifestIfPresent(flag('manifest'), prefix)
  const base = normalizeBase(flag('base') ?? env('STRESS_BASE') ?? 'http://localhost:8080/v1')
  const project = required(flag('project') ?? env('STRESS_PROJECT'), '--project (or STRESS_PROJECT)')
  const key = flag('key') ?? env('STRESS_API_KEY')
  const auth = (flag('auth') ?? env('STRESS_RT_AUTH') ?? 'key') as ConnectOptions['auth']
  if (!['key', 'session', 'guest'].includes(auth)) throw new Error('--auth must be key, session or guest')
  const database = flag('database') ?? manifest?.database ?? DEFAULT_DATABASE
  const collection = flag('collection') ?? DEFAULT_COLLECTION
  return {
    manifest,
    options: {
      base,
      project,
      key,
      database,
      collection,
      channels: resolveChannels(flag('channels'), database, collection),
      auth,
      authMessage: has('auth-message'),
      uniqueSubscriptions: has('unique-subscriptions'),
      timeoutSec: integerFlag('timeout', DEFAULT_TIMEOUT),
      connectBatch: integerFlag('connect-batch', DEFAULT_CONNECT_BATCH),
      connectDelayMs: integerFlag('connect-delay', DEFAULT_CONNECT_DELAY, 0),
      durationSec: integerFlag('duration', DEFAULT_DURATION),
      pingIntervalSec: integerFlag('ping-interval', DEFAULT_PING_INTERVAL, 0),
      out: flag('out') ?? 'data/stress',
    },
  }
}

async function resolveSession(options: ConnectOptions): Promise<string | undefined> {
  if (options.auth !== 'session') return undefined
  const email = flag('session-email') ?? 'stress-social@example.com'
  if (has('auth-message')) {
    // Open as a guest, then authenticate over the socket.
    return signIn(options.base, options.project, options.timeoutSec, email)
  }
  const explicit = flag('session') ?? env('STRESS_SESSION')
  if (explicit) return explicit
  return signIn(options.base, options.project, options.timeoutSec, email)
}

function buildOpenOptions(options: ConnectOptions, sessionSecret: string | undefined): OpenOptions {
  return {
    url: realtimeUrl(options.base, options.project),
    headers: options.auth === 'key' || (options.auth === 'session' && !options.authMessage)
      ? authHeaders(options.auth, options.key, sessionSecret)
      : {},
    channels: options.channels,
    timeoutSec: options.timeoutSec,
    connectBatch: options.connectBatch,
    connectDelayMs: options.connectDelayMs,
    authMessage: options.authMessage,
    uniqueSubscriptions: options.uniqueSubscriptions,
    sessionSecret,
  }
}

async function runConnect(levelsToRun: number[], options: ConnectOptions, sessionSecret: string | undefined): Promise<ConnectLevel[]> {
  const results: ConnectLevel[] = []
  for (const connections of levelsToRun) {
    console.log(`\nconnect level: ${connections} sockets, hold ${options.durationSec}s`)
    const opened = await openClients(connections, buildOpenOptions(options, sessionSecret), `connect c=${connections}`)
    const hold = await holdAndPing(opened.clients, options.durationSec, options.pingIntervalSec)
    const closeStarted = performance.now()
    for (const client of opened.clients) client.close()
    await sleep(250)
    const stillOpen = opened.clients.filter((client) => !client.closed).length
    const closeMs = performance.now() - closeStarted
    const level: ConnectLevel = {
      connections,
      attempted: opened.attempted,
      connected: opened.connected,
      subscribed: opened.subscribed,
      failed: opened.failed,
      errors: opened.errors,
      closedDuringHold: hold.closedDuringHold,
      stillOpen,
      connect: stats(opened.connectMs),
      subscribe: stats(opened.subscribeMs),
      ping: stats(hold.pingRtts),
      pingAttempts: hold.pings,
      pongs: hold.pongs,
      messages: opened.clients.reduce((sum, client) => sum + client.messages, 0),
      events: opened.clients.reduce((sum, client) => sum + client.events, 0),
      bytes: opened.clients.reduce((sum, client) => sum + client.bytes, 0),
      durationSec: options.durationSec,
    }
    results.push(level)
    console.log(
      `  connected=${level.connected}/${level.attempted} subscribed=${level.subscribed} ` +
        `connect p95=${ms(level.connect.p95)} subscribe p95=${ms(level.subscribe.p95)} ` +
        `ping p95=${ms(level.ping.p95)} pongs=${level.pongs}/${level.pingAttempts} ` +
        `closed=${level.closedDuringHold} stillOpen=${level.stillOpen} close=${ms(closeMs)}`,
    )
  }
  return results
}

function bodyFor(collection: string, seq: number, runId: string, options: FanoutOptions): Record<string, unknown> {
  const createdAt = new Date().toISOString()
  const content = `realtime stress ${runId} ${seq}`
  switch (collection) {
    case 'posts':
      return {
        authorId: options.firstProfileId,
        authorUsername: options.authorUsername,
        content,
        likeCount: 0,
        commentCount: 0,
        repostCount: 0,
        visibility: 'public',
        createdAt,
      }
    case 'comments':
      return {
        postId: options.firstPostId,
        authorId: options.firstProfileId,
        authorUsername: options.authorUsername,
        content,
        likeCount: 0,
        createdAt,
      }
    case 'post_likes':
      return { userId: options.firstProfileId, postId: options.firstPostId, createdAt }
    case 'comment_likes':
      return { userId: options.firstProfileId, commentId: options.firstCommentId, createdAt }
    case 'reposts':
      return { userId: options.firstProfileId, postId: options.firstPostId, createdAt }
    case 'follows':
      return { followerId: options.firstProfileId, followingId: options.secondProfileId, createdAt }
    default:
      throw new Error(
        `--collection must be posts, comments, post_likes, comment_likes, reposts or follows (got "${collection}")`,
      )
  }
}

async function fanoutLevel(listeners: number, options: FanoutOptions, sessionSecret: string | undefined): Promise<FanoutLevel> {
  console.log(`\nfanout level: ${listeners} listeners, ${options.writes} writes, ${options.collection}`)
  const opened = await openClients(listeners, buildOpenOptions(options, sessionSecret), `listeners c=${listeners}`)
  const clients = opened.clients
  const runId = Date.now().toString(36)
  const prefix = options.prefix
  const writes = new Map<string, { sentAt: number; doneAt: number; ok: boolean }>()
  const per = clients.map(() => ({
    receivedAt: new Map<string, number>(),
    duplicates: 0,
    unexpected: 0,
  }))

  clients.forEach((client, index) => {
    const record = per[index]!
    client.onEvent = (data, receivedAt) => {
      const id = data?.payload?.$id
      if (typeof id !== 'string') return
      if (record.receivedAt.has(id)) {
        record.duplicates++
        return
      }
      record.receivedAt.set(id, receivedAt)
    }
  })

  const writeLatencies: number[] = []
  const writeErrors: Record<string, number> = {}
  let writeOk = 0
  let writeFail = 0
  let nextSeq = 0
  const headers: Record<string, string> = {
    'X-Appwrite-Project': options.project,
    'content-type': 'application/json',
    ...(options.auth === 'session' || sessionSecret
      ? { 'X-Appwrite-Session': sessionSecret ?? '' }
      : { 'X-Appwrite-Key': options.key ?? '' }),
  }
  const documents = `${options.base}/databases/${encodeURIComponent(options.database)}/collections/${encodeURIComponent(options.collection)}/documents`

  const writer = async (): Promise<void> => {
    while (true) {
      const seq = nextSeq++
      if (seq >= options.writes) return
      const id = `${prefix}-rt-${runId}-${pad(seq, 6)}`
      const record = { sentAt: performance.now(), doneAt: 0, ok: false }
      writes.set(id, record)
      try {
        const response = await fetch(`${documents}/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ data: bodyFor(options.collection, seq, runId, options) }),
          signal: AbortSignal.timeout(options.timeoutSec * 1000),
        })
        const doneAt = performance.now()
        record.doneAt = doneAt
        if (response.ok) {
          record.ok = true
          writeOk++
          writeLatencies.push(doneAt - record.sentAt)
        } else {
          writeFail++
          const key = `HTTP ${response.status}`
          writeErrors[key] = (writeErrors[key] ?? 0) + 1
        }
        await response.arrayBuffer()
      } catch (error) {
        writeFail++
        const key = errorText(error)
        writeErrors[key] = (writeErrors[key] ?? 0) + 1
      }
    }
  }

  const writeStarted = performance.now()
  await Promise.all(
    Array.from({ length: Math.min(options.writeConcurrency, Math.max(1, options.writes)) }, () => writer()),
  )
  const writeDone = performance.now()
  const writeDurationSec = (writeDone - writeStarted) / 1000
  console.log(
    `  writes: ${writeOk}/${options.writes} ok, ${writeFail} failed, ${(writeOk / Math.max(0.001, writeDurationSec)).toFixed(0)} rps`,
  )

  const permissionFiltered = options.auth === 'guest'
  const expectedPerListener = permissionFiltered ? 0 : writeOk
  const expectedTotal = clients.length * expectedPerListener
  const deliveryStarted = performance.now()
  let timedOut = false
  while (expectedTotal > 0) {
    const seen = per.reduce((sum, record) => sum + record.receivedAt.size, 0)
    if (seen >= expectedTotal) {
      // Give the last stragglers a short window.
      await sleep(500)
      break
    }
    if (performance.now() - deliveryStarted > options.deliveryTimeoutSec * 1000) {
      timedOut = true
      break
    }
    await sleep(100)
  }

  const allLatencies: number[] = []
  const receivedPerListener: number[] = []
  let delivered = 0
  let duplicateTotal = 0
  let unexpectedTotal = 0
  for (const record of per) {
    let received = 0
    for (const [id, receivedAt] of record.receivedAt) {
      const write = writes.get(id)
      if (write?.ok) {
        received++
        allLatencies.push(receivedAt - write.sentAt)
      } else {
        record.unexpected++
      }
    }
    delivered += received
    duplicateTotal += record.duplicates
    unexpectedTotal += record.unexpected
    receivedPerListener.push(received)
  }

  const missing = Math.max(0, expectedTotal - delivered)
  const result: FanoutLevel = {
    listeners: clients.length,
    attempted: opened.attempted,
    connected: opened.connected,
    subscribed: opened.subscribed,
    failed: opened.failed,
    errors: opened.errors,
    writes: options.writes,
    writeOk,
    writeFail,
    writeRps: writeOk / Math.max(0.001, writeDurationSec),
    writeLatency: stats(writeLatencies),
    writeErrors,
    expectedPerListener,
    expectedTotal,
    delivered,
    missing,
    lossPct: expectedTotal === 0 ? 0 : (missing / expectedTotal) * 100,
    duplicates: duplicateTotal,
    unexpected: unexpectedTotal,
    deliveryLatency: stats(allLatencies),
    receivedPerListener: stats(receivedPerListener),
    listenersWithAll: expectedPerListener > 0
      ? receivedPerListener.filter((value) => value === expectedPerListener).length
      : 0,
    timedOut,
    permissionFiltered,
  }

  console.log(
    `  delivered=${result.delivered}/${result.expectedTotal} ` +
      `loss=${pct(result.lossPct)} latency p50=${ms(result.deliveryLatency.p50)} p95=${ms(result.deliveryLatency.p95)} ` +
      `p99=${ms(result.deliveryLatency.p99)} listenersWithAll=${result.listenersWithAll}/${result.listeners}` +
      (result.permissionFiltered ? ' (guest: permissions filter events)' : ''),
  )

  for (const client of clients) client.close()
  await sleep(250)
  return result
}

interface RealtimeReport {
  kind: 'realtime'
  startedAt: string
  base: string
  project: string
  database: string
  collection: string
  channels: string[]
  auth: string
  authMessage: boolean
  pingIntervalSec: number
  connectLevels: ConnectLevel[]
  fanoutLevels: FanoutLevel[]
}

function formatErrors(errors: Record<string, number>): string {
  return Object.entries(errors)
    .map(([name, count]) => `${name} × ${count}`)
    .join(', ')
}

function markdownReport(report: RealtimeReport): string {
  const lines: string[] = []
  lines.push('# Realtime WebSocket stress test')
  lines.push('')
  lines.push(`- Endpoint: \`${report.base}\``)
  lines.push(`- Project: \`${report.project}\``)
  lines.push(`- Database/collection: \`${report.database}.${report.collection}\``)
  lines.push(`- Channels: ${report.channels.map((channel) => `\`${channel}\``).join(', ')}`)
  lines.push(`- Auth: \`${report.auth}\`${report.authMessage ? ' (authentication message)' : ''}`)
  lines.push('')
  if (report.connectLevels.length > 0) {
    lines.push('## Connection capacity')
    lines.push('')
    lines.push('| Sockets | Connected | Subscribed | Failed | Connect p50/p95 | Subscribe p95 | Ping p95 | Pongs | Closed during hold |')
    lines.push('| ---: | ---: | ---: | ---: | --- | --- | --- | ---: | ---: |')
    for (const level of report.connectLevels) {
      lines.push(
        `| ${level.connections} | ${level.connected} | ${level.subscribed} | ${level.failed} | ` +
          `${ms(level.connect.p50)} / ${ms(level.connect.p95)} | ${ms(level.subscribe.p95)} | ${ms(level.ping.p95)} | ` +
          `${level.pongs}/${level.pingAttempts} | ${level.closedDuringHold} |`,
      )
    }
    lines.push('')
    lines.push(`Held for ${report.connectLevels[0]?.durationSec ?? 0}s per level with a ping every ${report.pingIntervalSec}s.`)
    for (const level of report.connectLevels) {
      if (Object.keys(level.errors).length > 0) {
        lines.push(`- ${level.connections} sockets: ${formatErrors(level.errors)}.`)
      }
    }
    lines.push('')
  }
  if (report.fanoutLevels.length > 0) {
    lines.push('## Event fan-out')
    lines.push('')
    lines.push('| Listeners (attempted) | Writes ok/failed | Write RPS | Delivered | Expected | Loss | p50 | p95 | p99 | Listeners with all |')
    lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const level of report.fanoutLevels) {
      lines.push(
        `| ${level.listeners} (${level.attempted}) | ${level.writeOk}/${level.writeFail} | ${level.writeRps.toFixed(0)} | ${level.delivered} | ${level.expectedTotal} | ` +
          `${pct(level.lossPct)} | ${ms(level.deliveryLatency.p50)} | ${ms(level.deliveryLatency.p95)} | ${ms(level.deliveryLatency.p99)} | ` +
          `${level.listenersWithAll}/${level.listeners} |`,
      )
    }
    lines.push('')
    for (const level of report.fanoutLevels) {
      const detail = [
        level.failed > 0 ? `${level.failed} sockets failed to subscribe (${formatErrors(level.errors)})` : '',
        level.writeFail > 0
          ? `${level.writeFail} writes failed (${formatErrors(level.writeErrors)})`
          : '',
        level.duplicates > 0 ? `${level.duplicates} duplicate deliveries` : '',
        level.unexpected > 0 ? `${level.unexpected} events for failed writes` : '',
        level.timedOut ? 'delivery wait timed out' : '',
      ].filter(Boolean)
      if (detail.length > 0) lines.push(`- ${level.listeners} listeners: ${detail.join('; ')}.`)
    }
    if (report.fanoutLevels.some((level) => level.writeOk === 0 && level.listeners > 0)) {
      lines.push('- A zero write success rate means the sockets consumed the connection/file-descriptor budget before the REST writes; this is a headroom failure, not an event-delivery bug.')
    }
    lines.push('')
    lines.push('Delivery latency is measured from the start of the REST write until the socket receives the event, so it includes the write, the fan-out and the network round trip.')
    lines.push('')
    const guest = report.fanoutLevels.some((level) => level.permissionFiltered)
    if (guest) {
      lines.push('Guest sockets subscribe successfully but receive no document events because the collections grant `read("users")`; this is the permission-filter path, not a loss bug.')
      lines.push('')
    }
  }
  lines.push('## Qualification')
  lines.push('')
  lines.push('The load generator runs on a remote client, so numbers include WAN/TLS and local client cost.')
  lines.push('A single Bun process opens every socket; at high connection counts the client can become the bottleneck before the server does.')
  lines.push('Events are created through the normal REST API and matched by document ID. The test covers document create events; update/delete events use the same fan-out path.')
  lines.push('Compression, HTTP/2 and proxy connection limits are whatever the target host uses in production.')
  return `${lines.join('\n')}\n`
}

function writeReports(report: RealtimeReport, outDir: string): { json: string; md: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  mkdirSync(outDir, { recursive: true })
  const json = resolve(outDir, `realtime-${stamp}.json`)
  const md = resolve(outDir, `realtime-${stamp}.md`)
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(md, markdownReport(report))
  return { json, md }
}

function usage(): void {
  console.log(`Realtime WebSocket stress test for Bunwrite.

Usage:
  bun run stress:realtime connect [options]
  bun run stress:realtime fanout  [options]
  bun run stress:realtime all     [options]

Common:
  --base <url>                 API root (http/https); realtime uses wss/ws
  --project <id>               X-Appwrite-Project
  --key <key>                  API key (or STRESS_API_KEY)
  --session <secret>           Session secret (or STRESS_SESSION)
  --session-email <email>      Login for --auth session (default stress-social@example.com)
  --auth <key|session|guest>   Socket auth, default key
  --auth-message               With session auth, connect as guest then send the authentication message
  --unique-subscriptions       Give every socket its own subscription ID (real SDK behavior)
  --database <id>              Default: ${DEFAULT_DATABASE}
  --collection <id>            Default: ${DEFAULT_COLLECTION}
  --channels <list>            Collection names, a full channel, "social" or "all"
  --timeout <seconds>          Connect/subscribe/ping/write timeout, default ${DEFAULT_TIMEOUT}
  --connect-batch <n>          Concurrent opens per batch, default ${DEFAULT_CONNECT_BATCH}
  --connect-delay <ms>         Delay between batches, default ${DEFAULT_CONNECT_DELAY}
  --out <dir>                  Report directory, default data/stress

Connect:
  --connections <list>         Socket counts, default ${DEFAULT_CONNECTIONS}
  --duration <seconds>         Hold per level, default ${DEFAULT_DURATION}
  --ping-interval <seconds>    Ping cadence, default ${DEFAULT_PING_INTERVAL} (0 disables)

Fanout:
  --fanout-connections <list>  Listener counts, default ${DEFAULT_FANOUT_CONNECTIONS}
  --writes <n>                 Documents to create, default ${DEFAULT_WRITES}
  --write-concurrency <n>      Concurrent REST writers, default ${DEFAULT_WRITE_CONCURRENCY}
  --delivery-timeout <seconds> Wait for the last event, default ${DEFAULT_DELIVERY_TIMEOUT}
  --prefix <text>              ID prefix, default ${DEFAULT_PREFIX}
  --manifest <path>            Social manifest for post/profile/comment IDs

Environment:
  STRESS_API_KEY, STRESS_PROJECT, STRESS_BASE, STRESS_SESSION,
  STRESS_RT_AUTH, STRESS_SESSION_PASSWORD

Examples:
  export STRESS_API_KEY=your-api-key
  bun run stress:realtime connect \\
    --base https://bunwrite.example.com/v1 --project social-media-app \\
    --connections 100,500,1000 --duration 30

  bun run stress:realtime fanout \\
    --manifest data/stress/social-soc-20261030.json \\
    --fanout-connections 100,500 --writes 200 --write-concurrency 20

Channels:
  posts, comments, post_likes, comment_likes, reposts, follows,
  a full channel like databases.<db>.collections.posts.documents,
  "social" for all six collections, or "all" for the global documents channel.`)
}

function reportFor(
  options: ConnectOptions,
  connectLevels: ConnectLevel[],
  fanoutLevels: FanoutLevel[],
): RealtimeReport {
  return {
    kind: 'realtime',
    startedAt: new Date().toISOString(),
    base: options.base,
    project: options.project,
    database: options.database,
    collection: options.collection,
    channels: options.channels,
    auth: options.auth,
    authMessage: options.authMessage,
    pingIntervalSec: options.pingIntervalSec,
    connectLevels,
    fanoutLevels,
  }
}

function emit(report: RealtimeReport, outDir: string): void {
  const paths = writeReports(report, outDir)
  console.log(`\n${markdownReport(report)}`)
  console.log(`report: ${paths.md}`)
  console.log(`raw:    ${paths.json}`)
}

async function runFanoutLevels(options: FanoutOptions, sessionSecret: string | undefined): Promise<FanoutLevel[]> {
  const results: FanoutLevel[] = []
  for (const listeners of levels('fanout-connections', DEFAULT_FANOUT_CONNECTIONS)) {
    results.push(await fanoutLevel(listeners, options, sessionSecret))
  }
  return results
}

try {
  const { options, manifest } = context()
  const sessionSecret = await resolveSession(options)
  const connectLevels =
    command === 'fanout' ? [] : await runConnect(levels('connections', DEFAULT_CONNECTIONS), options, sessionSecret)
  const fanoutLevels =
    command === 'connect' ? [] : await runFanoutLevels(fanoutOptionsFrom(options, manifest), sessionSecret)
  emit(reportFor(options, connectLevels, fanoutLevels), options.out)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

function fanoutOptionsFrom(options: ConnectOptions, manifest: SocialManifest | null): FanoutOptions {
  const prefix = flag('prefix') ?? manifest?.prefix ?? DEFAULT_PREFIX
  return {
    ...options,
    writes: integerFlag('writes', DEFAULT_WRITES, 0),
    writeConcurrency: integerFlag('write-concurrency', DEFAULT_WRITE_CONCURRENCY),
    deliveryTimeoutSec: integerFlag('delivery-timeout', DEFAULT_DELIVERY_TIMEOUT),
    prefix,
    firstProfileId: flag('first-profile-id') ?? manifest?.firstProfileId ?? `${prefix}-u-0000`,
    secondProfileId: flag('second-profile-id') ?? manifest?.secondProfileId ?? `${prefix}-u-0001`,
    firstPostId: flag('first-post-id') ?? manifest?.firstPostId ?? `${prefix}-p-000000`,
    firstCommentId: flag('first-comment-id') ?? manifest?.firstCommentId ?? `${prefix}-c-000000`,
    authorUsername: `${prefix}_u_0000`,
  }
}
