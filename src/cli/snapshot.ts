/**
 * Whole-instance backup from cron: `bun run snapshot [dir]` writes one archive
 * with the control database and every project database, laid out like the
 * Litestream replica. It keeps the newest KEEP `snapshot-*` archives (default
 * 7) and leaves console/automatic backups alone.
 *
 * Copy the folder off the VPS (rclone to R2, for example); a disk failure takes
 * both otherwise. Uploaded files are not included.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createInstanceBackup } from '~/backups/instance'
import { configFromEnv } from '~/config'
import { controlDatabasePath } from '~/projects/control'
import { requireSqliteCommand } from './sqlite-only'

requireSqliteCommand('snapshot')
const config = configFromEnv()
const controlPath = controlDatabasePath(config)
const databasePath = existsSync(controlPath) ? controlPath : resolve(config.databasePath)
const legacyDatabasePath = databasePath === resolve(config.databasePath) ? undefined : resolve(config.databasePath)
const dir = resolve(process.argv[2] ?? process.env.SNAPSHOT_DIR ?? process.env.BACKUPS_PATH ?? './data/backups')
const keep = Math.max(1, Number(process.env.KEEP ?? 7) || 7)

mkdirSync(dir, { recursive: true })
const created = await createInstanceBackup({
  databasePath,
  legacyDatabasePath,
  outputDir: dir,
  prefix: 'snapshot-',
  secret: process.env.BACKUP_ENCRYPTION_KEY || undefined,
  log: (line) => console.log(line),
})
console.log(`snapshot: ${created.path}`)

const old = readdirSync(dir)
  .filter((file) => /^snapshot-.*\.archive\.zst(\.enc)?$/.test(file))
  .sort()
  .reverse()
  .slice(keep)
for (const file of old) rmSync(join(dir, file))
if (old.length) console.log(`removed ${old.length} old snapshot(s)`)
