import { dirname, resolve } from 'node:path'

import { createApp, createServices } from './app'
import { LeaderLease } from './cluster/leader'
import { isLeader } from './cluster/role'
import { configFromEnv } from './config'
import { openDb } from './db/connection'
import { bootstrapInstance, clearInstanceApiKey } from './instance/bootstrap'
import { setupSandbox } from './functions/sandbox'
import { createProjectManager } from './projects/manager'
import { pushConfig } from './schema/push'
import { applyAutotune, bodyLimitBytes } from './system/autotune'

export async function startServer(): Promise<void> {
  const tuning = applyAutotune()
  if (tuning) console.log(`[autotune] ${tuning.summary}`)

  // Before the database opens: with function isolation on, files are created private to the server.
  const sandbox = setupSandbox(process.env.DATABASE_PATH ?? './data/bunwrite.sqlite')
  if (sandbox) console.log('[functions] isolation on: each function builds and runs as its own user')

  const db = openDb(process.env.DATABASE_PATH ?? './data/bunwrite.sqlite', tuning?.sqliteCacheMb)
  const instance = bootstrapInstance(db)
  const config = configFromEnv()
  config.orgId = instance.orgId
  config.projectId = instance.projectId
  config.projectName = instance.projectName
  config.secret = instance.secret
  config.functionsSandbox = sandbox
  config.bootstrap = { orgId: instance.orgId, projectId: instance.projectId, apiKey: instance.apiKey, generated: instance.generated }
  if (config.workerIndex === 0 && (instance.generated || instance.created || instance.apiKey)) {
    console.log(`[bootstrap] instance credentials stored in the database${instance.generated ? ' (generated)' : ''}`)
    console.log(`[bootstrap] ORG_ID=${instance.orgId} PROJECT_ID=${instance.projectId}`)
    if (instance.apiKey) console.log(`[bootstrap] API key: ${instance.apiKey} (shown until the first admin is created)`)
  }
  if (instance.ignoredEnv.length) {
    console.warn(
      `[bootstrap] ignoring ${instance.ignoredEnv.join(', ')} from the environment: project settings now live in the database. Remove them from .env and manage them in the console.`,
    )
  }

  // One worker applies the config file; the others wait for the schema version
  // bump and reload their registries.
  if (config.schemaPath && config.schemaSyncOnStart && config.workerIndex === 0) {
    const schema = await Bun.file(config.schemaPath).json()
    pushConfig(db, schema, { log: (line) => console.log(`[schema] ${line}`), baseDir: dirname(resolve(config.schemaPath)) })
  }

  const services = createServices(config, db)
  const projects = createProjectManager({ config, db, services })

  // Take (or lose) the scheduler lease before anything is started, so the
  // timers already know whether this process should do the work.
  const lease = config.workers > 1 ? new LeaderLease(db) : null
  lease?.start()

  // First console admin from env, if given and not there yet.
  if (config.workerIndex === 0 && process.env.CONSOLE_ADMIN_EMAIL && process.env.CONSOLE_ADMIN_PASSWORD) {
    const { ConsoleAuth } = await import('./console/auth')
    const consoleAuth = new ConsoleAuth(db)
    if (!consoleAuth.list().some((a) => a.email === process.env.CONSOLE_ADMIN_EMAIL!.toLowerCase())) {
      await consoleAuth.upsert(process.env.CONSOLE_ADMIN_EMAIL, process.env.CONSOLE_ADMIN_PASSWORD)
      clearInstanceApiKey(db)
      if (config.bootstrap) config.bootstrap.apiKey = undefined
      console.log(`[console] admin ${process.env.CONSOLE_ADMIN_EMAIL} created`)
    }
  }
  const app = createApp(projects)

  // Clear out old transactions, tokens, sessions and request logs every 10 minutes.
  setInterval(() => {
    if (isLeader()) projects.prune()
  }, 10 * 60 * 1000).unref()
  projects.start()

  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    // Several processes bind this port; the kernel spreads connections.
    reusePort: config.workers > 1,
    fetch: app.fetch,
    websocket: app.websocket,
    maxRequestBodySize: tuning?.maxRequestBodyBytes ?? bodyLimitBytes(),
  })
  const worker = config.workers > 1 ? `[worker ${config.workerIndex + 1}/${config.workers}] ` : ''
  console.log(
    `${worker}bunwrite listening on :${server.port} (${services.registry.collections.size} collections)${config.consoleEnabled ? `, console at /console` : ''}`,
  )

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      lease?.stop()
      server.stop()
      services.requestLogs.flush()
      projects.close()
      db.sqlite.close()
      process.exit(0)
    })
  }
}
