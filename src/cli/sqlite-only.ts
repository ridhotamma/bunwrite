/** Commands that copy local SQLite files must not run against Postgres. */
export function requireSqliteCommand(command: string, env: Record<string, string | undefined> = process.env): void {
  const driver = (env.DB_DRIVER || env.DATABASE_DRIVER || '').trim().toLowerCase()
  if (driver === 'postgres' || driver === 'postgresql' || driver === 'pg') {
    console.error(
      `${command}: this command only works with local SQLite databases, not DB_DRIVER=${driver}. ` +
        `Use Organization -> Backups for Postgres dumps, or your provider's managed PITR.`,
    )
    process.exit(1)
  }
}
