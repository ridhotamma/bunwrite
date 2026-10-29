import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decrypt, encrypt, packBackup, unpackBackup } from '~/backups/format'
import { BackupService } from '~/backups/service'
import { openDb, type Db } from '~/db/connection'
import { PRIVATE_ENV } from '~/lib/private-env'
import { testConfig } from './helpers'

const KEY = 'correct horse battery staple'

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const part of source) parts.push(Buffer.from(part))
  return Buffer.concat(parts)
}

async function* once(data: Uint8Array): AsyncGenerator<Uint8Array> {
  yield data
}

const roundTrip = async (data: Buffer, key = KEY) => collect(decrypt(once(await collect(encrypt(once(data), KEY))), key))

describe('backup encryption format', () => {
  test('round-trips empty, small and multi-record data', async () => {
    for (const size of [0, 10, 64 * 1024, 64 * 1024 + 1, 300_000]) {
      const data = Buffer.from(crypto.getRandomValues(new Uint8Array(size)))
      expect((await roundTrip(data)).equals(data)).toBe(true)
    }
  })

  test('the same data encrypts differently each time', async () => {
    const data = Buffer.from('same input')
    const a = await collect(encrypt(once(data), KEY))
    const b = await collect(encrypt(once(data), KEY))
    expect(a.equals(b)).toBe(false)
    expect(a.includes(data)).toBe(false)
  })

  test('rejects a wrong key, an edited byte, and a cut-off file', async () => {
    const data = Buffer.from(crypto.getRandomValues(new Uint8Array(200_000)))
    const sealed = await collect(encrypt(once(data), KEY))
    const open = (bytes: Buffer, key = KEY) => collect(decrypt(once(bytes), key))

    await expect(open(sealed, 'wrong key, same length!!!!')).rejects.toThrow(/Cannot decrypt/)

    const edited = Buffer.from(sealed)
    edited[edited.length - 100]! ^= 1
    await expect(open(edited)).rejects.toThrow(/Cannot decrypt/)

    // Dropping whole trailing records leaves a valid-looking file that never flagged its end.
    const firstRecordEnd = 31 + 4 + 64 * 1024 + 16
    await expect(open(sealed.subarray(0, firstRecordEnd))).rejects.toThrow(/Cannot decrypt/)
    await expect(open(sealed.subarray(0, sealed.length - 5))).rejects.toThrow()
    await expect(open(Buffer.from('not a backup at all, just some text'))).rejects.toThrow(/Not an encrypted/)
  })

  test('rejects a short key', async () => {
    await expect(collect(encrypt(once(Buffer.from('x')), 'short'))).rejects.toThrow(/at least 16/)
  })
})

describe('backup files', () => {
  let dir: string
  let db: Db

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bunwrite-backup-format-'))
    db = openDb(join(dir, 'source.sqlite'))
    db.sqlite.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)')
    const insert = db.sqlite.prepare('INSERT INTO notes (body) VALUES (?)')
    for (let i = 0; i < 2000; i++) insert.run(`secret note ${i} `.repeat(20))
  })

  afterAll(() => {
    db.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const countNotes = (path: string) => {
    const copy = new Database(path, { readonly: true })
    try {
      return (copy.query('SELECT count(*) AS n FROM notes').get() as { n: number }).n
    } finally {
      copy.close()
    }
  }

  test('pack and unpack, with and without encryption', async () => {
    const snapshot = join(dir, 'snap.sqlite')
    db.sqlite.run(`VACUUM INTO '${snapshot}'`)
    const raw = statSync(snapshot).size

    await packBackup(snapshot, join(dir, 'a.sqlite.zst'))
    expect(statSync(join(dir, 'a.sqlite.zst')).size).toBeLessThan(raw / 3)
    await unpackBackup(join(dir, 'a.sqlite.zst'), join(dir, 'a.sqlite'))
    expect(countNotes(join(dir, 'a.sqlite'))).toBe(2000)

    await packBackup(snapshot, join(dir, 'b.sqlite.zst.enc'), KEY)
    const sealed = readFileSync(join(dir, 'b.sqlite.zst.enc'))
    expect(sealed.includes(Buffer.from('secret note'))).toBe(false)
    expect(statSync(join(dir, 'b.sqlite.zst.enc')).mode & 0o777).toBe(0o600)

    await expect(unpackBackup(join(dir, 'b.sqlite.zst.enc'), join(dir, 'b.sqlite'))).rejects.toThrow(/BACKUP_ENCRYPTION_KEY/)
    await expect(unpackBackup(join(dir, 'b.sqlite.zst.enc'), join(dir, 'b.sqlite'), 'some other long key!')).rejects.toThrow(/Cannot decrypt/)
    expect(existsSync(join(dir, 'b.sqlite'))).toBe(false)

    await unpackBackup(join(dir, 'b.sqlite.zst.enc'), join(dir, 'b.sqlite'), KEY)
    expect(countNotes(join(dir, 'b.sqlite'))).toBe(2000)

    // Never overwrites an existing file.
    await expect(unpackBackup(join(dir, 'b.sqlite.zst.enc'), join(dir, 'b.sqlite'), KEY)).rejects.toThrow()
    expect(countNotes(join(dir, 'b.sqlite'))).toBe(2000)
  })

  test('the service writes encrypted backups when a key is set, and lists older ones', async () => {
    const backupsPath = mkdtempSync(join(tmpdir(), 'bunwrite-backup-service-'))
    try {
      const plain = new BackupService(db, testConfig({ backupsPath }))
      const compressed = await plain.create('manual')
      expect(compressed.name).toEndWith('.sqlite.zst')

      const encrypted = new BackupService(db, testConfig({ backupsPath, backupEncryptionKey: KEY }))
      const created = await encrypted.create('manual')
      expect(created.name).toEndWith('.sqlite.zst.enc')
      expect(statSync(join(backupsPath, created.name)).mode & 0o777).toBe(0o600)

      writeFileSync(join(backupsPath, 'backup-old.sqlite'), 'legacy')
      const names = (await encrypted.list()).map((b) => b.name).sort()
      expect(names).toEqual([compressed.name, created.name, 'backup-old.sqlite'].sort())
      // No plain-text snapshot or temp file is left behind.
      expect(readdirSync(backupsPath).filter((f) => f.endsWith('.tmp'))).toEqual([])

      const res = await encrypted.serve(created.name)
      expect(res.headers.get('content-type')).toBe('application/octet-stream')
      const out = join(backupsPath, 'restored.sqlite')
      writeFileSync(join(backupsPath, 'download.sqlite.zst.enc'), Buffer.from(await res.arrayBuffer()))
      await unpackBackup(join(backupsPath, 'download.sqlite.zst.enc'), out, KEY)
      expect(countNotes(out)).toBe(2000)

      const weak = new BackupService(db, testConfig({ backupsPath, backupEncryptionKey: 'short' }))
      await expect(weak.create('manual')).rejects.toThrow(/at least 16/)
    } finally {
      rmSync(backupsPath, { recursive: true, force: true })
    }
  })

  test('functions and sites never inherit the key', () => {
    expect(PRIVATE_ENV).toContain('BACKUP_ENCRYPTION_KEY')
  })
})
