import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readArchive, writeArchive } from '~/backups/archive'
import { decrypt, encrypt, packBackup, unpackBackup } from '~/backups/format'
import { createInstanceBackup } from '~/backups/instance'
import { applyPendingRestore, cancelPendingRestore, readPendingRestore, stagePendingRestore } from '~/backups/pending'
import { inspectBackup, inspectDatabase, restoreInstance } from '~/backups/restore'
import { BackupService } from '~/backups/service'
import { openDb, type Db } from '~/db/connection'
import { bootstrapInstance } from '~/instance/bootstrap'
import { now } from '~/lib/datetime'
import { PRIVATE_ENV } from '~/lib/private-env'
import { PROJECT, testConfig } from './helpers'

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

describe('single-database backup files', () => {
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

  test('functions and sites never inherit the key', () => {
    expect(PRIVATE_ENV).toContain('BACKUP_ENCRYPTION_KEY')
  })
})

/** A control database with one extra project, both carrying a marker row. */
function makeInstance(root: string) {
  const controlPath = join(root, 'bunwrite.sqlite')
  const control = bootstrapDb(controlPath, PROJECT)
  for (const [id, name] of [
    [PROJECT, 'Main'],
    ['other', 'Other'],
  ] as const) {
    control.sqlite
      .query('INSERT INTO _projects (id, name, org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, 'org_test', now(), now())
  }
  const projectPath = join(root, 'projects', 'other', 'bunwrite.sqlite')
  mkdirSync(join(root, 'projects', 'other'), { recursive: true })
  const project = bootstrapDb(projectPath, 'other')
  marker(control, 'control-before')
  marker(project, 'project-before')
  return { controlPath, control, projectPath, project }
}

function bootstrapDb(path: string, projectId: string): Db {
  const db = openDb(path)
  bootstrapInstance(db, {
    ORG_ID: 'org_test',
    PROJECT_ID: projectId,
    PROJECT_NAME: `Project ${projectId}`,
    SECRET: 's'.repeat(40),
  })
  return db
}

function marker(db: Db, value?: string): string {
  if (value !== undefined) {
    db.sqlite
      .query("INSERT INTO _settings (key, value, updated_at) VALUES ('marker', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(value, now())
  }
  return (db.sqlite.query("SELECT value FROM _settings WHERE key = 'marker'").get() as { value: string } | null)?.value ?? ''
}

const readMarker = (path: string): string => {
  const db = openDb(path)
  try {
    return marker(db)
  } finally {
    db.sqlite.close()
  }
}

describe('instance archives', () => {
  test('round-trips every database, with and without encryption', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-archive-'))
    const { controlPath, control, projectPath, project } = makeInstance(root)
    try {
      // writeArchive does not checkpoint, so snapshot first like the service does.
      const snapshots = join(root, 'snapshots')
      mkdirSync(snapshots, { recursive: true })
      const controlSnapshot = join(snapshots, 'control.sqlite')
      const projectSnapshot = join(snapshots, 'project.sqlite')
      control.sqlite.run(`VACUUM INTO '${controlSnapshot.replace(/'/g, "''")}'`)
      project.sqlite.run(`VACUUM INTO '${projectSnapshot.replace(/'/g, "''")}'`)
      const entries = [
        { path: 'bunwrite.sqlite', source: controlSnapshot },
        { path: 'projects/other/bunwrite.sqlite', source: projectSnapshot },
      ]
      const plain = join(root, 'plain.archive.zst')
      const manifest = await writeArchive({ output: plain, entries, control: 'bunwrite.sqlite', projects: ['other'] })
      expect(manifest.projects).toEqual(['other'])
      expect(manifest.files.map((file) => file.path)).toEqual(entries.map((entry) => entry.path))

      const out = join(root, 'out')
      mkdirSync(out)
      const read = await readArchive({ input: plain, destDir: out })
      expect(read.files).toHaveLength(2)
      expect(readMarker(join(out, 'bunwrite.sqlite'))).toBe('control-before')
      expect(readMarker(join(out, 'projects/other/bunwrite.sqlite'))).toBe('project-before')

      const sealed = join(root, 'sealed.archive.zst.enc')
      await writeArchive({ output: sealed, entries, control: 'bunwrite.sqlite', projects: ['other'], secret: KEY })
      await expect(readArchive({ input: sealed, destDir: join(root, 'missing-key') })).rejects.toThrow(/BACKUP_ENCRYPTION_KEY/)
      await expect(readArchive({ input: sealed, destDir: join(root, 'wrong-key'), secret: 'wrong key, long enough!!!!' })).rejects.toThrow(/Cannot decrypt/)
      const open = join(root, 'open')
      mkdirSync(open)
      await readArchive({ input: sealed, destDir: open, secret: KEY })
      expect(readMarker(join(open, 'bunwrite.sqlite'))).toBe('control-before')

      // One changed byte fails the SHA-256 check.
      const bytes = readFileSync(plain)
      bytes[bytes.length - 32]! ^= 1
      const tampered = join(root, 'tampered.archive.zst')
      writeFileSync(tampered, bytes)
      await expect(readArchive({ input: tampered, destDir: join(root, 'tampered') })).rejects.toThrow()
    } finally {
      control.sqlite.close()
      project.sqlite.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('createInstanceBackup includes the control and every project database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-instance-backup-'))
    const { controlPath, control, projectPath, project } = makeInstance(root)
    try {
      const outputDir = join(root, 'backups')
      const created = await createInstanceBackup({ databasePath: controlPath, outputDir, secret: KEY })
      expect(created.name).toMatch(/^backup-.*\.archive\.zst\.enc$/)
      expect(created.manifest.projects).toEqual(['other'])
      expect(created.manifest.control).toBe('bunwrite.sqlite')
      expect(existsSync(join(outputDir, created.name))).toBe(true)
      expect(statSync(join(outputDir, created.name)).mode & 0o777).toBe(0o600)

      const out = join(root, 'out')
      mkdirSync(out)
      await readArchive({ input: join(outputDir, created.name), destDir: out, secret: KEY })
      expect(readMarker(join(out, 'bunwrite.sqlite'))).toBe('control-before')
      expect(readMarker(join(out, 'projects/other/bunwrite.sqlite'))).toBe('project-before')
    } finally {
      control.sqlite.close()
      project.sqlite.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses unsafe paths and a project list that disagrees with the control database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-instance-bad-'))
    const { controlPath, control, project } = makeInstance(root)
    try {
      await expect(
        writeArchive({
          output: join(root, 'escape.archive.zst'),
          entries: [{ path: '../escape.sqlite', source: controlPath }],
          control: 'bunwrite.sqlite',
          projects: [],
        }),
      ).rejects.toThrow(/unsafe path/)

      const snapshot = join(root, 'control.sqlite')
      control.sqlite.run(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`)
      const archive = join(root, 'mismatch.archive.zst')
      await writeArchive({
        output: archive,
        entries: [{ path: 'bunwrite.sqlite', source: snapshot }],
        control: 'bunwrite.sqlite',
        projects: [],
      })
      await expect(restoreInstance({ databasePath: controlPath, archive })).rejects.toThrow(/project list does not match/)
    } finally {
      control.sqlite.close()
      project.sqlite.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('restoring whole-instance archives', () => {
  test('replaces every database, keeps the old files, and supports a dry run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-instance-restore-'))
    const { controlPath, control, projectPath, project } = makeInstance(root)
    try {
      const outputDir = join(root, 'backups')
      await createInstanceBackup({ databasePath: controlPath, outputDir })
      const archive = join(outputDir, readdirSync(outputDir)[0]!)
      marker(control, 'control-after')
      marker(project, 'project-after')
      control.sqlite.close()
      project.sqlite.close()

      const dry = await restoreInstance({ databasePath: controlPath, archive, dryRun: true })
      expect(dry.outcomes.map((outcome) => outcome.result)).toEqual(['planned', 'planned'])
      expect(readMarker(controlPath)).toBe('control-after')

      const restored = await restoreInstance({ databasePath: controlPath, archive })
      expect(restored.outcomes).toHaveLength(2)
      expect(restored.previous).toHaveLength(2)
      expect(restored.previous.every((path) => existsSync(path))).toBe(true)
      expect(readMarker(controlPath)).toBe('control-before')
      expect(readMarker(projectPath)).toBe('project-before')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a wrong key changes nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-instance-restore-key-'))
    const { controlPath, control, project } = makeInstance(root)
    try {
      const outputDir = join(root, 'backups')
      await createInstanceBackup({ databasePath: controlPath, outputDir, secret: KEY })
      const archive = join(outputDir, readdirSync(outputDir)[0]!)
      marker(control, 'control-after')
      control.sqlite.close()
      project.sqlite.close()

      await expect(restoreInstance({ databasePath: controlPath, archive, key: 'wrong key, long enough!!!!' })).rejects.toThrow(/Cannot decrypt/)
      expect(readMarker(controlPath)).toBe('control-after')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses a database that belongs to another project', () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-instance-other-'))
    const otherPath = join(root, 'other.sqlite')
    const other = bootstrapDb(otherPath, 'another-project')
    try {
      expect(() => inspectBackup(otherPath, PROJECT)).toThrow(/belongs to project "another-project"/)
      expect(inspectDatabase(otherPath).projectId).toBe('another-project')
    } finally {
      other.sqlite.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('stages a console upload and applies it on the next start, or cancels it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-instance-staged-'))
    const { controlPath, control, projectPath, project } = makeInstance(root)
    try {
      const outputDir = join(root, 'backups')
      await createInstanceBackup({ databasePath: controlPath, outputDir })
      const first = join(outputDir, readdirSync(outputDir)[0]!)
      const staged = stagePendingRestore({ databasePath: controlPath, archive: first, name: 'first.archive.zst' })
      expect(existsSync(staged.archive)).toBe(true)
      expect(readPendingRestore(controlPath)?.name).toBe('first.archive.zst')
      expect(cancelPendingRestore(controlPath)).toBe(true)
      expect(readPendingRestore(controlPath)).toBeNull()
      expect(cancelPendingRestore(controlPath)).toBe(false)

      // A fresh archive, then a change that the restore must undo.
      await createInstanceBackup({ databasePath: controlPath, outputDir })
      const second = join(outputDir, readdirSync(outputDir)[0]!)
      marker(control, 'control-after')
      marker(project, 'project-after')
      control.sqlite.close()
      project.sqlite.close()
      stagePendingRestore({ databasePath: controlPath, archive: second, name: 'second.archive.zst' })

      expect(await applyPendingRestore(testConfig({ databasePath: controlPath }))).toBe(true)
      expect(readPendingRestore(controlPath)).toBeNull()
      expect(readMarker(controlPath)).toBe('control-before')
      expect(readMarker(projectPath)).toBe('project-before')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('backup service', () => {
  test('writes whole-instance backups, lists them and serves them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-backup-service-'))
    const { controlPath, control, project } = makeInstance(root)
    const backupsPath = join(root, 'backups')
    try {
      const plain = new BackupService(testConfig({ databasePath: controlPath, backupsPath }))
      const compressed = await plain.create('manual')
      expect(compressed.name).toMatch(/\.archive\.zst$/)

      const encrypted = new BackupService(
        testConfig({ databasePath: controlPath, backupsPath, backupEncryptionKey: KEY }),
      )
      const created = await encrypted.create('manual')
      expect(created.name).toMatch(/\.archive\.zst\.enc$/)
      expect(statSync(join(backupsPath, created.name)).mode & 0o777).toBe(0o600)

      const names = (await encrypted.list()).map((backup) => backup.name).sort()
      expect(names).toEqual([compressed.name, created.name].sort())
      expect(readdirSync(backupsPath).filter((file) => file.startsWith('.'))).toEqual([])

      const res = await encrypted.serve(created.name)
      expect(res.headers.get('content-type')).toBe('application/x-bunwrite-archive')
      const download = join(root, 'download.archive.zst.enc')
      writeFileSync(download, Buffer.from(await res.arrayBuffer()))
      const out = join(root, 'out')
      mkdirSync(out)
      await readArchive({ input: download, destDir: out, secret: KEY })
      expect(readMarker(join(out, 'bunwrite.sqlite'))).toBe('control-before')

      const weak = new BackupService(
        testConfig({ databasePath: controlPath, backupsPath, backupEncryptionKey: 'short' }),
      )
      await expect(weak.create('manual')).rejects.toThrow(/at least 16/)
    } finally {
      control.sqlite.close()
      project.sqlite.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
