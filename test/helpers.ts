process.env.TZ = 'UTC'

import { Account, Client, Databases, Functions, Storage, Teams, Users } from 'node-appwrite'

import { createApp, createServices, type Services } from '~/app'
import { MemoryMailer } from '~/mail/mailer'
import type { Config } from '~/config'
import { openDb, type Db } from '~/db/connection'
import { now } from '~/lib/datetime'
import { randomSecret, sha256, uniqueId } from '~/lib/ids'
import { pushConfig } from '~/schema/push'

export const PROJECT = 'test-project'
export const KEY = 'standard_testkey'
export const DB = 'main'

export const testSchema = {
  tablesDB: [{ $id: DB, name: 'Main', enabled: true }],
  tables: [
    {
      $id: 'products',
      databaseId: DB,
      name: 'Products',
      enabled: true,
      rowSecurity: true,
      $permissions: [],
      columns: [
        { key: 'tenantId', type: 'string', required: true, array: false, size: 36, default: null },
        { key: 'name', type: 'string', required: true, array: false, size: 255, default: null },
        { key: 'slug', type: 'string', required: false, array: false, size: 255, default: null },
        { key: 'sku', type: 'string', required: false, array: false, size: 64, default: null },
        { key: 'tags', type: 'string', required: false, array: true, size: 64, default: null },
        { key: 'price', type: 'integer', required: false, array: false, min: 0, max: 9007199254740991, default: 0 },
        { key: 'rating', type: 'double', required: false, array: false, default: null },
        { key: 'active', type: 'boolean', required: false, array: false, default: true },
        { key: 'publishedAt', type: 'datetime', required: false, array: false, format: '', default: null },
        { key: 'status', type: 'string', format: 'enum', elements: ['active', 'draft'], required: false, array: false, size: 6, default: 'draft' },
      ],
      indexes: [
        { key: 'idx_tenant_slug', type: 'unique', columns: ['tenantId', 'slug'], orders: ['ASC', 'ASC'] },
        { key: 'idx_name', type: 'fulltext', columns: ['name'], orders: ['ASC'] },
        { key: 'idx_price', type: 'key', columns: ['price'], orders: ['ASC'] },
      ],
    },
    {
      $id: 'notes',
      databaseId: DB,
      name: 'Notes',
      enabled: true,
      rowSecurity: true,
      $permissions: ['create("users")'],
      columns: [{ key: 'text', type: 'string', required: false, array: false, size: 1000, default: null }],
      indexes: [],
    },
    {
      $id: 'locked',
      databaseId: DB,
      name: 'Locked',
      enabled: true,
      rowSecurity: false,
      $permissions: [],
      columns: [{ key: 'value', type: 'integer', required: false, array: false, default: null }],
      indexes: [],
    },
  ],
}

export interface TestServer {
  endpoint: string
  services: Services
  db: Db
  mailer: MemoryMailer
  config: Config
  stop(): void
}

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    // The suite checks Appwrite compatibility through Appwrite's SDKs; test/compat.test.ts covers Bunwrite's names.
    apiCompat: 'appwrite',
    hostname: '127.0.0.1',
    databasePath: ':memory:',
    orgId: 'org_test',
    projectId: PROJECT,
    projectName: 'Test Project',
    apiKeys: [KEY],
    secret: 'x'.repeat(40),
    allowedOrigins: ['*.example.com', 'localhost'],
    publicEndpoint: 'http://localhost/v1',
    sitesDomain: 'sites.localhost',
    functionsDomain: 'functions.localhost',
    sitesPrefix: 'sites',
    functionsPrefix: 'functions',
    sitesBuildCommands: true,
    sitesSsr: true,
    sitesSsrIdleMs: 5 * 60 * 1000,
    sitesSsrMaxProcesses: 2,
    sitesSsrKeepPrevious: 2,
    sessionDuration: 31536000,
    sessionsLimit: 10,
    smtp: null,
    google: null,
    storagePath: '',
    skipSchedules: [],
    functionsDir: process.cwd(),
    functionsBuildCommands: true,
    consoleEnabled: true,
    schemaSyncOnStart: false,
    logRequests: false,
    logFormat: 'text',
    logRetentionDays: 7,
    logIp: true,
    s3: { enabled: false, bucket: '', region: '', endpoint: '', accessKey: '', secret: '', forcePathStyle: false },
    storagePrefix: '',
    backupsPrefix: '',
    backups: {
      enabled: false,
      keep: 7,
      s3: { enabled: false, bucket: '', region: '', endpoint: '', accessKey: '', secret: '', forcePathStyle: false },
    },
    backupsPath: './data/test-backups',
    render: { enabled: false, allowRemote: false },
    cache: { fileMaxAge: 3888000, previewMaxAge: 2592000, previewRetentionDays: 30 },
    compression: true,
    ...over,
  }
}

export function startServer(schema: unknown = testSchema, over: Partial<Config> = {}, baseDir?: string): TestServer {
  const db = openDb(':memory:')
  pushConfig(db, schema, { baseDir })
  const mailer = new MemoryMailer()
  const config = testConfig(over)
  const services = createServices(config, db, { mailer })
  const app = createApp(services)
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.websocket })
  config.publicEndpoint = `http://localhost:${server.port}/v1`
  config.port = server.port!
  return {
    endpoint: `http://localhost:${server.port}/v1`,
    services,
    db,
    mailer,
    config,
    stop: () => server.stop(true),
  }
}

const services = (client: Client) => ({
  client,
  databases: new Databases(client) as any,
  account: new Account(client) as any,
  users: new Users(client) as any,
  teams: new Teams(client) as any,
  storage: new Storage(client) as any,
  functions: new Functions(client) as any,
})

export function adminClient(endpoint: string) {
  return services(new Client().setEndpoint(endpoint).setProject(PROJECT).setKey(KEY))
}

export function sessionClient(endpoint: string, secret?: string) {
  const client = new Client().setEndpoint(endpoint).setProject(PROJECT)
  if (secret) client.setSession(secret)
  return services(client)
}

export function jwtClient(endpoint: string, jwt: string) {
  return services(new Client().setEndpoint(endpoint).setProject(PROJECT).setJWT(jwt))
}

/** Insert a user with a live session; returns the session secret. */
export function makeUser(db: Db, id = uniqueId(), opts: { verified?: boolean; labels?: string[] } = {}): { id: string; secret: string } {
  const stamp = now()
  db.sqlite
    .query(
      `INSERT INTO _users (id, name, email, registration, labels, email_verification, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, `User ${id}`, `${id}@example.com`, stamp, JSON.stringify(opts.labels ?? []), opts.verified ? 1 : 0, stamp, stamp)
  const secret = randomSecret()
  db.sqlite
    .query(
      `INSERT INTO _sessions (id, user_id, secret_hash, provider, expire, created_at, updated_at)
       VALUES (?, ?, ?, 'email', '9999-01-01T00:00:00.000+00:00', ?, ?)`,
    )
    .run(uniqueId(), id, sha256(secret), stamp, stamp)
  return { id, secret }
}

export function addMembership(db: Db, teamId: string, userId: string, roles: string[] = []): void {
  const stamp = now()
  db.sqlite.query('INSERT OR IGNORE INTO _teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(teamId, teamId, stamp, stamp)
  db.sqlite
    .query(
      `INSERT INTO _memberships (id, team_id, user_id, roles, invited, joined, confirm, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(uniqueId(), teamId, userId, JSON.stringify(roles), stamp, stamp, stamp, stamp)
}

/** Await a promise that should reject with an AppwriteException; return its shape. */
export async function failure(promise: Promise<unknown>): Promise<{ code: number; type: string; message: string }> {
  try {
    await promise
  } catch (error: any) {
    return { code: error.code, type: error.type, message: error.message }
  }
  throw new Error('Expected the call to fail, but it succeeded')
}
