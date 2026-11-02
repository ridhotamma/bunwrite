/**
 * Decompress a backup into the file an operator restores by hand.
 *
 *   bunwrite backup:open backup-...dump.zst [bunwrite.dump]
 *   pg_restore --clean --if-exists --dbname="$DATABASE_URL" bunwrite.dump
 *
 * It also opens the legacy per-project `.sqlite.zst` / `.sqlite.zst.enc`
 * backups kept for upgrades. Encrypted backups need the BACKUP_ENCRYPTION_KEY
 * they were made with, from the environment or `.env`.
 */
import { existsSync } from 'node:fs'

import { unpackBackup } from '~/backups/format'

const [input, given] = process.argv.slice(2)
if (!input) {
  console.error('Usage: backup:open <backup file> [output]')
  process.exit(1)
}
if (!/\.(?:sqlite|dump)\.zst(\.enc)?$/.test(input)) {
  console.error(`${input} is not a compressed backup (.sqlite.zst, .dump.zst, or their .enc form). Use bunwrite restore for an .archive.zst.`)
  process.exit(1)
}
if (!existsSync(input)) {
  console.error(`${input} does not exist.`)
  process.exit(1)
}

const output = given ?? input.replace(/\.zst(\.enc)?$/, '')
try {
  await unpackBackup(input, output, process.env.BACKUP_ENCRYPTION_KEY || undefined)
  console.log(`backup:open: ${output}`)
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code
  console.error(code === 'EEXIST' ? `${output} already exists; pass another output path.` : error instanceof Error ? error.message : String(error))
  process.exit(1)
}
