/**
 * Databases, collections, attributes and indexes over Appwrite's REST API,
 * under both of Appwrite's paths:
 *
 *   /databases/:db/collections/:id/attributes   (Databases)
 *   /tablesdb/:db/tables/:id/columns            (TablesDB)
 *
 * The backup and media-sweep jobs read them, and `appwrite push tables` /
 * `appwrite push collections` write through them. Writes go through
 * SchemaAdmin, the same code the console and `schema:push` use, and need an
 * API key. Changes apply at once, so attributes and indexes are created
 * `available` instead of `processing`.
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { err } from '~/lib/errors'
import { bool, json, list, noContent, num, str, type Params } from '~/lib/http'
import { uniqueId } from '~/lib/ids'
import type { Router } from '~/lib/router'
import { SchemaAdmin } from './admin'
import type { DatabaseInfo } from './registry'
import { attributeDefinition, FORMATTED_STRINGS as FORMATTED, type Attribute, type Collection, type Index } from './types'

type Flavor = 'collections' | 'tables'

export function databaseModel(d: DatabaseInfo) {
  return { $id: d.id, name: d.name, description: '', $createdAt: d.createdAt, $updatedAt: d.updatedAt, enabled: d.enabled, type: 'tablesdb', status: 'ready' }
}

/** An attribute (column) as Appwrite returns it; see `attributeDefinition` for why its fields vary. */
export function attributeModel(a: Attribute, c: Collection) {
  const { key, type, required, array, ...rest } = attributeDefinition(a)
  return { key, type, status: 'available', error: '', required, array, $createdAt: c.createdAt, $updatedAt: c.updatedAt, ...rest }
}

export function indexModel(i: Index, c: Collection, flavor: Flavor = 'collections') {
  return {
    $id: `${c.databaseSeq}_${c.seq}_${i.key}`,
    key: i.key,
    type: i.type,
    status: 'available',
    error: '',
    [flavor === 'tables' ? 'columns' : 'attributes']: i.attributes,
    lengths: i.attributes.map(() => null),
    orders: i.orders,
    $createdAt: c.createdAt,
    $updatedAt: c.updatedAt,
  }
}

export function collectionModel(c: Collection, flavor: Flavor = 'collections') {
  const tables = flavor === 'tables'
  return {
    $id: c.id,
    $createdAt: c.createdAt,
    $updatedAt: c.updatedAt,
    $permissions: c.permissions,
    databaseId: c.databaseId,
    name: c.name,
    description: '',
    enabled: c.enabled,
    [tables ? 'rowSecurity' : 'documentSecurity']: c.documentSecurity,
    [tables ? 'columns' : 'attributes']: c.attributes.map((a) => attributeModel(a, c)),
    indexes: c.indexes.map((i) => indexModel(i, c, flavor)),
    bytesMax: 0,
    bytesUsed: 0,
  }
}

/** Apply the few list queries clients send here: limit, offset, cursorAfter, equal on $id/key/name/type. */
function page<T extends Record<string, unknown>>(items: T[], rawQueries: unknown[], idField = '$id'): T[] {
  let out = items
  let limit = 25
  let offset = 0
  for (const raw of rawQueries) {
    let query: any
    try {
      query = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch {
      throw err('general_argument_invalid', 'Invalid `queries` param: Invalid query: Syntax error')
    }
    const v = query?.values ?? []
    if (query?.method === 'limit') limit = Number(v[0])
    else if (query?.method === 'offset') offset = Number(v[0])
    else if (query?.method === 'cursorAfter') {
      const i = out.findIndex((x) => x[idField] === v[0])
      out = i >= 0 ? out.slice(i + 1) : out
    } else if (query?.method === 'equal' && ['$id', 'key', 'name', 'type'].includes(query.attribute)) {
      out = out.filter((x) => v.includes(x[query.attribute]))
    }
  }
  return out.slice(offset, offset + limit)
}

/** `ID.unique()` arrives as the literal string "unique()". */
const newId = (value: unknown, label: string): string => {
  const id = str(value)
  if (!id) throw err('general_argument_invalid', `Param "${label}" is not optional.`)
  return id === 'unique()' ? uniqueId() : id
}

const permissionsOf = (value: unknown): string[] | undefined => (value === undefined || value === null ? undefined : list(value).map(String))

/** The attribute definition a create call describes. `type` is the last path segment. */
function definitionFor(type: string, p: Params): Record<string, unknown> {
  const key = str(p.key)
  if (!key) throw err('general_argument_invalid', 'Param "key" is not optional.')
  const base: Record<string, unknown> = { key, required: bool(p.required, false), array: bool(p.array, false), default: p.default ?? null }
  const encrypt = p.encrypt === undefined || p.encrypt === null ? {} : { encrypt: bool(p.encrypt, false) }
  switch (type) {
    case 'string':
    case 'varchar': {
      const size = num(p.size)
      if (size === undefined) throw err('general_argument_invalid', 'Param "size" is not optional.')
      return { ...base, type, size, ...encrypt }
    }
    case 'text':
    case 'mediumtext':
    case 'longtext':
      return { ...base, type, ...encrypt }
    case 'email':
    case 'url':
    case 'ip':
      return { ...base, type: 'string', format: type }
    case 'enum': {
      const elements = list(p.elements).map(String)
      if (!elements.length) throw err('general_argument_invalid', 'Param "elements" must list at least one value.')
      return { ...base, type: 'string', format: 'enum', elements }
    }
    case 'integer':
    case 'bigint':
    case 'float':
      return { ...base, type: type === 'float' ? 'double' : type, min: num(p.min), max: num(p.max) }
    case 'boolean':
      return { ...base, type }
    case 'datetime':
      // Kept as given ('' or 'datetime') so the definition reads back unchanged.
      return { ...base, type, format: str(p.format) ?? '' }
    default:
      throw err('general_argument_invalid', `"${type}" attributes are not supported by this server.`)
  }
}

/** The create-path type for an inline definition: `{ type: 'string', format: 'email' }` is created as `email`. */
const pathTypeOf = (raw: Record<string, any>): string =>
  FORMATTED.includes(raw.format) ? raw.format : raw.type === 'double' ? 'float' : String(raw.type)

/** Kind of value a path type stores, to reject e.g. PATCH /integer/<a string key>. */
function kindOf(type: string): string {
  if (['string', 'varchar', 'text', 'mediumtext', 'longtext', 'email', 'url', 'ip', 'enum'].includes(type)) return 'string'
  if (type === 'bigint') return 'integer'
  if (type === 'float') return 'double'
  return type
}

function attributeIn(c: Collection, key: string): Attribute {
  const a = c.attributeMap.get(key)
  if (!a) throw err('attribute_not_found', undefined, [key])
  return a
}

function indexIn(c: Collection, key: string): Index {
  const i = c.indexes.find((x) => x.key === key)
  if (!i) throw err('index_not_found', undefined, [key])
  return i
}

/** Run schema changes as one unit; a failure part-way leaves nothing behind. */
function atomically(ctx: AppContext, work: () => void): void {
  try {
    ctx.db.sqlite.transaction(work).immediate()
  } finally {
    ctx.registry.reload()
  }
}

function register(router: Router<AppContext>, flavor: Flavor): void {
  const tables = flavor === 'tables'
  const dbs = tables ? '/tablesdb' : '/databases'
  const colls = `${dbs}/:databaseId/${flavor}`
  const coll = `${colls}/:collectionId`
  const attrsName = tables ? 'columns' : 'attributes'
  const attrs = `${coll}/${attrsName}`
  const idxs = `${coll}/indexes`
  const admin = (ctx: AppContext) => new SchemaAdmin(ctx.db, ctx.registry)
  const collection = (ctx: AppContext, path: Record<string, string>) => ctx.registry.collection(path.databaseId!, path.collectionId!, true)

  // ---- Databases ----

  router.get(dbs, ({ ctx, params }) => {
    requireKey(ctx, 'databases.read')
    const all = [...ctx.registry.databases.values()].map(databaseModel)
    return json({ total: all.length, databases: page(all, list(params.queries)) })
  })

  router.post(dbs, ({ ctx, params }) => {
    requireKey(ctx, 'databases.write')
    const id = newId(params.databaseId, 'databaseId')
    const name = str(params.name) ?? id
    if (ctx.registry.databases.has(id)) throw err('database_already_exists', undefined, [id])
    admin(ctx).createDatabase(id, name)
    if (!bool(params.enabled, true)) admin(ctx).updateDatabase(id, name, false)
    return json(databaseModel(ctx.registry.database(id, true)), 201)
  })

  router.get(`${dbs}/:databaseId`, ({ ctx, path }) => {
    requireKey(ctx, 'databases.read')
    return json(databaseModel(ctx.registry.database(path.databaseId!, true)))
  })

  router.put(`${dbs}/:databaseId`, ({ ctx, path, params }) => {
    requireKey(ctx, 'databases.write')
    const d = ctx.registry.database(path.databaseId!, true)
    admin(ctx).updateDatabase(d.id, str(params.name) ?? d.name, bool(params.enabled, d.enabled))
    return json(databaseModel(ctx.registry.database(d.id, true)))
  })

  router.delete(`${dbs}/:databaseId`, ({ ctx, path }) => {
    requireKey(ctx, 'databases.write')
    admin(ctx).deleteDatabase(path.databaseId!)
    return noContent()
  })

  // ---- Collections / tables ----

  router.get(colls, ({ ctx, path, params }) => {
    requireKey(ctx, 'collections.read')
    ctx.registry.database(path.databaseId!, true)
    const all = [...ctx.registry.collections.values()]
      .filter((c) => c.databaseId === path.databaseId)
      .sort((a, b) => a.seq - b.seq)
      .map((c) => collectionModel(c, flavor))
    return json({ total: all.length, [flavor]: page(all, list(params.queries)) })
  })

  router.post(colls, ({ ctx, path, params }) => {
    requireKey(ctx, 'collections.write')
    const databaseId = path.databaseId!
    ctx.registry.database(databaseId, true)
    const id = newId(tables ? params.tableId : params.collectionId, tables ? 'tableId' : 'collectionId')
    if (ctx.registry.collections.has(`${databaseId}/${id}`)) throw err(tables ? 'table_already_exists' : 'collection_already_exists', undefined, [id])
    const security = bool(tables ? (params.rowSecurity ?? params.documentSecurity) : (params.documentSecurity ?? params.rowSecurity), false)
    // Appwrite 1.8 can create the attributes and indexes in the same call.
    const attributes = list(params.attributes ?? params.columns) as Record<string, any>[]
    const indexes = list(params.indexes) as Record<string, any>[]
    atomically(ctx, () => {
      const a = admin(ctx)
      a.createCollection(databaseId, id, str(params.name) ?? id, security, permissionsOf(params.permissions) ?? [])
      if (!bool(params.enabled, true)) a.updateCollection(databaseId, id, { enabled: false })
      for (const raw of attributes) a.saveAttribute(databaseId, id, definitionFor(pathTypeOf(raw), raw))
      for (const raw of indexes) a.saveIndex(databaseId, id, raw)
    })
    return json(collectionModel(ctx.registry.collection(databaseId, id, true), flavor), 201)
  })

  router.get(coll, ({ ctx, path }) => {
    requireKey(ctx, 'collections.read')
    return json(collectionModel(collection(ctx, path), flavor))
  })

  router.put(coll, ({ ctx, path, params }) => {
    requireKey(ctx, 'collections.write')
    const c = collection(ctx, path)
    const security = tables ? (params.rowSecurity ?? params.documentSecurity) : (params.documentSecurity ?? params.rowSecurity)
    admin(ctx).updateCollection(c.databaseId, c.id, {
      name: str(params.name) ?? c.name,
      enabled: bool(params.enabled, c.enabled),
      documentSecurity: bool(security, c.documentSecurity),
      permissions: permissionsOf(params.permissions) ?? c.permissions,
    })
    return json(collectionModel(collection(ctx, path), flavor))
  })

  router.delete(coll, ({ ctx, path }) => {
    requireKey(ctx, 'collections.write')
    admin(ctx).deleteCollection(path.databaseId!, path.collectionId!)
    return noContent()
  })

  // ---- Attributes / columns ----

  router.get(attrs, ({ ctx, path, params }) => {
    requireKey(ctx, 'collections.read')
    const c = collection(ctx, path)
    const all = c.attributes.map((a) => attributeModel(a, c))
    return json({ total: all.length, [attrsName]: page(all, list(params.queries), 'key') })
  })

  router.get(`${attrs}/:key`, ({ ctx, path }) => {
    requireKey(ctx, 'collections.read')
    const c = collection(ctx, path)
    return json(attributeModel(attributeIn(c, path.key!), c))
  })

  router.post(`${attrs}/:type`, ({ ctx, path, params }) => {
    requireKey(ctx, 'collections.write')
    const c = collection(ctx, path)
    const definition = definitionFor(path.type!, params)
    if (c.attributeMap.has(String(definition.key))) throw err(tables ? 'column_already_exists' : 'attribute_already_exists', undefined, [definition.key])
    admin(ctx).saveAttribute(c.databaseId, c.id, definition)
    const after = collection(ctx, path)
    return json(attributeModel(attributeIn(after, String(definition.key)), after), 202)
  })

  router.patch(`${attrs}/:type/:key`, ({ ctx, path, params }) => {
    requireKey(ctx, 'collections.write')
    const c = collection(ctx, path)
    const current = attributeIn(c, path.key!)
    if (kindOf(path.type!) !== current.type || (FORMATTED.includes(path.type!) && current.format !== path.type)) {
      throw err('attribute_type_invalid', undefined, [path.key])
    }
    const newKey = str(params.newKey)
    if (newKey && newKey !== current.key) throw err('general_argument_invalid', 'Renaming attributes is not supported by this server.')
    const next: Record<string, unknown> = { ...current }
    if (params.required !== undefined) next.required = bool(params.required, current.required)
    if ('default' in params) next.default = params.default ?? null
    if (params.size !== undefined) next.size = num(params.size, current.size)
    if (params.min !== undefined) next.min = num(params.min)
    if (params.max !== undefined) next.max = num(params.max)
    if (params.elements !== undefined && current.format === 'enum') next.elements = list(params.elements).map(String)
    admin(ctx).saveAttribute(c.databaseId, c.id, next, true)
    const after = collection(ctx, path)
    return json(attributeModel(attributeIn(after, current.key), after))
  })

  router.delete(`${attrs}/:key`, ({ ctx, path }) => {
    requireKey(ctx, 'collections.write')
    const c = collection(ctx, path)
    attributeIn(c, path.key!)
    admin(ctx).deleteAttribute(c.databaseId, c.id, path.key!)
    return noContent()
  })

  // ---- Indexes ----

  router.get(idxs, ({ ctx, path, params }) => {
    requireKey(ctx, 'collections.read')
    const c = collection(ctx, path)
    const all = c.indexes.map((i) => indexModel(i, c, flavor))
    return json({ total: all.length, indexes: page(all, list(params.queries), 'key') })
  })

  router.get(`${idxs}/:key`, ({ ctx, path }) => {
    requireKey(ctx, 'collections.read')
    const c = collection(ctx, path)
    return json(indexModel(indexIn(c, path.key!), c, flavor))
  })

  router.post(idxs, ({ ctx, path, params }) => {
    requireKey(ctx, 'collections.write')
    const c = collection(ctx, path)
    const key = str(params.key)
    if (!key) throw err('general_argument_invalid', 'Param "key" is not optional.')
    admin(ctx).saveIndex(c.databaseId, c.id, {
      key,
      type: params.type,
      columns: list(params.columns ?? params.attributes).map(String),
      orders: list(params.orders).map((o) => (o === null ? 'ASC' : String(o))),
    })
    const after = collection(ctx, path)
    return json(indexModel(indexIn(after, key), after, flavor), 202)
  })

  router.delete(`${idxs}/:key`, ({ ctx, path }) => {
    requireKey(ctx, 'collections.write')
    const c = collection(ctx, path)
    indexIn(c, path.key!)
    admin(ctx).deleteIndex(c.databaseId, c.id, path.key!)
    return noContent()
  })
}

export function schemaRoutes(router: Router<AppContext>): void {
  register(router, 'collections')
  register(router, 'tables')
}
