/**
 * Restore a whole-instance backup archive.
 *
 *   bunwrite restore backup-2026-10-31T02-00-00-000Z.archive.zst
 *   bunwrite restore <file> --dry-run
 *   LITESTREAM_... bunwrite restore <file>
 *
 * Stop Bunwrite first. The archive replaces the control database and every
 * project database; uploaded files, function code and site builds are not in
 * it. Each database is checked before any live file is touched, and a failure
 * while swapping puts the previous files back.
 */
import { dirname, resolve } from 'node:path'

import { applyPendingRestore } from '~/backups/pending'
import { restoreInstance } from '~/backups/restore'
import { configFromEnv } from '~/config'
import { controlDatabasePath } from '~/projects/control'
import { requireSqliteCommand } from './sqlite-only'

const USAGE = `Usage: bunwrite restore <archive> [options]

Restore the control database and every project database from one archive.

Options:
  --database <path>  Control database (or DATABASE_PATH)
  --key <key>        Backup encryption key (or BACKUP_ENCRYPTION_KEY)
  --pending          Apply an archive staged from the console, then exit
  --dry-run          Check the archive and print the plan without writing
  -h, --help         Show this help

Stop Bunwrite before restoring. Uploaded files and function/site code are not
in the archive; back up STORAGE_PATH separately.
`

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}
requireSqliteCommand('restore')

function flag(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

if (args.includes('--pending')) {
  const config = configFromEnv()
  const database = flag('--database')
  if (database) config.databasePath = resolve(database)
  const key = flag('--key')
  if (key) config.backupEncryptionKey = key
  try {
    await applyPendingRestore(config)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  process.exit(0)
}

const archive = args.find((arg, index) => !arg.startsWith('-') && !['--database', '--key'].includes(args[index - 1] ?? ''))
if (!archive) {
  console.error(USAGE)
  process.exit(1)
}

const databasePath = resolve(flag('--database') ?? process.env.DATABASE_PATH ?? './data/bunwrite.sqlite')
const config = configFromEnv()
const controlPath = controlDatabasePath({ ...config, databasePath })
const key = flag('--key') ?? process.env.BACKUP_ENCRYPTION_KEY
const dryRun = args.includes('--dry-run')

try {
  const result = await restoreInstance({
    databasePath: controlPath,
    legacyDatabasePath: databasePath,
    dataDir: dirname(databasePath),
    archive,
    key: key || undefined,
    dryRun,
    log: (line) => console.log(line),
  })
  console.log(`restore: ${result.outcomes.length} database(s) ${dryRun ? 'planned' : 'restored'}`)
  if (result.previous.length) {
    console.log('restore: previous files kept:')
    for (const path of result.previous) console.log(`  ${path}`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
