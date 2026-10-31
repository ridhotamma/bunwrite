/**
 * Whole-instance database backups.
 *
 * One archive holds the control database and every project database, laid out
 * like the Litestream replica (`bunwrite.sqlite`, `projects/<id>/...`). It is
 * compressed with zstd and encrypted when BACKUP_ENCRYPTION_KEY is set; the
 * console and the daily timer use this service, and `bunwrite restore` reads
 * what it writes.
 *
 * Only the control instance creates backups. Other project service graphs get
 * an inert instance so the shared `Services` shape stays uniform.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '~/config'
import { isLeader } from '~/cluster/role'
import { err } from '~/lib/errors'
import { s3Call, s3Client } from '~/storage/s3'
import { contentType, MIN_KEY_LENGTH } from './format'
import { createInstanceBackup } from './instance'

export interface BackupFile {
  name: string
  size: number
  modified: string
}

const NAME_RE = /^[A-Za-z0-9._-]+\.archive\.zst(\.enc)?$/
const AUTO_PREFIX = 'auto-'

export class BackupService {
  private active = false
  private timer: ReturnType<typeof setInterval> | null = null
  private lastAutoDay = ''

  constructor(private config: Config) {}

  /** Only the control instance owns whole-instance backups. */
  private get enabled(): boolean {
    return this.config.instanceBackups !== false
  }

  private get s3() {
    return this.config.backups.s3
  }

  private s3Prefix(): string {
    // The console setting wins; `backupsPrefix` stays for older project configs
    // where it was the project ID.
    const prefix = (this.config.backups.prefix ?? this.config.backupsPrefix ?? '').replace(/^\/+|\/+$/g, '')
    return prefix ? `${prefix}/` : ''
  }

  private s3Key(name: string): string {
    return `${this.s3Prefix()}${name}`
  }

  private validName(name: string): boolean {
    return NAME_RE.test(name) && !name.includes('/') && !name.includes('\\')
  }

  async list(): Promise<BackupFile[]> {
    if (!this.enabled) return []
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
    if (!this.enabled) throw err('general_argument_invalid', 'Backups are managed from the default project.')
    if (this.active) throw err('general_argument_invalid', 'A backup is already running.')
    const key = this.config.backupEncryptionKey
    if (key && key.length < MIN_KEY_LENGTH) {
      throw err('general_argument_invalid', `BACKUP_ENCRYPTION_KEY must be at least ${MIN_KEY_LENGTH} characters.`)
    }
    this.active = true
    // A remote backup is built locally first; keep that copy out of the
    // backups folder so a failed upload does not show up in the list.
    const remote = this.s3.enabled
    const dir = remote ? mkdtempSync(join(tmpdir(), 'bunwrite-backup-')) : this.config.backupsPath
    try {
      mkdirSync(dir, { recursive: true })
      const created = await createInstanceBackup({
        databasePath: this.config.databasePath,
        outputDir: dir,
        prefix: kind === 'auto' ? AUTO_PREFIX : 'backup-',
        secret: key || undefined,
        log: (line) => console.log(line),
      })
      if (remote) {
        await s3Call(this.s3, () =>
          s3Client(this.s3).file(this.s3Key(created.name)).write(Bun.file(created.path), { type: contentType(created.name) }),
        )
      }
      if (kind === 'auto') {
        try {
          await this.pruneAuto()
        } catch (error) {
          console.error('[backups] failed to prune old automatic backups:', error)
        }
      }
      return { name: created.name, size: created.size, modified: new Date().toISOString() }
    } finally {
      if (remote) rmSync(dir, { recursive: true, force: true })
      this.active = false
    }
  }

  async delete(name: string): Promise<void> {
    if (!this.enabled) throw err('general_argument_invalid', 'Backups are managed from the default project.')
    if (!this.validName(name)) throw err('general_argument_invalid', 'Invalid backup name.')
    if (this.s3.enabled) await s3Call(this.s3, () => s3Client(this.s3).delete(this.s3Key(name)))
    else rmSync(join(this.config.backupsPath, name), { force: true })
  }

  async serve(name: string): Promise<Response> {
    if (!this.enabled) throw err('general_argument_invalid', 'Backups are managed from the default project.')
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
    if (!this.enabled || this.timer) return
    this.timer = setInterval(() => void this.tick(new Date()), 60_000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Daily at 02:00 UTC; exposed for tests through the optional date argument. */
  async tick(now = new Date()): Promise<void> {
    // One backup a day across the cluster, not one per worker.
    if (!this.enabled) return
    if (!isLeader()) return
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
