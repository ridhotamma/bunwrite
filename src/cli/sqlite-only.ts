/** Commands that copy local SQLite files must not run against Postgres. */
export function requireSqliteCommand(command: string, env: Record<string, string | undefined> = process.env): void {
  const driver = (env.DB_DRIVER || env.DATABASE_DRIVER || '').trim().toLowerCase()
  if (driver === 'postgres' || driver === 'postgresql' || driver === 'pg') {
    console.error(
      `${command}: local SQLite archives are not available with DB_DRIVER=${driver}. ` +
        `Use WAL-G (wal-g backup-push / wal-g wal-push) or your provider's managed PITR for Postgres.`,
    )
    process.exit(1)
  }
}
