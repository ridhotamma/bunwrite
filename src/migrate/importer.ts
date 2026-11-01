/**
 * Copy a live Appwrite project into this server's SQLite database, using only
 * reads against Appwrite (an API key with read scopes is enough).
 *
 * What moves, keeping every ID, timestamp, permission and `$sequence`:
 * schema (databases, collections, attributes, indexes, buckets), documents,
 * users with their password hashes (nobody resets a password), linked Google
 * identities, teams with prefs, memberships, and stored files.
 *
 * What does not: sessions and tokens (Appwrite stores only hashes, so everyone
 * signs in once more), executions, and anything in collections being created.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { keyCaller } from '~/auth/caller'
import { parsePermission } from '~/auth/permissions'
import { q, type Db } from '~/db/connection'
import type { BindValue, SqlDatabase, SqlExecutor } from '~/db/driver'
import type { PostgresDriver } from '~/db/postgres-driver'
import { decodeRow, type Doc } from '~/documents/codec'
import { DocumentStore } from '~/documents/store'
import { normalizeDate, now } from '~/lib/datetime'
import { pushConfig } from '~/schema/push'
import { pushConfigPostgres } from '~/schema/push-postgres'
import { Registry } from '~/schema/registry'
import type { Attribute, Collection } from '~/schema/types'

export interface LiveAttribute {
  key?: string
  type?: string
  format?: string
  required?: boolean
  array?: boolean
  size?: number
  min?: number
  max?: number
  default?: unknown
  elements?: string[]
  status?: string
}

interface LiveIndex {
  key?: string
  type?: string
  attributes?: string[]
  columns?: string[]
  orders?: (string | null)[]
  status?: string
}

export interface LiveDatabase {
  $id: string
  name?: string
  enabled?: boolean
}

export interface LiveCollection {
  $id: string
  databaseId?: string
  name?: string
  enabled?: boolean
  documentSecurity?: boolean
  rowSecurity?: boolean
  $permissions?: string[]
  attributes?: LiveAttribute[]
  columns?: LiveAttribute[]
  indexes?: LiveIndex[]
}

export interface LiveUser {
  $id: string
  name?: string
  email?: string
  phone?: string
  password?: string
  hash?: string
  hashOptions?: Record<string, unknown>
  registration?: string
  status?: boolean
  labels?: string[]
  passwordUpdate?: string
  emailVerification?: boolean
  phoneVerification?: boolean
  mfa?: boolean
  prefs?: Record<string, unknown>
  accessedAt?: string
  $createdAt: string
  $updatedAt: string
}

interface LiveIdentity {
  $id: string
  userId: string
  provider: string
  providerUid?: string
  providerEmail?: string
  providerAccessToken?: string
  providerAccessTokenExpiry?: string
  providerRefreshToken?: string
  $createdAt: string
  $updatedAt: string
}

interface LiveTeam {
  $id: string
  name?: string
  prefs?: Record<string, unknown>
  $createdAt: string
  $updatedAt: string
}

interface LiveMembership {
  $id: string
  userId: string
  roles?: string[]
  invited?: string
  joined?: string
  confirm?: boolean
  $createdAt: string
  $updatedAt: string
}

interface LiveVariable {
  $id: string
  key: string
  value?: string
  secret?: boolean
  $createdAt: string
  $updatedAt: string
}

interface LiveBucket {
  $id: string
}

interface LiveFile {
  $id: string
  name?: string
  $permissions?: string[]
  signature?: string
  mimeType?: string
  chunksTotal?: number
  chunksUploaded?: number
  $createdAt: string
  $updatedAt: string
}

export interface LiveDocument {
  $id: string
  $sequence?: string
  $createdAt?: string
  $updatedAt?: string
  $permissions?: string[]
  $revision?: number
  [key: string]: unknown
}

export interface ImportOptions {
  endpoint: string
  projectId: string
  key: string
  /** Where file bytes go (the server's STORAGE_PATH). */
  storagePath: string
  /** Areas to copy; default all: schema, documents, users, teams, files. */
  only?: Set<string>
  pageSize?: number
  log?: (line: string) => void
  /** Functions to register from the appwrite.config.json (their code lives there). */
  functions?: { config: unknown; baseDir: string }
}

export interface ImportReport {
  collections: { id: string; source: number; imported: number }[]
  users: number
  identities: number
  teams: number
  memberships: number
  /** Project variables (`/project/variables`); site variables follow their sites. */
  variables: number
  files: number
  fileBytes: number
  skipped: string[]
  hashFormats: Record<string, number>
}

class Source {
  constructor(private opts: ImportOptions) {}

  async get<T = unknown>(path: string, queries: string[] = []): Promise<T> {
    const url = new URL(this.opts.endpoint.replace(/\/$/, '') + path)
    queries.forEach((qq, i) => url.searchParams.append(`queries[${i}]`, qq))
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { 'x-appwrite-project': this.opts.projectId, 'x-appwrite-key': this.opts.key } })
      if (res.ok) return (await res.json()) as T
      if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
        await Bun.sleep(1000 * (attempt + 1))
        continue
      }
      throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`)
    }
  }

  async bytes(path: string): Promise<Uint8Array> {
    const res = await fetch(this.opts.endpoint.replace(/\/$/, '') + path, {
      headers: { 'x-appwrite-project': this.opts.projectId, 'x-appwrite-key': this.opts.key },
    })
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  /** Every item of a list endpoint, paged by cursor. */
  async all<T extends { $id: string }>(path: string, key: string, extra: string[] = [], pageSize = 100): Promise<T[]> {
    const out: T[] = []
    let cursor: string | null = null
    for (;;) {
      const queries = [...extra, JSON.stringify({ method: 'limit', values: [pageSize] })]
      if (cursor) queries.push(JSON.stringify({ method: 'cursorAfter', values: [cursor] }))
      const page = await this.get<Record<string, T[]>>(path, queries)
      const items = page[key] ?? []
      out.push(...items)
      if (items.length < pageSize) return out
      cursor = items[items.length - 1]!.$id
    }
  }
}

const empty = (v: unknown) => (v === '' || v === undefined ? null : v)

/** Store a value as-is apart from type encoding: old documents may predate a `required` flag. */
function encodeLenient(a: Attribute, value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (a.array) return JSON.stringify(Array.isArray(value) ? value : [value])
  if (a.type === 'boolean') return value ? 1 : 0
  if (a.type === 'datetime') return normalizeDate(value) ?? String(value)
  if (typeof value === 'object') return JSON.stringify(value)
  return value as string | number
}

/** Turn Appwrite's collection list into the appwrite.config.json shape pushConfig reads. */
export function configFromLive(databases: LiveDatabase[], collections: LiveCollection[], buckets: LiveBucket[]) {
  return {
    tablesDB: databases.map((d) => ({ $id: d.$id, name: d.name, enabled: d.enabled })),
    tables: collections.map((c) => ({
      $id: c.$id,
      databaseId: c.databaseId,
      name: c.name,
      enabled: c.enabled,
      rowSecurity: c.documentSecurity ?? c.rowSecurity,
      $permissions: c.$permissions ?? [],
      columns: (c.attributes ?? c.columns ?? [])
        .filter((a: LiveAttribute) => !a.status || a.status === 'available')
        .map((a: LiveAttribute) => ({
          key: a.key,
          type: a.type,
          format: a.format ?? '',
          required: a.required,
          array: a.array,
          size: a.size,
          min: a.min,
          max: a.max,
          default: a.default ?? null,
          elements: a.elements,
        })),
      indexes: (c.indexes ?? [])
        .filter((i: LiveIndex) => !i.status || i.status === 'available')
        .map((i: LiveIndex) => ({ key: i.key, type: i.type, columns: i.attributes ?? i.columns ?? [], orders: (i.orders ?? []).map((o: string | null) => o ?? 'ASC') })),
    })),
    buckets,
  }
}

/** Import replaces rows by their stable IDs, so a re-run is idempotent. */
async function replaceRow(
  tx: SqlExecutor,
  table: string,
  where: { column: string; value: string | number }[],
  columns: string[],
  values: BindValue[],
): Promise<void> {
  await tx.run(`DELETE FROM ${q(table)} WHERE ${where.map((entry) => `${q(entry.column)} = ?`).join(' AND ')}`, where.map((entry) => entry.value))
  await tx.run(`INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, values)
}

export async function importFromAppwrite(db: SqlDatabase, opts: ImportOptions): Promise<ImportReport> {
  const log = opts.log ?? (() => {})
  const want = (area: string) => !opts.only || opts.only.has(area)
  const source = new Source(opts)
  const pageSize = opts.pageSize ?? 500
  const report: ImportReport = { collections: [], users: 0, identities: 0, teams: 0, memberships: 0, variables: 0, files: 0, fileBytes: 0, skipped: [], hashFormats: {} }

  // ---------------------------------------------------------- schema
  const databases = (await source.get<{ databases: LiveDatabase[] }>('/databases')).databases
  const collections: LiveCollection[] = []
  for (const d of databases) collections.push(...(await source.all<LiveCollection>(`/databases/${d.$id}/collections`, 'collections')))
  const buckets: LiveBucket[] = want('files') || want('schema') ? (await source.get<{ buckets: LiveBucket[] }>('/storage/buckets')).buckets : []
  if (want('schema')) {
    const push = async (config: unknown) => {
      if (db.dialect === 'postgres') await pushConfigPostgres(db.driver as PostgresDriver, config, { log: (l) => log(`[schema] ${l}`) })
      else pushConfig(db as Db, config, { log: (l) => log(`[schema] ${l}`) })
    }
    await push(configFromLive(databases, collections, buckets))
    if (opts.functions) {
      const config = opts.functions.config && typeof opts.functions.config === 'object' ? (opts.functions.config as Record<string, unknown>) : {}
      const functions = Array.isArray(config.functions) ? config.functions : []
      if (db.dialect === 'postgres') {
        await pushConfigPostgres(db.driver as PostgresDriver, { functions }, { baseDir: opts.functions.baseDir, log: (l) => log(`[schema] ${l}`) })
      } else {
        pushConfig(db as Db, { functions }, { baseDir: opts.functions.baseDir, log: (l) => log(`[schema] ${l}`) })
      }
    }
  }
  const registry = new Registry(db)

  // ---------------------------------------------------------- users
  if (want('users')) {
    const users = await source.all<LiveUser>('/users', 'users', [], pageSize)
    const columns = [
      'id', 'name', 'email', 'phone', 'password', 'hash', 'hash_options', 'registration', 'status', 'labels', 'password_update',
      'email_verification', 'phone_verification', 'mfa', 'prefs', 'accessed_at', 'created_at', 'updated_at',
    ]
    await db.driver.transaction(async (tx) => {
      for (const u of users) {
        const format = !u.password ? 'none' : /^\$argon2id\$/.test(u.password) ? 'argon2id-phc' : /^\$2[aby]\$/.test(u.password) ? 'bcrypt' : String(u.hash ?? 'unknown')
        report.hashFormats[format] = (report.hashFormats[format] ?? 0) + 1
        await replaceRow(tx, '_users', [{ column: 'id', value: u.$id }], columns, [
          u.$id, u.name ?? '', empty(u.email) ? String(u.email).toLowerCase() : null, empty(u.phone) as string | null, empty(u.password) as string | null,
          u.hash || 'argon2', JSON.stringify(u.hashOptions ?? {}), u.registration ?? u.$createdAt, u.status === false ? 0 : 1,
          JSON.stringify(u.labels ?? []), empty(u.passwordUpdate) as string | null, u.emailVerification ? 1 : 0, u.phoneVerification ? 1 : 0,
          u.mfa ? 1 : 0, JSON.stringify(u.prefs ?? {}), empty(u.accessedAt) as string | null, u.$createdAt, u.$updatedAt,
        ])
      }
    })
    report.users = users.length
    log(`users: ${users.length}`)

    const identities = await source.all<LiveIdentity>('/users/identities', 'identities', [], pageSize)
    const identityColumns = [
      'id', 'user_id', 'provider', 'provider_uid', 'provider_email', 'provider_access_token', 'provider_access_token_expiry',
      'provider_refresh_token', 'created_at', 'updated_at',
    ]
    await db.driver.transaction(async (tx) => {
      for (const i of identities) {
        if (!(await tx.get('SELECT 1 AS one FROM _users WHERE id = ?', [i.userId]))) continue
        await replaceRow(tx, '_identities', [{ column: 'id', value: i.$id }], identityColumns, [
          i.$id, i.userId, i.provider, i.providerUid ?? '', i.providerEmail ?? '', i.providerAccessToken ?? '', i.providerAccessTokenExpiry ?? '',
          i.providerRefreshToken ?? '', i.$createdAt, i.$updatedAt,
        ])
        report.identities++
      }
    })
    log(`identities: ${report.identities}`)
  }

  // ---------------------------------------------------------- teams
  if (want('teams')) {
    const teams = await source.all<LiveTeam>('/teams', 'teams', [], pageSize)
    for (const t of teams) {
      const prefs = await source.get<Record<string, unknown>>(`/teams/${t.$id}/prefs`).catch(() => t.prefs ?? {})
      await db.driver.run('DELETE FROM _teams WHERE id = ?', [t.$id])
      await db.driver.run('INSERT INTO _teams (id, name, prefs, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
        t.$id,
        t.name ?? t.$id,
        JSON.stringify(prefs ?? {}),
        t.$createdAt,
        t.$updatedAt,
      ])
      const memberships = await source.all<LiveMembership>(`/teams/${t.$id}/memberships`, 'memberships', [], pageSize)
      for (const m of memberships) {
        if (!(await db.driver.get('SELECT 1 AS one FROM _users WHERE id = ?', [m.userId]))) {
          report.skipped.push(`membership ${m.$id}: user ${m.userId} missing`)
          continue
        }
        await replaceRow(
          db.driver,
          '_memberships',
          [{ column: 'id', value: m.$id }],
          ['id', 'team_id', 'user_id', 'roles', 'invited', 'joined', 'confirm', 'created_at', 'updated_at'],
          [m.$id, t.$id, m.userId, JSON.stringify(m.roles ?? []), m.invited || m.$createdAt, empty(m.joined) as string | null, m.confirm ? 1 : 0, m.$createdAt, m.$updatedAt],
        )
        report.memberships++
      }
    }
    report.teams = teams.length
    log(`teams: ${teams.length}, memberships: ${report.memberships}`)
  }

  // ---------------------------------------------------------- variables
  if (want('variables')) {
    // Project variables apply to every function and site. Site variables are
    // set with the sites themselves (the importer does not create sites).
    const vars = await source
      .all<LiveVariable>('/project/variables', 'variables', [], pageSize)
      .catch((error) => {
        report.skipped.push(`project variables: ${(error as Error).message}`)
        return []
      })
    await db.driver.transaction(async (tx) => {
      for (const v of vars) {
        await tx.run("DELETE FROM _variables WHERE id = ? OR (scope = 'project' AND key = ? AND context = '')", [v.$id, v.key])
        await tx.run("INSERT INTO _variables (id, scope, key, value, secret, context, created_at, updated_at) VALUES (?, 'project', ?, ?, ?, '', ?, ?)", [
          v.$id,
          v.key,
          v.value ?? '',
          v.secret ? 1 : 0,
          v.$createdAt,
          v.$updatedAt,
        ])
        report.variables++
      }
    })
    log(`project variables: ${report.variables}`)
  }

  // ---------------------------------------------------------- documents
  if (want('documents')) {
    for (const c of collections) {
      const collection = registry.collections.get(`${c.databaseId}/${c.$id}`)
      if (!collection) {
        report.skipped.push(`collection ${c.databaseId}/${c.$id}: not in schema`)
        continue
      }
      const imported = await importCollection(db, source, collection, pageSize)
      report.collections.push({ id: `${c.databaseId}/${c.$id}`, ...imported })
      if (imported.source) log(`documents ${c.$id}: ${imported.imported}/${imported.source}`)
    }
  }

  // ---------------------------------------------------------- files
  if (want('files')) {
    for (const b of buckets) {
      const files = await source.all<LiveFile>(`/storage/buckets/${b.$id}/files`, 'files', [], 100)
      for (const f of files) {
        if ((f.chunksUploaded ?? 1) < (f.chunksTotal ?? 1)) {
          report.skipped.push(`file ${b.$id}/${f.$id}: upload never finished`)
          continue
        }
        const bytes = await source.bytes(`/storage/buckets/${b.$id}/files/${f.$id}/download?project=${opts.projectId}`)
        const target = join(opts.storagePath, b.$id, f.$id)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, bytes)
        await db.driver.run('DELETE FROM _files WHERE bucket_id = ? AND id = ?', [b.$id, f.$id])
        await db.driver.run(
          `INSERT INTO _files (id, bucket_id, name, permissions, signature, mime_type, size_original, chunks_total, chunks_uploaded, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            f.$id,
            b.$id,
            f.name ?? f.$id,
            JSON.stringify(f.$permissions ?? []),
            f.signature ?? '',
            f.mimeType ?? 'application/octet-stream',
            bytes.length,
            f.chunksTotal ?? 1,
            f.chunksUploaded ?? 1,
            f.$createdAt,
            f.$updatedAt,
          ],
        )
        report.files++
        report.fileBytes += bytes.length
      }
      log(`files ${b.$id}: ${files.length}`)
    }
  }

  if (db.dialect === 'sqlite') await db.driver.exec('PRAGMA optimize')
  return report
}

async function importCollection(db: SqlDatabase, source: Source, collection: Collection, pageSize: number): Promise<{ source: number; imported: number }> {
  const columns = ['_seq', '_id', '_createdAt', '_updatedAt', '_permissions', '_rev', ...collection.attributes.map((a) => a.key)]
  const path = `/databases/${collection.databaseId}/collections/${collection.id}/documents`
  const insert = `INSERT INTO ${q(collection.table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  let imported = 0
  let total = 0
  let cursor: string | null = null
  for (;;) {
    const queries = [JSON.stringify({ method: 'orderAsc', attribute: '$sequence' }), JSON.stringify({ method: 'limit', values: [pageSize] })]
    if (cursor) queries.push(JSON.stringify({ method: 'cursorAfter', values: [cursor] }))
    const page = await source.get<{ total: number; documents: LiveDocument[] }>(path, queries)
    if (!cursor) total = page.total
    await db.driver.transaction(async (tx) => {
      for (const d of page.documents) {
        const seq = Number(d.$sequence)
        // Replace by both keys so a re-run that kept the ID but changed the
        // sequence does not collide with the identity/unique index.
        await tx.run(`DELETE FROM ${q(collection.table)} WHERE ${q('_seq')} = ? OR ${q('_id')} = ?`, [seq, d.$id])
        await tx.run(insert, [
          seq,
          d.$id,
          normalizeDate(d.$createdAt) ?? now(),
          normalizeDate(d.$updatedAt) ?? now(),
          JSON.stringify(d.$permissions ?? []),
          // Appwrite has no revision; keep the source's if it is a Bunwrite one.
          Number(d.$revision) || 1,
          ...collection.attributes.map((a) => encodeLenient(a, d[a.key])),
        ])
        await tx.run(`DELETE FROM ${q(collection.permsTable)} WHERE doc = ?`, [seq])
        for (const p of d.$permissions ?? []) {
          const { type, role } = parsePermission(p)
          if (type === 'write') {
            await tx.run(`INSERT OR IGNORE INTO ${q(collection.permsTable)} (doc, type, role) VALUES (?, ?, ?)`, [seq, 'update', role])
            await tx.run(`INSERT OR IGNORE INTO ${q(collection.permsTable)} (doc, type, role) VALUES (?, ?, ?)`, [seq, 'delete', role])
          } else await tx.run(`INSERT OR IGNORE INTO ${q(collection.permsTable)} (doc, type, role) VALUES (?, ?, ?)`, [seq, type, role])
        }
        imported++
      }
    })
    if (page.documents.length < pageSize) break
    cursor = page.documents[page.documents.length - 1]!.$id
  }
  // Explicit `_seq` values do not advance a Postgres identity sequence.
  if (db.dialect === 'postgres') {
    await db.driver.exec(
      `SELECT setval(pg_get_serial_sequence('${q(collection.table).replace(/'/g, "''")}', '_seq'), COALESCE(MAX("_seq"), 1), MAX("_seq") IS NOT NULL) FROM ${q(collection.table)}`,
    )
  }
  // Appwrite caps `total` at 5000; report what was actually copied when it is larger.
  return { source: Math.max(total, imported), imported }
}

/**
 * Compare documents between the source and this database: the first `sample`
 * of every collection, in $sequence order, must match field for field.
 */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v))

export async function verifyAgainstAppwrite(
  db: SqlDatabase,
  opts: ImportOptions,
  sample = 100,
): Promise<{ checked: number; mismatches: string[]; orderOnly: number }> {
  const source = new Source(opts)
  const registry = new Registry(db)
  const store = new DocumentStore(db)
  const mismatches: string[] = []
  let checked = 0
  // Key order is not data: some live tables list their attributes before `$id`.
  let orderOnly = 0
  for (const collection of registry.collections.values()) {
    const queries = [JSON.stringify({ method: 'orderAsc', attribute: '$sequence' }), JSON.stringify({ method: 'limit', values: [sample] })]
    const remote = await source.get<{ total: number; documents: Doc[] }>(`/databases/${collection.databaseId}/collections/${collection.id}/documents`, queries)
    const local = await store.listDocuments(keyCaller(), collection, queries)
    if (remote.total !== local.total) mismatches.push(`${collection.id}: total ${remote.total} vs ${local.total}`)
    remote.documents.forEach((doc, i) => {
      checked++
      const localDoc = local.documents[i]
      // A real Appwrite source has no `$revision`; ignore our metadata there.
      const mine = localDoc && doc.$revision === undefined
        ? (() => {
            const { $revision, ...rest } = localDoc
            return rest
          })()
        : localDoc
      if (canonical(doc) !== canonical(mine)) {
        const keys = new Set([...Object.keys(doc), ...Object.keys(mine ?? {})])
        const fields = [...keys].filter((k) => canonical(doc[k]) !== canonical(mine?.[k]))
        mismatches.push(`${collection.id}/${doc.$id}: ${fields.join(', ')}`)
      } else if (JSON.stringify(doc) !== JSON.stringify(mine)) {
        orderOnly++
      }
    })
  }
  return { checked, mismatches, orderOnly }
}

export { decodeRow }
