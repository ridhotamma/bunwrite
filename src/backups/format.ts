/**
 * Backup file format: the SQLite snapshot is compressed with zstd and, when
 * BACKUP_ENCRYPTION_KEY is set, encrypted.
 *
 *   backup-<stamp>.sqlite.zst       zstd only; `zstd -d` opens it
 *   backup-<stamp>.sqlite.zst.enc   zstd, then encrypted (format below)
 *   backup-<stamp>.sqlite           older, uncompressed backups
 *
 * Encrypted file:
 *
 *   header   "BWBK" | version 1 | compression 1 (zstd) | scrypt log2(N) | salt[16] | nonce prefix[8]
 *   records  length[4, big-endian] | AES-256-GCM ciphertext[length] | tag[16]
 *
 * The key is scrypt(BACKUP_ENCRYPTION_KEY, salt). Each record holds up to
 * 64 KiB and uses nonce = prefix | record number. Its additional data is the
 * header plus a flag set only on the last record, so a cut-off, reordered or
 * edited file fails to open instead of restoring part of a database.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, type ScryptOptions } from 'node:crypto'
import { createReadStream, createWriteStream, rmSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'

export const ENCRYPTED_EXT = '.sqlite.zst.enc'
export const COMPRESSED_EXT = '.sqlite.zst'
export const PLAIN_EXT = '.sqlite'

/** Shortest BACKUP_ENCRYPTION_KEY accepted; `openssl rand -base64 32` gives 44 characters. */
export const MIN_KEY_LENGTH = 16

const MAGIC = Buffer.from('BWBK')
const VERSION = 1
const ZSTD = 1
const LOG_N = 15
const SALT_BYTES = 16
const PREFIX_BYTES = 8
const HEADER_BYTES = MAGIC.length + 3 + SALT_BYTES + PREFIX_BYTES
const CHUNK = 64 * 1024
const TAG_BYTES = 16
const MAX_RECORD = CHUNK + TAG_BYTES

function scrypt(secret: string, salt: Buffer, logN: number): Promise<Buffer> {
  const N = 2 ** logN
  const options: ScryptOptions = { N, r: 8, p: 1, maxmem: 256 * N * 8 }
  return new Promise((resolve, reject) =>
    scryptCallback(secret, salt, 32, options, (error, key) => (error ? reject(error) : resolve(key))),
  )
}

export function checkKey(secret: string): void {
  if (secret.length < MIN_KEY_LENGTH) {
    throw new Error(`BACKUP_ENCRYPTION_KEY must be at least ${MIN_KEY_LENGTH} characters.`)
  }
}

function nonce(prefix: Buffer, counter: number): Buffer {
  const out = Buffer.alloc(12)
  prefix.copy(out, 0)
  out.writeUInt32BE(counter, PREFIX_BYTES)
  return out
}

function aad(header: Buffer, last: boolean): Buffer {
  return Buffer.concat([header, Buffer.from([last ? 1 : 0])])
}

/** Encrypt a byte stream into the format above. */
export async function* encrypt(source: AsyncIterable<Uint8Array>, secret: string): AsyncGenerator<Buffer> {
  checkKey(secret)
  const salt = randomBytes(SALT_BYTES)
  const prefix = randomBytes(PREFIX_BYTES)
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION, ZSTD, LOG_N]), salt, prefix])
  const key = await scrypt(secret, salt, LOG_N)
  let counter = 0

  const seal = (plain: Buffer, last: boolean): Buffer => {
    if (counter === 0xffffffff) throw new Error('Backup is too large to encrypt.')
    const cipher = createCipheriv('aes-256-gcm', key, nonce(prefix, counter++))
    cipher.setAAD(aad(header, last))
    const body = Buffer.concat([cipher.update(plain), cipher.final()])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length)
    return Buffer.concat([length, body, cipher.getAuthTag()])
  }

  yield header
  // Hold one full chunk back so the last record can be flagged.
  let pending = Buffer.alloc(0)
  for await (const piece of source) {
    pending = pending.length ? Buffer.concat([pending, piece]) : Buffer.from(piece)
    while (pending.length > CHUNK) {
      yield seal(pending.subarray(0, CHUNK), false)
      pending = pending.subarray(CHUNK)
    }
  }
  yield seal(pending, true)
}

/** Reads exact byte counts from a stream. */
class Reader {
  private buffer = Buffer.alloc(0)
  private done = false
  private iterator: AsyncIterator<Uint8Array>

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]()
  }

  private async fill(size: number): Promise<void> {
    while (this.buffer.length < size && !this.done) {
      const next = await this.iterator.next()
      if (next.done) this.done = true
      else this.buffer = Buffer.concat([this.buffer, next.value])
    }
  }

  /** Exactly `size` bytes, or null at a clean end of stream. */
  async read(size: number): Promise<Buffer | null> {
    await this.fill(size)
    if (this.buffer.length === 0 && this.done) return null
    if (this.buffer.length < size) throw new Error('Backup file is truncated.')
    const out = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    return out
  }
}

/** Decrypt the format above back to the compressed stream. */
export async function* decrypt(source: AsyncIterable<Uint8Array>, secret: string): AsyncGenerator<Buffer> {
  const reader = new Reader(source)
  const header = await reader.read(HEADER_BYTES)
  if (!header || !header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an encrypted Bunwrite backup.')
  const [version, compression, logN] = [header[4]!, header[5]!, header[6]!]
  if (version !== VERSION) throw new Error(`Unsupported backup format version ${version}.`)
  if (compression !== ZSTD) throw new Error(`Unsupported backup compression ${compression}.`)
  if (logN < 10 || logN > 20) throw new Error('Backup header is invalid.')
  const salt = header.subarray(7, 7 + SALT_BYTES)
  const prefix = header.subarray(7 + SALT_BYTES, HEADER_BYTES)
  const key = await scrypt(secret, Buffer.from(salt), logN)

  const record = async (): Promise<Buffer | null> => {
    const length = await reader.read(4)
    if (!length) return null
    const size = length.readUInt32BE() + TAG_BYTES
    if (size > MAX_RECORD) throw new Error('Backup file is corrupted.')
    return Buffer.from((await reader.read(size))!)
  }

  let counter = 0
  let current = await record()
  if (!current) throw new Error('Backup file is truncated.')
  while (current) {
    // A record is the last one only when nothing follows it.
    const next = await record()
    const decipher = createDecipheriv('aes-256-gcm', key, nonce(Buffer.from(prefix), counter++))
    decipher.setAAD(aad(Buffer.from(header), next === null))
    decipher.setAuthTag(current.subarray(current.length - TAG_BYTES))
    try {
      yield Buffer.concat([decipher.update(current.subarray(0, current.length - TAG_BYTES)), decipher.final()])
    } catch {
      throw new Error('Cannot decrypt backup: wrong BACKUP_ENCRYPTION_KEY, or the file was changed or cut off.')
    }
    current = next
  }
}

/** Compress `input` (and encrypt it when `secret` is set) into `output`. */
export async function packBackup(input: string, output: string, secret?: string): Promise<void> {
  const write = createWriteStream(output, { mode: 0o600 })
  if (secret) {
    checkKey(secret)
    await pipeline(createReadStream(input), createZstdCompress(), (source: AsyncIterable<Uint8Array>) => encrypt(source, secret), write)
  } else {
    await pipeline(createReadStream(input), createZstdCompress(), write)
  }
}

/** Turn any backup file back into a plain SQLite file. Never overwrites `output`. */
export async function unpackBackup(input: string, output: string, secret?: string): Promise<void> {
  if (input.endsWith('.enc') && !secret) throw new Error('Set BACKUP_ENCRYPTION_KEY to open an encrypted backup.')
  const write = createWriteStream(output, { mode: 0o600, flags: 'wx' })
  try {
    if (input.endsWith('.enc')) {
      await pipeline(createReadStream(input), (source: AsyncIterable<Uint8Array>) => decrypt(source, secret!), createZstdDecompress(), write)
    } else if (input.endsWith('.zst')) {
      await pipeline(createReadStream(input), createZstdDecompress(), write)
    } else {
      await pipeline(createReadStream(input), write)
    }
  } catch (error) {
    // `wx` failing means the file was already there; leave it alone.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') rmSync(output, { force: true })
    throw error
  }
}

export function contentType(name: string): string {
  if (name.endsWith('.enc')) return 'application/octet-stream'
  if (name.endsWith('.zst')) return 'application/zstd'
  return 'application/x-sqlite3'
}
