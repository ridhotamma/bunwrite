process.env.TZ = 'UTC'

import { dirname, resolve } from 'node:path'

import { createApp, createServices } from './app'
import { configFromEnv } from './config'
import { openDb } from './db/connection'
import { bootstrapInstance, clearInstanceApiKey } from './instance/bootstrap'
import { createProjectManager } from './projects/manager'
import { pushConfig } from './schema/push'
import { applyAutotune, bodyLimitBytes } from './system/autotune'

const tuning = applyAutotune()
if (tuning) console.log(`[autotune] ${tuning.summary}`)

const db = openDb(process.env.DATABASE_PATH ?? './data/bunwrite.sqlite', tuning?.sqliteCacheMb)
const instance = bootstrapInstance(db)
const config = configFromEnv(instance.env)
config.orgId = instance.orgId
config.bootstrap = { orgId: instance.orgId, projectId: instance.projectId, apiKey: instance.apiKey, generated: instance.generated }
if (instance.generated || instance.created || instance.apiKey) {
  console.log(`[bootstrap] instance credentials stored in the database${instance.generated ? ' (generated)' : ''}`)
  console.log(`[bootstrap] ORG_ID=${instance.orgId} PROJECT_ID=${instance.projectId}`)
  if (instance.apiKey) console.log(`[bootstrap] API key: ${instance.apiKey} (shown until the first admin is created)`)
  console.log('[bootstrap] Set ORG_ID, PROJECT_ID, SECRET or API_KEYS to override the stored values.')
}

if (config.schemaPath && config.schemaSyncOnStart) {
  const schema = await Bun.file(config.schemaPath).json()
  pushConfig(db, schema, { log: (line) => console.log(`[schema] ${line}`), baseDir: dirname(resolve(config.schemaPath)) })
}

const services = createServices(config, db)
const projects = createProjectManager({ config, db, services })

// First console admin from env, if given and not there yet.
if (process.env.CONSOLE_ADMIN_EMAIL && process.env.CONSOLE_ADMIN_PASSWORD) {
  const { ConsoleAuth } = await import('./console/auth')
  const consoleAuth = new ConsoleAuth(db)
  if (!consoleAuth.list().some((a) => a.email === process.env.CONSOLE_ADMIN_EMAIL!.toLowerCase())) {
    await consoleAuth.upsert(process.env.CONSOLE_ADMIN_EMAIL, process.env.CONSOLE_ADMIN_PASSWORD)
    const bootstrapKey = config.bootstrap?.apiKey
    clearInstanceApiKey(db)
    if (bootstrapKey) config.apiKeys = config.apiKeys.filter((key) => key !== bootstrapKey)
    if (config.bootstrap) config.bootstrap.apiKey = undefined
    console.log(`[console] admin ${process.env.CONSOLE_ADMIN_EMAIL} created`)
  }
}
const app = createApp(projects)

// Clear out old transactions, tokens, sessions and request logs every 10 minutes.
setInterval(() => projects.prune(), 10 * 60 * 1000).unref()
projects.start()

const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  fetch: app.fetch,
  websocket: app.websocket,
  maxRequestBodySize: tuning?.maxRequestBodyBytes ?? bodyLimitBytes(),
})
console.log(`bunwrite listening on :${server.port} (${services.registry.collections.size} collections)${config.consoleEnabled ? `, console at /console` : ''}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.stop()
    services.requestLogs.flush()
    projects.close()
    db.sqlite.close()
    process.exit(0)
  })
}
