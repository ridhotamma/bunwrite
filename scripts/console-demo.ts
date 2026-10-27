/**
 * Local demo of the console: a throwaway database in data/demo with Pesanle's
 * schema and a little sample data. Sign in as demo@pesanle.test / demo-password.
 *   bun scripts/console-demo.ts
 */
import { existsSync } from 'node:fs'
import { Client, Databases, ID, Permission, Role, Storage, Teams, Users } from 'node-appwrite'

const dir = new URL('../data/demo/', import.meta.url).pathname
const schema = new URL('../../pesanle/packages/appwrite-config/appwrite.config.json', import.meta.url).pathname
const fresh = !existsSync(`${dir}pesanle.sqlite`)

// Bun loads .env files from where it starts; keep real SMTP/Google/keys out of the demo.
for (const key of Object.keys(process.env)) {
  if (/^(SMTP_|GOOGLE_|API_KEYS|SECRET|PROJECT_|APPWRITE_|CONSOLE_|FUNCTIONS_|STORAGE_|SCHEMA_)/.test(key)) delete process.env[key]
}

Object.assign(process.env, {
  PROJECT_ID: 'demo-project',
  API_KEYS: 'demo-key',
  SECRET: 'demo-secret-demo-secret-demo-secret-0000',
  PORT: process.env.PORT ?? '8790',
  DATABASE_PATH: `${dir}pesanle.sqlite`,
  STORAGE_PATH: `${dir}storage`,
  PUBLIC_ENDPOINT: `http://localhost:${process.env.PORT ?? '8790'}/v1`,
  ALLOWED_ORIGINS: 'localhost,*.pesanle.com',
  CONSOLE_ADMIN_EMAIL: 'demo@pesanle.test',
  CONSOLE_ADMIN_PASSWORD: 'demo-password',
  FUNCTIONS_SKIP_SCHEDULES: 'render,followup,invoice-reminders,backup,prune-store-events,expire-orders,stock-health,prune-orphaned-media',
  ...(existsSync(schema) ? { SCHEMA_PATH: schema, SCHEMA_SYNC_ON_START: fresh ? 'true' : 'false' } : {}),
})

await import('../src/index.ts')

if (fresh && existsSync(schema)) {
  const client = new Client().setEndpoint(process.env.PUBLIC_ENDPOINT!).setProject('demo-project').setKey('demo-key')
  const users = new Users(client)
  const teams = new Teams(client)
  const db = new Databases(client)
  const DB = '6ab3c61500311ebcfc08'
  for (const [name, email] of [['Siti Rahma', 'siti@example.com'], ['Budi Santoso', 'budi@example.com'], ['Ayu Lestari', 'ayu@example.com']] as const) {
    await users.create({ userId: ID.unique(), email, name, password: 'password-123' })
  }
  const owner = (await users.list()).users[0]!
  const team = await teams.create({ teamId: ID.unique(), name: 'Toko Siti (toko-siti)' })
  await teams.createMembership({ teamId: team.$id, userId: owner.$id, roles: ['owner'] })
  const items = ['Kaos Polos Hitam', 'Kemeja Flanel', 'Celana Chino', 'Sepatu Kanvas', 'Topi Baseball', 'Tas Ransel', 'Jaket Denim', 'Kaos Kaki']
  for (const [i, name] of items.entries()) {
    await db.createDocument({
      databaseId: DB,
      collectionId: 'products',
      documentId: ID.unique(),
      data: { tenantId: 'demo-tenant', name, slug: name.toLowerCase().replace(/\s+/g, '-'), status: i % 3 ? 'active' : 'draft', sellPrice: 50000 + i * 25000, stockTotal: 10 * i },
      permissions: [Permission.read(Role.team(team.$id))],
    })
  }
  const png = await (await import('sharp')).default({ create: { width: 400, height: 300, channels: 3, background: '#e3e3e3' } }).png().toBuffer()
  await new Storage(client).createFile({ bucketId: '6ab3c61f00236fad8559', fileId: ID.unique(), file: new File([png], 'banner.png', { type: 'image/png' }), permissions: [Permission.read(Role.any())] })
  console.log('[demo] seeded sample data')
}
console.log('[demo] console: http://localhost:' + process.env.PORT + '/console  (demo@pesanle.test / demo-password)')
