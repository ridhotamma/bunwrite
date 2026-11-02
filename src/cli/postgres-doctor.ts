/**
 * Preflight checks and a copy-paste runbook for restoring Postgres from WAL-G.
 *
 *   bunwrite postgres:doctor
 *   bunwrite postgres:doctor --runbook
 *   bunwrite postgres:doctor --target-time '2026-11-02 10:00:00+00'
 *
 * Bunwrite cannot replace PGDATA on a remote Postgres server, so this command
 * reports what is wrong and prints the operator steps instead of pretending it
 * can perform the restore itself.
 */
import { configFromEnv } from '~/config'
import { openDatabase } from '~/db'
import { parseDatabaseBackend } from '~/db/driver'
import { maskDatabaseUrl, postgresDoctor, type DoctorCheck } from '~/backups/postgres'

const USAGE = `Usage: bunwrite postgres:doctor [options]

Check WAL-G archiving and print a restore runbook for Postgres.

Options:
  --url <url>              Postgres URL (or DATABASE_URL)
  --database <name>        Postgres schema/namespace
  --pgdata <path>          Data directory for the runbook (or PGDATA)
  --target-time <time>     Point-in-time target, e.g. '2026-11-02 10:00:00+00'
  --base-backup <name>     Base backup name instead of LATEST
  --service <name>         Bunwrite systemd unit (or BUNWRITE_SERVICE, default bunwrite)
  --postgres-service <n>   Postgres systemd unit (or POSTGRES_SERVICE, default postgresql)
  --docker                 Include the Docker restore profile in the runbook
  --binary <path>          WAL-G executable (or WALG_BIN, default wal-g)
  --no-walg                Skip the wal-g backup-list check
  --json                   Print the report as JSON
  --runbook                Print only the runbook
  -h, --help               Show this help

Exit code is 1 when a required check fails, so it can gate a deploy.`

interface Flags {
  url?: string
  database?: string
  pgdata?: string
  'target-time'?: string
  'base-backup'?: string
  service?: string
  'postgres-service'?: string
  docker?: boolean
  binary?: string
  'no-walg'?: boolean
  json?: boolean
  runbook?: boolean
  help?: boolean
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    if (!raw.startsWith('--')) throw new Error(`Unexpected argument "${raw}".`)
    const [key, inline] = raw.slice(2).split('=', 2) as [string, string | undefined]
    if (key === 'docker' || key === 'no-walg' || key === 'json' || key === 'runbook') {
      flags[key] = true
      continue
    }
    if (key === 'help') {
      flags.help = true
      continue
    }
    const value = inline ?? argv[++i]
    switch (key) {
      case 'url':
        flags.url = value
        break
      case 'database':
      case 'namespace':
        flags.database = value
        break
      case 'pgdata':
        flags.pgdata = value
        break
      case 'target-time':
        flags['target-time'] = value
        break
      case 'base-backup':
        flags['base-backup'] = value
        break
      case 'service':
        flags.service = value
        break
      case 'postgres-service':
        flags['postgres-service'] = value
        break
      case 'binary':
        flags.binary = value
        break
      default:
        throw new Error(`Unknown flag --${key}`)
    }
  }
  return flags
}

const symbol = (check: DoctorCheck): string => {
  if (check.status === 'ok') return 'OK  '
  if (check.status === 'fail') return 'FAIL'
  if (check.status === 'warn') return 'WARN'
  return 'INFO'
}

async function main(): Promise<void> {
  let flags: Flags
  try {
    flags = parseFlags(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(USAGE)
    process.exit(2)
  }
  if (flags.help) {
    console.log(USAGE)
    return
  }

  const config = configFromEnv()
  const url = flags.url ?? config.databaseUrl
  const backend = flags.url ? 'postgres' : parseDatabaseBackend(config.databaseDriver, url)
  if (backend !== 'postgres') {
    console.error('postgres:doctor: this command needs DB_DRIVER=postgres and DATABASE_URL (or --url).')
    console.error('For SQLite, use `bunwrite failover` instead.')
    process.exit(2)
  }
  if (!url) {
    console.error('postgres:doctor: DATABASE_URL is required for DB_DRIVER=postgres.')
    process.exit(2)
  }

  const database = await openDatabase({
    backend: 'postgres',
    url,
    namespace: flags.database ?? config.databaseNamespace,
    poolMax: 1,
    bootstrap: false,
  })
  try {
    const report = await postgresDoctor({
      sql: database.sql,
      databaseUrl: maskDatabaseUrl(url),
      pgdata: flags.pgdata,
      bunwriteService: flags.service,
      postgresService: flags['postgres-service'],
      baseBackup: flags['base-backup'],
      targetTime: flags['target-time'],
      docker: flags.docker,
      walgBinary: flags.binary,
      checkWalg: !flags['no-walg'],
    })

    if (flags.runbook) {
      console.log(report.runbook)
      return
    }
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2))
      if (!report.ok) process.exitCode = 1
      return
    }

    const { status, walg } = report
    const failures = report.checks.filter((check) => check.status === 'fail').length
    const warnings = report.checks.filter((check) => check.status === 'warn').length
    console.log('Postgres restore doctor')
    console.log(`  Server:     PostgreSQL ${status.version} (${status.inRecovery ? 'standby' : 'primary'})`)
    console.log(`  Database:   ${status.database} as ${status.user}`)
    if (status.dataDirectory) console.log(`  PGDATA:     ${status.dataDirectory}`)
    console.log(`  WAL-G:      ${walg.configured ? 'configured' : 'not configured'}${walg.binary ? ` (${walg.binary})` : ''}`)
    console.log(`  Backups:    ${walg.skipped ? 'skipped' : walg.error ? `error: ${walg.error}` : `${walg.backups.length} base backup${walg.backups.length === 1 ? '' : 's'}`}`)
    console.log('')
    for (const check of report.checks) {
      console.log(`  [${symbol(check)}] ${check.label}: ${check.detail}`)
      if (check.fix) console.log(`         fix: ${check.fix}`)
    }
    console.log('')
    console.log(`${report.ok ? 'Ready' : 'Not ready'}: ${failures} failed, ${warnings} warning${warnings === 1 ? '' : 's'}.`)
    console.log('Run with --runbook to print the copy-paste restore steps.')
    if (!report.ok) process.exitCode = 1
  } finally {
    await database.close()
  }
}

await main().catch((error) => {
  console.error(`postgres:doctor: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
