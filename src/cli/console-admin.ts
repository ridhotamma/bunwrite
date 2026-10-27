/**
 * Create a console admin or reset an admin's password:
 *   bun run console:admin you@example.com            (asks for the password)
 *   bun run console:admin you@example.com --remove
 */
import { openDb } from '~/db/connection'
import { ConsoleAuth } from '~/console/auth'

const [email, flag] = process.argv.slice(2)
if (!email) {
  console.error('Usage: bun run console:admin <email> [--remove]')
  process.exit(1)
}
const db = openDb(process.env.DATABASE_PATH ?? './data/bunwrite.sqlite')
const auth = new ConsoleAuth(db)
if (flag === '--remove') {
  const admin = auth.list().find((a) => a.email === email.toLowerCase())
  if (!admin) throw new Error(`No admin ${email}`)
  auth.remove(admin.seq)
  console.log(`Removed ${email}`)
} else {
  const password = process.env.CONSOLE_ADMIN_PASSWORD ?? prompt('Password (8+ characters):') ?? ''
  await auth.upsert(email, password)
  console.log(`Admin ${email} saved. Sign in at /console.`)
}
db.sqlite.close()
