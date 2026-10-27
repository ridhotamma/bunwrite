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

import { keyCaller } from '../auth/caller'
import { parsePermission } from '../auth/permissions'
import { q, type Db } from '../db/connection'
import { decodeRow, type Doc } from '../documents/codec'
import { DocumentStore } from '../documents/store'
import { normalizeDate, now } from '../lib/datetime'
import { pushConfig } from '../schema/push'
import { Registry } from '../schema/registry'
import type { Attribute, Collection } from '../schema/types'

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
  /** Functions to register from pesanle's appwrite.config.json (their code lives there). */
  functions?: { config: unknown; baseDir: string }
}

export interface ImportReport {
  collections: { id: string; source: number; imported: number }[]
  users: number
  identities: number
  teams: number
  memberships: number
  files: number
  fileBytes: number
  skipped: string[]
  hashFormats: Record<string, number>
}

class Source {
  constructor(private opts: ImportOptions) {}

  async get<T = any>(path: string, queries: string[] = []): Promise<T> {
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
export function configFromLive(databases: any[], collections: any[], buckets: any[]) {
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
        .filter((a: any) => !a.status || a.status === 'available')
        .map((a: any) => ({
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
        .filter((i: any) => !i.status || i.status === 'available')
        .map((i: any) => ({ key: i.key, type: i.type, columns: i.attributes ?? i.columns ?? [], orders: (i.orders ?? []).map((o: string | null) => o ?? 'ASC') })),
    })),
    buckets,
  }
}

export async function importFromAppwrite(db: Db, opts: ImportOptions): Promise<ImportReport> {
  const log = opts.log ?? (() => {})
  const want = (area: string) => !opts.only || opts.only.has(area)
  const source = new Source(opts)
  const pageSize = opts.pageSize ?? 500
  const sql = db.sqlite
  const report: ImportReport = { collections: [], users: 0, identities: 0, teams: 0, memberships: 0, files: 0, fileBytes: 0, skipped: [], hashFormats: {} }

  // ---------------------------------------------------------- schema
  const databases = (await source.get<{ databases: any[] }>('/databases')).databases
  const collections: any[] = []
  for (const d of databases) collections.push(...(await source.all(`/databases/${d.$id}/collections`, 'collections')))
  const buckets = want('files') || want('schema') ? (await source.get<{ buckets: any[] }>('/storage/buckets')).buckets : []
  if (want('schema')) {
    pushConfig(db, configFromLive(databases, collections, buckets), { log: (l) => log(`[schema] ${l}`) })
    if (opts.functions) pushConfig(db, { functions: (opts.functions.config as any).functions ?? [] }, { baseDir: opts.functions.baseDir, log: (l) => log(`[schema] ${l}`) })
  }
  const registry = new Registry(db)

  // ---------------------------------------------------------- users
  if (want('users')) {
    const users = await source.all<any>('/users', 'users', [], pageSize)
    const insert = sql.query(
      `INSERT OR REPLACE INTO _users (id, name, email, phone, password, hash, hash_options, registration, status, labels, password_update,
        email_verification, phone_verification, mfa, prefs, accessed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    sql.transaction(() => {
      for (const u of users) {
        const format = !u.password ? 'none' : /^\$argon2id\$/.test(u.password) ? 'argon2id-phc' : /^\$2[aby]\$/.test(u.password) ? 'bcrypt' : String(u.hash ?? 'unknown')
        report.hashFormats[format] = (report.hashFormats[format] ?? 0) + 1
        insert.run(
          u.$id, u.name ?? '', empty(u.email) ? String(u.email).toLowerCase() : null, empty(u.phone) as string | null, empty(u.password) as string | null,
          u.hash || 'argon2', JSON.stringify(u.hashOptions ?? {}), u.registration ?? u.$createdAt, u.status === false ? 0 : 1,
          JSON.stringify(u.labels ?? []), empty(u.passwordUpdate) as string | null, u.emailVerification ? 1 : 0, u.phoneVerification ? 1 : 0,
          u.mfa ? 1 : 0, JSON.stringify(u.prefs ?? {}), empty(u.accessedAt) as string | null, u.$createdAt, u.$updatedAt,
        )
      }
    })()
    report.users = users.length
    log(`users: ${users.length}`)

    const identities = await source.all<any>('/users/identities', 'identities', [], pageSize)
    const insertIdentity = sql.query(
      `INSERT OR REPLACE INTO _identities (id, user_id, provider, provider_uid, provider_email, provider_access_token, provider_access_token_expiry, provider_refresh_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    sql.transaction(() => {
      for (const i of identities) {
        if (!sql.query('SELECT 1 FROM _users WHERE id = ?').get(i.userId)) continue
        insertIdentity.run(i.$id, i.userId, i.provider, i.providerUid, i.providerEmail ?? '', i.providerAccessToken ?? '', i.providerAccessTokenExpiry ?? '', i.providerRefreshToken ?? '', i.$createdAt, i.$updatedAt)
        report.identities++
      }
    })()
    log(`identities: ${report.identities}`)
  }

  // ---------------------------------------------------------- teams
  if (want('teams')) {
    const teams = await source.all<any>('/teams', 'teams', [], pageSize)
    for (const t of teams) {
      const prefs = await source.get(`/teams/${t.$id}/prefs`).catch(() => t.prefs ?? {})
      sql.query('INSERT OR REPLACE INTO _teams (id, name, prefs, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(t.$id, t.name, JSON.stringify(prefs ?? {}), t.$createdAt, t.$updatedAt)
      const memberships = await source.all<any>(`/teams/${t.$id}/memberships`, 'memberships', [], pageSize)
      for (const m of memberships) {
        if (!sql.query('SELECT 1 FROM _users WHERE id = ?').get(m.userId)) {
          report.skipped.push(`membership ${m.$id}: user ${m.userId} missing`)
          continue
        }
        sql
          .query(
            `INSERT OR REPLACE INTO _memberships (id, team_id, user_id, roles, invited, joined, confirm, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(m.$id, t.$id, m.userId, JSON.stringify(m.roles ?? []), m.invited || m.$createdAt, empty(m.joined) as string | null, m.confirm ? 1 : 0, m.$createdAt, m.$updatedAt)
        report.memberships++
      }
    }
    report.teams = teams.length
    log(`teams: ${teams.length}, memberships: ${report.memberships}`)
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
      const files = await source.all<any>(`/storage/buckets/${b.$id}/files`, 'files', [], 100)
      for (const f of files) {
        if (f.chunksUploaded < f.chunksTotal) {
          report.skipped.push(`file ${b.$id}/${f.$id}: upload never finished`)
          continue
        }
        const bytes = await source.bytes(`/storage/buckets/${b.$id}/files/${f.$id}/download?project=${opts.projectId}`)
        const target = join(opts.storagePath, b.$id, f.$id)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, bytes)
        sql
          .query(
            `INSERT OR REPLACE INTO _files (id, bucket_id, name, permissions, signature, mime_type, size_original, chunks_total, chunks_uploaded, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(f.$id, b.$id, f.name, JSON.stringify(f.$permissions ?? []), f.signature ?? '', f.mimeType ?? 'application/octet-stream', bytes.length, f.chunksTotal ?? 1, f.chunksUploaded ?? 1, f.$createdAt, f.$updatedAt)
        report.files++
        report.fileBytes += bytes.length
      }
      log(`files ${b.$id}: ${files.length}`)
    }
  }

  sql.run('PRAGMA optimize')
  return report
}

async function importCollection(db: Db, source: Source, collection: Collection, pageSize: number): Promise<{ source: number; imported: number }> {
  const sql = db.sqlite
  const columns = ['_seq', '_id', '_createdAt', '_updatedAt', '_permissions', ...collection.attributes.map((a) => a.key)]
  const insert = sql.query(`INSERT OR REPLACE INTO ${q(collection.table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
  const clearPerms = sql.query(`DELETE FROM ${q(collection.permsTable)} WHERE doc = ?`)
  const addPerm = sql.query(`INSERT OR IGNORE INTO ${q(collection.permsTable)} (doc, type, role) VALUES (?, ?, ?)`)
  const path = `/databases/${collection.databaseId}/collections/${collection.id}/documents`
  let imported = 0
  let total = 0
  let cursor: string | null = null
  for (;;) {
    const queries = [JSON.stringify({ method: 'orderAsc', attribute: '$sequence' }), JSON.stringify({ method: 'limit', values: [pageSize] })]
    if (cursor) queries.push(JSON.stringify({ method: 'cursorAfter', values: [cursor] }))
    const page = await source.get<{ total: number; documents: any[] }>(path, queries)
    if (!cursor) total = page.total
    sql.transaction(() => {
      for (const d of page.documents) {
        const seq = Number(d.$sequence)
        insert.run(
          seq,
          d.$id,
          normalizeDate(d.$createdAt) ?? now(),
          normalizeDate(d.$updatedAt) ?? now(),
          JSON.stringify(d.$permissions ?? []),
          ...collection.attributes.map((a) => encodeLenient(a, d[a.key])),
        )
        clearPerms.run(seq)
        for (const p of d.$permissions ?? []) {
          const { type, role } = parsePermission(p)
          if (type === 'write') {
            addPerm.run(seq, 'update', role)
            addPerm.run(seq, 'delete', role)
          } else addPerm.run(seq, type, role)
        }
        imported++
      }
    })()
    if (page.documents.length < pageSize) break
    cursor = page.documents[page.documents.length - 1].$id
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
  db: Db,
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
    const local = store.listDocuments(keyCaller(), collection, queries)
    if (remote.total !== local.total) mismatches.push(`${collection.id}: total ${remote.total} vs ${local.total}`)
    remote.documents.forEach((doc, i) => {
      checked++
      const mine = local.documents[i]
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
