/**
 * Whole-instance backup archive.
 *
 * One file holds every SQLite database Bunwrite owns, laid out like the
 * Litestream replica so the two are interchangeable:
 *
 *   manifest.json
 *   bunwrite.sqlite
 *   projects/<project-folder>/bunwrite.sqlite
 *
 * The bundle is zstd-compressed and, when BACKUP_ENCRYPTION_KEY is set,
 * encrypted with the format in ./format.ts. The manifest is the first entry
 * and lists every other file with its size and SHA-256, so a truncated or
 * edited archive fails before anything is restored.
 */
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'

import { checkKey, decrypt, encrypt } from './format'

const MAGIC = Buffer.from('BWBUNDLE')
const VERSION = 1
const MAX_PATH = 4096
const MAX_ENTRIES = 10_000
const MAX_MANIFEST = 16 * 1024 * 1024
const CHUNK = 256 * 1024

export interface ArchiveFile {
  path: string
  size: number
  sha256: string
}

export interface ArchiveManifest {
  format: 1
  createdAt: string
  bunwrite?: string
  /** File name of the control database inside the archive. */
  control: string
  /** Project IDs whose databases are in the archive. */
  projects: string[]
  /** Every entry except the manifest itself. */
  files: ArchiveFile[]
}

export interface ArchiveEntry {
  /** Path inside the archive, always with `/` separators. */
  path: string
  /** Local file to read. */
  source: string
}

export interface WriteArchiveOptions {
  output: string
  entries: ArchiveEntry[]
  control: string
  projects: string[]
  secret?: string
  bunwrite?: string
}

export interface ReadArchiveOptions {
  input: string
  /** Empty folder the archive is extracted into. */
  destDir: string
  secret?: string
}

/** Refuse paths that could escape `destDir` or confuse the extractor. */
function checkPath(path: string): void {
  if (!path || path.length > MAX_PATH) throw new Error('Backup archive contains an invalid path.')
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw new Error(`Backup archive contains an unsafe path: ${path}`)
  }
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..') throw new Error(`Backup archive contains an unsafe path: ${path}`)
  }
}

function entryHeader(path: string, size: number): Buffer {
  const name = Buffer.from(path, 'utf8')
  const header = Buffer.alloc(2 + name.length + 8)
  header.writeUInt16BE(name.length, 0)
  name.copy(header, 2)
  header.writeBigUInt64BE(BigInt(size), 2 + name.length)
  return header
}

async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    hash.update(chunk)
  }
  return { size, sha256: hash.digest('hex') }
}

/** Compress (and optionally encrypt) a set of files into one archive. */
export async function writeArchive(options: WriteArchiveOptions): Promise<ArchiveManifest> {
  const files: ArchiveFile[] = []
  for (const entry of options.entries) {
    checkPath(entry.path)
    files.push({ path: entry.path, ...(await hashFile(entry.source)) })
  }
  const manifest: ArchiveManifest = {
    format: VERSION,
    createdAt: new Date().toISOString(),
    bunwrite: options.bunwrite,
    control: options.control,
    projects: [...options.projects],
    files,
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')

  const header = Buffer.alloc(MAGIC.length + 1 + 4)
  MAGIC.copy(header, 0)
  header.writeUInt8(VERSION, MAGIC.length)
  header.writeUInt32BE(options.entries.length + 1, MAGIC.length + 1)

  async function* body(): AsyncGenerator<Uint8Array> {
    yield header
    yield entryHeader('manifest.json', manifestBytes.length)
    yield manifestBytes
    for (const entry of options.entries) {
      const info = files.find((file) => file.path === entry.path)!
      yield entryHeader(entry.path, info.size)
      for await (const chunk of createReadStream(entry.source)) yield chunk
    }
  }

  const output = createWriteStream(options.output, { mode: 0o600 })
  if (options.secret) {
    checkKey(options.secret)
    await pipeline(
      Readable.from(body()),
      createZstdCompress(),
      (source: AsyncIterable<Uint8Array>) => encrypt(source, options.secret!),
      output,
    )
  } else {
    await pipeline(Readable.from(body()), createZstdCompress(), output)
  }
  return manifest
}

function parseManifest(bytes: Buffer): ArchiveManifest {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('Backup archive manifest is not valid JSON.')
  }
  if (!value || typeof value !== 'object') throw new Error('Backup archive manifest is invalid.')
  const manifest = value as Partial<ArchiveManifest>
  if (manifest.format !== VERSION) throw new Error(`Unsupported backup archive version ${String(manifest.format)}.`)
  if (typeof manifest.createdAt !== 'string') throw new Error('Backup archive manifest has no creation time.')
  if (typeof manifest.control !== 'string' || !manifest.control) throw new Error('Backup archive manifest has no control database.')
  checkPath(manifest.control)
  if (!Array.isArray(manifest.projects) || manifest.projects.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('Backup archive manifest has an invalid project list.')
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('Backup archive manifest has no files.')
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || typeof file.size !== 'number' || typeof file.sha256 !== 'string') {
      throw new Error('Backup archive manifest has an invalid file list.')
    }
    checkPath(file.path)
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Backup archive manifest has an invalid file size.')
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('Backup archive manifest has an invalid checksum.')
  }
  if (!manifest.files.some((file) => file.path === manifest.control)) {
    throw new Error('Backup archive manifest does not list the control database.')
  }
  return manifest as ArchiveManifest
}

class ByteReader {
  private iterator: AsyncIterator<Uint8Array>
  private buffer = Buffer.alloc(0)
  private ended = false

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]()
  }

  private async fill(need: number): Promise<void> {
    while (this.buffer.length < need && !this.ended) {
      const next = await this.iterator.next()
      if (next.done) {
        this.ended = true
        break
      }
      const chunk = Buffer.from(next.value)
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    }
  }

  async read(size: number): Promise<Buffer> {
    if (size === 0) return Buffer.alloc(0)
    await this.fill(size)
    if (this.buffer.length < size) throw new Error('Backup archive is truncated.')
    const out = Buffer.from(this.buffer.subarray(0, size))
    this.buffer = this.buffer.subarray(size)
    return out
  }
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ENCRYPTED_MAGIC = Buffer.from('BWBK')

/** The first bytes decide compression, not the file name (staged files have no suffix). */
function headerOf(path: string): Buffer {
  const handle = openSync(path, 'r')
  try {
    const header = Buffer.alloc(4)
    readSync(handle, header, 0, header.length, 0)
    return header
  } finally {
    closeSync(handle)
  }
}

function archiveStream(options: ReadArchiveOptions): AsyncIterable<Uint8Array> {
  const header = headerOf(options.input)
  const encrypted = header.equals(ENCRYPTED_MAGIC)
  const compressed = encrypted || header.equals(ZSTD_MAGIC)
  let source: AsyncIterable<Uint8Array> = createReadStream(options.input)
  if (encrypted) {
    if (!options.secret) throw new Error('Set BACKUP_ENCRYPTION_KEY to open an encrypted backup.')
    source = decrypt(source, options.secret)
  }
  if (compressed) {
    // `pipe` does not forward source errors, which would leave the reader
    // waiting forever on a wrong key or a truncated file.
    const out = new PassThrough()
    pipeline(Readable.from(source), createZstdDecompress(), out).catch((error: Error) => out.destroy(error))
    return out
  }
  return source
}

async function extract(reader: ByteReader, target: string, size: number, sha256: string): Promise<void> {
  mkdirSync(dirname(target), { recursive: true })
  const handle = await open(target, 'w', 0o600)
  const hash = createHash('sha256')
  try {
    let left = size
    while (left > 0) {
      const chunk = await reader.read(Math.min(left, CHUNK))
      hash.update(chunk)
      await handle.write(chunk)
      left -= chunk.length
    }
  } catch (error) {
    await handle.close().catch(() => {})
    rmSync(target, { force: true })
    throw error
  }
  await handle.close()
  if (hash.digest('hex') !== sha256) {
    rmSync(target, { force: true })
    throw new Error(`Backup archive is corrupted: ${target}`)
  }
}

/** Verify an archive and extract it into `destDir`. */
export async function readArchive(options: ReadArchiveOptions): Promise<ArchiveManifest> {
  const reader = new ByteReader(archiveStream(options))
  const magic = await reader.read(MAGIC.length)
  if (!magic.equals(MAGIC)) throw new Error('Not a Bunwrite backup archive.')
  const version = (await reader.read(1))[0]
  if (version !== VERSION) throw new Error(`Unsupported backup archive version ${version}.`)
  const count = (await reader.read(4)).readUInt32BE(0)
  if (count < 1 || count > MAX_ENTRIES) throw new Error('Backup archive has an invalid entry count.')

  let manifest: ArchiveManifest | undefined
  const seen = new Set<string>()
  for (let index = 0; index < count; index++) {
    const pathLength = (await reader.read(2)).readUInt16BE(0)
    if (pathLength < 1 || pathLength > MAX_PATH) throw new Error('Backup archive contains an invalid path.')
    const path = (await reader.read(pathLength)).toString('utf8')
    checkPath(path)
    const size = Number((await reader.read(8)).readBigUInt64BE(0))
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Backup archive contains an invalid file size.')

    if (index === 0) {
      if (path !== 'manifest.json') throw new Error('Backup archive has no manifest.')
      if (size > MAX_MANIFEST) throw new Error('Backup archive manifest is too large.')
      manifest = parseManifest(await reader.read(size))
      seen.add(path)
      continue
    }
    if (!manifest) throw new Error('Backup archive has no manifest.')
    const expected = manifest.files.find((file) => file.path === path)
    if (!expected || seen.has(path)) throw new Error(`Backup archive contains an unexpected file: ${path}`)
    if (expected.size !== size) throw new Error(`Backup archive size mismatch for ${path}.`)
    await extract(reader, join(options.destDir, path), size, expected.sha256)
    seen.add(path)
  }
  if (!manifest) throw new Error('Backup archive has no manifest.')
  for (const file of manifest.files) {
    if (!seen.has(file.path) || !existsSync(join(options.destDir, file.path))) {
      throw new Error(`Backup archive is missing ${file.path}.`)
    }
  }
  return manifest
}
