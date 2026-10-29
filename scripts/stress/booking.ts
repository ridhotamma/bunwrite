/**
 * Booking-app stress test for a running Bunwrite instance.
 *
 * It creates an isolated `booking_stress` database, seeds services, slots and
 * bookings, then measures the reads and writes a booking user generates:
 * browse services, open the calendar, view bookings, open one booking and make
 * a booking. The report turns those numbers into an estimated active-user
 * capacity at a latency SLO.
 *
 * Examples:
 *   export STRESS_API_KEY=...
 *   bun run stress:booking setup \
 *     --base https://bunwrite.example.com/v1 --project booking-app \
 *     --prefix bkg-20261030 --reset
 *   bun run stress:booking run --manifest data/stress/booking-bkg-20261030.json
 *
 * This is a development tool. Use it against a disposable project, never
 * production data.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { runMatrix, type RunResult, type Target } from './run'

const DEFAULT_DATABASE = 'booking_stress'
const DEFAULT_PREFIX = `bkg-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(2, 12)}`
const DEFAULT_SERVICES = 24
const DEFAULT_DAYS = 7
const DEFAULT_SLOTS_PER_DAY = 8
const DEFAULT_BOOKINGS = 5000
const DEFAULT_BATCH = 250
const DEFAULT_CONCURRENCY = '1,10,50,100,200,400'
const DEFAULT_WRITE_CONCURRENCY = '1,10,50,100'
const DEFAULT_DURATION = 10
const DEFAULT_WARMUP = 2
const DEFAULT_TIMEOUT = 15

const argv = process.argv.slice(2)
const command = argv[0] ?? 'all'
if (command === '--help' || command === '-h' || command === 'help') {
  usage()
  process.exit(0)
}
if (!['setup', 'run', 'all', 'mix', 'cleanup'].includes(command)) {
  usage()
  process.exit(1)
}
if (argv.includes('--help') || argv.includes('-h')) {
  usage()
  process.exit(0)
}

function flag(name: string): string | undefined {
  const eq = argv.find((arg) => arg.startsWith(`--${name}=`))
  if (eq !== undefined) return eq.slice(name.length + 3)
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

function has(name: string): boolean {
  return argv.includes(`--${name}`)
}

function numberFlag(name: string, fallback: number): number {
  const raw = flag(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`)
  return value
}

function integerFlag(name: string, fallback: number, min = 1): number {
  const value = numberFlag(name, fallback)
  if (!Number.isInteger(value) || value < min) throw new Error(`--${name} must be an integer >= ${min}`)
  return value
}

function levels(name: string, fallback: string): number[] {
  const raw = flag(name) ?? fallback
  const out = raw.split(',').map((value) => Number(value.trim()))
  if (out.length === 0 || out.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error(`--${name} must be a comma-separated list of positive integers`)
  }
  return out
}

function boolFlag(name: string, fallback = false): boolean {
  if (has(name)) return true
  const raw = flag(name)
  if (raw === undefined) return fallback
  return raw === 'true' || raw === '1' || raw === 'yes'
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required.`)
  return value
}

function normalizeBase(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function env(name: string): string | undefined {
  return process.env[name] || undefined
}

function assertId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(value)) {
    throw new Error(`${label} must be 1-36 chars of a-z, A-Z, 0-9, period, hyphen and underscore`)
  }
  return value
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0')
}

function iso(value: Date): string {
  return value.toISOString()
}

function dayStart(anchor: Date, day: number): Date {
  const date = new Date(anchor)
  date.setUTCDate(date.getUTCDate() + day)
  date.setUTCHours(0, 0, 0, 0)
  return date
}

function dayEnd(anchor: Date, day: number): Date {
  const date = new Date(anchor)
  date.setUTCDate(date.getUTCDate() + day)
  date.setUTCHours(23, 59, 59, 999)
  return date
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function queryString(queries: Record<string, unknown>[], total: boolean): string {
  const encoded = queries.map((query, index) => `queries[${index}]=${encodeURIComponent(JSON.stringify(query))}`)
  encoded.push(`total=${total ? 'true' : 'false'}`)
  return encoded.join('&')
}

interface ApiOptions {
  base: string
  project: string
  key: string
  timeout: number
}

interface ApiResult {
  status: number
  body: unknown
  text: string
}

async function api(
  options: ApiOptions,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    'X-Appwrite-Project': options.project,
    'X-Appwrite-Key': options.key,
    ...extraHeaders,
  }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${options.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeout * 1000),
  })
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  return { status: response.status, body: parsed, text }
}

function assertOk(result: ApiResult, label: string, allowed: number[] = []): ApiResult {
  if (result.status >= 200 && result.status < 300) return result
  if (allowed.includes(result.status)) return result
  throw new Error(`${label} failed: HTTP ${result.status} ${result.text.slice(0, 1000)}`)
}

const serviceAttributes = [
  { key: 'tenantId', type: 'string', size: 36, required: true },
  { key: 'name', type: 'string', size: 80, required: true },
  { key: 'category', type: 'string', size: 40, required: true },
  { key: 'durationMinutes', type: 'integer', required: true, min: 15, max: 480 },
  { key: 'price', type: 'integer', required: true, min: 0, max: 100_000_000 },
  { key: 'capacity', type: 'integer', required: true, min: 1, max: 100 },
  { key: 'rating', type: 'double', required: true, min: 0, max: 5 },
  { key: 'active', type: 'boolean', required: true },
]

const slotAttributes = [
  { key: 'tenantId', type: 'string', size: 36, required: true },
  { key: 'serviceId', type: 'string', size: 40, required: true },
  { key: 'startsAt', type: 'datetime', required: true, format: '' },
  { key: 'endsAt', type: 'datetime', required: true, format: '' },
  { key: 'capacity', type: 'integer', required: true, min: 1, max: 100 },
  { key: 'booked', type: 'integer', required: true, min: 0, max: 100 },
  { key: 'price', type: 'integer', required: true, min: 0, max: 100_000_000 },
  { key: 'status', type: 'enum', required: true, elements: ['open', 'full', 'closed'] },
]

const bookingAttributes = [
  { key: 'tenantId', type: 'string', size: 36, required: true },
  { key: 'slotId', type: 'string', size: 40, required: true },
  { key: 'serviceId', type: 'string', size: 40, required: true },
  { key: 'customerName', type: 'string', size: 120, required: true },
  { key: 'customerEmail', type: 'email', required: true },
  { key: 'partySize', type: 'integer', required: true, min: 1, max: 50 },
  { key: 'status', type: 'enum', required: true, elements: ['confirmed', 'cancelled', 'completed'] },
  { key: 'startsAt', type: 'datetime', required: true, format: '' },
  { key: 'createdAt', type: 'datetime', required: true, format: '' },
  { key: 'notes', type: 'string', size: 500, required: false },
]

const collections = [
  {
    id: 'services',
    name: 'Booking services',
    attributes: serviceAttributes,
    indexes: [
      { key: 'idx_services_active', type: 'key', columns: ['tenantId', 'active', 'price'], orders: ['ASC', 'ASC', 'ASC'] },
      { key: 'idx_services_category', type: 'key', columns: ['tenantId', 'category'], orders: ['ASC', 'ASC'] },
    ],
  },
  {
    id: 'slots',
    name: 'Availability slots',
    attributes: slotAttributes,
    indexes: [
      { key: 'idx_slots_service_start', type: 'key', columns: ['tenantId', 'serviceId', 'startsAt'], orders: ['ASC', 'ASC', 'ASC'] },
      { key: 'idx_slots_status_start', type: 'key', columns: ['tenantId', 'status', 'startsAt'], orders: ['ASC', 'ASC', 'ASC'] },
    ],
  },
  {
    id: 'bookings',
    name: 'Bookings',
    attributes: bookingAttributes,
    indexes: [
      { key: 'idx_bookings_email', type: 'key', columns: ['tenantId', 'customerEmail', 'createdAt'], orders: ['ASC', 'ASC', 'DESC'] },
      { key: 'idx_bookings_slot', type: 'key', columns: ['tenantId', 'slotId'], orders: ['ASC', 'ASC'] },
      { key: 'idx_bookings_start', type: 'key', columns: ['tenantId', 'startsAt'], orders: ['ASC', 'ASC'] },
    ],
  },
] as const

interface Manifest {
  version: 1
  createdAt: string
  base: string
  project: string
  database: string
  prefix: string
  services: number
  days: number
  slotsPerDay: number
  bookings: number
  anchor: string
  window: { start: string; end: string }
  firstServiceId: string
  firstSlotId: string
  firstBookingId: string
  writeEmail: string
}

interface SeedOptions {
  prefix: string
  services: number
  days: number
  slotsPerDay: number
  bookings: number
  anchor: Date
}

function serviceId(prefix: string, index: number): string {
  return `${prefix}-svc-${pad(index, 3)}`
}

function slotId(prefix: string, service: number, day: number, slot: number): string {
  return `${prefix}-sl-${pad(service, 2)}-${pad(day, 2)}-${pad(slot, 2)}`
}

function bookingId(prefix: string, index: number): string {
  return `${prefix}-bk-${pad(index, 6)}`
}

function serviceName(index: number): string {
  const names = [
    'Haircut',
    'Hair colour',
    'Beard trim',
    'Massage 60',
    'Massage 90',
    'Facial',
    'Manicure',
    'Pedicure',
    'Consultation',
    'Dental check',
    'Physio session',
    'Personal training',
    'Yoga class',
    'Pilates class',
    'Photography',
    'Studio hour',
    'Room booking',
    'Table booking',
    'Equipment rental',
    'Workshop seat',
    'Coaching call',
    'Tutoring',
    'Car service',
    'Pet grooming',
  ]
  return names[index % names.length]!
}

function makeServices(options: SeedOptions): Record<string, unknown>[] {
  return Array.from({ length: options.services }, (_, index) => ({
    $id: serviceId(options.prefix, index),
    tenantId: options.prefix,
    name: `${serviceName(index)} ${pad(index + 1, 2)}`,
    category: ['beauty', 'wellness', 'health', 'fitness', 'creative', 'home'][index % 6]!,
    durationMinutes: [30, 45, 60, 90, 120][index % 5]!,
    price: 25_000 + (index % 12) * 15_000,
    capacity: 1 + (index % 6),
    rating: Number((4.2 + (index % 8) * 0.1).toFixed(1)),
    active: true,
  }))
}

function makeSlots(options: SeedOptions): Record<string, unknown>[] {
  const slots: Record<string, unknown>[] = []
  for (let service = 0; service < options.services; service++) {
    for (let day = 1; day <= options.days; day++) {
      for (let slot = 0; slot < options.slotsPerDay; slot++) {
        const start = dayStart(options.anchor, day)
        start.setUTCHours(8 + slot, 0, 0, 0)
        const end = new Date(start.getTime() + 60 * 60 * 1000)
        slots.push({
          $id: slotId(options.prefix, service, day, slot),
          tenantId: options.prefix,
          serviceId: serviceId(options.prefix, service),
          startsAt: iso(start),
          endsAt: iso(end),
          capacity: 1 + (service % 4),
          booked: (service + day + slot) % 4,
          price: 25_000 + (service % 12) * 15_000,
          status: (service + day + slot) % 11 === 0 ? 'full' : 'open',
        })
      }
    }
  }
  return slots
}

function makeBookings(options: SeedOptions): Record<string, unknown>[] {
  const bookings: Record<string, unknown>[] = []
  const now = Date.now()
  for (let index = 0; index < options.bookings; index++) {
    const service = index % options.services
    const day = 1 + (index % options.days)
    const slot = index % options.slotsPerDay
    const start = dayStart(options.anchor, day)
    start.setUTCHours(8 + slot, 0, 0, 0)
    bookings.push({
      $id: bookingId(options.prefix, index),
      tenantId: options.prefix,
      slotId: slotId(options.prefix, service, day, slot),
      serviceId: serviceId(options.prefix, service),
      customerName: `Load Customer ${index % 250}`,
      customerEmail: `${options.prefix}-customer-${index % 250}@example.com`,
      partySize: 1 + (index % 4),
      status: index % 13 === 0 ? 'cancelled' : index % 17 === 0 ? 'completed' : 'confirmed',
      startsAt: iso(start),
      createdAt: iso(new Date(now - (index % 20_000) * 60_000)),
      notes: index % 7 === 0 ? 'Window seat preferred' : '',
    })
  }
  return bookings
}

async function bulkUpsert(
  apiOptions: ApiOptions,
  database: string,
  collection: string,
  documents: Record<string, unknown>[],
  batch: number,
  label: string,
): Promise<void> {
  for (let start = 0; start < documents.length; start += batch) {
    const end = Math.min(start + batch, documents.length)
    const result = await api(apiOptions, 'PUT', `/databases/${encodeURIComponent(database)}/collections/${collection}/documents`, {
      documents: documents.slice(start, end),
    })
    assertOk(result, `seeding ${label} ${start}-${end}`)
    console.log(`  ${label}: ${end}/${documents.length}`)
  }
}

async function createSchema(apiOptions: ApiOptions, database: string): Promise<void> {
  const createdDatabase = await api(apiOptions, 'POST', '/databases', { databaseId: database, name: 'Booking stress' })
  assertOk(createdDatabase, 'create database', [409])

  for (const collection of collections) {
    const created = await api(apiOptions, 'POST', `/databases/${encodeURIComponent(database)}/collections`, {
      collectionId: collection.id,
      name: collection.name,
      documentSecurity: false,
      attributes: collection.attributes,
      indexes: collection.indexes,
    })
    assertOk(created, `create collection ${collection.id}`, [409])
    console.log(`  collection ${collection.id}`)
  }
}

function manifestPath(prefix: string): string {
  return resolve('data/stress', `booking-${prefix}.json`)
}

function writeManifest(manifest: Manifest): string {
  const path = manifestPath(manifest.prefix)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return path
}

function readManifest(path: string): Manifest {
  const parsed = JSON.parse(readFileSync(resolve(path), 'utf8')) as Manifest
  if (parsed.version !== 1 || !parsed.prefix || !parsed.base || !parsed.project || !parsed.database) {
    throw new Error(`Invalid manifest: ${path}`)
  }
  return parsed
}

function setupOptions(): {
  api: ApiOptions
  database: string
  prefix: string
  services: number
  days: number
  slotsPerDay: number
  bookings: number
  batch: number
  reset: boolean
} {
  const base = normalizeBase(required(flag('base') ?? env('STRESS_BASE'), '--base (or STRESS_BASE)'))
  const project = required(flag('project') ?? env('STRESS_PROJECT'), '--project (or STRESS_PROJECT)')
  const key = required(flag('key') ?? env('STRESS_API_KEY'), '--key (or STRESS_API_KEY)')
  const database = flag('database') ?? DEFAULT_DATABASE
  const prefix = assertId(flag('prefix') ?? DEFAULT_PREFIX, '--prefix')
  assertId(database, '--database')
  const reset = boolFlag('reset')
  if (reset && !/stress/i.test(database)) {
    throw new Error('--reset only deletes databases whose name contains "stress"')
  }
  return {
    api: { base, project, key, timeout: numberFlag('timeout', 60) },
    database,
    prefix,
    services: integerFlag('services', DEFAULT_SERVICES),
    days: integerFlag('days', DEFAULT_DAYS),
    slotsPerDay: integerFlag('slots-per-day', DEFAULT_SLOTS_PER_DAY),
    bookings: integerFlag('bookings', DEFAULT_BOOKINGS, 0),
    batch: integerFlag('batch', DEFAULT_BATCH),
    reset,
  }
}

async function setup(): Promise<Manifest> {
  const options = setupOptions()
  console.log(`setting up ${options.api.base} project=${options.api.project} database=${options.database}`)
  if (options.reset) {
    const deleted = await api(options.api, 'DELETE', `/databases/${encodeURIComponent(options.database)}`)
    assertOk(deleted, 'reset database', [404])
    console.log(`reset database ${options.database}`)
  }
  await createSchema(options.api, options.database)

  const anchor = new Date()
  anchor.setUTCHours(0, 0, 0, 0)
  const seed: SeedOptions = {
    prefix: options.prefix,
    services: options.services,
    days: options.days,
    slotsPerDay: options.slotsPerDay,
    bookings: options.bookings,
    anchor,
  }
  const services = makeServices(seed)
  const slots = makeSlots(seed)
  const bookings = makeBookings(seed)

  if (options.reset) {
    console.log(`seeding ${services.length} services`)
    await bulkUpsert(options.api, options.database, 'services', services, options.batch, 'services')
    console.log(`seeding ${slots.length} slots`)
    await bulkUpsert(options.api, options.database, 'slots', slots, options.batch, 'slots')
    console.log(`seeding ${bookings.length} bookings`)
    await bulkUpsert(options.api, options.database, 'bookings', bookings, options.batch, 'bookings')
  } else {
    console.log('seeding with upsert (use --reset for a clean database)')
    await bulkUpsert(options.api, options.database, 'services', services, options.batch, 'services')
    await bulkUpsert(options.api, options.database, 'slots', slots, options.batch, 'slots')
    await bulkUpsert(options.api, options.database, 'bookings', bookings, options.batch, 'bookings')
  }

  const manifest: Manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    base: options.api.base,
    project: options.api.project,
    database: options.database,
    prefix: options.prefix,
    services: options.services,
    days: options.days,
    slotsPerDay: options.slotsPerDay,
    bookings: options.bookings,
    anchor: iso(anchor),
    window: { start: iso(dayStart(anchor, 1)), end: iso(dayEnd(anchor, 1)) },
    firstServiceId: serviceId(options.prefix, 0),
    firstSlotId: slotId(options.prefix, 0, 1, 0),
    firstBookingId: bookingId(options.prefix, 0),
    writeEmail: `${options.prefix}-load@example.com`,
  }
  const path = writeManifest(manifest)
  console.log(`\nseeded ${services.length} services, ${slots.length} slots, ${bookings.length} bookings`)
  console.log(`manifest: ${path}`)
  console.log(`\nnext:\n  bun run stress:booking run --manifest ${JSON.stringify(path)}`)
  return manifest
}

interface RunOptions {
  manifest: Manifest
  api: ApiOptions
  concurrency: number[]
  writeConcurrency: number[]
  duration: number
  warmup: number
  timeout: number
  tool: 'auto' | 'oha' | 'builtin'
  total: boolean
  out: string
}

function runOptions(): RunOptions {
  const manifestPath = flag('manifest') ?? env('STRESS_MANIFEST')
  const manifest = manifestPath ? readManifest(manifestPath) : loadImplicitManifest()
  const base = normalizeBase(flag('base') ?? env('STRESS_BASE') ?? manifest.base)
  const project = flag('project') ?? env('STRESS_PROJECT') ?? manifest.project
  const key = required(flag('key') ?? env('STRESS_API_KEY'), '--key (or STRESS_API_KEY)')
  const tool = (flag('tool') ?? env('STRESS_TOOL') ?? 'auto') as RunOptions['tool']
  if (!['auto', 'oha', 'builtin'].includes(tool)) throw new Error('--tool must be auto, oha or builtin')
  return {
    manifest,
    api: { base, project, key, timeout: numberFlag('timeout', DEFAULT_TIMEOUT) },
    concurrency: levels('concurrency', DEFAULT_CONCURRENCY),
    writeConcurrency: levels('write-concurrency', DEFAULT_WRITE_CONCURRENCY),
    duration: integerFlag('duration', DEFAULT_DURATION),
    warmup: integerFlag('warmup', DEFAULT_WARMUP, 0),
    timeout: integerFlag('timeout', DEFAULT_TIMEOUT),
    tool,
    total: boolFlag('total'),
    out: flag('out') ?? 'data/stress',
  }
}

function loadImplicitManifest(): Manifest {
  const prefix = flag('prefix')
  if (!prefix) throw new Error('Pass --manifest or --prefix, or run setup first.')
  return readManifest(manifestPath(assertId(prefix, '--prefix')))
}

function targetUrls(manifest: Manifest, base: string, total: boolean): Record<string, string> {
  const db = encodeURIComponent(manifest.database)
  const documents = (collection: string) => `${base}/databases/${db}/collections/${collection}/documents`
  const servicesQuery = queryString(
    [
      { method: 'equal', attribute: 'tenantId', values: [manifest.prefix] },
      { method: 'equal', attribute: 'active', values: [true] },
      { method: 'orderAsc', attribute: 'price' },
      { method: 'limit', values: [manifest.services] },
      { method: 'select', values: ['$id', 'name', 'category', 'durationMinutes', 'price', 'rating'] },
    ],
    total,
  )
  const availabilityQuery = queryString(
    [
      { method: 'equal', attribute: 'tenantId', values: [manifest.prefix] },
      { method: 'equal', attribute: 'serviceId', values: [manifest.firstServiceId] },
      { method: 'greaterThanEqual', attribute: 'startsAt', values: [manifest.window.start] },
      { method: 'lessThan', attribute: 'startsAt', values: [manifest.window.end] },
      { method: 'equal', attribute: 'status', values: ['open'] },
      { method: 'orderAsc', attribute: 'startsAt' },
      { method: 'limit', values: [Math.min(24, manifest.slotsPerDay)] },
      { method: 'select', values: ['$id', 'startsAt', 'capacity', 'booked', 'price'] },
    ],
    total,
  )
  const bookingsQuery = queryString(
    [
      { method: 'equal', attribute: 'tenantId', values: [manifest.prefix] },
      { method: 'equal', attribute: 'customerEmail', values: [manifest.writeEmail] },
      { method: 'orderDesc', attribute: 'createdAt' },
      { method: 'limit', values: [20] },
      { method: 'select', values: ['$id', 'status', 'startsAt', 'serviceId'] },
    ],
    total,
  )
  return {
    services: `${documents('services')}?${servicesQuery}`,
    availability: `${documents('slots')}?${availabilityQuery}`,
    bookings: `${documents('bookings')}?${bookingsQuery}`,
    point: `${documents('bookings')}/${encodeURIComponent(manifest.firstBookingId)}?total=false`,
    write: `${documents('bookings')}/${escapeRegex(manifest.prefix)}-bk-[a-z0-9]{12}`,
  }
}

function bookingBody(manifest: Manifest): string {
  const start = new Date(manifest.window.start)
  start.setUTCHours(8, 0, 0, 0)
  return JSON.stringify({
    data: {
      tenantId: manifest.prefix,
      slotId: manifest.firstSlotId,
      serviceId: manifest.firstServiceId,
      customerName: 'Load Test',
      customerEmail: manifest.writeEmail,
      partySize: 2,
      status: 'confirmed',
      startsAt: iso(start),
      createdAt: new Date().toISOString(),
      notes: 'oha booking stress',
    },
  })
}

function targetsFor(options: RunOptions): Target[] {
  const urls = targetUrls(options.manifest, options.api.base, options.total)
  const writeBase = urls.write!
  return [
    { name: 'services', url: urls.services! },
    { name: 'availability', url: urls.availability! },
    { name: 'bookings', url: urls.bookings! },
    { name: 'point', url: urls.point! },
    {
      name: 'create',
      url: writeBase,
      method: 'PUT',
      body: bookingBody(options.manifest),
      contentType: 'application/json',
      randomUrl: true,
      concurrency: options.writeConcurrency,
      urlFor: () => `${writeBase.slice(0, writeBase.lastIndexOf('/') + 1)}${options.manifest.prefix}-bk-${randomId()}`,
    },
  ]
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 14).padEnd(12, '0')
}

interface MixedPathResult {
  target: string
  concurrency: number
  rps: number
  p95ms: number
  successPct: number
  status: Record<string, number>
  errors: Record<string, number>
}

interface MixedLevel {
  concurrency: number
  durationSec: number
  totalRps: number
  p95ms: number
  successPct: number
  paths: MixedPathResult[]
}

const MIX_SHARES: Record<string, number> = {
  services: 0.15,
  availability: 0.35,
  bookings: 0.15,
  point: 0.05,
  create: 0.3,
}

async function runOhaMix(
  target: Target,
  concurrency: number,
  duration: number,
  timeout: number,
  headers: Record<string, string>,
): Promise<MixedPathResult> {
  const args = ['-z', `${duration}s`, '-c', String(concurrency), '-t', `${timeout}s`, '--no-tui', '-j']
  for (const [name, value] of Object.entries(headers)) args.push('-H', `${name}: ${value}`)
  if (target.randomUrl) args.push('--rand-regex-url')
  if (target.method) args.push('-m', target.method)
  if (target.body) args.push('-d', target.body)
  if (target.contentType) args.push('-T', target.contentType)
  args.push(target.url)

  const proc = Bun.spawn(['oha', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), (duration + timeout + 10) * 1000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`oha ${target.name} exited ${code}: ${stderr.slice(0, 400)}`)
    const raw = JSON.parse(stdout) as {
      languagePercentiles?: Record<string, number>
      latencyPercentiles?: Record<string, number>
      statusCodeDistribution?: Record<string, number>
      errorDistribution?: Record<string, number>
    }
    const status = raw.statusCodeDistribution ?? {}
    const errors = raw.errorDistribution ?? {}
    const attempts = [...Object.values(status), ...Object.values(errors)].reduce((sum, count) => sum + Number(count), 0)
    const ok = Object.entries(status)
      .filter(([code]) => {
        const value = Number(code)
        return value >= 200 && value < 400
      })
      .reduce((sum, [, count]) => sum + Number(count), 0)
    return {
      target: target.name,
      concurrency,
      rps: attempts / duration,
      p95ms: (raw.latencyPercentiles?.p95 ?? 0) * 1000,
      successPct: attempts === 0 ? 0 : (ok / attempts) * 100,
      status,
      errors,
    }
  } finally {
    clearTimeout(timer)
  }
}

function allocateMix(total: number, targets: Target[]): { target: Target; concurrency: number }[] {
  const byName = new Map(targets.map((target) => [target.name, target]))
  const entries = Object.entries(MIX_SHARES)
  let used = 0
  const out: { target: Target; concurrency: number }[] = []
  for (const [index, [name, share]] of entries.entries()) {
    const target = byName.get(name)
    if (!target) throw new Error(`Missing target ${name}`)
    const clients = index === entries.length - 1 ? Math.max(1, total - used) : Math.max(1, Math.round(total * share))
    used += clients
    out.push({ target, concurrency: clients })
  }
  return out
}

async function runMixedLevel(
  level: number,
  duration: number,
  timeout: number,
  headers: Record<string, string>,
  targets: Target[],
): Promise<MixedLevel> {
  const allocations = allocateMix(level, targets)
  const paths = await Promise.all(
    allocations.map(({ target, concurrency }) => runOhaMix(target, concurrency, duration, timeout, headers)),
  )
  const attempts = paths.reduce((sum, path) => sum + (path.rps * duration), 0)
  const ok = paths.reduce((sum, path) => sum + (path.rps * duration * path.successPct) / 100, 0)
  return {
    concurrency: level,
    durationSec: duration,
    totalRps: paths.reduce((sum, path) => sum + path.rps, 0),
    p95ms: Math.max(...paths.map((path) => path.p95ms)),
    successPct: attempts === 0 ? 0 : (ok / attempts) * 100,
    paths,
  }
}

async function runMix(): Promise<void> {
  const options = runOptions()
  if (!Bun.which('oha')) throw new Error('Mixed load needs oha: brew install oha')
  const mixLevels = levels('mix-concurrency', '50,100,200,400')
  const duration = integerFlag('mix-duration', 15)
  const warmup = integerFlag('mix-warmup', 2, 0)
  const headers = {
    'X-Appwrite-Project': options.api.project,
    'X-Appwrite-Key': options.api.key,
  }
  console.log(`mixed booking load: ${options.api.base} project=${options.api.project}`)
  console.log(`levels=${mixLevels.join(',')} duration=${duration}s warmup=${warmup}s`)
  const targets = targetsFor(options)
  const results: MixedLevel[] = []
  for (const level of mixLevels) {
    if (warmup > 0) {
      console.log(`  warmup ${warmup}s at total c=${Math.max(20, Math.round(level / 2))}`)
      await runMixedLevel(Math.max(20, Math.round(level / 2)), warmup, options.timeout, headers, targets)
    }
    const result = await runMixedLevel(level, duration, options.timeout, headers, targets)
    results.push(result)
    console.log(
      `  total c=${String(level).padStart(3)}  ${result.totalRps.toFixed(0).padStart(6)} rps  ` +
        `p95(max)=${result.p95ms.toFixed(0).padStart(5)}ms  ok=${result.successPct.toFixed(2)}%`,
    )
    for (const path of result.paths) {
      console.log(
        `    ${path.target.padEnd(12)} c=${String(path.concurrency).padStart(3)}  ` +
          `${path.rps.toFixed(0).padStart(6)} rps  p95=${path.p95ms.toFixed(0).padStart(5)}ms  ok=${path.successPct.toFixed(2)}%`,
      )
    }
  }

  const report = mixedReport(options, results)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = resolve(options.out, `mix-${stamp}.json`)
  const mdPath = resolve(options.out, `mix-${stamp}.md`)
  mkdirSync(options.out, { recursive: true })
  const safeOptions = {
    manifest: options.manifest,
    api: { ...options.api, key: '[redacted]' },
    duration: options.duration,
    timeout: options.timeout,
  }
  writeFileSync(jsonPath, `${JSON.stringify({ kind: 'booking-mix', options: safeOptions, results }, null, 2)}\n`)
  writeFileSync(mdPath, report)
  console.log(`\n${report}`)
  console.log(`report: ${mdPath}`)
  console.log(`raw:    ${jsonPath}`)
}

function mixedReport(options: RunOptions, results: MixedLevel[]): string {
  const lines: string[] = []
  lines.push('# Booking mixed load test')
  lines.push('')
  lines.push(`- Endpoint: \`${options.api.base}\``)
  lines.push(`- Project: \`${options.api.project}\``)
  lines.push(`- Duration: ${results[0]?.durationSec ?? 0}s per level`)
  lines.push(`- Mix: services 15%, availability 35%, bookings 15%, point 5%, create 30%`)
  lines.push(`- HTML rendering: not tested (disabled on the target)`)
  lines.push('')
  lines.push('## Measured throughput')
  lines.push('')
  lines.push('| Total clients | Total RPS | Worst p95 | Success | Constraint |')
  lines.push('| ---: | ---: | ---: | ---: | --- |')
  for (const result of results) {
    const worst = result.paths.reduce((a, b) => (a.p95ms >= b.p95ms ? a : b))
    const failed = result.paths.find((path) => path.successPct < 99)
    const constraint = failed ? `${failed.target} errors ${(100 - failed.successPct).toFixed(2)}%` : worst.target
    lines.push(
      `| ${result.concurrency} | ${result.totalRps.toFixed(0)} | ${result.p95ms.toFixed(0)} ms | ${result.successPct.toFixed(2)}% | ${constraint} |`,
    )
  }
  lines.push('')
  lines.push('## Path detail')
  lines.push('')
  lines.push('| Total clients | Path | Clients | RPS | p95 | Success |')
  lines.push('| ---: | --- | ---: | ---: | ---: | ---: |')
  for (const result of results) {
    for (const path of result.paths) {
      lines.push(
        `| ${result.concurrency} | ${path.target} | ${path.concurrency} | ${path.rps.toFixed(0)} | ${path.p95ms.toFixed(0)} ms | ${path.successPct.toFixed(2)}% |`,
      )
    }
  }
  lines.push('')
  lines.push('## Capacity at SLO')
  lines.push('')
  lines.push('Active users assume 5 API calls per user per 60 s. Change the assumption if your booking flow makes more or fewer calls.')
  lines.push('')
  lines.push('| SLO | Safe total clients | Throughput | Active users @ 5 calls/60s |')
  lines.push('| --- | ---: | ---: | ---: |')
  for (const slo of [300, 500, 1000]) {
    const passing = results.filter((result) => result.successPct >= 99 && result.p95ms <= slo)
    const best = passing.sort((a, b) => b.concurrency - a.concurrency)[0]
    if (!best) {
      lines.push(`| p95 <= ${slo} ms | none | 0 rps | 0 |`)
    } else {
      lines.push(`| p95 <= ${slo} ms | ${best.concurrency} | ${best.totalRps.toFixed(0)} rps | ${((best.totalRps * 60) / 5).toFixed(0)} |`)
    }
  }
  lines.push('')
  lines.push('## Qualification')
  lines.push('')
  lines.push('This is a real concurrent mix: each path runs at the same time with clients split by the mix percentages.')
  lines.push('It still runs from a remote client, so the numbers include network/TLS latency and the client machine.')
  lines.push('It excludes HTML/PDF rendering, WebSocket realtime, file uploads, function runs and console traffic.')
  return `${lines.join('\n')}\n`
}

interface Capacity {
  target: string
  concurrency: number
  rps: number
  p95ms: number
  successPct: number
}

interface Slo {
  label: string
  p95ms: number
}

function capacityAt(results: RunResult[], target: string, slo: Slo): Capacity | null {
  const passing = results.filter(
    (result) => result.target === target && result.successPct >= 99 && result.p95ms <= slo.p95ms,
  )
  if (passing.length === 0) return null
  const best = passing.sort((a, b) => b.concurrency - a.concurrency)[0]!
  return {
    target: best.target,
    concurrency: best.concurrency,
    rps: best.rps,
    p95ms: best.p95ms,
    successPct: best.successPct,
  }
}

function markdownReport(options: RunOptions, results: RunResult[], file: string): string {
  const slos: Slo[] = [
    { label: 'strict (p95 <= 300 ms)', p95ms: 300 },
    { label: 'balanced (p95 <= 500 ms)', p95ms: 500 },
    { label: 'loose (p95 <= 1000 ms)', p95ms: 1000 },
  ]
  const weights: Record<string, number> = {
    services: 0.15,
    availability: 0.35,
    bookings: 0.15,
    point: 0.05,
    create: 0.3,
  }
  const requestsPerSession = 5
  const sessionSeconds = 60
  const lines: string[] = []
  lines.push('# Booking load test')
  lines.push('')
  lines.push(`- Endpoint: \`${options.api.base}\``)
  lines.push(`- Project: \`${options.api.project}\``)
  lines.push(`- Database: \`${options.manifest.database}\``)
  lines.push(`- Prefix: \`${options.manifest.prefix}\``)
  lines.push(`- Seeded: ${options.manifest.services} services, ${options.manifest.services * options.manifest.days * options.manifest.slotsPerDay} slots, ${options.manifest.bookings} bookings`)
  lines.push(`- Run: ${options.duration}s per level, warmup ${options.warmup}s, concurrency ${options.concurrency.join(', ')}`)
  lines.push(`- HTML rendering: not tested (disabled on the target)`)
  lines.push('')
  lines.push('## Per-path results')
  lines.push('')
  lines.push('| Path | Concurrency | RPS | p50 | p95 | p99 | OK |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const result of results) {
    lines.push(
      `| ${result.target} | ${result.concurrency} | ${result.rps.toFixed(0)} | ${result.p50ms.toFixed(1)} ms | ${result.p95ms.toFixed(1)} ms | ${result.p99ms.toFixed(1)} ms | ${result.successPct.toFixed(2)}% |`,
    )
  }
  lines.push('')
  lines.push('## Estimated capacity')
  lines.push('')
  lines.push('Model: one active user makes 5 API calls per 60 s (15% services, 35% availability, 15% bookings, 5% point, 30% create).')
  lines.push('The mixed RPS is the harmonic combination of each path at the highest passing concurrency; the user count is a model, not a measured WebSocket/session count.')
  lines.push('')
  lines.push('| SLO | Mixed RPS | Active users @ 5 calls/60s | Concurrent requests | Limiting path |')
  lines.push('| --- | ---: | ---: | ---: | --- |')
  for (const slo of slos) {
    const capacities = Object.keys(weights)
      .map((target) => capacityAt(results, target, slo))
      .filter((entry): entry is Capacity => entry !== null)
    if (capacities.length === 0) {
      lines.push(`| ${slo.label} | 0 | 0 | 0 | none passed |`)
      continue
    }
    const totalWeight = capacities.reduce((sum, entry) => sum + (weights[entry.target] ?? 0), 0)
    const mixedRps = 1 / capacities.reduce((sum, entry) => sum + (weights[entry.target] ?? 0) / Math.max(0.001, entry.rps), 0)
    const activeUsers = (mixedRps * sessionSeconds) / requestsPerSession
    const avgLatency = capacities.reduce((sum, entry) => sum + (weights[entry.target] ?? 0) * entry.p95ms, 0) / totalWeight
    const concurrent = (mixedRps * avgLatency) / 1000
    const limiting = capacities.sort((a, b) => a.rps - b.rps)[0]!
    lines.push(
      `| ${slo.label} | ${mixedRps.toFixed(0)} | ${activeUsers.toFixed(0)} | ${concurrent.toFixed(1)} | ${limiting.target} (${limiting.rps.toFixed(0)} rps) |`,
    )
  }
  lines.push('')
  lines.push('## Qualification')
  lines.push('')
  lines.push('These are HTTP API numbers from a remote client. They include network and TLS latency, so they are lower than a local loopback benchmark.')
  lines.push('The estimate excludes HTML/PDF rendering, WebSocket realtime connections, large file uploads, function runs and admin console traffic.')
  lines.push('Use the lowest SLO that still feels acceptable for the booking flow, and leave headroom for traffic spikes and SQLite maintenance.')
  lines.push('')
  lines.push(`Raw results: \`${file}\``)
  return `${lines.join('\n')}\n`
}

async function run(): Promise<void> {
  await runWith(runOptions())
}

async function cleanup(): Promise<void> {
  const base = normalizeBase(required(flag('base') ?? env('STRESS_BASE'), '--base (or STRESS_BASE)'))
  const project = required(flag('project') ?? env('STRESS_PROJECT'), '--project (or STRESS_PROJECT)')
  const key = required(flag('key') ?? env('STRESS_API_KEY'), '--key (or STRESS_API_KEY)')
  const database = flag('database') ?? DEFAULT_DATABASE
  assertId(database, '--database')
  if (!/stress/i.test(database) && !boolFlag('yes')) {
    throw new Error('Refusing to delete a database without "stress" in its name; pass --yes to override.')
  }
  if (!boolFlag('yes')) {
    console.log(`Would delete ${database}. Pass --yes to confirm.`)
    process.exit(0)
  }
  const result = await api({ base, project, key, timeout: 30 }, 'DELETE', `/databases/${encodeURIComponent(database)}`)
  assertOk(result, 'delete database', [404])
  console.log(`deleted ${database}`)
}

function usage(): void {
  console.log(`Booking-app stress test for Bunwrite.

Usage:
  bun run stress:booking setup [options]
  bun run stress:booking run   [options]
  bun run stress:booking mix   [options]
  bun run stress:booking all   [options]
  bun run stress:booking cleanup --yes [options]

Common:
  --base <url>            API root, e.g. https://bunwrite.example.com/v1
  --project <id>          X-Appwrite-Project
  --key <key>             API key (or STRESS_API_KEY)
  --database <id>         Default: ${DEFAULT_DATABASE}
  --prefix <text>         Document prefix (letters, digits, . _ -)
  --manifest <path>       Manifest written by setup
  --timeout <seconds>     Request timeout, default ${DEFAULT_TIMEOUT}

Setup:
  --services <n>          Default: ${DEFAULT_SERVICES}
  --days <n>              Default: ${DEFAULT_DAYS}
  --slots-per-day <n>     Default: ${DEFAULT_SLOTS_PER_DAY}
  --bookings <n>          Default: ${DEFAULT_BOOKINGS}
  --batch <n>             Bulk write batch size, default ${DEFAULT_BATCH}
  --reset                 Delete the stress database first (name must contain "stress")

Run:
  --concurrency <list>    Default: ${DEFAULT_CONCURRENCY}
  --write-concurrency <list> Default: ${DEFAULT_WRITE_CONCURRENCY}
  --duration <seconds>    Per level, default ${DEFAULT_DURATION}
  --warmup <seconds>      Default ${DEFAULT_WARMUP}
  --mix-concurrency <list> Mixed clients, default: 50,100,200,400
  --mix-duration <seconds> Mixed level, default 15
  --mix-warmup <seconds>  Mixed warmup, default 2
  --total                 Request total=true on list queries
  --tool <auto|oha|builtin> Default: auto
  --out <dir>             Default: data/stress

Environment:
  STRESS_API_KEY, STRESS_PROJECT, STRESS_BASE, STRESS_MANIFEST

Paths measured:
  services      list active services
  availability  list one service's slots for tomorrow
  bookings      list a user's bookings (limit 20)
  point         get one booking by ID
  create        PUT a new booking (random ID)

The report estimates active users from a 5-call booking session every 60s.
HTML rendering is intentionally excluded; it is off on the target host.`)
}

try {
  if (command === 'setup') await setup()
  else if (command === 'run') await run()
  else if (command === 'mix') await runMix()
  else if (command === 'cleanup') await cleanup()
  else {
    const manifest = await setup()
    const next = runOptionsFromManifest(manifest)
    await runWith(next)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

function runOptionsFromManifest(manifest: Manifest): RunOptions {
  return {
    manifest,
    api: {
      base: normalizeBase(flag('base') ?? env('STRESS_BASE') ?? manifest.base),
      project: flag('project') ?? env('STRESS_PROJECT') ?? manifest.project,
      key: required(flag('key') ?? env('STRESS_API_KEY'), '--key (or STRESS_API_KEY)'),
      timeout: numberFlag('timeout', DEFAULT_TIMEOUT),
    },
    concurrency: levels('concurrency', DEFAULT_CONCURRENCY),
    writeConcurrency: levels('write-concurrency', DEFAULT_WRITE_CONCURRENCY),
    duration: integerFlag('duration', DEFAULT_DURATION),
    warmup: integerFlag('warmup', DEFAULT_WARMUP, 0),
    timeout: integerFlag('timeout', DEFAULT_TIMEOUT),
    tool: (flag('tool') ?? env('STRESS_TOOL') ?? 'auto') as RunOptions['tool'],
    total: boolFlag('total'),
    out: flag('out') ?? 'data/stress',
  }
}

async function runWith(options: RunOptions): Promise<void> {
  const targets = targetsFor(options)
  const { results, file } = await runMatrix({
    targets,
    headers: {
      'X-Appwrite-Project': options.api.project,
      'X-Appwrite-Key': options.api.key,
    },
    concurrency: options.concurrency,
    duration: options.duration,
    warmup: options.warmup,
    timeout: options.timeout,
    tool: options.tool,
    outDir: options.out,
    meta: {
      kind: 'booking',
      startedAt: new Date().toISOString(),
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      base: options.api.base,
      project: options.api.project,
      database: options.manifest.database,
      prefix: options.manifest.prefix,
      concurrency: options.concurrency,
      writeConcurrency: options.writeConcurrency,
      durationSec: options.duration,
      requestsPerSession: 5,
      sessionSeconds: 60,
    },
    log: (line) => console.log(line),
  })
  const report = markdownReport(options, results, file)
  const reportPath = file.replace(/\.json$/, '.md')
  writeFileSync(reportPath, report)
  console.log(`\n${report}`)
  console.log(`report: ${reportPath}`)
}
