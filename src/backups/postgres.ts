/**
 * Postgres logical backups.
 *
 * Bunwrite does not own the Postgres data directory, so a backup is a logical
 * dump made with `pg_dump` rather than a file swap. The backup service runs
 * this on the same console cron schedule as the SQLite archives, stores the
 * dump in BACKUPS_PATH, and uploads it when backup S3 storage is enabled.
 *
 * `bunwrite backup:open` decompresses and decrypts a downloaded dump, then
 * `pg_restore` loads it into the database.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { checkKey, packBackup } from './format'

export const DUMP_COMPRESSED_EXT = '.dump.zst'
export const DUMP_ENCRYPTED_EXT = '.dump.zst.enc'

export interface PostgresDump {
  name: string
  path: string
  size: number
}

export interface CommandResult {
  code: number
  stderr: string
}

export type CommandRunner = (command: string[], env: Record<string, string | undefined>) => Promise<CommandResult>

export interface CreatePostgresDumpOptions {
  databaseUrl: string
  /** Folder that receives the dump. Created when missing. */
  outputDir: string
  /** File-name prefix, for example `backup-` or `auto-`. */
  prefix?: string
  secret?: string
  log?: (line: string) => void
  /** pg_dump executable; defaults to PG_DUMP_BIN or `pg_dump` on PATH. */
  binary?: string
  run?: CommandRunner
  now?: Date
}

/**
 * Split a Postgres URL into the connection string pg_dump may see and the
 * password it must not. pg_dump reads PGPASSWORD from the environment, so the
 * secret stays out of the process list.
 */
export function postgresConnection(databaseUrl: string): { database: string; password?: string } {
  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch {
    throw new Error('DATABASE_URL is not a valid Postgres connection URL.')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must start with postgres:// or postgresql://.')
  }
  const password = url.password ? decodeURIComponent(url.password) : undefined
  url.password = ''
  return { database: url.toString(), password }
}

export function pgDumpArgs(binary: string, database: string, file: string): string[] {
  return [binary, '--format=custom', '--no-owner', '--no-privileges', '--no-password', `--file=${file}`, `--dbname=${database}`]
}

const defaultRunner: CommandRunner = async (command, env) => {
  const proc = Bun.spawn(command, { env: env as Record<string, string>, stdout: 'ignore', stderr: 'pipe' })
  const stderr = await new Response(proc.stderr).text()
  return { code: await proc.exited, stderr }
}

function resolveBinary(binary: string | undefined): string {
  const name = (binary ?? process.env.PG_DUMP_BIN ?? 'pg_dump').trim()
  if (!name) throw new Error('pg_dump is not configured.')
  if (name.includes('/') || name.includes('\\')) {
    if (!existsSync(name)) throw new Error(`pg_dump was not found at ${name}.`)
    return name
  }
  const found = Bun.which(name, { PATH: process.env.PATH ?? '' })
  if (!found) throw new Error('pg_dump was not found. Install the PostgreSQL client tools on this server.')
  return found
}

/** Dump the whole Postgres database and store it as one compressed backup file. */
export async function createPostgresBackup(options: CreatePostgresDumpOptions): Promise<PostgresDump> {
  if (!options.databaseUrl) throw new Error('DATABASE_URL is required to back up Postgres.')
  if (options.secret) checkKey(options.secret)
  const { database, password } = postgresConnection(options.databaseUrl)
  const binary = resolveBinary(options.binary)
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const name = `${options.prefix ?? 'backup-'}${stamp}${options.secret ? DUMP_ENCRYPTED_EXT : DUMP_COMPRESSED_EXT}`
  mkdirSync(options.outputDir, { recursive: true })
  const output = join(options.outputDir, name)
  const dump = join(options.outputDir, `.pgdump-${process.pid}-${Date.now()}.dump`)
  try {
    options.log?.('backup: dumping Postgres')
    const env = { ...process.env }
    if (password) env.PGPASSWORD = password
    const result = await (options.run ?? defaultRunner)(pgDumpArgs(binary, database, dump), env)
    if (result.code !== 0) {
      const detail = result.stderr.trim().slice(0, 2000)
      throw new Error(`pg_dump exited ${result.code}${detail ? `: ${detail}` : '.'}`)
    }
    chmodSync(dump, 0o600)
    await packBackup(dump, output, options.secret)
    return { name, path: output, size: statSync(output).size }
  } catch (error) {
    rmSync(output, { force: true })
    throw error
  } finally {
    rmSync(dump, { force: true })
  }
}
