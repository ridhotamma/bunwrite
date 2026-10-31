/**
 * Create a console admin, reset an admin's password, or clear email MFA:
 *   bun run console:admin you@example.com            (asks for the password)
 *   bun run console:admin you@example.com --no-mfa   (recovery when email is lost)
 *   bun run console:admin you@example.com --remove
 */
import { openDb } from '~/db/connection'
import { ConsoleAuth } from '~/console/auth'
import { clearInstanceApiKey } from '~/instance/bootstrap'

const [email, flag] = process.argv.slice(2)
if (!email) {
  console.error('Usage: bun run console:admin <email> [--no-mfa|--remove]')
  process.exit(1)
}
const db = openDb(process.env.DATABASE_PATH ?? './data/bunwrite.sqlite')
const auth = new ConsoleAuth(db)
if (flag === '--remove') {
  const admin = auth.list().find((a) => a.email === email.toLowerCase())
  if (!admin) throw new Error(`No admin ${email}`)
  auth.remove(admin.seq)
  console.log(`Removed ${email}`)
} else if (flag === '--no-mfa') {
  const admin = auth.list().find((a) => a.email === email.toLowerCase())
  if (!admin) throw new Error(`No admin ${email}`)
  auth.setMfa(admin.seq, false)
  console.log(`Email MFA is off for ${admin.email}. Sign in at /console.`)
} else {
  const password = process.env.CONSOLE_ADMIN_PASSWORD ?? prompt('Password (8+ characters):') ?? ''
  await auth.upsert(email, password)
  clearInstanceApiKey(db)
  console.log(`Admin ${email} saved. Sign in at /console.`)
}
db.sqlite.close()
