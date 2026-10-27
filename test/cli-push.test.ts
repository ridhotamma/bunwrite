/**
 * The calls `appwrite push tables`, `push collections` and `push functions`
 * make, through node-appwrite (the SDK the CLI is built on).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, Databases, Functions, ID, Query, TablesDB } from 'node-appwrite'

import { deploymentDir } from '~/functions/deployments'
import { DB, failure, KEY, PROJECT, startServer, testSchema, type TestServer } from './helpers'

let server: TestServer
let tables: any
let databases: any
let functions: any
let work: string

/** Columns whose read-back shape `appwrite push` is picky about. */
const tricky = [
  { key: 'title', type: 'string', required: true, array: false, size: 128, default: null, encrypt: false },
  { key: 'email', type: 'string', required: false, array: false, default: null, format: 'email' },
  { key: 'contact', type: 'string', required: false, array: false, size: 255, default: null, encrypt: false, format: 'email' },
  { key: 'state', type: 'string', required: false, array: false, default: 'open', format: 'enum', elements: ['open', 'closed'] },
  { key: 'site', type: 'string', required: false, array: false, default: null, format: 'url' },
  { key: 'seenAt', type: 'datetime', required: false, array: false, default: null, format: '' },
  { key: 'paidAt', type: 'datetime', required: false, array: false, default: null, format: 'datetime' },
  { key: 'count', type: 'integer', required: false, array: false, default: 0, min: 0, max: 1000 },
  { key: 'rate', type: 'double', required: false, array: false, default: 0, min: 0, max: 100 },
  { key: 'flag', type: 'boolean', required: false, array: false, default: false },
  { key: 'tags', type: 'string', required: false, array: true, size: 64, default: null, encrypt: false },
]

beforeAll(() => {
  const schema = structuredClone(testSchema) as any
  schema.tables.push({
    $id: 'tricky',
    databaseId: DB,
    name: 'Tricky',
    enabled: true,
    rowSecurity: false,
    $permissions: ['read("any")'],
    columns: tricky,
    indexes: [{ key: 'idx_title', type: 'key', status: 'available', columns: ['title'], orders: ['ASC'] }],
  })
  server = startServer(schema)
  const client = new Client().setEndpoint(server.endpoint).setProject(PROJECT).setKey(KEY)
  tables = new TablesDB(client)
  databases = new Databases(client)
  functions = new Functions(client)
  work = mkdtempSync(join(tmpdir(), 'bunwrite-push-'))
})

afterAll(() => {
  server.stop()
  rmSync(work, { recursive: true, force: true })
})

// The CLI's own comparison (lib/commands/push.ts, Attributes.checkAttributeChanges).
const COMPARED = ['key', 'type', 'required', 'array', 'size', 'default', 'min', 'max', 'format', 'elements', 'relatedCollection', 'relatedTable', 'relationType', 'twoWay', 'twoWayKey', 'onDelete', 'side', 'attributes', 'orders', 'encrypt']
const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)
const isEqual = (a: unknown, b: unknown) => a === b || (typeof a === 'object' && typeof b === 'object' && a && b ? JSON.stringify(a) === JSON.stringify(b) : String(a) === String(b))
function differences(remote: Record<string, unknown>, local: Record<string, unknown>): string[] {
  return Object.keys(remote)
    .filter((k) => COMPARED.includes(k))
    .filter((k) => !(isEmpty(remote[k]) && isEmpty(local[k])) && !isEqual(remote[k], local[k]))
}

describe('push tables', () => {
  test('columns read back exactly as defined, so a re-push changes nothing', async () => {
    const table = await tables.getTable({ databaseId: DB, tableId: 'tricky' })
    expect(table).toMatchObject({ $id: 'tricky', name: 'Tricky', enabled: true, rowSecurity: false, $permissions: ['read("any")'] })
    for (const local of tricky) {
      const remote = table.columns.find((c: any) => c.key === local.key)
      expect({ key: local.key, diff: differences(remote, local) }).toEqual({ key: local.key, diff: [] })
      expect(remote.status).toBe('available')
    }
    expect(table.indexes).toEqual([expect.objectContaining({ key: 'idx_title', type: 'key', status: 'available', columns: ['title'], orders: ['ASC'] })])
  })

  test('email and enum columns saved with the old default size still read back without one', async () => {
    const stored = JSON.parse(server.db.sqlite.query<any, []>("SELECT attributes FROM _collections WHERE id = 'tricky'").get()!.attributes)
    expect(stored.find((a: any) => a.key === 'email').size).toBe(16384)
    const email = await tables.getColumn({ databaseId: DB, tableId: 'tricky', key: 'email' })
    expect(email).not.toHaveProperty('size')
    expect(email).not.toHaveProperty('encrypt')
  })

  test('database, table, columns and indexes: create, read, update, delete', async () => {
    const db = await tables.create({ databaseId: 'crm', name: 'CRM' })
    expect(db).toMatchObject({ $id: 'crm', name: 'CRM', enabled: true })
    expect(await failure(tables.create({ databaseId: 'crm', name: 'again' }))).toMatchObject({ code: 409 })
    expect((await tables.list()).databases.map((d: any) => d.$id)).toContain('crm')

    await tables.createTable({ databaseId: 'crm', tableId: 'leads', name: 'Leads', permissions: ['read("any")'], rowSecurity: true })
    await tables.createStringColumn({ databaseId: 'crm', tableId: 'leads', key: 'name', size: 100, required: true, encrypt: false })
    await tables.createEmailColumn({ databaseId: 'crm', tableId: 'leads', key: 'email', required: false })
    await tables.createEnumColumn({ databaseId: 'crm', tableId: 'leads', key: 'stage', elements: ['new', 'won'], required: false, xdefault: 'new' })
    await tables.createIntegerColumn({ databaseId: 'crm', tableId: 'leads', key: 'score', required: false, min: 0, max: 10 })
    await tables.createFloatColumn({ databaseId: 'crm', tableId: 'leads', key: 'value', required: false })
    await tables.createBooleanColumn({ databaseId: 'crm', tableId: 'leads', key: 'hot', required: false, xdefault: false })
    await tables.createDatetimeColumn({ databaseId: 'crm', tableId: 'leads', key: 'closedAt', required: false })
    await tables.createIndex({ databaseId: 'crm', tableId: 'leads', key: 'idx_stage', type: 'key', columns: ['stage', 'score'], orders: ['ASC', 'DESC'] })

    const columns = await tables.listColumns({ databaseId: 'crm', tableId: 'leads', queries: [Query.limit(100)] })
    expect(columns.columns.map((c: any) => [c.key, c.type, c.format ?? null])).toEqual([
      ['name', 'string', null],
      ['email', 'string', 'email'],
      ['stage', 'string', 'enum'],
      ['score', 'integer', null],
      ['value', 'double', null],
      ['hot', 'boolean', null],
      ['closedAt', 'datetime', ''],
    ])
    expect(columns.columns.every((c: any) => c.status === 'available')).toBe(true)
    expect(await failure(tables.createStringColumn({ databaseId: 'crm', tableId: 'leads', key: 'name', size: 10, required: false }))).toMatchObject({ code: 409 })

    // Rows work against the new columns.
    await databases.createDocument({ databaseId: 'crm', collectionId: 'leads', documentId: 'l1', data: { name: 'Ada', email: 'ada@example.com', score: 7 } })
    expect(await databases.getDocument({ databaseId: 'crm', collectionId: 'leads', documentId: 'l1' })).toMatchObject({ stage: 'new', hot: false, score: 7 })

    // Changeable fields update in place; the data stays.
    const updated = await tables.updateIntegerColumn({ databaseId: 'crm', tableId: 'leads', key: 'score', required: false, min: 0, max: 100, xdefault: 1 })
    expect(updated).toMatchObject({ key: 'score', min: 0, max: 100, default: 1 })
    expect(await failure(tables.updateEmailColumn({ databaseId: 'crm', tableId: 'leads', key: 'score', required: false, xdefault: null }))).toMatchObject({ code: 400 })
    expect((await databases.getDocument({ databaseId: 'crm', collectionId: 'leads', documentId: 'l1' })).score).toBe(7)

    await tables.updateTable({ databaseId: 'crm', tableId: 'leads', name: 'Prospects', rowSecurity: false, permissions: [] })
    expect(await tables.getTable({ databaseId: 'crm', tableId: 'leads' })).toMatchObject({ name: 'Prospects', rowSecurity: false, $permissions: [] })

    await tables.deleteIndex({ databaseId: 'crm', tableId: 'leads', key: 'idx_stage' })
    await tables.deleteColumn({ databaseId: 'crm', tableId: 'leads', key: 'hot' })
    const after = await tables.getTable({ databaseId: 'crm', tableId: 'leads' })
    expect(after.indexes).toEqual([])
    expect(after.columns.map((c: any) => c.key)).not.toContain('hot')

    expect((await tables.listTables({ databaseId: 'crm' })).tables.map((t: any) => t.$id)).toEqual(['leads'])
    await tables.deleteTable({ databaseId: 'crm', tableId: 'leads' })
    expect(await failure(tables.getTable({ databaseId: 'crm', tableId: 'leads' }))).toMatchObject({ code: 404 })
    await tables.update({ databaseId: 'crm', name: 'Sales', enabled: false })
    expect(await tables.get({ databaseId: 'crm' })).toMatchObject({ name: 'Sales', enabled: false })
    await tables.delete({ databaseId: 'crm' })
    expect(await failure(tables.get({ databaseId: 'crm' }))).toMatchObject({ code: 404 })
  })

  test('relationship and geo columns are refused, not half-made', async () => {
    const res = await failure(tables.createPointColumn({ databaseId: DB, tableId: 'tricky', key: 'where', required: false }))
    expect(res.code).toBe(400)
    expect((await tables.getTable({ databaseId: DB, tableId: 'tricky' })).columns.map((c: any) => c.key)).not.toContain('where')
  })

  test('writes need an API key', async () => {
    const guest = new TablesDB(new Client().setEndpoint(server.endpoint).setProject(PROJECT))
    expect((await failure(guest.create({ databaseId: 'nope', name: 'nope' }))).code).toBe(401)
  })
})

describe('push collections', () => {
  test('a collection can be created with its attributes and indexes in one call', async () => {
    await databases.create({ databaseId: 'legacy', name: 'Legacy' })
    await databases.createCollection({
      databaseId: 'legacy',
      collectionId: 'posts',
      name: 'Posts',
      documentSecurity: true,
      permissions: [],
      attributes: [
        { key: 'title', type: 'string', size: 200, required: true, array: false },
        { key: 'kind', type: 'string', format: 'enum', elements: ['a', 'b'], required: false, array: false, default: 'a' },
        { key: 'score', type: 'double', required: false, array: false },
      ],
      indexes: [{ key: 'idx_title', type: 'fulltext', attributes: ['title'], orders: ['ASC'] }],
    })
    const posts = await databases.getCollection({ databaseId: 'legacy', collectionId: 'posts' })
    expect(posts.documentSecurity).toBe(true)
    expect(posts.attributes.map((a: any) => a.key)).toEqual(['title', 'kind', 'score'])
    expect(posts.indexes[0]).toMatchObject({ key: 'idx_title', type: 'fulltext', attributes: ['title'] })
    const attrs = await databases.listAttributes({ databaseId: 'legacy', collectionId: 'posts', queries: [Query.limit(1)] })
    expect([attrs.total, attrs.attributes.length]).toEqual([3, 1])
  })

  test('a bad inline attribute leaves no collection behind', async () => {
    const res = await failure(
      databases.createCollection({ databaseId: 'legacy', collectionId: 'broken', name: 'Broken', attributes: [{ key: 'geo', type: 'point', required: false }] }),
    )
    expect(res.code).toBe(400)
    expect(await failure(databases.getCollection({ databaseId: 'legacy', collectionId: 'broken' }))).toMatchObject({ code: 404 })
  })
})

/** A function folder packed as the CLI packs it. */
function pack(name: string, files: Record<string, string | Uint8Array>): File {
  const dir = join(work, name)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const archive = join(work, `${name}.tar.gz`)
  const tar = Bun.spawnSync(['tar', '-czf', archive, '-C', dir, '.'])
  expect(tar.exitCode).toBe(0)
  return new File([readFileSync(archive)], 'code.tar.gz', { type: 'application/gzip' })
}

async function settled(functionId: string, deploymentId: string) {
  for (let i = 0; i < 200; i++) {
    const d = await functions.getDeployment({ functionId, deploymentId })
    if (d.status === 'ready' || d.status === 'failed') return d
    await Bun.sleep(25)
  }
  throw new Error('deployment did not settle')
}

const MAIN = `module.exports = async (context) => context.res.json({
  from: 'deployment',
  built: require('node:fs').existsSync('built.txt'),
  greeting: process.env.GREETING ?? null,
})`

describe('push functions', () => {
  test('create, deploy, activate, then run the deployed code', async () => {
    const created = await functions.create({
      functionId: 'hello',
      name: 'hello',
      runtime: 'node-22',
      execute: ['any'],
      schedule: '',
      timeout: 30,
      enabled: true,
      logging: true,
      entrypoint: 'src/main.js',
      commands: 'echo built > built.txt',
      scopes: ['users.read'],
    })
    expect(created).toMatchObject({ $id: 'hello', runtime: 'node-22', commands: 'echo built > built.txt', scopes: ['users.read'], deploymentId: '' })
    expect(await failure(functions.create({ functionId: 'hello', name: 'x', runtime: 'node-22' }))).toMatchObject({ code: 409 })
    expect(await failure(functions.create({ functionId: 'rb', name: 'x', runtime: 'ruby-3.3' }))).toMatchObject({ code: 404, type: 'function_runtime_unsupported' })

    // What the CLI calls right after creating a function.
    const consoleVars = (await (await fetch(`${server.endpoint}/console/variables`, { headers: { 'x-appwrite-project': 'console' } })).json()) as any
    expect(consoleVars._APP_DOMAIN_FUNCTIONS).toBe(new URL(server.endpoint).host)
    const rule = (await (
      await fetch(`${server.endpoint}/proxy/rules/function`, {
        method: 'POST',
        headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ domain: 'abc.functions.localhost', functionId: 'hello' }),
      })
    ).json()) as any
    expect(rule.domain).toBe(`${new URL(server.endpoint).host}/v1/functions/hello/http`)

    await functions.createVariable({ functionId: 'hello', variableId: ID.unique(), key: 'GREETING', value: 'hi', secret: false })
    const deployment = await functions.createDeployment({ functionId: 'hello', code: pack('hello', { 'src/main.js': MAIN, 'package.json': '{}' }), activate: true, entrypoint: 'src/main.js', commands: 'echo built > built.txt' })
    expect(['processing', 'building']).toContain(deployment.status)
    const done = await settled('hello', deployment.$id)
    expect(done.status).toBe('ready')
    expect(done.buildLogs).toContain('$ echo built > built.txt')

    const fn = await functions.get({ functionId: 'hello' })
    expect([fn.deploymentId, fn.latestDeploymentId, fn.latestDeploymentStatus]).toEqual([deployment.$id, deployment.$id, 'ready'])
    const run = await functions.createExecution({ functionId: 'hello' })
    expect(JSON.parse(run.responseBody)).toEqual({ from: 'deployment', built: true, greeting: 'hi' })

    const rules = (await (
      await fetch(`${server.endpoint}/proxy/rules?queries[]=${encodeURIComponent(Query.equal('deploymentResourceId', 'hello'))}`, { headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY } })
    ).json()) as any
    expect(rules.total).toBe(1)
  })

  test('update keeps what is not sent; the runtime and build command can change', async () => {
    const updated = await functions.update({ functionId: 'hello', name: 'Hello', runtime: 'node-22', timeout: 60, schedule: '*/5 * * * *', commands: '' })
    expect(updated).toMatchObject({ name: 'Hello', timeout: 60, schedule: '*/5 * * * *', commands: '', scopes: ['users.read'], entrypoint: 'src/main.js' })
    expect(await failure(functions.update({ functionId: 'hello', name: 'x', schedule: 'not a cron' }))).toMatchObject({ code: 400 })
  })

  test('a failing build is reported with its logs and does not replace the active code', async () => {
    const before = (await functions.get({ functionId: 'hello' })).deploymentId
    const bad = await functions.createDeployment({ functionId: 'hello', code: pack('bad', { 'src/main.js': MAIN }), activate: true, entrypoint: 'src/main.js', commands: 'echo nope >&2; exit 3' })
    const done = await settled('hello', bad.$id)
    expect(done.status).toBe('failed')
    expect(done.buildLogs).toContain('nope')
    expect(done.buildLogs).toContain('exited with code 3')
    expect((await functions.get({ functionId: 'hello' })).deploymentId).toBe(before)
    expect(await failure(functions.updateFunctionDeployment({ functionId: 'hello', deploymentId: bad.$id }))).toMatchObject({ type: 'build_not_ready' })
  })

  test('a missing entrypoint fails the deployment', async () => {
    const d = await functions.createDeployment({ functionId: 'hello', code: pack('noentry', { 'index.js': MAIN }), activate: false, entrypoint: 'src/main.js' })
    const done = await settled('hello', d.$id)
    expect(done.status).toBe('failed')
    expect(done.buildLogs).toContain('Entrypoint "src/main.js" is not in the upload')
  })

  test('uploads over 5 MB arrive in chunks and still build', async () => {
    const d = await functions.createDeployment({
      functionId: 'hello',
      code: pack('big', { 'src/main.js': MAIN, 'blob.bin': new Uint8Array(randomBytes(12 * 1024 * 1024)) }),
      activate: false,
      entrypoint: 'src/main.js',
    })
    expect(d.chunksTotal).toBe(3)
    const done = await settled('hello', d.$id)
    expect(done.status).toBe('ready')
    expect(existsSync(join(deploymentDir(server.config, 'hello', d.$id), 'blob.bin'))).toBe(true)

    // Activating by hand (what the CLI does after polling).
    const fn = await functions.updateFunctionDeployment({ functionId: 'hello', deploymentId: d.$id })
    expect(fn.deploymentId).toBe(d.$id)
    const run = await functions.createExecution({ functionId: 'hello' })
    expect(JSON.parse(run.responseBody).built).toBe(false)
    expect((await functions.listDeployments({ functionId: 'hello' })).total).toBeGreaterThanOrEqual(2)
  })

  test('variables: list, update, delete (push --with-variables)', async () => {
    const list = await functions.listVariables({ functionId: 'hello' })
    expect(list.variables.map((v: any) => [v.$id, v.key, v.value])).toEqual([['GREETING', 'GREETING', 'hi']])
    await functions.updateVariable({ functionId: 'hello', variableId: 'GREETING', key: 'GREETING', value: 'hello', secret: true })
    expect(await functions.getVariable({ functionId: 'hello', variableId: 'GREETING' })).toMatchObject({ value: '', secret: true })
    await functions.deleteVariable({ functionId: 'hello', variableId: 'GREETING' })
    expect((await functions.listVariables({ functionId: 'hello' })).total).toBe(0)
  })

  test('deleting a function removes its deployments from disk', async () => {
    const dir = deploymentDir(server.config, 'hello')
    expect(existsSync(dir)).toBe(true)
    await functions.delete({ functionId: 'hello' })
    expect(existsSync(dir)).toBe(false)
    expect(await failure(functions.get({ functionId: 'hello' }))).toMatchObject({ code: 404 })
  })
})
