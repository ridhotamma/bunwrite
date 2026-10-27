/**
 * Read-only database and collection metadata (`databases.list`,
 * `databases.listCollections`, ...). The backup and media-sweep jobs read it
 * to find every collection and its columns. Schema changes go through
 * `schema:push`, not these routes.
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { err } from '~/lib/errors'
import { json, list } from '~/lib/http'
import type { Router } from '~/lib/router'
import type { DatabaseInfo } from './registry'
import type { Attribute, Collection, Index } from './types'

function databaseModel(d: DatabaseInfo) {
  return { $id: d.id, name: d.name, description: '', $createdAt: d.createdAt, $updatedAt: d.updatedAt, enabled: d.enabled, type: 'tablesdb', status: 'ready' }
}

function attributeModel(a: Attribute, c: Collection) {
  const base: Record<string, unknown> = {
    key: a.key,
    description: '',
    type: a.type,
    status: 'available',
    error: '',
    required: a.required,
    array: a.array,
    $createdAt: c.createdAt,
    $updatedAt: c.updatedAt,
  }
  if (a.type === 'string') {
    base.size = a.size
    if (a.format) base.format = a.format
    if (a.elements) base.elements = a.elements
    base.default = a.default
    base.encrypt = false
  } else if (a.type === 'integer' || a.type === 'double') {
    base.min = a.min ?? null
    base.max = a.max ?? null
    base.default = a.default
  } else if (a.type === 'datetime') {
    base.format = 'datetime'
    base.default = a.default
  } else {
    base.default = a.default
  }
  return base
}

function indexModel(i: Index, c: Collection) {
  return {
    $id: `${c.databaseSeq}_${c.seq}_${i.key}`,
    key: i.key,
    type: i.type,
    status: 'available',
    error: '',
    attributes: i.attributes,
    lengths: i.attributes.map(() => null),
    orders: i.orders,
    $createdAt: c.createdAt,
    $updatedAt: c.updatedAt,
  }
}

function collectionModel(c: Collection) {
  return {
    $id: c.id,
    $createdAt: c.createdAt,
    $updatedAt: c.updatedAt,
    $permissions: c.permissions,
    databaseId: c.databaseId,
    name: c.name,
    description: '',
    enabled: c.enabled,
    documentSecurity: c.documentSecurity,
    attributes: c.attributes.map((a) => attributeModel(a, c)),
    indexes: c.indexes.map((i) => indexModel(i, c)),
    bytesMax: 0,
    bytesUsed: 0,
  }
}

/** Apply the few list queries scripts send here: limit, offset, cursorAfter, equal on $id/name. */
function page<T extends { $id: string; name?: string }>(items: T[], rawQueries: unknown[]): T[] {
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
      const i = out.findIndex((x) => x.$id === v[0])
      out = i >= 0 ? out.slice(i + 1) : out
    } else if (query?.method === 'equal' && (query.attribute === '$id' || query.attribute === 'name')) {
      out = out.filter((x) => v.includes(query.attribute === '$id' ? x.$id : x.name))
    }
  }
  return out.slice(offset, offset + limit)
}

export function schemaRoutes(router: Router<AppContext>): void {
  router.get('/databases', ({ ctx, params }) => {
    requireKey(ctx, 'databases.read')
    const all = [...ctx.registry.databases.values()].map(databaseModel)
    return json({ total: all.length, databases: page(all, list(params.queries)) })
  })

  router.get('/databases/:databaseId', ({ ctx, path }) => {
    requireKey(ctx, 'databases.read')
    return json(databaseModel(ctx.registry.database(path.databaseId!, true)))
  })

  router.get('/databases/:databaseId/collections', ({ ctx, path, params }) => {
    requireKey(ctx, 'collections.read')
    ctx.registry.database(path.databaseId!, true)
    const all = [...ctx.registry.collections.values()].filter((c) => c.databaseId === path.databaseId).sort((a, b) => a.seq - b.seq).map(collectionModel)
    return json({ total: all.length, collections: page(all, list(params.queries)) })
  })

  router.get('/databases/:databaseId/collections/:collectionId', ({ ctx, path }) => {
    requireKey(ctx, 'collections.read')
    return json(collectionModel(ctx.registry.collection(path.databaseId!, path.collectionId!, true)))
  })
}
