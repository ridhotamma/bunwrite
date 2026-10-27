/**
 * Appwrite Storage on local disk: `<storagePath>/<bucketId>/<fileId>`, with
 * metadata in `_files`. Supports the SDK's chunked uploads (Content-Range +
 * x-appwrite-id), Range reads for video, and resized previews through sharp.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, openSync, writeSync, closeSync, renameSync, rmSync, statSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Caller } from '../auth/caller'
import { aggregatePermissions, grants, parsePermission, type PermissionType } from '../auth/permissions'
import type { Config } from '../config'
import type { Db } from '../db/connection'
import type { DocumentStore } from '../documents/store'
import { now } from '../lib/datetime'
import { err } from '../lib/errors'
import { isValidId, resolveId } from '../lib/ids'
import { listSeqs } from '../system/list'
import { normalizeAttribute, type Collection } from '../schema/types'

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

  saveBucket(input: { id: string; name: string; enabled: boolean; fileSecurity: boolean; permissions: string[]; maximumFileSize: number; allowedFileExtensions: string[]; transformations: boolean }, create: boolean): BucketRow {
    if (create && !isValidId(input.id)) throw err('general_argument_invalid', 'Bucket ID: up to 36 chars of a-z, A-Z, 0-9, period, hyphen and underscore.')
    if (!Number.isInteger(input.maximumFileSize) || input.maximumFileSize < 1) throw err('general_argument_invalid', 'Maximum file size must be a positive number of bytes.')
    const stamp = now()
    const values = [input.name || input.id, input.enabled ? 1 : 0, input.fileSecurity ? 1 : 0, JSON.stringify(input.permissions), input.maximumFileSize, JSON.stringify(input.allowedFileExtensions.map((e) => e.replace(/^\./, '').toLowerCase())), input.transformations ? 1 : 0]
    if (create) {
      if (this.sql.query('SELECT 1 FROM _buckets WHERE id = ?').get(input.id)) throw err('storage_bucket_already_exists')
      this.sql
        .query('INSERT INTO _buckets (name, enabled, file_security, permissions, maximum_file_size, allowed_file_extensions, transformations, created_at, updated_at, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(...(values as any[]), stamp, stamp, input.id)
    } else {
      this.bucket(input.id, true)
      this.sql
        .query('UPDATE _buckets SET name = ?, enabled = ?, file_security = ?, permissions = ?, maximum_file_size = ?, allowed_file_extensions = ?, transformations = ?, updated_at = ? WHERE id = ?')
        .run(...(values as any[]), stamp, input.id)
    }
    return this.bucket(input.id, true)
  }

  deleteBucket(id: string): void {
    this.bucket(id, true)
    this.sql.transaction(() => {
      this.sql.query('DELETE FROM _files WHERE bucket_id = ?').run(id)
      this.sql.query('DELETE FROM _buckets WHERE id = ?').run(id)
    })()
    rmSync(join(this.config.storagePath, id), { recursive: true, force: true })
    rmSync(join(this.config.storagePath, '.previews', id), { recursive: true, force: true })
  }

  buckets(): BucketRow[] {
    return this.sql.query<BucketRow, []>('SELECT * FROM _buckets ORDER BY seq').all()
  }

  path(bucketId: string, fileId: string): string {
    return join(this.config.storagePath, bucketId, fileId)
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

    // Chunked uploads: `Content-Range: bytes start-end/total`, later chunks carry x-appwrite-id.
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
    const target = this.path(bucketId, fileId)
    const partial = `${target}.part`
    mkdirSync(dirname(target), { recursive: true })

    const bytes = new Uint8Array(await file.arrayBuffer())
    const fd = openSync(chunked ? partial : target, chunked && existing ? 'r+' : 'w')
    try {
      writeSync(fd, bytes, 0, bytes.length, start)
    } finally {
      closeSync(fd)
    }

    const permissions = existing ? JSON.parse(existing.permissions) : this.permissionsFor(caller, input.permissions)
    const uploaded = (existing?.chunks_uploaded ?? 0) + 1
    const done = !chunked || uploaded >= chunksTotal || statSync(partial).size >= total
    if (done && chunked) renameSync(partial, target)
    const signature = done ? createHash('md5').update(await Bun.file(target).bytes()).digest('hex') : ''
    const mime = (file.type && file.type !== 'application/octet-stream' ? file.type : Bun.file(name).type).split(';')[0]!

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

  deleteFile(caller: Caller, bucketId: string, fileId: string): void {
    const { file } = this.file(caller, bucketId, fileId, 'delete')
    this.sql.query('DELETE FROM _files WHERE seq = ?').run(file.seq)
    for (const p of [this.path(bucketId, fileId), `${this.path(bucketId, fileId)}.part`]) rmSync(p, { force: true })
    rmSync(join(this.config.storagePath, '.previews', bucketId, fileId), { recursive: true, force: true })
  }

  /** Serve the bytes, honouring a Range header. */
  serve(request: Request, bucketId: string, file: FileRow, disposition: 'inline' | 'attachment'): Response {
    const path = this.path(bucketId, file.id)
    if (!existsSync(path)) throw err('storage_file_not_found')
    const blob = Bun.file(path)
    const headers: Record<string, string> = {
      'content-type': file.mime_type,
      'content-disposition': `${disposition}; filename="${encodeURIComponent(file.name)}"`,
      'cache-control': 'private, max-age=3888000',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
    }
    const range = request.headers.get('range')
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
    if (m && (m[1] || m[2])) {
      const size = blob.size
      let start = m[1] ? Number(m[1]) : size - Number(m[2])
      let end = m[1] && m[2] ? Number(m[2]) : size - 1
      if (start < 0) start = 0
      if (end >= size) end = size - 1
      if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
      return new Response(blob.slice(start, end + 1), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}` } })
    }
    return new Response(blob, { headers })
  }

  /** Resized copy (width/height/quality/output), cached on disk. Non-images are served as they are. */
  async preview(request: Request, url: URL, bucket: BucketRow, file: FileRow): Promise<Response> {
    const width = Math.min(4000, Math.max(0, Number(url.searchParams.get('width') ?? 0) || 0))
    const height = Math.min(4000, Math.max(0, Number(url.searchParams.get('height') ?? 0) || 0))
    const qualityRaw = Number(url.searchParams.get('quality') ?? -1)
    const quality = qualityRaw >= 0 && qualityRaw <= 100 ? qualityRaw : 80
    const output = (url.searchParams.get('output') || '').toLowerCase().replace('jpeg', 'jpg')
    const gravity = (url.searchParams.get('gravity') || 'center').toLowerCase()
    const image = file.mime_type.startsWith('image/') && file.mime_type !== 'image/svg+xml'
    if (!image || !bucket.transformations) return this.serve(request, bucket.id, file, 'inline')

    const format = (['jpg', 'png', 'webp', 'avif', 'gif'].includes(output) ? output : file.mime_type.split('/')[1]!.replace('jpeg', 'jpg')) as string
    const key = `${width}x${height}-q${quality}-${gravity}.${format}`
    const cached = join(this.config.storagePath, '.previews', bucket.id, file.id, key)
    if (!existsSync(cached)) {
      let sharp: any
      try {
        sharp = (await import('sharp')).default
      } catch {
        return this.serve(request, bucket.id, file, 'inline')
      }
      const position = { center: 'centre', 'top-left': 'northwest', top: 'north', 'top-right': 'northeast', left: 'west', right: 'east', 'bottom-left': 'southwest', bottom: 'south', 'bottom-right': 'southeast' }[gravity] ?? 'centre'
      let pipeline = sharp(this.path(bucket.id, file.id), { animated: format === 'gif' }).rotate()
      if (width || height) pipeline = pipeline.resize({ width: width || undefined, height: height || undefined, fit: width && height ? 'cover' : 'inside', position, withoutEnlargement: true })
      pipeline = pipeline.toFormat(format === 'jpg' ? 'jpeg' : format, { quality })
      mkdirSync(dirname(cached), { recursive: true })
      await pipeline.toFile(`${cached}.tmp`)
      renameSync(`${cached}.tmp`, cached)
    }
    const mime = format === 'jpg' ? 'image/jpeg' : `image/${format}`
    return new Response(Bun.file(cached), {
      headers: { 'content-type': mime, 'cache-control': 'private, max-age=2592000', 'x-content-type-options': 'nosniff' },
    })
  }
}
