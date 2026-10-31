/**
 * PocketBase-style restore for Bunwrite's SQLite layout.
 *
 * The control database lists every project. After restoring it, restore each
 * project database from the same Litestream replica tree, then start the app.
 * This is deliberately a single-host operation: never run it while another
 * instance is writing to the same replica.
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { dataDirOf, projectFolder, projectPaths } from '~/projects/paths'

export interface FailoverOptions {
  databasePath: string
  /** Base replica URL, for example s3://bucket/bunwrite. */
  replicaUrl: string
  /** Litestream executable; defaults to `litestream`. */
  litestreamBin?: string
  /** S3-compatible endpoint (R2, MinIO). Omit for AWS S3. */
  endpoint?: string
  /** Region for the S3-compatible endpoint. */
  region?: string
  /** Path-style addressing, required by most non-AWS providers. */
  forcePathStyle?: boolean
  /** The event was a first deployment with no remote backup yet. */
  allowEmpty?: boolean
  /** Replace databases that already exist locally. Dangerous. */
  force?: boolean
  dryRun?: boolean
  log?: (line: string) => void
}

export interface RestoreOutcome {
  target: 'control' | 'project'
  id?: string
  path: string
  remote: string
  result: 'restored' | 'skipped' | 'missing' | 'planned'
}

export interface FailoverResult {
  outcomes: RestoreOutcome[]
  projects: string[]
}

const trimSlash = (value: string) => value.replace(/\/+$/, '')

export const remoteControlUrl = (replicaUrl: string, databasePath: string): string =>
  `${trimSlash(replicaUrl)}/${basename(databasePath)}`

export const remoteProjectUrl = (replicaUrl: string, id: string): string =>
  `${trimSlash(replicaUrl)}/projects/${projectFolder(id)}/bunwrite.sqlite`

function projectIds(databasePath: string, log: (line: string) => void): string[] {
  if (!existsSync(databasePath)) return []
  try {
    // Open read-write: a WAL database needs a writable -shm file even for a
    // read-only query, and Litestream restores the database in WAL mode.
    const db = new Database(databasePath)
    try {
      const rows = db.query<{ id: string }, []>('SELECT id FROM _projects ORDER BY seq').all()
      return rows.map((row) => row.id)
    } finally {
      db.close()
    }
  } catch (error) {
    log(`failover: could not read projects from ${databasePath}: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

let restoreConfigCounter = 0

/**
 * Restore from a URL. AWS S3 works with the URL alone; R2/MinIO need an
 * endpoint, which Litestream only accepts through a config file. Generate a
 * one-entry config for that case, using the local path so the filename does
 * not need to exist in the main replication config (project DBs are discovered
 * by directory there).
 */
function spawnRestore(
  bin: string,
  output: string,
  localPath: string,
  remote: string,
  endpoint?: string,
  region?: string,
  forcePathStyle?: boolean,
): void {
  let tempConfig: string | undefined
  let args: string[]
  if (endpoint) {
    tempConfig = join(tmpdir(), `bunwrite-litestream-restore-${process.pid}-${restoreConfigCounter++}.yml`)
    const yaml = [
      'dbs:',
      `  - path: ${JSON.stringify(localPath)}`,
      '    replica:',
      `      url: ${JSON.stringify(remote)}`,
      `      endpoint: ${JSON.stringify(endpoint)}`,
      `      region: ${JSON.stringify(region || 'auto')}`,
      `      force-path-style: ${forcePathStyle ? 'true' : 'false'}`,
    ].join('\n')
    writeFileSync(tempConfig, `${yaml}\n`, { mode: 0o600 })
    args = ['restore', '-config', tempConfig, '-o', output, localPath]
  } else {
    args = ['restore', '-o', output, remote]
  }
  try {
    const result = Bun.spawnSync([bin, ...args], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr).trim()
      const stdout = new TextDecoder().decode(result.stdout).trim()
      throw new Error(stderr || stdout || `litestream restore exited ${result.exitCode}`)
    }
  } finally {
    if (tempConfig) rmSync(tempConfig, { force: true })
  }
}

function restoreOne(
  options: Required<Pick<FailoverOptions, 'allowEmpty' | 'force' | 'dryRun'>> & {
    bin: string
    endpoint?: string
    region?: string
    forcePathStyle?: boolean
    log: (line: string) => void
  },
  target: 'control' | 'project',
  path: string,
  remote: string,
  id?: string,
): RestoreOutcome {
  const outcome: RestoreOutcome = { target, id, path, remote, result: 'skipped' }
  const exists = existsSync(path)
  if (exists && !options.force) {
    options.log(`failover: ${target}${id ? ` ${id}` : ''} exists, skipping (${path})`)
    return outcome
  }
  if (options.dryRun) {
    options.log(`failover: would restore ${target}${id ? ` ${id}` : ''} from ${remote} to ${path}`)
    outcome.result = 'planned'
    return outcome
  }

  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.litestream-restore-${process.pid}-${Date.now()}`
  try {
    options.log(`failover: restoring ${target}${id ? ` ${id}` : ''} from ${remote}`)
    spawnRestore(options.bin, temp, path, remote, options.endpoint, options.region, options.forcePathStyle)
    if (exists) {
      const previous = `${path}.before-restore`
      rmSync(previous, { force: true })
      renameSync(path, previous)
    }
    // A WAL/SHM pair belongs to the old database; applying it to the restored
    // file can corrupt it. Remove it before putting the new file in place.
    for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${path}${suffix}`, { force: true })
    renameSync(temp, path)
    options.log(`failover: restored ${target}${id ? ` ${id}` : ''} to ${path}`)
    outcome.result = 'restored'
    return outcome
  } catch (error) {
    rmSync(temp, { force: true })
    if (options.allowEmpty) {
      options.log(
        `failover: no restore point for ${target}${id ? ` ${id}` : ''} (${remote}); continuing because allowEmpty is set`,
      )
      outcome.result = 'missing'
      return outcome
    }
    throw new Error(
      `failover: could not restore ${target}${id ? ` ${id}` : ''} from ${remote}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Restore the control database first, then every project listed by it. Reads
 * the current control database before a forced restore so a newer project list
 * is not lost when the restored control copy is slightly older.
 */
export function runFailover(options: FailoverOptions): FailoverResult {
  if (!options.replicaUrl) throw new Error('failover: LITESTREAM_REPLICA_URL or --from is required.')
  if (options.databasePath === ':memory:' || options.databasePath.startsWith('file::memory:')) {
    throw new Error('failover: cannot restore an in-memory database.')
  }

  const log = options.log ?? ((line: string) => console.log(line))
  const bin = options.litestreamBin ?? process.env.LITESTREAM_BIN ?? 'litestream'
  const endpoint = options.endpoint ?? (process.env.LITESTREAM_S3_ENDPOINT || undefined)
  const region = options.region ?? (process.env.LITESTREAM_S3_REGION || undefined)
  const forcePathStyle =
    options.forcePathStyle ?? ['1', 'true', 'yes', 'on'].includes((process.env.LITESTREAM_S3_FORCE_PATH_STYLE ?? '').toLowerCase())
  const allowEmpty = options.allowEmpty ?? false
  const force = options.force ?? false
  const dryRun = options.dryRun ?? false
  const dataDir = dataDirOf(options.databasePath)
  const outcomes: RestoreOutcome[] = []
  const before = projectIds(options.databasePath, log)

  const control = restoreOne(
    { allowEmpty, force, dryRun, bin, endpoint, region, forcePathStyle, log },
    'control',
    options.databasePath,
    remoteControlUrl(options.replicaUrl, options.databasePath),
  )
  outcomes.push(control)

  if (!existsSync(options.databasePath) && !dryRun) {
    // allowEmpty without a control database means this is a brand-new install.
    return { outcomes, projects: [] }
  }

  const after = projectIds(options.databasePath, log)
  const projects = [...new Set([...before, ...after])]
  for (const id of projects) {
    const path = projectPaths(dataDir, id).database
    outcomes.push(
      restoreOne(
        // A project listed by a restored control database should have a
        // restore point. Do not silently create an empty project if it does
        // not; --allow-empty is only for a brand-new control database.
        { allowEmpty: false, force, dryRun, bin, endpoint, region, forcePathStyle, log },
        'project',
        path,
        remoteProjectUrl(options.replicaUrl, id),
        id,
      ),
    )
  }
  return { outcomes, projects }
}
