/** Apply a project config file (bunwrite.config.json, bunwrite.json or appwrite.config.json) to the configured database: `bun run schema:push <path> [--prune]`. */
import { dirname, resolve } from 'node:path'

import { configFromEnv } from '~/config'
import { databaseOptionsOf, openDatabase } from '~/db'
import type { PostgresDriver } from '~/db/postgres-driver'
import { pushConfig } from '~/schema/push'
import { pushConfigPostgres } from '~/schema/push-postgres'

const args = process.argv.slice(2)
const path = args.find((a) => !a.startsWith('--')) ?? process.env.SCHEMA_PATH
if (!path) {
  console.error('Usage: bun run schema:push <bunwrite.config.json> [--prune]')
  process.exit(1)
}

const config = configFromEnv()
const database = await openDatabase(databaseOptionsOf(config))
let changes = 0
const options = {
  prune: args.includes('--prune'),
  baseDir: dirname(resolve(path)),
  log: (line: string) => {
    changes++
    console.log(line)
  },
}
try {
  const project = await Bun.file(path).json()
  if (database.backend === 'postgres') await pushConfigPostgres(database.sql as PostgresDriver, project, options)
  else if (database.sqlite) pushConfig(database.sqlite, project, options)
  console.log(changes === 0 ? 'Schema already up to date.' : `${changes} change(s) applied.`)
} finally {
  await database.close()
}
