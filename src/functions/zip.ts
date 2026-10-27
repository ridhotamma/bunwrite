/**
 * A small .zip reader for function uploads, so the host needs no `unzip`.
 * Handles stored and deflated entries, which is what zip tools and
 * "Compress" in Finder or Explorer write. Encrypted and Zip64 archives are
 * refused with a clear message.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
/** Stop zip bombs: unpacked size may not exceed this. */
const MAX_UNPACKED = 1024 * 1024 * 1024

export const isZip = (head: Uint8Array): boolean => head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5) && (head[3] === 4 || head[3] === 6)

/** Finder and Explorer add these; they are never function code. */
const junk = (name: string) => name.startsWith('__MACOSX/') || name.split('/').pop() === '.DS_Store'

/** Unpack `bytes` into `dest`. Returns the number of files written. */
export function extractZip(bytes: Uint8Array, dest: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('This is not a valid .zip file.')
  const entries = view.getUint16(end + 10, true)
  let offset = view.getUint32(end + 16, true)
  if (entries === 0xffff || offset === 0xffffffff) throw new Error('Zip64 archives are not supported. Upload a .tar.gz instead.')

  const root = resolve(dest)
  let files = 0
  let unpacked = 0
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL) throw new Error('The .zip file is damaged.')
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const compressed = view.getUint32(offset + 20, true)
    const size = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const mode = view.getUint32(offset + 38, true) >>> 16
    const local = view.getUint32(offset + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).replace(/\\/g, '/')
    offset += 46 + nameLength + extraLength + commentLength

    if (flags & 1) throw new Error('Password-protected .zip files are not supported.')
    if (junk(name)) continue
    const target = resolve(root, name)
    if (isAbsolute(name) || (target !== root && !target.startsWith(root + sep))) throw new Error(`Unsafe path in the .zip file: ${name}`)
    if (name.endsWith('/')) {
      mkdirSync(target, { recursive: true })
      continue
    }
    // Symlinks could point outside the function folder; skip them.
    if ((mode & 0o170000) === 0o120000) continue

    if (view.getUint32(local, true) !== LOCAL) throw new Error('The .zip file is damaged.')
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const raw = bytes.subarray(start, start + compressed)
    unpacked += size
    if (unpacked > MAX_UNPACKED) throw new Error('The .zip file unpacks to more than 1 GB.')
    let data: Uint8Array
    if (method === 0) data = raw
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: size || 1 })
    else throw new Error(`Unsupported compression in the .zip file (method ${method}) for ${name}.`)

    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    if (mode & 0o111) chmodSync(target, 0o755)
    files++
  }
  return files
}
