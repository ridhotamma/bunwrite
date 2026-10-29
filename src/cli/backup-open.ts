/**
 * Turn a downloaded backup back into a SQLite file you can restore:
 * `bun run backup:open <file> [out.sqlite]`. Encrypted backups need the
 * BACKUP_ENCRYPTION_KEY they were made with, read from the environment or .env.
 */
import { existsSync } from 'node:fs'

import { unpackBackup } from '~/backups/format'

const [input, given] = process.argv.slice(2)
if (!input) {
  console.error('Usage: backup:open <backup file> [output.sqlite]')
  process.exit(1)
}
if (!/\.sqlite\.zst(\.enc)?$/.test(input)) {
  console.error(`${input} is not a compressed backup (.sqlite.zst or .sqlite.zst.enc). A .sqlite backup can be restored as it is.`)
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
