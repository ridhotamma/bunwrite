/**
 * Copy a live Appwrite project into this server's database (read-only on Appwrite).
 *
 *   bun run migrate --endpoint https://appwrite.pesanle.com/v1 --project <id> --key <api key> \
 *     [--functions ../pesanle/packages/appwrite-config/appwrite.config.json] [--only schema,users,teams,documents,files] [--verify]
 *
 * Writes to DATABASE_PATH and STORAGE_PATH (same env as the server). Safe to run
 * again: rows are replaced by ID, so a final run at cutover picks up changes.
 */
import { dirname, resolve } from 'node:path'

import { openDb } from '~/db/connection'
import { importFromAppwrite, verifyAgainstAppwrite, type ImportOptions } from '~/migrate/importer'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const endpoint = flag('endpoint') ?? process.env.MIGRATE_ENDPOINT
const projectId = flag('project') ?? process.env.MIGRATE_PROJECT_ID ?? process.env.PROJECT_ID
const key = flag('key') ?? process.env.MIGRATE_API_KEY
if (!endpoint || !projectId || !key) {
  console.error('Usage: bun run migrate --endpoint <https://.../v1> --project <projectId> --key <apiKey> [--functions <appwrite.config.json>] [--only a,b] [--verify]')
  process.exit(1)
}

const functionsPath = flag('functions')
const options: ImportOptions = {
  endpoint,
  projectId,
  key,
  storagePath: process.env.STORAGE_PATH ?? './data/storage',
  only: flag('only') ? new Set(flag('only')!.split(',')) : undefined,
  log: (line) => console.log(line),
  functions: functionsPath ? { config: await Bun.file(functionsPath).json(), baseDir: dirname(resolve(functionsPath)) } : undefined,
}

const db = openDb(process.env.DATABASE_PATH ?? './data/pesanle.sqlite')
const started = performance.now()
const report = await importFromAppwrite(db, options)
const docs = report.collections.reduce((n, c) => n + c.imported, 0)
const short = report.collections.filter((c) => c.imported !== c.source)

console.log('\n=== Migration report')
console.log(`collections: ${report.collections.length}, documents: ${docs}`)
console.log(`users: ${report.users} (password hashes: ${JSON.stringify(report.hashFormats)}), identities: ${report.identities}`)
console.log(`teams: ${report.teams}, memberships: ${report.memberships}`)
console.log(`files: ${report.files} (${(report.fileBytes / 1024 / 1024).toFixed(1)} MB)`)
if (short.length) console.log('incomplete collections:', short)
if (report.skipped.length) console.log('skipped:', report.skipped)
console.log(`took ${((performance.now() - started) / 1000).toFixed(1)}s`)

if (args.includes('--verify')) {
  const { checked, mismatches, orderOnly } = await verifyAgainstAppwrite(db, options)
  console.log(`verify: ${checked} documents compared, ${mismatches.length} mismatches (${orderOnly} differ only in key order)`)
  for (const m of mismatches.slice(0, 50)) console.log('  ', m)
  if (mismatches.length) process.exitCode = 2
}
db.sqlite.close()
