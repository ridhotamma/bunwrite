/**
 * Create a console admin, reset an admin's password, or clear email MFA:
 *   bun run console:admin you@example.com            (asks for the password)
 *   bun run console:admin you@example.com --no-mfa   (recovery when email is lost)
 *   bun run console:admin you@example.com --remove
 *
 * Reads the same DB_DRIVER/DATABASE_URL environment as the server, so it works
 * on a Postgres deployment too.
 */
import { configFromEnv } from '~/config'
import { ConsoleAuth } from '~/console/auth'
import { databaseOptionsOf, openDatabase, sqlDatabaseOf } from '~/db'
import { clearInstanceApiKey, clearInstanceApiKeyAsync } from '~/instance/bootstrap'

const [email, flag] = process.argv.slice(2)
if (!email) {
  console.error('Usage: bun run console:admin <email> [--no-mfa|--remove]')
  process.exit(1)
}
const database = await openDatabase(databaseOptionsOf(configFromEnv()))
const db = sqlDatabaseOf(database)
const auth = new ConsoleAuth(db)
if (flag === '--remove') {
  const admin = (await auth.list()).find((a) => a.email === email.toLowerCase())
  if (!admin) throw new Error(`No admin ${email}`)
  await auth.remove(admin.seq)
  console.log(`Removed ${email}`)
} else if (flag === '--no-mfa') {
  const admin = (await auth.list()).find((a) => a.email === email.toLowerCase())
  if (!admin) throw new Error(`No admin ${email}`)
  await auth.setMfa(admin.seq, false)
  console.log(`Email MFA is off for ${admin.email}. Sign in at /console.`)
} else {
  const password = process.env.CONSOLE_ADMIN_PASSWORD ?? prompt('Password (8+ characters):') ?? ''
  await auth.upsert(email, password)
  if (db.dialect === 'sqlite') clearInstanceApiKey(db)
  else await clearInstanceApiKeyAsync(db)
  console.log(`Admin ${email} saved. Sign in at /console.`)
}
await database.close()
