/** Apply an appwrite.config.json to the database: `bun run schema:push <path> [--prune]`. */
import { dirname, resolve } from 'node:path'

import { openDb } from '~/db/connection'
import { pushConfig } from '~/schema/push'

const args = process.argv.slice(2)
const path = args.find((a) => !a.startsWith('--')) ?? process.env.SCHEMA_PATH
if (!path) {
  console.error('Usage: bun run schema:push <appwrite.config.json> [--prune]')
  process.exit(1)
}

const db = openDb(process.env.DATABASE_PATH ?? './data/bunwrite.sqlite')
let changes = 0
pushConfig(db, await Bun.file(path).json(), {
  prune: args.includes('--prune'),
  baseDir: dirname(resolve(path)),
  log: (line) => {
    changes++
    console.log(line)
  },
})
console.log(changes === 0 ? 'Schema already up to date.' : `${changes} change(s) applied.`)
db.sqlite.close()
