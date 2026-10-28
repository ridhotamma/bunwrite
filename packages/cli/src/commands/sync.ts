/**
 * `bunwrite pull <what>` and `bunwrite push <what>`: the project config file
 * against the server. The format is the same as Appwrite's appwrite.config.json,
 * so either file works.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  BunwriteException,
  Client,
  Functions,
  InputFile,
  Messaging,
  Organization,
  Project,
  Query,
  Sites,
  Storage,
  Teams,
  Webhooks,
} from '@bunwrite/sdk'

import { bool, flagList, flag, type Args } from '../args'
import { consoleClient, projectClient } from '../clients'
import { currentSession, readConfig, writeConfig, type ProjectConfig } from '../config'
import { collect } from '../files'
import { packGzip, unpackGzip } from '../tar'
import { CliError, confirm, dim, info, log, success, warn } from '../ui'

interface Ctx {
  client: Client
  projectId: string
  auth: 'key' | 'console'
  config: ProjectConfig
  args: Args
}

type Item = Record<string, any>

// ---- Helpers ----

const notFound = (error: unknown) => error instanceof BunwriteException && error.code === 404

async function orNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch (error) {
    if (notFound(error)) return null
    throw error
  }
}

/** Every item of a list endpoint, 100 at a time. */
async function listAll<T>(page: (queries: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let offset = 0; ; offset += 100) {
    const items = await page([Query.limit(100), Query.offset(offset)])
    out.push(...items)
    if (items.length < 100) return out
  }
}

/** Raw API call, for the schema endpoints that the SDK splits by column type. */
const api = (ctx: Ctx, method: string, path: string, body: Item = {}) =>
  ctx.client.call(method, new URL(ctx.client.config.endpoint + path), { 'content-type': 'application/json' }, body)

/** Site and function `domains` are Bunwrite extensions the generated SDK methods do not send. */
const syncDomains = async (ctx: Ctx, type: 'site' | 'function', id: string, domains: unknown) => {
  if (!Array.isArray(domains)) return
  const path = type === 'site' ? 'sites' : 'functions'
  await api(ctx, 'put', `/${path}/${encodeURIComponent(id)}`, { domains })
}

const pick = (item: Item, keys: string[]): Item => {
  const out: Item = {}
  for (const k of keys) if (item[k] !== undefined) out[k] = item[k]
  return out
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Keys set in the local item whose values differ on the server. Unset keys keep the server's value. */
const changedKeys = (local: Item, remote: Item, keys: string[]) => keys.filter((k) => local[k] !== undefined && !same(local[k], remote[k]))

const enc = encodeURIComponent

async function confirmDeletes(ctx: Ctx, what: string[]): Promise<boolean> {
  if (!what.length) return false
  if (bool(ctx.args, 'force')) return true
  warn(`These are on the server but not in the config:\n  ${what.join('\n  ')}`)
  return confirm('Delete them from the server?')
}

/** The items to work on: `--<kind>-id` values, or all of them. */
function selected<T extends Item>(ctx: Ctx, items: T[], idFlag: string): T[] {
  const ids = flagList(ctx.args, idFlag)
  if (!ids.length) return items
  const missing = ids.filter((id) => !items.some((i) => i.$id === id))
  if (missing.length) throw new CliError(`Not in the config: ${missing.join(', ')}`)
  return items.filter((i) => ids.includes(i.$id))
}

// ---- Simple resources: buckets, teams, webhooks, topics ----

interface Resource {
  /** Config key and plural label. */
  key: 'buckets' | 'teams' | 'webhooks' | 'topics'
  fields: string[]
  list(ctx: Ctx): Promise<Item[]>
  toConfig(remote: Item): Item
  create(ctx: Ctx, local: Item): Promise<unknown>
  update(ctx: Ctx, local: Item, remote: Item): Promise<unknown>
  remove(ctx: Ctx, id: string): Promise<unknown>
}

const BUCKET_FIELDS = ['$permissions', 'fileSecurity', 'name', 'enabled', 'maximumFileSize', 'allowedFileExtensions', 'compression', 'encryption', 'antivirus']

const bucketParams = (b: Item) => ({
  name: b.name,
  permissions: b.$permissions,
  fileSecurity: b.fileSecurity,
  enabled: b.enabled,
  maximumFileSize: b.maximumFileSize,
  allowedFileExtensions: b.allowedFileExtensions,
  compression: b.compression,
  encryption: b.encryption,
  antivirus: b.antivirus,
})

const webhookParams = (w: Item) => ({
  name: w.name,
  url: w.url,
  events: w.events ?? [],
  enabled: w.enabled,
  tls: w.tls,
  authUsername: w.authUsername,
  authPassword: w.authPassword,
})

const RESOURCES: Resource[] = [
  {
    key: 'buckets',
    fields: BUCKET_FIELDS,
    list: (ctx) => listAll(async (queries) => (await new Storage(ctx.client).listBuckets({ queries })).buckets),
    toConfig: (b) => ({ $id: b.$id, ...pick(b, BUCKET_FIELDS) }),
    create: (ctx, b) => new Storage(ctx.client).createBucket({ bucketId: b.$id, ...bucketParams(b) }),
    update: (ctx, b, remote) => new Storage(ctx.client).updateBucket({ bucketId: b.$id, ...bucketParams({ ...remote, ...b }) }),
    remove: (ctx, id) => new Storage(ctx.client).deleteBucket({ bucketId: id }),
  },
  {
    key: 'teams',
    fields: ['name'],
    list: (ctx) => listAll(async (queries) => (await new Teams(ctx.client).list({ queries })).teams),
    toConfig: (t) => ({ $id: t.$id, name: t.name }),
    create: (ctx, t) => new Teams(ctx.client).create({ teamId: t.$id, name: t.name }),
    update: (ctx, t) => new Teams(ctx.client).updateName({ teamId: t.$id, name: t.name }),
    remove: (ctx, id) => new Teams(ctx.client).delete({ teamId: id }),
  },
  {
    key: 'webhooks',
    fields: ['name', 'url', 'events', 'enabled', 'tls', 'authUsername', 'authPassword'],
    list: (ctx) => listAll(async (queries) => (await new Webhooks(ctx.client).list({ queries })).webhooks),
    toConfig: (w) => ({
      $id: w.$id,
      ...pick(w, ['name', 'url', 'events', 'enabled', 'tls']),
      ...(w.authUsername ? { authUsername: w.authUsername, authPassword: w.authPassword } : {}),
    }),
    create: (ctx, w) => new Webhooks(ctx.client).create({ webhookId: w.$id, ...webhookParams(w) }),
    update: (ctx, w, remote) => new Webhooks(ctx.client).update({ webhookId: w.$id, ...webhookParams({ ...remote, ...w }) }),
    remove: (ctx, id) => new Webhooks(ctx.client).delete({ webhookId: id }),
  },
  {
    key: 'topics',
    fields: ['name', 'subscribe'],
    list: (ctx) => listAll(async (queries) => (await new Messaging(ctx.client).listTopics({ queries })).topics),
    toConfig: (t) => ({ $id: t.$id, name: t.name, subscribe: t.subscribe ?? [] }),
    create: (ctx, t) => new Messaging(ctx.client).createTopic({ topicId: t.$id, name: t.name, subscribe: t.subscribe }),
    update: (ctx, t) => new Messaging(ctx.client).updateTopic({ topicId: t.$id, name: t.name, subscribe: t.subscribe }),
    remove: (ctx, id) => new Messaging(ctx.client).deleteTopic({ topicId: id }),
  },
]

async function pullResource(ctx: Ctx, r: Resource): Promise<string> {
  const items = (await r.list(ctx)).map(r.toConfig)
  ctx.config[r.key] = items
  return `Pulled ${items.length} ${r.key}`
}

async function pushResource(ctx: Ctx, r: Resource): Promise<string> {
  const local: Item[] = ctx.config[r.key] ?? []
  const remote = new Map((await r.list(ctx)).map((i) => [i.$id as string, i]))
  let pushed = 0
  for (const item of local) {
    if (!item.$id) throw new CliError(`Every entry of "${r.key}" needs a $id.`)
    const found = remote.get(item.$id)
    if (!found) {
      await r.create(ctx, item)
    } else {
      const changes = changedKeys(item, r.toConfig(found), r.fields)
      if (!changes.length) {
        log(dim(`No changes for ${item.name ?? item.$id} ( ${item.$id} )`))
        continue
      }
      await r.update(ctx, item, found)
    }
    pushed++
    success(`Pushed ${item.name ?? item.$id} ( ${item.$id} )`)
  }
  if (bool(ctx.args, 'prune')) {
    const extra = [...remote.keys()].filter((id) => !local.some((i) => i.$id === id))
    if (await confirmDeletes(ctx, extra.map((id) => `${r.key.slice(0, -1)} ${id}`))) {
      for (const id of extra) await r.remove(ctx, id)
      success(`Deleted ${extra.length} ${r.key}`)
    }
  }
  return pushed ? `Pushed ${pushed} ${r.key}` : `No ${r.key} were pushed: no changes`
}

// ---- Databases: tables or collections ----

interface Flavor {
  label: string
  base: string
  dbsKey: 'tablesDB' | 'databases'
  itemsKey: 'tables' | 'collections'
  child: 'tables' | 'collections'
  fields: 'columns' | 'attributes'
  security: 'rowSecurity' | 'documentSecurity'
  idParam: 'tableId' | 'collectionId'
}

const TABLES: Flavor = {
  label: 'tables',
  base: '/tablesdb',
  dbsKey: 'tablesDB',
  itemsKey: 'tables',
  child: 'tables',
  fields: 'columns',
  security: 'rowSecurity',
  idParam: 'tableId',
}

const COLLECTIONS: Flavor = {
  label: 'collections',
  base: '/databases',
  dbsKey: 'databases',
  itemsKey: 'collections',
  child: 'collections',
  fields: 'attributes',
  security: 'documentSecurity',
  idParam: 'collectionId',
}

const COLUMN_DROP = new Set(['status', 'error', '$createdAt', '$updatedAt'])
const columnConfig = (c: Item): Item => Object.fromEntries(Object.entries(c).filter(([k]) => !COLUMN_DROP.has(k)))
const indexConfig = (i: Item, f: Flavor): Item => ({ key: i.key, type: i.type, [f.fields]: i[f.fields] ?? i.columns ?? i.attributes ?? [], orders: i.orders ?? [] })

/** The create/update path segment for a column: `email`, `float`, `string`, ... */
const pathType = (c: Item): string =>
  ['email', 'url', 'ip', 'enum'].includes(c.format) ? c.format : c.type === 'double' ? 'float' : String(c.type)

const COLUMN_COMPARE = ['required', 'array', 'default', 'size', 'min', 'max', 'elements', 'encrypt']

async function listDatabases(ctx: Ctx, f: Flavor): Promise<Item[]> {
  return listAll(async (queries) => (await api(ctx, 'get', f.base, { queries })).databases)
}

async function listItems(ctx: Ctx, f: Flavor, databaseId: string): Promise<Item[]> {
  return listAll(async (queries) => (await api(ctx, 'get', `${f.base}/${enc(databaseId)}/${f.child}`, { queries }))[f.child])
}

function itemConfig(item: Item, f: Flavor): Item {
  return {
    $id: item.$id,
    $permissions: item.$permissions ?? [],
    databaseId: item.databaseId,
    name: item.name,
    enabled: item.enabled,
    [f.security]: item[f.security] ?? item.documentSecurity ?? item.rowSecurity ?? false,
    [f.fields]: (item[f.fields] ?? []).map(columnConfig),
    indexes: (item.indexes ?? []).map((i: Item) => indexConfig(i, f)),
  }
}

async function pullSchema(ctx: Ctx, f: Flavor): Promise<string> {
  const dbs = await listDatabases(ctx, f)
  const items: Item[] = []
  for (const db of dbs) for (const item of await listItems(ctx, f, db.$id)) items.push(itemConfig(item, f))
  ctx.config[f.dbsKey] = dbs.map((d) => ({ $id: d.$id, name: d.name, enabled: d.enabled }))
  ctx.config[f.itemsKey] = items
  return `Pulled ${items.length} ${f.label} from ${dbs.length} databases`
}

async function pushSchema(ctx: Ctx, f: Flavor): Promise<string> {
  const localDbs: Item[] = ctx.config[f.dbsKey] ?? []
  const localItems: Item[] = selected(ctx, ctx.config[f.itemsKey] ?? [], `${f.idParam.replace('Id', '')}-id`)
  const remoteDbs = new Map((await listDatabases(ctx, f)).map((d) => [d.$id as string, d]))
  const prune = bool(ctx.args, 'prune')
  const deletes: { label: string; path: string }[] = []
  let pushed = 0

  // Databases named by items but not listed are created with their ID as name.
  const wanted = [...localDbs]
  for (const item of localItems) {
    if (!item.databaseId) throw new CliError(`${f.label} "${item.$id}" has no databaseId.`)
    if (!wanted.some((d) => d.$id === item.databaseId)) wanted.push({ $id: item.databaseId, name: item.databaseId })
  }
  for (const db of wanted) {
    const remote = remoteDbs.get(db.$id)
    if (!remote) {
      await api(ctx, 'post', f.base, { databaseId: db.$id, name: db.name ?? db.$id, enabled: db.enabled ?? true })
      success(`Created database ${db.name ?? db.$id} ( ${db.$id} )`)
    } else if (changedKeys(db, remote, ['name', 'enabled']).length) {
      await api(ctx, 'put', `${f.base}/${enc(db.$id)}`, { name: db.name ?? remote.name, enabled: db.enabled ?? remote.enabled })
      success(`Updated database ${db.name} ( ${db.$id} )`)
    }
  }

  for (const item of localItems) {
    const base = `${f.base}/${enc(item.databaseId)}/${f.child}`
    const path = `${base}/${enc(item.$id)}`
    const remote = await orNull(api(ctx, 'get', path))
    if (!remote) {
      await api(ctx, 'post', base, {
        [f.idParam]: item.$id,
        name: item.name ?? item.$id,
        permissions: item.$permissions ?? [],
        [f.security]: item[f.security] ?? false,
        enabled: item.enabled ?? true,
        [f.fields]: item[f.fields] ?? [],
        indexes: item.indexes ?? [],
      })
      pushed++
      success(`Created ${item.name ?? item.$id} ( ${item.$id} )`)
      continue
    }

    let changed = false
    const remoteConfig = itemConfig(remote, f)
    if (changedKeys(item, remoteConfig, ['name', 'enabled', f.security, '$permissions']).length) {
      await api(ctx, 'put', path, {
        name: item.name ?? remote.name,
        permissions: item.$permissions ?? remote.$permissions,
        [f.security]: item[f.security] ?? remoteConfig[f.security],
        enabled: item.enabled ?? remote.enabled,
      })
      changed = true
    }

    const remoteColumns = new Map<string, Item>(remoteConfig[f.fields].map((c: Item) => [c.key, c]))
    for (const column of (item[f.fields] ?? []) as Item[]) {
      const found = remoteColumns.get(column.key)
      if (!found) {
        await api(ctx, 'post', `${path}/${f.fields}/${pathType(column)}`, column)
        changed = true
        continue
      }
      if (pathType(found) !== pathType(column) || (column.type && column.type !== found.type)) {
        throw new CliError(
          `"${column.key}" in ${item.$id} changed type (${pathType(found)} → ${pathType(column)}). Remove it from the config, push with --prune, then add it back.`,
        )
      }
      if (changedKeys(column, found, COLUMN_COMPARE).length) {
        const { key: _key, type: _type, format: _format, array: _array, encrypt: _encrypt, ...update } = column
        await api(ctx, 'patch', `${path}/${f.fields}/${pathType(column)}/${enc(column.key)}`, { required: found.required, default: found.default ?? null, ...update })
        changed = true
      }
    }

    const remoteIndexes = new Map<string, Item>(remoteConfig.indexes.map((i: Item) => [i.key, i]))
    for (const index of (item.indexes ?? []) as Item[]) {
      const local = indexConfig(index, f)
      const found = remoteIndexes.get(index.key)
      if (found && !changedKeys(local, found, ['type', f.fields, ...(index.orders ? ['orders'] : [])]).length) continue
      if (found) await api(ctx, 'delete', `${path}/indexes/${enc(index.key)}`)
      await api(ctx, 'post', `${path}/indexes`, { key: local.key, type: local.type, [f.fields]: local[f.fields], orders: local.orders })
      changed = true
    }

    if (prune) {
      for (const key of remoteIndexes.keys()) {
        if (!(item.indexes ?? []).some((i: Item) => i.key === key)) deletes.push({ label: `index ${item.$id}.${key}`, path: `${path}/indexes/${enc(key)}` })
      }
      for (const key of remoteColumns.keys()) {
        if (!(item[f.fields] ?? []).some((c: Item) => c.key === key)) deletes.push({ label: `${f.fields.slice(0, -1)} ${item.$id}.${key}`, path: `${path}/${f.fields}/${enc(key)}` })
      }
    }

    if (changed) {
      pushed++
      success(`Pushed ${item.name ?? item.$id} ( ${item.$id} )`)
    }
  }

  if (prune && !flagList(ctx.args, `${f.idParam.replace('Id', '')}-id`).length) {
    for (const db of wanted) {
      for (const remote of await listItems(ctx, f, db.$id)) {
        if (!localItems.some((i) => i.$id === remote.$id && i.databaseId === db.$id)) {
          deletes.push({ label: `${f.label.slice(0, -1)} ${db.$id}.${remote.$id}`, path: `${f.base}/${enc(db.$id)}/${f.child}/${enc(remote.$id)}` })
        }
      }
    }
  }
  if (await confirmDeletes(ctx, deletes.map((d) => d.label))) {
    for (const d of deletes) await api(ctx, 'delete', d.path)
    success(`Deleted ${deletes.length} items`)
  }

  return pushed ? `Pushed ${pushed} ${f.label}` : `No ${f.label} were pushed: no changes`
}

// ---- Functions ----

const FUNCTION_FIELDS = ['name', 'runtime', 'execute', 'events', 'schedule', 'timeout', 'enabled', 'logging', 'entrypoint', 'commands', 'scopes', 'domains']

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'function'

async function pullFunctions(ctx: Ctx): Promise<string> {
  const functions = new Functions(ctx.client)
  const all = await listAll(async (queries) => (await functions.list({ queries })).functions)
  const ids = flagList(ctx.args, 'function-id')
  const chosen = ids.length ? all.filter((fn) => ids.includes(fn.$id)) : all
  const withCode = bool(ctx.args, 'code', true)
  const existing: Item[] = ctx.config.functions ?? []
  const pulled: Item[] = []

  for (const fn of chosen) {
    const local = existing.find((e) => e.$id === fn.$id)
    const path = local?.path ?? `functions/${slug(fn.name)}`
    const entry: Item = { $id: fn.$id, ...pick(fn, FUNCTION_FIELDS), path, ...(local?.ignore ? { ignore: local.ignore } : {}) }
    pulled.push(entry)
    if (!withCode) continue
    if (!fn.deploymentId) {
      info(`${fn.name} has no deployment; no code to pull`)
      continue
    }
    const archive = await orNull(functions.getDeploymentDownload({ functionId: fn.$id, deploymentId: fn.deploymentId }))
    if (!archive) {
      info(`${fn.name}: its code is not a deployment on the server; nothing to pull`)
      continue
    }
    const dir = resolve(path)
    for (const file of unpackGzip(new Uint8Array(archive))) {
      const target = join(dir, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.data, { mode: file.mode ? file.mode & 0o777 : 0o644 })
    }
    success(`Pulled the code of ${fn.name} into ${path}`)
  }

  // Keep functions that were not pulled this time.
  ctx.config.functions = [...existing.filter((e) => !pulled.some((p) => p.$id === e.$id)), ...pulled]
  return `Pulled ${pulled.length} functions`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function deploy(ctx: Ctx, fn: Item): Promise<void> {
  const functions = new Functions(ctx.client)
  const folder = resolve(fn.path ?? `functions/${slug(fn.name ?? fn.$id)}`)
  if (!existsSync(folder)) throw new CliError(`The code folder of ${fn.$id} does not exist: ${folder}`)
  const files = collect(folder, fn.ignore)
  if (!files.length) throw new CliError(`No files to deploy in ${folder}`)
  const code = packGzip(files)
  const activate = bool(ctx.args, 'activate', true)

  info(`Deploying ${fn.name ?? fn.$id}: ${files.length} files, ${(code.length / 1024).toFixed(1)} KB`)
  let deployment = await functions.createDeployment({
    functionId: fn.$id,
    code: InputFile.fromBuffer(code, 'code.tar.gz'),
    activate,
    entrypoint: fn.entrypoint,
    commands: fn.commands,
  })

  const started = Date.now()
  const timeout = Number(flag(ctx.args, 'timeout') ?? 900) * 1000
  while (!['ready', 'failed', 'canceled'].includes(deployment.status)) {
    if (Date.now() - started > timeout) throw new CliError(`${fn.$id}: the build is still running after ${timeout / 1000}s (deployment ${deployment.$id}).`)
    await sleep(500)
    deployment = await functions.getDeployment({ functionId: fn.$id, deploymentId: deployment.$id })
  }
  if (deployment.status !== 'ready') {
    throw new CliError(`Failed to deploy ${fn.name ?? fn.$id} ( ${fn.$id} ): the build ${deployment.status}.\n${deployment.buildLogs ?? ''}`.trimEnd())
  }
  success(`Deployed ${fn.name ?? fn.$id} ( ${fn.$id} )${activate ? ' and activated it' : ''}`)
}

const functionParams = (fn: Item) => ({
  name: fn.name,
  runtime: fn.runtime,
  execute: fn.execute,
  events: fn.events,
  schedule: fn.schedule,
  timeout: fn.timeout,
  enabled: fn.enabled,
  logging: fn.logging,
  entrypoint: fn.entrypoint,
  commands: fn.commands,
  scopes: fn.scopes,
})

async function pushFunctions(ctx: Ctx): Promise<string> {
  const functions = new Functions(ctx.client)
  const chosen = selected(ctx, (ctx.config.functions ?? []) as Item[], 'function-id')
  const withCode = bool(ctx.args, 'code', true)
  let deployed = 0
  let updated = 0
  for (const fn of chosen) {
    if (!fn.$id || !fn.name || !fn.runtime) throw new CliError('Every function needs $id, name and runtime.')
    const remote = await orNull(functions.get({ functionId: fn.$id }))
    if (!remote) {
      await functions.create({ functionId: fn.$id, ...functionParams(fn) } as any)
      await syncDomains(ctx, 'function', fn.$id, fn.domains)
      success(`Created ${fn.name} ( ${fn.$id} )`)
      updated++
    } else if (changedKeys(fn, remote, FUNCTION_FIELDS).length) {
      await functions.update({ functionId: fn.$id, ...functionParams({ ...pick(remote, FUNCTION_FIELDS), ...fn }) } as any)
      await syncDomains(ctx, 'function', fn.$id, fn.domains)
      success(`Updated the settings of ${fn.name} ( ${fn.$id} )`)
      updated++
    }
    if (withCode) {
      await deploy(ctx, fn)
      deployed++
    }
  }
  if (withCode) return `Deployed ${deployed} function${deployed === 1 ? '' : 's'}`
  return updated ? `Pushed ${updated} functions` : 'No functions were pushed: no changes'
}

// ---- Sites ----

/**
 * Sites are uploaded as they should be served; nothing is built on the
 * server. Only the output folder is packed (`outputDirectory` inside `path`),
 * and .gitignore is not applied there, since build output is usually ignored.
 */
const SITE_FIELDS = ['name', 'framework', 'enabled', 'outputDirectory', 'fallbackFile', 'installCommand', 'buildCommand', 'buildRuntime', 'adapter', 'apiFunctionId', 'domain', 'domains']

const siteParams = (site: Item) => ({ ...pick(site, SITE_FIELDS), framework: site.framework ?? 'other', buildRuntime: site.buildRuntime ?? 'static-1' })

async function pullSites(ctx: Ctx): Promise<string> {
  const sites = new Sites(ctx.client)
  const all = await listAll(async (queries) => (await sites.list({ queries })).sites)
  const ids = flagList(ctx.args, 'site-id')
  const chosen = ids.length ? all.filter((s) => ids.includes(s.$id)) : all
  const withCode = bool(ctx.args, 'code', true)
  const existing: Item[] = ctx.config.sites ?? []
  const pulled: Item[] = []
  for (const site of chosen) {
    const local = existing.find((e) => e.$id === site.$id)
    const path = local?.path ?? `sites/${slug(site.name)}`
    pulled.push({ $id: site.$id, ...pick(site, SITE_FIELDS), path, ...(local?.ignore ? { ignore: local.ignore } : {}) })
    if (!withCode || !site.deploymentId) continue
    const archive = await orNull(sites.getDeploymentDownload({ siteId: site.$id, deploymentId: site.deploymentId }))
    if (!archive) continue
    const dir = resolve(path)
    for (const file of unpackGzip(new Uint8Array(archive))) {
      const target = join(dir, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.data, { mode: file.mode ? file.mode & 0o777 : 0o644 })
    }
    success(`Pulled the files of ${site.name} into ${path}`)
  }
  ctx.config.sites = [...existing.filter((e) => !pulled.some((p) => p.$id === e.$id)), ...pulled]
  return `Pulled ${pulled.length} sites`
}

async function deploySite(ctx: Ctx, site: Item): Promise<void> {
  const sites = new Sites(ctx.client)
  const root = resolve(site.path ?? `sites/${slug(site.name ?? site.$id)}`)
  const out = String(site.outputDirectory ?? '').replace(/^\.?\/+|\/+$/g, '')
  const folder = out ? join(root, out) : root
  if (!existsSync(folder)) throw new CliError(`The files of ${site.$id} are not at ${folder}.${out ? ' Run the build first.' : ''}`)
  const files = collect(folder, site.ignore ?? []).map((f) => (out ? { ...f, path: `${out}/${f.path}` } : f))
  if (!files.length) throw new CliError(`No files to deploy in ${folder}`)
  const code = packGzip(files)
  const activate = bool(ctx.args, 'activate', true)
  info(`Deploying ${site.name ?? site.$id}: ${files.length} files, ${(code.length / 1024).toFixed(1)} KB`)
  const deployment = await sites.createDeployment({ siteId: site.$id, code: InputFile.fromBuffer(code, 'site.tar.gz'), activate })
  if (deployment.status !== 'ready') {
    throw new CliError(`Failed to deploy ${site.name ?? site.$id} ( ${site.$id} ): ${deployment.status}.\n${deployment.buildLogs ?? ''}`.trimEnd())
  }
  const remote = (await sites.get({ siteId: site.$id })) as Item
  success(`Deployed ${site.name ?? site.$id}${activate ? `, live at ${remote.url ?? ''}` : ''}`)
}

async function pushSites(ctx: Ctx): Promise<string> {
  const sites = new Sites(ctx.client)
  const chosen = selected(ctx, (ctx.config.sites ?? []) as Item[], 'site-id')
  const withCode = bool(ctx.args, 'code', true)
  let deployed = 0
  let updated = 0
  for (const site of chosen) {
    if (!site.$id || !site.name) throw new CliError('Every site needs $id and name.')
    const remote = await orNull(sites.get({ siteId: site.$id }))
    if (!remote) {
      await sites.create({ siteId: site.$id, ...siteParams(site) } as any)
      await syncDomains(ctx, 'site', site.$id, site.domains)
      success(`Created ${site.name} ( ${site.$id} )`)
      updated++
    } else if (changedKeys(site, remote, SITE_FIELDS).length) {
      await sites.update({ siteId: site.$id, ...siteParams({ ...pick(remote, SITE_FIELDS), ...site }) } as any)
      await syncDomains(ctx, 'site', site.$id, site.domains)
      success(`Updated the settings of ${site.name} ( ${site.$id} )`)
      updated++
    }
    if (withCode) {
      await deploySite(ctx, site)
      deployed++
    }
  }
  if (withCode) return `Deployed ${deployed} site${deployed === 1 ? '' : 's'}`
  return updated ? `Pushed ${updated} sites` : 'No sites were pushed: no changes'
}

// ---- Settings ----

/** Config key → server policy, and how to read and write it. */
const SECURITY: { key: string; policy: string; field: 'total' | 'enabled' | 'duration' }[] = [
  { key: 'duration', policy: 'session-duration', field: 'duration' },
  { key: 'limit', policy: 'user-limit', field: 'total' },
  { key: 'sessionsLimit', policy: 'session-limit', field: 'total' },
  { key: 'passwordHistory', policy: 'password-history', field: 'total' },
  { key: 'passwordDictionary', policy: 'password-dictionary', field: 'enabled' },
  { key: 'personalDataCheck', policy: 'password-personal-data', field: 'enabled' },
  { key: 'sessionAlerts', policy: 'session-alert', field: 'enabled' },
]

const toMap = (list: { $id: string; enabled: boolean }[]) => Object.fromEntries(list.map((x) => [x.$id, x.enabled]))

async function readSettings(ctx: Ctx) {
  const project = new Project(ctx.client)
  const info = (await project.get()) as Item
  const policies = new Map(((await project.listPolicies()) as Item).policies.map((p: Item) => [p.$id, p]))
  const mocks = ((await project.listMockPhones()) as Item).mockNumbers as Item[]
  const security: Item = {}
  for (const s of SECURITY) security[s.key] = (policies.get(s.policy) as Item | undefined)?.[s.field]
  security.mockNumbers = mocks.map((m) => ({ phone: m.number, otp: m.otp }))
  return {
    name: info.name as string,
    settings: {
      services: toMap(info.services),
      protocols: toMap(info.protocols),
      auth: { methods: toMap(info.authMethods), security },
    },
  }
}

async function pullSettings(ctx: Ctx): Promise<string> {
  const { name, settings } = await readSettings(ctx)
  ctx.config.projectName = name
  ctx.config.settings = settings
  return 'Pulled all project settings'
}

async function pushSettings(ctx: Ctx): Promise<string> {
  const local = ctx.config.settings
  if (!local) throw new CliError('No "settings" in the config. Run `bunwrite pull settings` first.')
  const project = new Project(ctx.client)
  const current = await readSettings(ctx)
  let changes = 0

  if (ctx.config.projectName && ctx.config.projectName !== current.name) {
    if (currentSession().cookie) {
      await new Organization(consoleClient(ctx.config)).updateProject({ projectId: ctx.projectId, name: ctx.config.projectName })
      changes++
    } else {
      warn('Renaming the project needs a console sign-in (`bunwrite login`); the name was not changed.')
    }
  }
  for (const [id, enabled] of Object.entries(local.services ?? {})) {
    if (current.settings.services[id] === enabled) continue
    await project.updateService({ serviceId: id as any, enabled: Boolean(enabled) })
    changes++
  }
  for (const [id, enabled] of Object.entries(local.protocols ?? {})) {
    if (current.settings.protocols[id] === enabled) continue
    await project.updateProtocol({ protocolId: id as any, enabled: Boolean(enabled) })
    changes++
  }
  for (const [id, enabled] of Object.entries(local.auth?.methods ?? {})) {
    if (current.settings.auth.methods[id] === enabled) continue
    await project.updateAuthMethod({ methodId: id as any, enabled: Boolean(enabled) })
    changes++
  }
  const security = local.auth?.security ?? {}
  for (const s of SECURITY) {
    const value = security[s.key]
    if (value === undefined || same(value, current.settings.auth.security[s.key])) continue
    await api(ctx, 'patch', `/project/policies/${s.policy}`, { [s.field]: value })
    changes++
  }
  if (Array.isArray(security.mockNumbers)) {
    const remote = new Map<string, string>((current.settings.auth.security.mockNumbers as Item[]).map((m) => [m.phone, m.otp]))
    const wanted = new Map<string, string>((security.mockNumbers as Item[]).map((m) => [m.phone ?? m.number, String(m.otp)]))
    for (const [phone, otp] of wanted) {
      if (!remote.has(phone)) await project.createMockPhone({ number: phone, otp })
      else if (remote.get(phone) !== otp) await project.updateMockPhone({ number: phone, otp })
      else continue
      changes++
    }
    for (const phone of remote.keys()) {
      if (wanted.has(phone)) continue
      await project.deleteMockPhone({ number: phone })
      changes++
    }
  }
  return changes ? 'Pushed all project settings' : 'No settings were pushed: no changes'
}

// ---- Commands ----

const KINDS = ['settings', 'tables', 'collections', 'functions', 'sites', 'buckets', 'teams', 'webhooks', 'topics'] as const
type Kind = (typeof KINDS)[number]

const resource = (key: string) => RESOURCES.find((r) => r.key === key)!

const PULL: Record<Kind, (ctx: Ctx) => Promise<string>> = {
  settings: pullSettings,
  tables: (ctx) => pullSchema(ctx, TABLES),
  collections: (ctx) => pullSchema(ctx, COLLECTIONS),
  functions: pullFunctions,
  sites: pullSites,
  buckets: (ctx) => pullResource(ctx, resource('buckets')),
  teams: (ctx) => pullResource(ctx, resource('teams')),
  webhooks: (ctx) => pullResource(ctx, resource('webhooks')),
  topics: (ctx) => pullResource(ctx, resource('topics')),
}

const PUSH: Record<Kind, (ctx: Ctx) => Promise<string>> = {
  settings: pushSettings,
  tables: (ctx) => pushSchema(ctx, TABLES),
  collections: (ctx) => pushSchema(ctx, COLLECTIONS),
  functions: pushFunctions,
  sites: pushSites,
  buckets: (ctx) => pushResource(ctx, resource('buckets')),
  teams: (ctx) => pushResource(ctx, resource('teams')),
  webhooks: (ctx) => pushResource(ctx, resource('webhooks')),
  topics: (ctx) => pushResource(ctx, resource('topics')),
}

function kindsOf(what: string | undefined, config: ProjectConfig, direction: 'pull' | 'push'): Kind[] {
  if (what === 'all') {
    if (direction === 'pull') return ['settings', 'tables', 'functions', 'sites', 'buckets', 'teams', 'webhooks', 'topics']
    return KINDS.filter((k) => (k === 'settings' ? config.settings : config[k]) !== undefined)
  }
  if (!what || !(KINDS as readonly string[]).includes(what)) {
    throw new CliError(`Say what to ${direction}: ${[...KINDS, 'all'].join(', ')}`)
  }
  return [what as Kind]
}

export async function sync(direction: 'pull' | 'push', args: Args): Promise<void> {
  const config = readConfig()
  const { client, projectId, auth } = projectClient(config)
  const ctx: Ctx = { client, projectId, auth, config, args }
  const kinds = kindsOf(args.positional[1], config, direction)
  for (const kind of kinds) {
    const message = await (direction === 'pull' ? PULL : PUSH)[kind](ctx)
    if (direction === 'pull') {
      ctx.config.projectId ??= projectId
      writeConfig(ctx.config)
    }
    success(message)
  }
}
