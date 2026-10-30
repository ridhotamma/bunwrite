/**
 * Reproducible seed + load-test tool for Bunwrite.
 *
 *   bun run stress seed --config appwrite.config.json --count 20000
 *   bun run stress run  --config appwrite.config.json --prefix stress-...
 *
 * `seed` writes through the normal Appwrite-compatible API; `run` measures
 * HTTP throughput and latency with oha when it is installed.
 */
import { resolve } from 'node:path'

import { makeDocument, seed, type CollectionDef, type ColumnDef } from './seed'
import { createCli, randomId } from './lib'
import { runMatrix, type Target } from './run'

interface AppwriteConfig {
  projectId?: string
  tablesDB?: any[]
  databases?: any[]
  tables?: any[]
  collections?: any[]
}

const argv = process.argv.slice(2)
const first = argv[0]
if (!first || first === '--help' || first === '-h' || first === 'help') {
  usage()
  process.exit(0)
}
const command = first
if (command !== 'seed' && command !== 'run') {
  usage()
  process.exit(1)
}
const args = argv.slice(1)
if (args.includes('--help') || args.includes('-h')) {
  usage()
  process.exit(0)
}

const { flag, has, numberFlag } = createCli(args)

function listFlag(name: string): string[] {
  const raw = flag(name)
  return raw ? raw.split(',').map((value) => value.trim()).filter(Boolean) : []
}

function extraHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    let raw: string | undefined
    if (arg === '--header') raw = args[++i]
    else if (arg.startsWith('--header=')) raw = arg.slice('--header='.length)
    if (!raw) continue
    const colon = raw.indexOf(':')
    if (colon <= 0) throw new Error(`Invalid --header "${raw}"; use "Name: value"`)
    headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim()
  }
  return headers
}

const configPath = flag('config') ?? process.env.STRESS_CONFIG
const config = configPath ? ((await Bun.file(resolve(configPath)).json()) as AppwriteConfig) : undefined
const tables: any[] = config?.tables ?? config?.collections ?? []
const databases: any[] = config?.tablesDB ?? config?.databases ?? []
const findTable = (id: string) => tables.find((table) => table.$id === id)
const asCollectionDef = (table: any): CollectionDef => ({
  $id: table.$id,
  databaseId: table.databaseId,
  columns: (table.columns ?? table.attributes ?? []) as ColumnDef[],
})

const requestedCollection = flag('collection') ?? process.env.STRESS_COLLECTION
const collection = requestedCollection ?? (findTable('products') ? 'products' : (tables[0]?.$id as string | undefined)) ?? 'products'
const collectionRaw = findTable(collection)
const collectionDef = collectionRaw ? asCollectionDef(collectionRaw) : undefined
const columnNames = new Set((collectionDef?.columns ?? []).map((column) => column.key))
const hasColumn = (name: string) => columnNames.size === 0 || columnNames.has(name)
const database = flag('database') ?? process.env.STRESS_DATABASE ?? (collectionRaw?.databaseId as string | undefined) ?? (databases[0]?.$id as string | undefined)

const project = flag('project') ?? process.env.STRESS_PROJECT ?? process.env.PROJECT_ID ?? config?.projectId
const key = flag('key') ?? process.env.STRESS_API_KEY ?? process.env.APPWRITE_API_KEY
const session = flag('session') ?? process.env.STRESS_SESSION
const jwt = flag('jwt') ?? process.env.STRESS_JWT
const base = (flag('base') ?? process.env.STRESS_BASE ?? 'http://localhost:8080/v1').replace(/\/$/, '')
const prefix = flag('prefix') ?? process.env.STRESS_PREFIX
const headersFromCli = extraHeaders()

function apiHeaders(requireAuth: boolean): Record<string, string> {
  if (requireAuth && !project) throw new Error('Pass --project, or set STRESS_PROJECT / PROJECT_ID / --config with projectId.')
  if (requireAuth && !key && !session && !jwt) throw new Error('Pass --key, --session or --jwt (or set STRESS_API_KEY).')
  const headers: Record<string, string> = {}
  if (project) headers['X-Appwrite-Project'] = project
  if (key) headers['X-Appwrite-Key'] = key
  if (session) headers['X-Appwrite-Session'] = session
  if (jwt) headers['X-Appwrite-JWT'] = jwt
  return { ...headers, ...headersFromCli }
}

const concurrency = (flag('concurrency') ?? '1,10,50,100,200').split(',').map((value) => Number(value.trim()))
const duration = numberFlag('duration', 10)
const warmup = numberFlag('warmup', 3)
const timeout = numberFlag('timeout', 10)
const limit = numberFlag('limit', 25)
const total = has('total')
const select = listFlag('select')
const tenantAttribute = flag('tenant-attribute') ?? 'tenantId'
const tenantValue = flag('tenant-value') ?? process.env.STRESS_TENANT ?? (prefix ? `${prefix}-tenant-00` : undefined)
const status = flag('status') ?? (collection === 'products' && hasColumn('status') ? 'active' : '')
const order = flag('order') ?? (collection === 'products' && hasColumn('soldCount') ? 'soldCount' : '')
const orderDesc = has('order-desc') || (Boolean(order) && collection === 'products' && !has('order-asc') && flag('order') === undefined)
const pointId = flag('point-id') ?? (prefix ? `${prefix}-000000` : undefined)
const write = has('write')
const writeCollection = flag('write-collection') ?? 'customers'
const writeTenant = flag('write-tenant') ?? (prefix ? `${prefix}-write` : 'stress-write')

if (concurrency.length === 0 || concurrency.some((value) => !Number.isInteger(value) || value < 1)) {
  throw new Error('--concurrency must be a comma-separated list of positive integers')
}
if (!Number.isFinite(duration) || duration <= 0) throw new Error('--duration must be greater than 0')
if (!Number.isFinite(warmup) || warmup < 0) throw new Error('--warmup must be 0 or greater')
if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('--timeout must be greater than 0')
if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer')

if (command === 'seed') {
  if (!database) throw new Error('Pass --database, or use --config with a database definition.')
  if (!key) throw new Error('Seeding uses bulk create: pass --key (or set STRESS_API_KEY).')
  const count = numberFlag('count', 20000)
  const batch = numberFlag('batch', 500)
  const tenants = numberFlag('tenants', 20)
  if (!Number.isInteger(count) || count < 1) throw new Error('--count must be a positive integer')
  if (!Number.isInteger(batch) || batch < 1) throw new Error('--batch must be a positive integer')
  if (!Number.isInteger(tenants) || tenants < 1) throw new Error('--tenants must be a positive integer')
  const dataRaw = flag('data')
  let data: Record<string, unknown> | undefined
  if (dataRaw) {
    const parsed = JSON.parse(dataRaw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--data must be a JSON object')
    data = parsed
  }
  if (!collectionDef && !data) {
    throw new Error(`Collection "${collection}" was not found in ${configPath ?? 'the config'}. Pass --data or a valid --collection.`)
  }
  const seedPrefix = prefix ?? `stress-${timestamp()}`
  const result = await seed({
    base,
    headers: apiHeaders(true),
    database,
    collection,
    collectionDef,
    count,
    batch,
    prefix: seedPrefix,
    tenants,
    data,
    upsert: has('upsert'),
    dryRun: has('dry-run'),
    log: (line) => console.log(line),
  })
  if (has('dry-run')) process.exit(0)
  const seconds = result.durationMs / 1000
  console.log(`\nseeded ${result.count} documents in ${seconds.toFixed(2)}s (${Math.round(result.count / Math.max(0.001, seconds))}/s)`)
  console.log(`prefix:      ${result.prefix}`)
  console.log(`first id:    ${result.firstId}`)
  console.log(`first tenant: ${result.firstTenant}`)
  const next = [
    'bun run stress run',
    `--base ${base}`,
    project ? `--project ${project}` : '',
    '--key "$STRESS_API_KEY"',
    configPath ? `--config ${JSON.stringify(configPath)}` : '',
    `--database ${database}`,
    `--collection ${collection}`,
    `--prefix ${result.prefix}`,
    status ? `--status ${JSON.stringify(status)}` : '',
    order ? `--order ${order}` : '',
    orderDesc ? '--order-desc' : '',
    `--limit ${limit}`,
    total ? '--total' : '',
    select.length ? `--select ${select.join(',')}` : '',
    write ? '--write' : '',
    `--concurrency ${concurrency.join(',')}`,
    `--duration ${duration}`,
  ].filter(Boolean).join(' ')
  console.log(`\nnext:\n  ${next}`)
  process.exit(0)
}

const targets: Target[] = []
const targetsPath = flag('targets')
const customUrl = flag('url')
if (targetsPath) {
  const raw = (await Bun.file(resolve(targetsPath)).json()) as unknown
  if (!Array.isArray(raw)) throw new Error('--targets must be a JSON array')
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') throw new Error(`Target ${index} must be an object`)
    const target = entry as Record<string, any>
    if (typeof target.url !== 'string') throw new Error(`Target ${index} needs a string url`)
    const levels = Array.isArray(target.concurrency) ? target.concurrency.map(Number) : undefined
    if (levels && (levels.length === 0 || levels.some((value) => !Number.isInteger(value) || value < 1))) {
      throw new Error(`Target ${index} has an invalid concurrency list`)
    }
    targets.push({
      name: String(target.name ?? `target-${index}`),
      url: target.url,
      method: target.method,
      headers: target.headers,
      body: typeof target.body === 'string' ? target.body : target.body ? JSON.stringify(target.body) : undefined,
      contentType: target.contentType,
      randomUrl: Boolean(target.randomUrl),
      concurrency: levels,
    })
  }
} else if (customUrl) {
  const body = flag('body') ?? (flag('body-file') ? await Bun.file(resolve(flag('body-file')!)).text() : undefined)
  targets.push({
    name: flag('name') ?? 'custom',
    url: customUrl,
    method: flag('method') ?? 'GET',
    body,
    contentType: flag('content-type') ?? (body ? 'application/json' : undefined),
    randomUrl: has('random-url'),
  })
} else {
  targets.push({ name: 'health', url: `${base}/health` })
  if (database && collection) {
    if (!project) throw new Error('Pass --project, or set PROJECT_ID, for the built-in collection targets.')
    if (!key && !session && !jwt) throw new Error('Pass --key, --session or --jwt for the built-in collection targets.')
    const documents = `${base}/databases/${database}/collections/${collection}/documents`
    const queries: unknown[] = []
    if (tenantAttribute && tenantValue && hasColumn(tenantAttribute)) {
      queries.push({ method: 'equal', attribute: tenantAttribute, values: [tenantValue] })
    }
    if (status && hasColumn('status')) queries.push({ method: 'equal', attribute: 'status', values: [status] })
    if (order && hasColumn(order)) queries.push({ method: orderDesc ? 'orderDesc' : 'orderAsc', attribute: order })
    queries.push({ method: 'limit', values: [limit] })
    if (select.length > 0) {
      const valid = select.filter((name) => name.startsWith('$') || hasColumn(name))
      if (valid.length > 0) queries.push({ method: 'select', values: valid })
    }
    const query = queries.map((entry, index) => `queries[${index}]=${encodeURIComponent(JSON.stringify(entry))}`).join('&')
    targets.push({ name: 'list', url: `${documents}?${query}&total=${total}` })
    if (pointId) targets.push({ name: 'point', url: `${documents}/${encodeURIComponent(pointId)}` })
    if (write) {
      const writeRaw = findTable(writeCollection)
      const writeDef = writeRaw ? asCollectionDef(writeRaw) : undefined
      const writeDb = (writeRaw?.databaseId as string | undefined) ?? database
      const writeBase = `${base}/databases/${writeDb}/collections/${writeCollection}/documents`
      let writeBody = flag('write-body')
      if (!writeBody) {
        const doc = writeDef ? makeDocument(writeDef, 0, prefix ?? 'stress', writeTenant) : { tenantId: writeTenant, name: 'Stress Customer' }
        delete doc.$id
        writeBody = JSON.stringify({ data: doc })
      }
      JSON.parse(writeBody)
      const fixedUrl = flag('write-url')
      targets.push({
        name: 'write',
        url: fixedUrl ?? `${writeBase}/write-[a-z0-9]{12}`,
        method: 'PUT',
        body: writeBody,
        contentType: 'application/json',
        randomUrl: fixedUrl ? has('random-url') : true,
        urlFor: fixedUrl ? undefined : () => `${writeBase}/write-${randomId()}`,
      })
    }
  } else {
    console.log('No --database/--collection; running only the health target. Use --url or --targets for other endpoints.')
  }
}

const tool = (flag('tool') ?? 'auto') as 'auto' | 'oha' | 'builtin'
if (!['auto', 'oha', 'builtin'].includes(tool)) throw new Error('--tool must be auto, oha or builtin')
await runMatrix({
  targets,
  headers: apiHeaders(false),
  concurrency,
  duration,
  warmup,
  timeout,
  tool,
  outDir: flag('out') ?? 'data/stress',
  meta: {
    startedAt: new Date().toISOString(),
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    base,
    project,
    database,
    collection,
    prefix,
    tenantAttribute,
    tenantValue,
    status,
    order,
    orderDesc,
    limit,
    total,
    select,
    concurrency,
    durationSec: duration,
  },
})

function timestamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}

function usage(): void {
  console.log(`Stress-test Bunwrite through its normal HTTP API.

Usage:
  bun run stress seed [options]
  bun run stress run  [options]

Common:
  --base <url>              API root (default http://localhost:8080/v1)
  --project <id>            X-Appwrite-Project (or STRESS_PROJECT / PROJECT_ID)
  --key <key>               API key (or STRESS_API_KEY / APPWRITE_API_KEY)
  --session <secret>        X-Appwrite-Session
  --jwt <token>             X-Appwrite-JWT
  --header "Name: value"    Extra header (repeatable)
  --config <path>           appwrite.config.json (fills project/database/collection)
  --database <id>           Database ID
  --collection <id>         Collection ID (default products)
  --prefix <text>           Seed prefix (default stress-<timestamp>)
  --limit <n>               Rows per list page (default 25)
  --select <a,b>            Return only these columns
  --total                   Include total=true in list queries
  --status <value>          Status filter (default active for products; empty disables)
  --order <attribute>       Order attribute (default soldCount for products)
  --order-desc              Descending order
  --tenant-attribute <key>  Tenant attribute (default tenantId; empty disables)
  --tenant-value <value>    Tenant value (default <prefix>-tenant-00)
  --point-id <id>           Point-read ID (default <prefix>-000000)
  --concurrency <list>      Default 1,10,50,100,200
  --duration <seconds>      Default 10
  --warmup <seconds>        Default 3
  --timeout <seconds>       Default 10
  --tool <auto|oha|builtin> Default auto (oha is recommended: brew install oha)
  --out <dir>               Report directory (default data/stress)
  --write                   Also test the upsert write target
  --write-collection <id>   Write collection (default customers)
  --write-body <json>       Override the {data:...} write body
  --write-url <url>         Override the write URL
  --targets <file>          JSON array of custom targets
  --url <url>               Single custom target
  --name <name>             Custom target name (default custom)
  --method <method>         Custom target method
  --body <json>             Custom target body
  --body-file <path>        Custom target body file
  --content-type <type>     Custom target content type
  --random-url              Treat the custom URL as an oha regex
  --help                    Show this help

Seed:
  --count <n>               Default 20000
  --batch <n>               Default 500
  --tenants <n>             Default 20
  --data <json>             Override generated fields; supports {{i}}, {{tenant}}, {{prefix}}
  --upsert                  Use PUT bulk upsert instead of POST create
  --dry-run                 Print one document and the endpoint, do not write

Examples:
  export STRESS_API_KEY=your-api-key
  bun run stress seed --base http://localhost:8080/v1 \\
    --config ../pesanle/packages/appwrite-config/appwrite.config.json --count 20000

  bun run stress run --base http://localhost:8080/v1 \\
    --config ../pesanle/packages/appwrite-config/appwrite.config.json \\
    --prefix stress-20261028120000 --concurrency 1,10,50,100,200

  bun run stress run --url http://localhost:8080/v1/health --concurrency 10,50,100
  bun run stress run --targets stress-targets.json`)
}
