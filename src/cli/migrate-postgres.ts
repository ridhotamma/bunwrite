/**
 * Move a stopped Bunwrite SQLite install to Postgres:
 *
 *   bunwrite migrate:postgres --url postgres://user:pass@host/bunwrite --dry-run
 *   bunwrite migrate:postgres --url postgres://user:pass@host/bunwrite
 *
 * The command reads DATABASE_PATH and the control database beside it, copies
 * the control store and every project into Postgres schemas, verifies row
 * counts, and prints the environment switch. It never edits the SQLite files
 * and never changes .env.
 */
import { migrationEnvironment, migrateSqliteToPostgres, type MigrateSqliteOptions, type MigrationReport } from '~/db/migrate-sqlite-postgres'

const USAGE = `Usage: bunwrite migrate:postgres [options]

Copy a stopped SQLite control database and every project database into Postgres.

Options:
  --url <url>               Postgres target URL (default: DATABASE_URL)
  --ssl                     Require TLS for Postgres (default: DATABASE_SSL)
  --schema <name>           Base schema (default: DATABASE_SCHEMA or bunwrite)
  --control-schema <name>   Control schema (default: CONTROL_DATABASE_SCHEMA or <schema>_console)
  --source <path>           Main SQLite database (default: DATABASE_PATH)
  --control <path>          Control SQLite database (default: control/bunwrite.sqlite)
  --data-dir <path>         Folder containing projects/ (default: source folder)
  --skip-logs               Skip request logs and telemetry tables
  --force                   Replace non-empty non-public target schemas
  --dry-run                 Print the plan without writing
  --json                    Print the report as JSON
  --help                    Show this help

Stop the Bunwrite server before running this command. The SQLite files are
left untouched, so switching DB_DRIVER back is the rollback path.`

interface Flags extends MigrateSqliteOptions {
  json?: boolean
  help?: boolean
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {}
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index]!
    if (!raw.startsWith('--')) throw new Error(`Unknown argument "${raw}". Use --help for usage.`)
    const body = raw.slice(2)
    const equals = body.indexOf('=')
    const key = equals >= 0 ? body.slice(0, equals) : body
    const inline = equals >= 0 ? body.slice(equals + 1) : undefined
    const value = inline ?? argv[index + 1]
    switch (key) {
      case 'url':
      case 'schema':
      case 'control-schema':
      case 'source':
      case 'control':
      case 'data-dir':
        if (!value || value.startsWith('--')) throw new Error(`--${key} needs a value.`)
        if (key === 'url') flags.url = value
        else if (key === 'schema') flags.schema = value
        else if (key === 'control-schema') flags.controlSchema = value
        else if (key === 'source') flags.source = value
        else if (key === 'control') flags.control = value
        else flags.dataDir = value
        if (inline === undefined) index++
        break
      case 'ssl':
      case 'skip-logs':
      case 'force':
      case 'dry-run':
      case 'json':
      case 'help':
        flags[key === 'skip-logs' ? 'skipLogs' : key === 'dry-run' ? 'dryRun' : key] = true
        break
      default:
        throw new Error(`Unknown option --${key}. Use --help for usage.`)
    }
  }
  return flags
}

function redactedUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.password) url.password = '***'
    return url.toString()
  } catch {
    return '<postgres-url>'
  }
}

function printPlan(report: MigrationReport): void {
  const { plan } = report
  console.log('Bunwrite SQLite -> Postgres migration')
  console.log(`  source:   ${plan.source}`)
  console.log(`  control:  ${plan.controlSource} (${plan.controlCurrentLayout ? 'current layout' : 'legacy single-database layout'})`)
  console.log(`  target:   ${redactedUrl(plan.targetUrl)}`)
  console.log(`  base:     ${plan.targetBase}`)
  console.log(`  control schema: ${plan.controlSchema}`)
  console.log('  projects:')
  for (const project of plan.projects) {
    console.log(`    - ${project.id}${project.legacy ? ' (legacy)' : ''} -> ${project.schema} (${project.tables} tables)`)
  }
}

function printNextSteps(report: MigrationReport): void {
  const env = migrationEnvironment(report.plan)
  console.log('\nNext')
  console.log('  1. Keep the SQLite files until the Postgres server has been verified.')
  console.log('  2. Set these values in .env or your deployment environment:')
  for (const [key, value] of Object.entries(env)) console.log(`       ${key}=${value}`)
  console.log('     DATABASE_URL must be the same URL passed to --url.')
  console.log('  3. If the Postgres server is on another host, copy STORAGE_PATH, functions and site files too.')
  console.log('  4. Start Bunwrite on Postgres and verify projects, documents and logins.')
  console.log('  5. Roll back by unsetting DB_DRIVER/DATABASE_URL and restarting on SQLite.')
  if (report.plan.projects.some((project) => project.legacy)) console.log('     The legacy project keeps the base schema.')
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  if (flags.help) {
    console.log(USAGE)
    return
  }
  const report = await migrateSqliteToPostgres({
    ...flags,
    log: (line) => {
      if (!flags.json) console.log(line)
    },
  })
  if (flags.json) {
    console.log(JSON.stringify({ ...report, plan: { ...report.plan, targetUrl: redactedUrl(report.plan.targetUrl) } }, null, 2))
    return
  }
  printPlan(report)
  if (report.dryRun) {
    console.log('\nDry run: no target schemas or rows were changed.')
    return
  }
  console.log(`\nMigration complete in ${(report.durationMs / 1000).toFixed(1)}s.`)
  if (report.control) console.log(`  control: ${report.control.tables} tables, ${report.control.rows.toLocaleString('en-US')} rows -> ${report.control.schema}`)
  for (const project of report.projects)
    console.log(`  ${project.id}: ${project.tables} tables, ${project.rows.toLocaleString('en-US')} rows -> ${project.schema}`)
  printNextSteps(report)
}

main().catch((error: unknown) => {
  console.error(`migrate:postgres: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
