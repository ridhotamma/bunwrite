/**
 * Database backups with SQLite `VACUUM INTO` for a consistent live snapshot.
 * Stored locally or in the separate backup S3 bucket; automatic backups run
 * once a day at 02:00 UTC.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { Config } from '~/config'
import type { Db } from '~/db/connection'
import { err } from '~/lib/errors'
import { s3Call, s3Client } from '~/storage/s3'

export interface BackupFile {
  name: string
  size: number
  modified: string
}

const NAME_RE = /^[A-Za-z0-9._-]+\.sqlite$/
const AUTO_PREFIX = 'auto-'

export class BackupService {
  private active = false
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
            if (!object.key.endsWith('.sqlite')) continue
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
      .filter((name) => name.endsWith('.sqlite'))
      .map((name) => {
        const stat = statSync(join(dir, name))
        return { name, size: stat.size, modified: stat.mtime.toISOString() }
      })
      .sort((a, b) => b.modified.localeCompare(a.modified))
  }

  async create(kind: 'manual' | 'auto' = 'manual'): Promise<BackupFile> {
    if (this.active) throw err('general_argument_invalid', 'A backup is already running.')
    this.active = true
    const dir = this.config.backupsPath
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `${kind === 'auto' ? AUTO_PREFIX : 'backup-'}${stamp}.sqlite`
    const temp = join(dir, `.${name}.tmp`)
    try {
      this.db.sqlite.run(`VACUUM INTO '${temp.replace(/'/g, "''")}'`)
      const size = statSync(temp).size
      if (this.s3.enabled) {
        await s3Call(this.s3, () => s3Client(this.s3).file(this.s3Key(name)).write(Bun.file(temp), { type: 'application/x-sqlite3' }))
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
      rmSync(temp, { force: true })
      this.active = false
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
      'content-type': 'application/x-sqlite3',
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
