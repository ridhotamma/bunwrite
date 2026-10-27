/**
 * Appwrite queries over users, teams and memberships. Each is exposed as a
 * SQL view (drizzle/0002_list_views.sql) shaped like a collection table, so the
 * document query compiler handles filters, ordering, cursors and totals.
 */
import { keyCaller } from '~/auth/caller'
import type { DocumentStore } from '~/documents/store'
import { AppwriteError, err } from '~/lib/errors'
import { normalizeAttribute, type Attribute, type Collection } from '~/schema/types'

type Spec = [key: string, type: Attribute['type'], array?: boolean]

function pseudo(id: string, view: string, specs: Spec[]): Collection {
  const attributes = specs.map(([key, type, array]) =>
    normalizeAttribute({ key, type, array: Boolean(array), required: false, size: 1_000_000 }),
  )
  return {
    seq: 0,
    databaseId: '',
    databaseSeq: 0,
    id,
    name: id,
    enabled: true,
    documentSecurity: false,
    permissions: [],
    attributes,
    indexes: [],
    createdAt: '',
    updatedAt: '',
    table: view,
    permsTable: '',
    attributeMap: new Map(attributes.map((a) => [a.key, a])),
  }
}

export const USERS = pseudo('users', 'v_users', [
  ['name', 'string'],
  ['email', 'string'],
  ['phone', 'string'],
  ['status', 'boolean'],
  ['labels', 'string', true],
  ['registration', 'datetime'],
  ['passwordUpdate', 'datetime'],
  ['emailVerification', 'boolean'],
  ['phoneVerification', 'boolean'],
  ['accessedAt', 'datetime'],
])

export const TEAMS = pseudo('teams', 'v_teams', [
  ['name', 'string'],
  ['total', 'integer'],
])

export const MEMBERSHIPS = pseudo('memberships', 'v_memberships', [
  ['userId', 'string'],
  ['teamId', 'string'],
  ['invited', 'datetime'],
  ['joined', 'datetime'],
  ['confirm', 'boolean'],
  ['roles', 'string', true],
  ['userName', 'string'],
  ['userEmail', 'string'],
  ['teamName', 'string'],
])

const q = (method: string, attribute: string | undefined, values: unknown[]) => JSON.stringify({ method, attribute, values })

export interface ListOptions {
  /** Extra filters the caller may not remove, e.g. `teamId = x`. */
  scope?: string[]
  /** Appwrite's `search` param, matched against these fields. */
  search?: { term: string; fields: string[] }
  includeTotal?: boolean
}

/** Run Appwrite queries against a view; returns the matching row `seq`s in order, and the total. */
export function listSeqs(store: DocumentStore, collection: Collection, queries: unknown[], options: ListOptions = {}): { total: number; seqs: number[] } {
  const all = [...(options.scope ?? []), ...queries]
  const term = options.search?.term?.trim()
  if (term && options.search) {
    all.push(q('or', undefined, options.search.fields.map((f) => JSON.parse(q('contains', f, [term])))))
  }
  try {
    const result = store.listDocuments(keyCaller(), collection, all, options.includeTotal ?? true)
    return { total: result.total, seqs: result.documents.map((d) => Number(d.$sequence)) }
  } catch (error) {
    if (error instanceof AppwriteError && error.type === 'general_query_invalid') {
      throw err('general_argument_invalid', `Invalid \`queries\` param: ${error.message}`)
    }
    throw error
  }
}

export const scopeEqual = (attribute: string, value: string) => q('equal', attribute, [value])
