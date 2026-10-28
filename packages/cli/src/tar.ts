/**
 * .tar.gz without the `tar` program: ustar with PAX headers for long names on
 * the way out; ustar, PAX and GNU long names on the way in.
 */
import { gunzipSync, gzipSync } from 'node:zlib'

export interface TarEntry {
  path: string
  data: Uint8Array
  mode?: number
  /** Seconds since the epoch. */
  mtime?: number
}

const BLOCK = 512
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function writeString(block: Uint8Array, offset: number, length: number, value: string) {
  block.set(encoder.encode(value).subarray(0, length), offset)
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number) {
  writeString(block, offset, length - 1, value.toString(8).padStart(length - 1, '0'))
}

function header(name: string, size: number, mode: number, mtime: number, type: string, prefix = ''): Uint8Array {
  const block = new Uint8Array(BLOCK)
  writeString(block, 0, 100, name)
  writeOctal(block, 100, 8, mode)
  writeOctal(block, 108, 8, 0)
  writeOctal(block, 116, 8, 0)
  writeOctal(block, 124, 12, size)
  writeOctal(block, 136, 12, mtime)
  block.fill(0x20, 148, 156)
  writeString(block, 156, 1, type)
  writeString(block, 257, 6, 'ustar')
  writeString(block, 263, 2, '00')
  writeString(block, 345, 155, prefix)
  let sum = 0
  for (const byte of block) sum += byte
  writeString(block, 148, 7, sum.toString(8).padStart(6, '0') + '\0')
  return block
}

const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK

/** Split a long path into ustar's prefix and name, if it fits. */
function split(path: string): { name: string; prefix: string } | null {
  if (encoder.encode(path).length <= 100) return { name: path, prefix: '' }
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '/') continue
    const prefix = path.slice(0, i)
    const name = path.slice(i + 1)
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100) return { name, prefix }
  }
  return null
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let length = body.length + 1
  while (String(length).length + encoder.encode(body).length !== length) length = String(length).length + encoder.encode(body).length
  return `${length}${body}`
}

export function pack(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = []
  const now = Math.floor(Date.now() / 1000)
  for (const entry of entries) {
    const mode = entry.mode ?? 0o644
    const mtime = entry.mtime ?? now
    const fits = split(entry.path)
    if (!fits) {
      const pax = encoder.encode(paxRecord('path', entry.path))
      parts.push(header('PaxHeader', pax.length, 0o644, mtime, 'x'), pax, new Uint8Array(padding(pax.length)))
    }
    const { name, prefix } = fits ?? { name: entry.path.slice(-100), prefix: '' }
    parts.push(header(name, entry.data.length, mode, mtime, '0', prefix), entry.data, new Uint8Array(padding(entry.data.length)))
  }
  parts.push(new Uint8Array(BLOCK * 2))
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

export const packGzip = (entries: TarEntry[]): Uint8Array => gzipSync(pack(entries))

const readString = (block: Uint8Array, offset: number, length: number) => {
  const slice = block.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return decoder.decode(end >= 0 ? slice.subarray(0, end) : slice)
}

const readOctal = (block: Uint8Array, offset: number, length: number) => parseInt(readString(block, offset, length).trim() || '0', 8)

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  const text = decoder.decode(data)
  let i = 0
  while (i < text.length) {
    const space = text.indexOf(' ', i)
    if (space < 0) break
    const length = Number(text.slice(i, space))
    if (!length) break
    const record = text.slice(space + 1, i + length - 1)
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    i += length
  }
  return out
}

/** Regular files in the archive, with safe relative paths. Links and devices are skipped. */
export function unpack(tar: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  let longName: string | undefined
  let pax: Record<string, string> = {}
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK)
    if (block.every((b) => b === 0)) break
    const size = readOctal(block, 124, 12)
    const type = String.fromCharCode(block[156] || 48)
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size)
    offset += BLOCK + size + padding(size)

    if (type === 'x') {
      pax = parsePax(data)
      continue
    }
    if (type === 'g') continue
    if (type === 'L') {
      longName = readString(data, 0, data.length)
      continue
    }

    const prefix = readString(block, 345, 155)
    const name = readString(block, 0, 100)
    let path = pax.path ?? longName ?? (prefix ? `${prefix}/${name}` : name)
    const mode = readOctal(block, 100, 8)
    const mtime = readOctal(block, 136, 12)
    longName = undefined
    pax = {}

    if (type !== '0' && type !== '7') continue
    path = path.replace(/^(\.\/)+/, '')
    const segments = path.split('/')
    if (!path || path.startsWith('/') || segments.includes('..') || segments.at(-1)!.startsWith('._')) continue
    entries.push({ path, data: data.slice(), mode, mtime })
  }
  return entries
}

export const unpackGzip = (gz: Uint8Array): TarEntry[] => unpack(gunzipSync(gz))
