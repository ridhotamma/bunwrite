/**
 * Appwrite Storage on local disk: `<storagePath>/<bucketId>/<fileId>`, with
 * metadata in `_files`. Supports the SDK's chunked uploads (Content-Range +
 * the upload ID header), Range reads for video, and resized previews through sharp.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, openSync, writeSync, closeSync, renameSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Caller } from '~/auth/caller'
import { aggregatePermissions, grants, parsePermission, type PermissionType } from '~/auth/permissions'
import type { Config } from '~/config'
import type { Db } from '~/db/connection'
import type { DocumentStore } from '~/documents/store'
import { isCompressible } from '~/lib/compress'
import { now } from '~/lib/datetime'
import { BunwriteError, err } from '~/lib/errors'
import { isValidId, resolveId } from '~/lib/ids'
import { listSeqs } from '~/system/list'
import { normalizeAttribute, type Collection } from '~/schema/types'
import { s3Client, s3Key } from './s3'
import { loadSharp } from './sharp'
import { previewKey, previewOptions, renderPreview } from './transform'

/** Cache headers for a file or preview: `private` so only the visitor's browser keeps it, never a shared proxy. */
function cacheHeaders(maxAge: number, etag: string): Record<string, string> {
  return { 'cache-control': maxAge > 0 ? `private, max-age=${maxAge}` : 'private, no-cache', etag }
}

/** A 304 when the browser already has this version (If-None-Match uses weak comparison). */
function notModified(request: Request, headers: Record<string, string>): Response | null {
  const header = request.headers.get('if-none-match')
  if (!header) return null
  const tags = header.split(',').map((t) => t.trim().replace(/^W\//, ''))
  if (!tags.includes('*') && !tags.includes(headers.etag!)) return null
  return new Response(null, {
    status: 304,
    headers: { etag: headers.etag!, 'cache-control': headers['cache-control']!, ...(headers.vary ? { vary: headers.vary } : {}) },
  })
}

/** File contents never change after upload, so the checksum (or the ID) names the version. */
/**
 * Uploads are served from the API's own origin, next to the console, with the
 * type the uploader chose. `sandbox` gives an HTML or SVG upload an opaque
 * origin with scripts off, so it cannot act as whoever opens it. Images,
 * audio and video still display. PDFs are left alone: browsers open them in
 * their own viewer, which a sandboxed page would block.
 */
export function uploadCsp(mime: string): string | null {
  if (mime.toLowerCase() === 'application/pdf') return null
  return "sandbox; default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'unsafe-inline'; font-src * data:"
}

const fileEtag = (file: FileRow) => `"${file.signature || `${file.id}-${file.size_original}`}"`

/** Previews rendered at once (PREVIEW_CONCURRENCY, default 4); more wait in line. */
function previewConcurrency(): number {
  const n = Number(process.env.PREVIEW_CONCURRENCY)
  return Number.isInteger(n) && n > 0 ? n : 4
}

export interface BucketRow {
  id: string
  name: string
  enabled: number
  file_security: number
  permissions: string
  maximum_file_size: number
  allowed_file_extensions: string
  compression: string
  encryption: number
  antivirus: number
  transformations: number
  created_at: string
  updated_at: string
}

export interface FileRow {
  seq: number
  id: string
  bucket_id: string
  name: string
  permissions: string
  signature: string
  mime_type: string
  size_original: number
  chunks_total: number
  chunks_uploaded: number
  created_at: string
  updated_at: string
}

export const CHUNK_SIZE = 5 * 1024 * 1024

const FILES: Collection = (() => {
  const attributes = (
    [
      ['bucketId', 'string'],
      ['name', 'string'],
      ['signature', 'string'],
      ['mimeType', 'string'],
      ['sizeOriginal', 'integer'],
      ['chunksTotal', 'integer'],
      ['chunksUploaded', 'integer'],
    ] as const
  ).map(([key, type]) => normalizeAttribute({ key, type, size: 1_000_000 }))
  return {
    seq: 0, databaseId: '', databaseSeq: 0, id: 'files', name: 'files', enabled: true, documentSecurity: false,
    permissions: [], attributes, indexes: [], createdAt: '', updatedAt: '', table: 'v_files', permsTable: '',
    attributeMap: new Map(attributes.map((a) => [a.key, a])),
  }
})()

export function bucketModel(b: BucketRow) {
  return {
    $id: b.id,
    $createdAt: b.created_at,
    $updatedAt: b.updated_at,
    $permissions: JSON.parse(b.permissions),
    fileSecurity: Boolean(b.file_security),
    name: b.name,
    description: '',
    enabled: Boolean(b.enabled),
    maximumFileSize: b.maximum_file_size,
    allowedFileExtensions: JSON.parse(b.allowed_file_extensions),
    compression: b.compression,
    encryption: Boolean(b.encryption),
    antivirus: Boolean(b.antivirus),
    transformations: Boolean(b.transformations),
    stripMetadata: false,
    totalSize: 0,
  }
}

/** Roles a request without a session carries: `any` and `guests`. */
const GUEST_ROLES = new Set(['any', 'guests'])

/**
 * Whether a file can be read without signing in, using the same precedence as
 * `StorageService.can`: bucket permissions first, then the file's own
 * permissions when file security is on.
 */
export function publiclyReadable(bucket: BucketRow, filePermissions: string[]): boolean {
  if (!bucket.enabled) return false
  if (grants(JSON.parse(bucket.permissions), 'read', GUEST_ROLES)) return true
  return Boolean(bucket.file_security) && grants(filePermissions, 'read', GUEST_ROLES)
}

export function fileModel(f: FileRow, bucket?: BucketRow) {
  return {
    $id: f.id,
    bucketId: f.bucket_id,
    $createdAt: f.created_at,
    $updatedAt: f.updated_at,
    $permissions: JSON.parse(f.permissions),
    name: f.name,
    folder: '',
    key: f.name,
    signature: f.signature,
    mimeType: f.mime_type,
    sizeOriginal: f.size_original,
    sizeActual: f.size_original,
    chunksTotal: f.chunks_total,
    chunksUploaded: f.chunks_uploaded,
    encryption: false,
    compression: bucket?.compression ?? 'none',
  }
}

export interface UploadInput {
  fileId: unknown
  file: unknown
  permissions: unknown
  contentRange: string | null
  uploadId: string | null
}

export class StorageService {
  constructor(
    private db: Db,
    private config: Config,
    private store: DocumentStore,
  ) {}

  private get sql() {
    return this.db.sqlite
  }

  bucket(id: string, privileged: boolean): BucketRow {
    const b = this.sql.query<BucketRow, [string]>('SELECT * FROM _buckets WHERE id = ?').get(id)
    if (!b || (!b.enabled && !privileged)) throw err('storage_bucket_not_found')
    return b
  }

  /**
   * Create or update a bucket. `compression`, `encryption` and `antivirus` are
   * kept as set (so the CLI sees no drift) but files are stored as uploaded.
   * Left out on an update, they keep their current value.
   */
  saveBucket(
    input: {
      id: string
      name: string
      enabled: boolean
      fileSecurity: boolean
      permissions: string[]
      maximumFileSize: number
      allowedFileExtensions: string[]
      transformations: boolean
      compression?: string
      encryption?: boolean
      antivirus?: boolean
    },
    create: boolean,
  ): BucketRow {
    if (create && !isValidId(input.id)) throw err('general_argument_invalid', 'Bucket ID: up to 36 chars of a-z, A-Z, 0-9, period, hyphen and underscore.')
    if (!Number.isInteger(input.maximumFileSize) || input.maximumFileSize < 1) throw err('general_argument_invalid', 'Maximum file size must be a positive number of bytes.')
    if (input.compression !== undefined && !['none', 'gzip', 'zstd'].includes(input.compression)) {
      throw err('general_argument_invalid', 'Invalid `compression` param: Value must be one of (none, gzip, zstd)')
    }
    const stamp = now()
    const current = create ? null : this.bucket(input.id, true)
    const values = [
      input.name || input.id,
      input.enabled ? 1 : 0,
      input.fileSecurity ? 1 : 0,
      JSON.stringify(input.permissions),
      input.maximumFileSize,
      JSON.stringify(input.allowedFileExtensions.map((e) => e.replace(/^\./, '').toLowerCase())),
      input.transformations ? 1 : 0,
      input.compression ?? current?.compression ?? 'none',
      (input.encryption ?? Boolean(current?.encryption)) ? 1 : 0,
      (input.antivirus ?? Boolean(current?.antivirus)) ? 1 : 0,
    ]
    if (create) {
      if (this.sql.query('SELECT 1 FROM _buckets WHERE id = ?').get(input.id)) throw err('storage_bucket_already_exists')
      this.sql
        .query(
          'INSERT INTO _buckets (name, enabled, file_security, permissions, maximum_file_size, allowed_file_extensions, transformations, compression, encryption, antivirus, created_at, updated_at, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(...(values as any[]), stamp, stamp, input.id)
    } else {
      this.sql
        .query(
          'UPDATE _buckets SET name = ?, enabled = ?, file_security = ?, permissions = ?, maximum_file_size = ?, allowed_file_extensions = ?, transformations = ?, compression = ?, encryption = ?, antivirus = ?, updated_at = ? WHERE id = ?',
        )
        .run(...(values as any[]), stamp, input.id)
    }
    return this.bucket(input.id, true)
  }

  async deleteBucket(id: string): Promise<void> {
    this.bucket(id, true)
    this.sql.transaction(() => {
      this.sql.query('DELETE FROM _files WHERE bucket_id = ?').run(id)
      this.sql.query('DELETE FROM _buckets WHERE id = ?').run(id)
    })()
    if (this.config.s3.enabled) await this.deletePrefix(`${this.prefix() ? `${this.prefix()}/` : ''}${id}/`)
    else rmSync(join(this.config.storagePath, id), { recursive: true, force: true })
    rmSync(join(this.config.storagePath, '.previews', id), { recursive: true, force: true })
    rmSync(join(this.config.storagePath, '.uploads', id), { recursive: true, force: true })
  }

  buckets(): BucketRow[] {
    return this.sql.query<BucketRow, []>('SELECT * FROM _buckets ORDER BY seq').all()
  }

  /** File count and total original bytes per bucket. */
  usageByBucket(): Map<string, { files: number; bytes: number }> {
    const rows = this.sql
      .query<{ bucket_id: string; files: number; bytes: number }, []>(
        'SELECT bucket_id, count(*) AS files, coalesce(sum(size_original), 0) AS bytes FROM _files GROUP BY bucket_id',
      )
      .all()
    return new Map(rows.map((row) => [row.bucket_id, { files: row.files, bytes: row.bytes }]))
  }

  /** File count and total original bytes across all buckets. */
  totals(): { files: number; bytes: number } {
    return this.sql
      .query<{ files: number; bytes: number }, []>('SELECT count(*) AS files, coalesce(sum(size_original), 0) AS bytes FROM _files')
      .get() as { files: number; bytes: number }
  }

  path(bucketId: string, fileId: string): string {
    return join(this.config.storagePath, bucketId, fileId)
  }

  private stagingPath(bucketId: string, fileId: string): string {
    return join(this.config.storagePath, '.uploads', bucketId, fileId)
  }

  private prefix(): string {
    return (this.config.storagePrefix ?? '').replace(/^\/+|\/+$/g, '')
  }

  private objectKey(bucketId: string, fileId: string): string {
    return s3Key(...(this.prefix() ? [this.prefix()] : []), bucketId, fileId)
  }

  private async deletePrefix(prefix: string): Promise<void> {
    const client = s3Client(this.config.s3)
    let token: string | undefined
    do {
      const page = await client.list({ prefix, maxKeys: 1000, continuationToken: token })
      for (const object of page.contents ?? []) await client.delete(object.key)
      token = page.isTruncated ? page.nextContinuationToken : undefined
    } while (token)
  }

  private row(bucketId: string, fileId: string): FileRow | null {
    return this.sql.query<FileRow, [string, string]>('SELECT * FROM _files WHERE bucket_id = ? AND id = ?').get(bucketId, fileId) ?? null
  }

  private can(caller: Caller, bucket: BucketRow, file: FileRow, type: PermissionType): boolean {
    if (caller.privileged || grants(JSON.parse(bucket.permissions), type, caller.roles)) return true
    return Boolean(bucket.file_security) && grants(JSON.parse(file.permissions), type, caller.roles)
  }

  /** A file the caller may act on; unreadable files look missing. */
  file(caller: Caller, bucketId: string, fileId: string, type: PermissionType = 'read', complete = false): { bucket: BucketRow; file: FileRow } {
    const bucket = this.bucket(bucketId, caller.privileged)
    const file = this.row(bucketId, fileId)
    if (!file || (complete && file.chunks_uploaded < file.chunks_total)) throw err('storage_file_not_found')
    if (!this.can(caller, bucket, file, 'read') && !caller.privileged) throw err('storage_file_not_found')
    if (type !== 'read' && !this.can(caller, bucket, file, type)) throw err('user_unauthorized')
    return { bucket, file }
  }

  listFiles(caller: Caller, bucketId: string, queries: unknown[], search?: string, includeTotal = true) {
    const bucket = this.bucket(bucketId, caller.privileged)
    const scope = [JSON.stringify({ method: 'equal', attribute: 'bucketId', values: [bucketId] })]
    const { total, seqs } = listSeqs(this.store, FILES, queries, {
      scope,
      includeTotal,
      search: search ? { term: search, fields: ['name', '$id'] } : undefined,
    })
    const rows = seqs.length
      ? (this.sql.query(`SELECT * FROM _files WHERE seq IN (${seqs.map(() => '?').join(', ')})`).all(...seqs) as FileRow[])
      : []
    const bySeq = new Map(rows.map((r) => [r.seq, r]))
    let files = seqs.map((s) => bySeq.get(s)!).filter(Boolean)
    if (!caller.privileged && !grants(JSON.parse(bucket.permissions), 'read', caller.roles)) {
      if (!bucket.file_security) throw err('user_unauthorized')
      files = files.filter((f) => grants(JSON.parse(f.permissions), 'read', caller.roles))
    }
    return { total, files: files.map((f) => fileModel(f, bucket)) }
  }

  private permissionsFor(caller: Caller, permissions: unknown): string[] {
    const aggregated = aggregatePermissions(permissions)
    if (aggregated === null) {
      if (caller.privileged || !caller.user) return []
      const id = caller.user.id
      return [`read("user:${id}")`, `update("user:${id}")`, `delete("user:${id}")`]
    }
    if (!caller.privileged) {
      for (const p of aggregated) {
        if (!caller.roles.has(parsePermission(p).role)) {
          throw err('user_unauthorized', `Permissions must be one of: (${[...caller.roles].join(', ')})`)
        }
      }
    }
    return aggregated
  }

  async createFile(caller: Caller, bucketId: string, input: UploadInput) {
    const bucket = this.bucket(bucketId, caller.privileged)
    if (!caller.privileged && !grants(JSON.parse(bucket.permissions), 'create', caller.roles)) throw err('user_unauthorized')
    const file = input.file
    if (!(file instanceof Blob)) throw err('storage_invalid_file')
    const name = (file as File).name || 'file'
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
    const allowed = JSON.parse(bucket.allowed_file_extensions) as string[]
    if (allowed.length && !allowed.includes(ext)) throw err('storage_file_type_unsupported')

    // Chunked uploads: `Content-Range: bytes start-end/total`, later chunks carry the upload ID header (X-Bunwrite-ID or X-Appwrite-ID).
    let start = 0
    let total = file.size
    if (input.contentRange) {
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(input.contentRange.trim())
      if (!m) throw err('storage_invalid_content_range')
      start = Number(m[1])
      total = Number(m[3])
      if (Number(m[2]) - start + 1 !== file.size || Number(m[2]) >= total) throw err('storage_invalid_content_range')
    }
    if (total === 0) throw err('storage_file_empty')
    if (total > bucket.maximum_file_size) throw err('storage_invalid_file_size')

    const fileId = input.uploadId && start > 0 ? input.uploadId : resolveId(input.fileId, 'File ID')
    if (input.uploadId && !isValidId(input.uploadId)) throw err('storage_invalid_appwrite_id')
    const existing = this.row(bucketId, fileId)
    const chunked = total > file.size
    const stamp = now()

    if (existing && (!chunked || existing.chunks_uploaded >= existing.chunks_total)) throw err('storage_file_already_exists')
    if (!existing && start > 0) throw err('storage_file_not_found')

    const chunksTotal = existing?.chunks_total ?? Math.max(1, Math.ceil(total / file.size))
    const target = this.config.s3.enabled ? this.stagingPath(bucketId, fileId) : this.path(bucketId, fileId)
    const partial = `${target}.part`
    const bytes = new Uint8Array(await file.arrayBuffer())
    const direct = this.config.s3.enabled && !chunked
    if (!direct) {
      mkdirSync(dirname(target), { recursive: true })
      const fd = openSync(chunked ? partial : target, chunked && existing ? 'r+' : 'w')
      try {
        writeSync(fd, bytes, 0, bytes.length, start)
      } finally {
        closeSync(fd)
      }
    }

    const permissions = existing ? JSON.parse(existing.permissions) : this.permissionsFor(caller, input.permissions)
    const uploaded = (existing?.chunks_uploaded ?? 0) + 1
    const done = !chunked || uploaded >= chunksTotal || statSync(partial).size >= total
    const mime = (file.type && file.type !== 'application/octet-stream' ? file.type : Bun.file(name).type).split(';')[0]!
    let signature = ''
    if (done) {
      const data = direct ? bytes : await Bun.file(chunked ? partial : target).bytes()
      signature = createHash('md5').update(data).digest('hex')
      if (this.config.s3.enabled) {
        await s3Client(this.config.s3).file(this.objectKey(bucketId, fileId)).write(data, { type: mime })
        rmSync(target, { force: true })
        rmSync(partial, { force: true })
      } else if (chunked) {
        renameSync(partial, target)
      }
    }

    if (existing) {
      this.sql
        .query('UPDATE _files SET chunks_uploaded = ?, signature = ?, size_original = ?, updated_at = ? WHERE seq = ?')
        .run(done ? chunksTotal : uploaded, signature, total, stamp, existing.seq)
    } else {
      this.sql
        .query(
          `INSERT INTO _files (id, bucket_id, name, permissions, signature, mime_type, size_original, chunks_total, chunks_uploaded, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(fileId, bucketId, name, JSON.stringify(permissions), signature, mime, total, chunksTotal, done ? chunksTotal : 1, stamp, stamp)
    }
    return fileModel(this.row(bucketId, fileId)!, bucket)
  }

  updateFile(caller: Caller, bucketId: string, fileId: string, name: unknown, permissions: unknown) {
    const { bucket, file } = this.file(caller, bucketId, fileId, 'update')
    const fields: Record<string, string> = {}
    if (typeof name === 'string' && name) fields.name = name
    if (permissions !== undefined && permissions !== null) fields.permissions = JSON.stringify(this.permissionsFor(caller, permissions))
    const keys = Object.keys(fields)
    if (keys.length) {
      this.sql.query(`UPDATE _files SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE seq = ?`).run(...keys.map((k) => fields[k]!), now(), file.seq)
    }
    return fileModel(this.row(bucketId, fileId)!, bucket)
  }

  async deleteFile(caller: Caller, bucketId: string, fileId: string): Promise<void> {
    const { file } = this.file(caller, bucketId, fileId, 'delete')
    if (this.config.s3.enabled) await s3Client(this.config.s3).file(this.objectKey(bucketId, fileId)).delete()
    for (const p of [this.path(bucketId, fileId), `${this.path(bucketId, fileId)}.part`]) rmSync(p, { force: true })
    const staging = this.stagingPath(bucketId, fileId)
    for (const p of [staging, `${staging}.part`]) rmSync(p, { force: true })
    rmSync(join(this.config.storagePath, '.previews', bucketId, fileId), { recursive: true, force: true })
    this.sql.query('DELETE FROM _files WHERE seq = ?').run(file.seq)
  }

  /** Serve the bytes, honouring a Range header. */
  async serve(request: Request, bucketId: string, file: FileRow, disposition: 'inline' | 'attachment'): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': file.mime_type,
      'content-disposition': `${disposition}; filename="${encodeURIComponent(file.name)}"`,
      ...cacheHeaders(this.config.cache.fileMaxAge, fileEtag(file)),
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
    }
    const csp = uploadCsp(file.mime_type)
    if (csp) headers['content-security-policy'] = csp
    // A compressed 200 varies by Accept-Encoding; its 304 must carry the same Vary.
    if (this.config.compression && isCompressible(file.mime_type)) headers.vary = 'Accept-Encoding'
    const unchanged = notModified(request, headers)
    if (unchanged) return unchanged
    const range = request.headers.get('range')
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null

    if (this.config.s3.enabled) {
      const object = s3Client(this.config.s3).file(this.objectKey(bucketId, file.id))
      const size = file.size_original
      if (m && (m[1] || m[2])) {
        let start = m[1] ? Number(m[1]) : size - Number(m[2])
        let end = m[1] && m[2] ? Number(m[2]) : size - 1
        if (start < 0) start = 0
        if (end >= size) end = size - 1
        if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
        return new Response(object.slice(start, end + 1), {
          status: 206,
          headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
        })
      }
      return new Response(object.stream(), { headers: { ...headers, 'content-length': String(size) } })
    }

    const path = this.path(bucketId, file.id)
    if (!existsSync(path)) throw err('storage_file_not_found')
    const blob = Bun.file(path)
    if (m && (m[1] || m[2])) {
      const size = blob.size
      let start = m[1] ? Number(m[1]) : size - Number(m[2])
      let end = m[1] && m[2] ? Number(m[2]) : size - 1
      if (start < 0) start = 0
      if (end >= size) end = size - 1
      if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
      return new Response(blob.slice(start, end + 1), {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
      })
    }
    return new Response(blob, { headers: { ...headers, 'content-length': String(blob.size) } })
  }

  /** Previews being rendered, so identical requests share one render. */
  private rendering = new Map<string, Promise<void>>()
  private previewSlots = previewConcurrency()
  private previewQueue: (() => void)[] = []

  private async withPreviewSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.previewSlots > 0) this.previewSlots--
    else await new Promise<void>((resolve) => this.previewQueue.push(resolve))
    try {
      return await fn()
    } finally {
      const next = this.previewQueue.shift()
      if (next) next()
      else this.previewSlots++
    }
  }

  /**
   * Transformed copy with Appwrite's preview options, from local disk or S3,
   * cached on local disk. Non-images are served as they are.
   */
  async preview(request: Request, url: URL, bucket: BucketRow, file: FileRow): Promise<Response> {
    const image = file.mime_type.startsWith('image/') && file.mime_type !== 'image/svg+xml'
    if (!image || !bucket.transformations) return this.serve(request, bucket.id, file, 'inline')

    const options = previewOptions(url.searchParams, file.mime_type)
    const format = options.format
    const key = previewKey(options)
    const cached = join(this.config.storagePath, '.previews', bucket.id, file.id, key)
    const caching = cacheHeaders(this.config.cache.previewMaxAge, `"${fileEtag(file).slice(1, -1)}-${createHash('sha1').update(key).digest('hex').slice(0, 12)}"`)
    const unchanged = notModified(request, caching)
    if (unchanged) return unchanged
    if (!existsSync(cached)) {
      let sharp: any
      try {
        sharp = await loadSharp(this.config)
      } catch {
        return this.serve(request, bucket.id, file, 'inline')
      }
      let job = this.rendering.get(cached)
      if (!job) {
        job = this.withPreviewSlot(async () => {
          const source = this.config.s3.enabled ? await s3Client(this.config.s3).file(this.objectKey(bucket.id, file.id)).bytes() : this.path(bucket.id, file.id)
          const out = await renderPreview(sharp, source, options)
          mkdirSync(dirname(cached), { recursive: true })
          const tmp = `${cached}.${process.pid}.${Date.now()}.tmp`
          await Bun.write(tmp, out)
          renameSync(tmp, cached)
        }).finally(() => this.rendering.delete(cached))
        this.rendering.set(cached, job)
      }
      try {
        await job
      } catch (error) {
        if (error instanceof BunwriteError) throw error
        const code = (error as Error).message ?? ''
        if (/pixel limit/i.test(code)) throw err('general_argument_invalid', 'The image is too large to transform.')
        throw err('storage_file_type_unsupported', 'This image could not be transformed.')
      }
    }
    const mime = format === 'jpg' ? 'image/jpeg' : `image/${format}`
    return new Response(Bun.file(cached), {
      headers: {
        'content-type': mime,
        'content-length': String(statSync(cached).size),
        ...caching,
        'x-content-type-options': 'nosniff',
      },
    })
  }

  // ------------------------------------------------------------ preview cache

  private get previewRoot(): string {
    return join(this.config.storagePath, '.previews')
  }

  private lastPreviewPrune = 0

  /** Delete previews older than the retention setting. Runs at most once an hour unless forced. */
  prunePreviews(force = false): number {
    const days = this.config.cache.previewRetentionDays
    if (!days || !existsSync(this.previewRoot)) return 0
    if (!force && Date.now() - this.lastPreviewPrune < 60 * 60 * 1000) return 0
    this.lastPreviewPrune = Date.now()
    const cutoff = Date.now() - days * 86400 * 1000
    let removed = 0
    for (const path of this.previewFiles()) {
      try {
        if (statSync(path).mtimeMs < cutoff) {
          rmSync(path, { force: true })
          removed++
        }
      } catch {
        // Deleted meanwhile, for example with its file.
      }
    }
    return removed
  }

  /** How many previews are cached on disk, and their size. */
  previewCacheStats(): { files: number; bytes: number } {
    let files = 0
    let bytes = 0
    for (const path of this.previewFiles()) {
      try {
        bytes += statSync(path).size
        files++
      } catch {}
    }
    return { files, bytes }
  }

  /** Remove every cached preview; they are made again on the next request. */
  clearPreviews(): void {
    rmSync(this.previewRoot, { recursive: true, force: true })
  }

  private previewFiles(): string[] {
    if (!existsSync(this.previewRoot)) return []
    return readdirSync(this.previewRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.endsWith('.tmp'))
      .map((entry) => join(entry.parentPath, entry.name))
  }
}
