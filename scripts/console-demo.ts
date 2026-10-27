/**
 * Local demo of the console: a throwaway database in data/demo with the
 * example schema and a little sample data.
 *   bun run demo
 * Sign in as demo@bunwrite.test / demo-password.
 */
import { existsSync } from 'node:fs'
import { Client, Databases, ID, Permission, Role, Storage, Teams, Users } from 'node-appwrite'

const dir = new URL('../data/demo/', import.meta.url).pathname
const schema = new URL('../examples/appwrite.config.json', import.meta.url).pathname
const port = process.env.DEMO_PORT ?? '8790'
const fresh = !existsSync(`${dir}bunwrite.sqlite`)

// Bun loads .env files from where it starts; keep real SMTP/Google/keys out of the demo.
for (const key of Object.keys(process.env)) {
  if (/^(SMTP_|GOOGLE_|API_KEYS|SECRET|PROJECT_|APPWRITE_|CONSOLE_|FUNCTIONS_|STORAGE_|SCHEMA_|S3_|BACKUPS_|LOG_)/.test(key)) delete process.env[key]
}

Object.assign(process.env, {
  PROJECT_ID: 'demo-project',
  API_KEYS: 'demo-key',
  SECRET: 'demo-secret-demo-secret-demo-secret-0000',
  PORT: port,
  DATABASE_PATH: `${dir}bunwrite.sqlite`,
  STORAGE_PATH: `${dir}storage`,
  PUBLIC_ENDPOINT: `http://localhost:${port}/v1`,
  ALLOWED_ORIGINS: 'localhost',
  CONSOLE_ADMIN_EMAIL: 'demo@bunwrite.test',
  CONSOLE_ADMIN_PASSWORD: 'demo-password',
  ...(existsSync(schema) ? { SCHEMA_PATH: schema, SCHEMA_SYNC_ON_START: fresh ? 'true' : 'false' } : {}),
})

await import('~/index')

if (fresh && existsSync(schema)) {
  const client = new Client().setEndpoint(process.env.PUBLIC_ENDPOINT!).setProject('demo-project').setKey('demo-key')
  const users = new Users(client)
  const teams = new Teams(client)
  const db = new Databases(client)

  for (const [name, email] of [
    ['Siti Rahma', 'siti@example.com'],
    ['Budi Santoso', 'budi@example.com'],
    ['Ayu Lestari', 'ayu@example.com'],
  ] as const) {
    await users.create({ userId: ID.unique(), email, name, password: 'password-123' })
  }

  const owner = (await users.list()).users[0]!
  const team = await teams.create({ teamId: ID.unique(), name: 'Demo team' })
  await teams.createMembership({ teamId: team.$id, userId: owner.$id, roles: ['owner'] })

  const items = [
    ['Canvas Tote', 'canvas-tote', 18],
    ['Ceramic Mug', 'ceramic-mug', 14],
    ['Linen Notebook', 'linen-notebook', 22],
    ['Desk Plant', 'desk-plant', 27],
  ] as const
  for (const [name, slug, price] of items) {
    await db.createDocument({
      databaseId: 'main',
      collectionId: 'products',
      documentId: ID.unique(),
      data: {
        name,
        slug,
        price,
        status: price > 20 ? 'active' : 'draft',
        tags: price > 20 ? ['home'] : ['paper'],
        publishedAt: price > 20 ? new Date().toISOString() : null,
      },
      permissions: [Permission.read(Role.any())],
    })
  }

  const png = await (await import('sharp')).default({
    create: { width: 800, height: 500, channels: 3, background: '#dbeafe' },
  }).png().toBuffer()
  await new Storage(client).createFile({
    bucketId: 'media',
    fileId: ID.unique(),
    file: new File([png], 'cover.png', { type: 'image/png' }),
    permissions: [Permission.read(Role.any())],
  })
  console.log('[demo] seeded sample data')
}

console.log(`[demo] console: http://localhost:${port}/console  (demo@bunwrite.test / demo-password)`)
