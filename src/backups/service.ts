/**
 * Database backups for the control instance.
 *
 * With SQLite, one archive holds the control database and every project
 * database, laid out like the Litestream replica (`bunwrite.sqlite`,
 * `projects/<id>/...`). With Postgres, one logical `pg_dump` covers the
 * database instead. Both are compressed with zstd, encrypted when
 * BACKUP_ENCRYPTION_KEY is set, and kept on local disk or in S3-compatible
 * storage. The console and the cron timer use this service.
 *
 * Only the control instance creates backups. Other project service graphs get
 * an inert instance so the shared `Services` shape stays uniform.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '~/config'
import { isLeader } from '~/cluster/role'
import { parseCron, type Cron } from '~/functions/cron'
import { err } from '~/lib/errors'
import { s3Call, s3Client } from '~/storage/s3'
import { contentType, MIN_KEY_LENGTH } from './format'
import { createInstanceBackup } from './instance'
import { createPostgresBackup } from './postgres'

export interface BackupFile {
  name: string
  size: number
  modified: string
}

const NAME_RE = /^[A-Za-z0-9._-]+\.(?:archive|dump)\.zst(?:\.enc)?$/
const AUTO_PREFIX = 'auto-'

export class BackupService {
  private active = false
  private timer: ReturnType<typeof setInterval> | null = null
  private lastAutoMinute = ''
  private cachedSchedule: { expression: string; cron: Cron } | null = null
  private badSchedule = ''

  constructor(
    private config: Config,
    /** Local SQLite databases get file archives; Postgres gets a pg_dump. */
    private readonly localFile = true,
  ) {}

  /** Only the control instance owns instance-wide backups. */
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
      const created = this.localFile
        ? await createInstanceBackup({
            databasePath: this.config.databasePath,
            legacyDatabasePath: this.config.legacyDatabasePath,
            outputDir: dir,
            prefix: kind === 'auto' ? AUTO_PREFIX : 'backup-',
            secret: key || undefined,
            log: (line) => console.log(line),
          })
        : await createPostgresBackup({
            databaseUrl: this.config.databaseUrl ?? '',
            outputDir: dir,
            prefix: kind === 'auto' ? AUTO_PREFIX : 'backup-',
            secret: key || undefined,
            log: (line) => console.log(line),
          })
      if (remote) {
        await s3Call(this.s3, () =>
          s3Client(this.s3)
            .file(this.s3Key(created.name))
            .write(Bun.file(created.path), { type: contentType(created.name) }),
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

  /** Matches the console cron schedule (UTC); exposed for tests through the optional date argument. */
  async tick(now = new Date()): Promise<void> {
    // One backup per matching minute across the cluster, not one per worker.
    if (!this.enabled) return
    if (!isLeader()) return
    if (!this.config.backups.enabled) return
    const expression = this.config.backups.schedule || '0 2 * * *'
    let cron: Cron
    try {
      cron = this.schedule(expression)
    } catch (error) {
      if (this.badSchedule !== expression) {
        this.badSchedule = expression
        console.error(`[backups] invalid schedule "${expression}":`, error instanceof Error ? error.message : error)
      }
      return
    }
    const minute = now.toISOString().slice(0, 16)
    if (!cron.matches(now) || this.lastAutoMinute === minute) return
    this.lastAutoMinute = minute
    try {
      await this.create('auto')
    } catch (error) {
      console.error('[backups] automatic backup failed:', error)
    }
  }

  private schedule(expression: string): Cron {
    if (this.cachedSchedule?.expression !== expression) {
      this.cachedSchedule = { expression, cron: parseCron(expression) }
    }
    return this.cachedSchedule.cron
  }
}
