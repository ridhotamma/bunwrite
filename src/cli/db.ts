/**
 * Inspect and prepare a database backend.
 *
 *   bun run db:check                 # connect, bootstrap and report capabilities
 *   bun run db:migrate               # create/upgrade the schema only
 *   bun run db:check --driver mongodb --url mongodb://localhost:27017 --database bunwrite
 *
 * Everything for the network backends can also come from the environment:
 * `DB_DRIVER`, `DATABASE_URL`, `DATABASE_SCHEMA` (Postgres) or
 * `MONGO_DATABASE`, `DATABASE_POOL_MAX`, `DATABASE_SSL`.
 */
import { databaseOptionsOf, describeDatabase, openDatabase, parseDatabaseBackend, type DatabaseOptions } from '~/db'
import { configFromEnv } from '~/config'

interface Flags {
  driver?: string
  url?: string
  database?: string
  pool?: string
  ssl?: boolean
  'no-bootstrap'?: boolean
  json?: boolean
}

function parseFlags(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!
    if (!value.startsWith('--')) {
      positional.push(value)
      continue
    }
    const [rawKey, inline] = value.slice(2).split('=', 2) as [string, string | undefined]
    const key = rawKey === 'mongodb' ? 'driver' : rawKey
    if (key === 'ssl' || key === 'no-bootstrap' || key === 'json') {
      flags[key] = true
      continue
    }
    const next = inline ?? argv[++i]
    switch (key) {
      case 'driver':
        flags.driver = next
        break
      case 'url':
        flags.url = next
        break
      case 'database':
      case 'schema':
      case 'namespace':
        flags.database = next
        break
      case 'pool':
        flags.pool = next
        break
      default:
        throw new Error(`Unknown flag --${rawKey}`)
    }
  }
  return { command: positional[0] ?? 'check', flags }
}

function optionsFrom(flags: Flags): DatabaseOptions {
  const config = configFromEnv()
  const base = databaseOptionsOf(config)
  const backend =
    (flags.driver as DatabaseOptions['backend'] | undefined) ??
    (flags.url ? parseDatabaseBackend(undefined, flags.url) : base.backend)
  return {
    ...base,
    backend,
    url: flags.url ?? base.url,
    namespace: flags.database ?? base.namespace,
    poolMax: flags.pool ? Number(flags.pool) : base.poolMax,
    ssl: flags.ssl ?? base.ssl,
    bootstrap: flags['no-bootstrap'] ? false : base.bootstrap,
    log: (line) => console.log(`[database] ${line}`),
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseFlags(process.argv.slice(2))
  if (!['check', 'migrate', 'ping'].includes(command)) {
    console.error(`Usage: bun src/cli/db.ts [check|migrate|ping] [--driver sqlite|postgres|mongodb] [--url URL] [--database NAME]`)
    process.exit(2)
  }

  const options = optionsFrom(flags)
  if (options.backend !== 'sqlite' && !options.url) {
    console.error(`[database] DATABASE_URL is required for ${options.backend}`)
    process.exit(2)
  }

  const database = await openDatabase({ ...options, bootstrap: options.bootstrap !== false || command === 'migrate' })
  try {
    await database.ping()
    const report: Record<string, unknown> = {
      backend: database.backend,
      description: describeDatabase(database),
      capabilities: database.capabilities,
    }
    if (database.backend === 'sqlite') {
      report.path = options.path
    } else {
      report.namespace = options.namespace ?? (database.backend === 'mongodb' ? 'bunwrite' : 'public')
    }
    if (database.sql) {
      const tables = await database.sql.all<{ name: string }>(
        database.backend === 'postgres'
          ? `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`
          : `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      report.tables = tables.map((row) => row.name)
    }
    if (database.backend === 'mongodb' && database.documents) {
      const driver = database.documents as unknown as { collections(): Promise<string[]> }
      report.collections = await driver.collections()
    }
    if (flags.json) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(`[database] ${report.description}`)
      if (Array.isArray(report.tables)) console.log(`[database] ${report.tables.length} tables`)
      if (Array.isArray(report.collections)) console.log(`[database] ${report.collections.length} collections`)
    }
  } finally {
    await database.close()
  }
}

await main()
