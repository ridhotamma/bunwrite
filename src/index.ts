process.env.TZ = 'UTC'

import { dirname, resolve } from 'node:path'

import { createApp, createServices } from './app'
import { configFromEnv } from './config'
import { openDb } from './db/connection'
import { pushConfig } from './schema/push'

const config = configFromEnv()
const db = openDb(config.databasePath)

if (config.schemaPath) {
  const schema = await Bun.file(config.schemaPath).json()
  pushConfig(db, schema, { log: (line) => console.log(`[schema] ${line}`), baseDir: dirname(resolve(config.schemaPath)) })
}

const services = createServices(config, db)
const app = createApp(services)

// Clear out old transactions, tokens and sessions every 10 minutes.
setInterval(() => {
  services.transactions.prune()
  services.auth.pruneExpired()
  services.functions.prune()
}, 10 * 60 * 1000).unref()
services.functions.start()

const server = Bun.serve({ port: config.port, fetch: app.fetch, websocket: app.websocket, maxRequestBodySize: 64 * 1024 * 1024 })
console.log(`pesanle-backend listening on :${server.port} (${services.registry.collections.size} collections)`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.stop()
    db.sqlite.close()
    process.exit(0)
  })
}
