/**
 * Restore the control database and every project database from Litestream.
 *
 *   bunwrite failover
 *   LITESTREAM_REPLICA_URL=s3://bucket/bunwrite bunwrite failover
 *
 * Run it while Bunwrite is stopped. It is safe to re-run: existing databases
 * are skipped unless --force is passed.
 */
import { resolve } from 'node:path'

import { runFailover } from '~/failover/restore'

const USAGE = `Usage: bunwrite failover [options]

Restore the control database and all project databases from Litestream.

Options:
  --from <url>       Replica base URL (or LITESTREAM_REPLICA_URL)
  --database <path>  Control database (or DATABASE_PATH)
  --bin <path>       Litestream executable (or LITESTREAM_BIN, default litestream)
  --endpoint <url>   S3-compatible endpoint (or LITESTREAM_S3_ENDPOINT)
  --region <name>    S3 region (or LITESTREAM_S3_REGION)
  --force-path-style Use path-style S3 addressing (or LITESTREAM_S3_FORCE_PATH_STYLE)
  --allow-empty      Allow a missing backup, for the very first deployment
  --force            Replace databases that already exist
  --dry-run          Print what would be restored without writing
  -h, --help         Show this help
`

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}

function flag(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const databasePath = resolve(flag('--database') ?? process.env.DATABASE_PATH ?? './data/bunwrite.sqlite')
const replicaUrl = flag('--from') ?? process.env.LITESTREAM_REPLICA_URL ?? ''
const allowEmpty = args.includes('--allow-empty') || ['1', 'true', 'yes', 'on'].includes((process.env.LITESTREAM_ALLOW_EMPTY ?? '').toLowerCase())
const force = args.includes('--force') || ['1', 'true', 'yes', 'on'].includes((process.env.LITESTREAM_FORCE_RESTORE ?? '').toLowerCase())
const dryRun = args.includes('--dry-run')

try {
  const result = runFailover({
    databasePath,
    replicaUrl,
    litestreamBin: flag('--bin') ?? process.env.LITESTREAM_BIN,
    endpoint: flag('--endpoint'),
    region: flag('--region'),
    forcePathStyle: args.includes('--force-path-style') || ['1', 'true', 'yes', 'on'].includes((process.env.LITESTREAM_S3_FORCE_PATH_STYLE ?? '').toLowerCase()),
    allowEmpty,
    force,
    dryRun,
  })
  const restored = result.outcomes.filter((outcome) => outcome.result === 'restored').length
  const skipped = result.outcomes.filter((outcome) => outcome.result === 'skipped').length
  const missing = result.outcomes.filter((outcome) => outcome.result === 'missing').length
  console.log(`failover: ${restored} restored, ${skipped} skipped, ${missing} missing, ${result.projects.length} project(s)`)
  if (dryRun) console.log('failover: dry run, nothing was written')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
