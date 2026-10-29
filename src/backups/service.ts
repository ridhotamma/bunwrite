/**
 * Database backups with SQLite `VACUUM INTO` for a consistent live snapshot,
 * compressed with zstd and encrypted when BACKUP_ENCRYPTION_KEY is set (see
 * format.ts). Stored locally or in the separate backup S3 bucket; automatic
 * backups run once a day at 02:00 UTC.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type { Config } from '~/config'
import type { Db } from '~/db/connection'
import { BunwriteError, err } from '~/lib/errors'
import { uniqueId } from '~/lib/ids'
import { s3Call, s3Client } from '~/storage/s3'
import { checkKey, COMPRESSED_EXT, contentType, ENCRYPTED_EXT, MIN_KEY_LENGTH, packBackup, unpackBackup } from './format'
import { databaseFile, inspectBackup } from './restore'

export interface BackupFile {
  name: string
  size: number
  modified: string
}

export interface RestoreResult {
  name: string
  size: number
  projectId: string
}

const NAME_RE = /^[A-Za-z0-9._-]+\.sqlite(\.zst(\.enc)?)?$/
const AUTO_PREFIX = 'auto-'

export class BackupService {
  private active = false
  /** A restore is being checked or applied; do not start a backup meanwhile. */
  private restoring = false
  private timer: ReturnType<typeof setInterval> | null = null
  private lastAutoDay = ''

  constructor(
    private db: Db,
    private config: Config,
  ) {}

  private get s3() {
    return this.config.backups.s3
  }

  private s3Prefix(): string {
    const prefix = (this.config.backupsPrefix ?? '').replace(/^\/+|\/+$/g, '')
    return prefix ? `${prefix}/` : ''
  }

  private s3Key(name: string): string {
    return `${this.s3Prefix()}${name}`
  }

  private validName(name: string): boolean {
    return NAME_RE.test(name) && !name.includes('/') && !name.includes('\\')
  }

  async list(): Promise<BackupFile[]> {
    if (this.s3.enabled) {
      const files = await s3Call(this.s3, async () => {
        const client = s3Client(this.s3)
        const prefix = this.s3Prefix()
        const found: BackupFile[] = []
        let token: string | undefined
        do {
          const page = await client.list({ maxKeys: 1000, continuationToken: token })
          for (const object of page.contents ?? []) {
            if (prefix && !object.key.startsWith(prefix)) continue
            const name = prefix ? object.key.slice(prefix.length) : object.key
            if (!this.validName(name)) continue
            found.push({ name, size: object.size ?? 0, modified: object.lastModified ?? '' })
          }
          token = page.isTruncated ? page.nextContinuationToken : undefined
        } while (token)
        return found
      })
      return files.sort((a, b) => b.modified.localeCompare(a.modified))
    }

    const dir = this.config.backupsPath
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((name) => this.validName(name))
      .map((name) => {
        const stat = statSync(join(dir, name))
        return { name, size: stat.size, modified: stat.mtime.toISOString() }
      })
      .sort((a, b) => b.modified.localeCompare(a.modified))
  }

  async create(kind: 'manual' | 'auto' = 'manual'): Promise<BackupFile> {
    if (this.active || this.restoring) throw err('general_argument_invalid', 'A backup or restore is already running.')
    const key = this.config.backupEncryptionKey
    if (key && key.length < MIN_KEY_LENGTH) {
      throw err('general_argument_invalid', `BACKUP_ENCRYPTION_KEY must be at least ${MIN_KEY_LENGTH} characters.`)
    }
    this.active = true
    const dir = this.config.backupsPath
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `${kind === 'auto' ? AUTO_PREFIX : 'backup-'}${stamp}${key ? ENCRYPTED_EXT : COMPRESSED_EXT}`
    // The raw snapshot is plain text; it only lives here until it is packed.
    const snapshot = join(dir, `.${name}.snapshot.tmp`)
    const temp = join(dir, `.${name}.tmp`)
    try {
      this.db.sqlite.run(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`)
      await packBackup(snapshot, temp, key)
      rmSync(snapshot, { force: true })
      const size = statSync(temp).size
      if (this.s3.enabled) {
        await s3Call(this.s3, () => s3Client(this.s3).file(this.s3Key(name)).write(Bun.file(temp), { type: contentType(name) }))
      } else {
        renameSync(temp, join(dir, name))
      }
      if (kind === 'auto') {
        try {
          await this.pruneAuto()
        } catch (error) {
          console.error('[backups] failed to prune old automatic backups:', error)
        }
      }
      return { name, size, modified: new Date().toISOString() }
    } finally {
      rmSync(snapshot, { force: true })
      rmSync(temp, { force: true })
      this.active = false
    }
  }

  /**
   * Decrypt and check an uploaded backup, then hand the plain SQLite file to
   * `apply` (which swaps it into this project). Nothing is replaced unless the
   * whole file opens, passes SQLite's integrity check, and belongs to this
   * project.
   */
  async restore(file: Blob, key: string | undefined, apply: (path: string) => Promise<void> | void): Promise<RestoreResult> {
    if (this.active || this.restoring) throw err('general_argument_invalid', 'A backup or restore is already running.')
    const database = databaseFile(this.config)
    if (!database) throw err('general_argument_invalid', 'Restoring a backup needs a file-backed database.')
    const name = basename(String((file as File).name || 'backup.sqlite').replace(/\\/g, '/'))
    if (!this.validName(name)) throw err('general_argument_invalid', 'Choose a Bunwrite backup: .sqlite, .sqlite.zst or .sqlite.zst.enc.')
    if (!file.size) throw err('general_argument_invalid', 'The backup file is empty.')

    this.restoring = true
    const dir = dirname(database)
    mkdirSync(dir, { recursive: true })
    const token = uniqueId()
    const suffix = name.endsWith(ENCRYPTED_EXT) ? ENCRYPTED_EXT : name.endsWith(COMPRESSED_EXT) ? COMPRESSED_EXT : '.sqlite'
    const upload = join(dir, `.restore-${token}.upload${suffix}`)
    const restored = join(dir, `.restore-${token}.sqlite`)
    const encrypted = name.endsWith(ENCRYPTED_EXT)
    let secret = ''
    let ready = false
    try {
      if (!(await Bun.write(upload, file))) throw new Error('The backup file is empty.')
      chmodSync(upload, 0o600)
      if (encrypted) {
        secret = (key ?? '').trim() || this.config.backupEncryptionKey || ''
        if (!secret) {
          throw err('general_argument_invalid', 'This backup is encrypted. Enter its BACKUP_ENCRYPTION_KEY, or set it on the server.')
        }
        checkKey(secret)
      }
      await unpackBackup(upload, restored, secret || undefined)
      const projectId = inspectBackup(restored, this.config.projectId)
      const size = statSync(restored).size
      ready = true
      await apply(restored)
      return { name, size, projectId }
    } catch (error) {
      // Validation errors are the caller's to fix; a failure while swapping the
      // live database is a server error and keeps its original type.
      if (ready || error instanceof BunwriteError) throw error
      throw err('general_argument_invalid', `${name}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      rmSync(upload, { force: true })
      rmSync(restored, { force: true })
      this.restoring = false
    }
  }

  async delete(name: string): Promise<void> {
    if (!this.validName(name)) throw err('general_argument_invalid', 'Invalid backup name.')
    if (this.s3.enabled) await s3Call(this.s3, () => s3Client(this.s3).delete(this.s3Key(name)))
    else rmSync(join(this.config.backupsPath, name), { force: true })
  }

  async serve(name: string): Promise<Response> {
    if (!this.validName(name)) throw err('general_argument_invalid', 'Invalid backup name.')
    const headers = {
      'content-type': contentType(name),
      'content-disposition': `attachment; filename="${encodeURIComponent(name)}"`,
      'cache-control': 'no-store',
    }
    if (this.s3.enabled) {
      const file = s3Client(this.s3).file(this.s3Key(name))
      try {
        const stat = await file.stat()
        return new Response(file.stream(), { headers: { ...headers, 'content-length': String(stat.size) } })
      } catch {
        throw err('general_argument_invalid', 'Backup not found.')
      }
    }
    const path = join(this.config.backupsPath, name)
    if (!existsSync(path)) throw err('general_argument_invalid', 'Backup not found.')
    return new Response(Bun.file(path), { headers })
  }

  async pruneAuto(): Promise<void> {
    const keep = Math.max(1, this.config.backups.keep)
    const old = (await this.list()).filter((file) => file.name.startsWith(AUTO_PREFIX)).slice(keep)
    for (const file of old) await this.delete(file.name)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(new Date()), 60_000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Daily at 02:00 UTC; exposed for tests through the optional date argument. */
  async tick(now = new Date()): Promise<void> {
    if (!this.config.backups.enabled) return
    const day = now.toISOString().slice(0, 10)
    if (now.getUTCHours() !== 2 || this.lastAutoDay === day) return
    this.lastAutoDay = day
    try {
      await this.create('auto')
    } catch (error) {
      console.error('[backups] automatic backup failed:', error)
    }
  }
}
