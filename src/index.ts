process.env.TZ = 'UTC'

import { dirname, resolve } from 'node:path'

import { createApp, createServices } from './app'
import { configFromEnv } from './config'
import { openDb } from './db/connection'
import { pushConfig } from './schema/push'

const config = configFromEnv()
const db = openDb(config.databasePath)

if (config.schemaPath && config.schemaSyncOnStart) {
  const schema = await Bun.file(config.schemaPath).json()
  pushConfig(db, schema, { log: (line) => console.log(`[schema] ${line}`), baseDir: dirname(resolve(config.schemaPath)) })
}

const services = createServices(config, db)

// First console admin from env, if given and not there yet.
if (process.env.CONSOLE_ADMIN_EMAIL && process.env.CONSOLE_ADMIN_PASSWORD) {
  const { ConsoleAuth } = await import('./console/auth')
  const consoleAuth = new ConsoleAuth(db)
  if (!consoleAuth.list().some((a) => a.email === process.env.CONSOLE_ADMIN_EMAIL!.toLowerCase())) {
    await consoleAuth.upsert(process.env.CONSOLE_ADMIN_EMAIL, process.env.CONSOLE_ADMIN_PASSWORD)
    console.log(`[console] admin ${process.env.CONSOLE_ADMIN_EMAIL} created`)
  }
}
const app = createApp(services)

// Clear out old transactions, tokens, sessions and request logs every 10 minutes.
setInterval(() => {
  services.transactions.prune()
  services.auth.pruneExpired()
  services.functions.prune()
  services.requestLogs.prune()
}, 10 * 60 * 1000).unref()
services.functions.start()
services.backups.start()

const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  fetch: app.fetch,
  websocket: app.websocket,
  maxRequestBodySize: 64 * 1024 * 1024,
})
console.log(`bunwrite listening on :${server.port} (${services.registry.collections.size} collections)${config.consoleEnabled ? `, console at /console` : ''}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.stop()
    services.requestLogs.flush()
    db.sqlite.close()
    process.exit(0)
  })
}
