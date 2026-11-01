/**
 * Read-only view of a WAL-G deployment for Postgres.
 *
 * WAL-G runs next to PostgreSQL: it archives WAL segments through
 * `archive_command`, takes base backups with `wal-g backup-push`, and fetches
 * them during recovery. Bunwrite does not own the Postgres data directory, so
 * it cannot start or stop WAL-G; the console reports the environment the
 * process inherited and shows the commands the Postgres host must run.
 */
export interface WalgStatus {
  configured: boolean
  /** Storage prefix with credentials removed. */
  storage?: string
  /** Compression method WAL-G will use, if set. */
  compression?: string
  /** Whether WAL-G encryption is configured. */
  encrypted: boolean
  /** The archive_command an operator should put in postgresql.conf. */
  archiveCommand: string
  /** The restore_command an operator should put in postgresql.conf. */
  restoreCommand: string
}

const PREFIX_VARS = ['WALG_S3_PREFIX', 'WALG_GS_PREFIX', 'WALG_AZ_PREFIX', 'WALG_SWIFT_PREFIX', 'WALG_FILE_PREFIX'] as const

/** Hide credentials in a storage URL before it reaches the console. */
export function maskStorage(value: string): string {
  try {
    const url = new URL(value)
    if (url.username || url.password) {
      url.username = '***'
      url.password = ''
    }
    return url.toString()
  } catch {
    return value.replace(/\/\/[^@/]+@/, '//***@')
  }
}

export function walgStatus(env: Record<string, string | undefined> = process.env): WalgStatus {
  const prefix = PREFIX_VARS.map((name) => (env[name] ?? '').trim()).find(Boolean) ?? ''
  const compression = (env.WALG_COMPRESSION_METHOD ?? '').trim() || undefined
  return {
    configured: Boolean(prefix),
    storage: prefix ? maskStorage(prefix) : undefined,
    compression,
    encrypted: Boolean(
      (env.WALG_LIBSODIUM_KEY ?? '').trim() ||
        (env.WALG_LIBSODIUM_KEY_PATH ?? '').trim() ||
        (env.WALG_PGP_KEY ?? '').trim() ||
        (env.WALG_PGP_KEY_PATH ?? '').trim()
    ),
    archiveCommand: 'wal-g wal-push %p',
    restoreCommand: 'wal-g wal-fetch %f %p',
  }
}
