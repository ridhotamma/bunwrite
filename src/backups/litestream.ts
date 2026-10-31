/**
 * Read-only view of the Litestream deployment settings.
 *
 * Litestream runs outside the app: the container entrypoint (or the systemd
 * wrapper) starts `litestream replicate -exec bunwrite serve`, and
 * `bunwrite failover` restores missing databases before the app opens SQLite.
 * Everything is environment-level, so the console can only report what the
 * process inherited. It cannot start, stop or monitor the replicator.
 */
export interface LitestreamStatus {
  configured: boolean
  /** Replica URL with any credentials removed. */
  replica?: string
  syncInterval: string
  heartbeat: boolean
  hasEndpoint: boolean
  allowEmpty: boolean
  forceRestore: boolean
}

function maskReplica(value: string): string {
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

export function litestreamStatus(env: Record<string, string | undefined> = process.env): LitestreamStatus {
  const replica = (env.LITESTREAM_REPLICA_URL ?? '').trim()
  const flag = (name: string) => ['1', 'true', 'yes', 'on'].includes((env[name] ?? '').toLowerCase())
  return {
    configured: Boolean(replica),
    replica: replica ? maskReplica(replica) : undefined,
    syncInterval: (env.LITESTREAM_SYNC_INTERVAL ?? '1s').trim() || '1s',
    heartbeat: Boolean((env.LITESTREAM_HEARTBEAT_URL ?? '').trim()),
    hasEndpoint: Boolean((env.LITESTREAM_S3_ENDPOINT ?? '').trim()),
    allowEmpty: flag('LITESTREAM_ALLOW_EMPTY'),
    forceRestore: flag('LITESTREAM_FORCE_RESTORE'),
  }
}
