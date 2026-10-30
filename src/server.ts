import { dirname, resolve } from 'node:path'

import { createApp, createServices } from './app'
import { workerPort } from './cluster/config'
import { LeaderLease } from './cluster/leader'
import { isLeader } from './cluster/role'
import { isWriterWorker } from './cluster/writer'
import { configFromEnv } from './config'
import { openDb } from './db/connection'
import { withInflightLimit } from './http/load-shed'
import { bootstrapInstance, clearInstanceApiKey } from './instance/bootstrap'
import { setupSandbox } from './functions/sandbox'
import { createProjectManager } from './projects/manager'
import { pushConfig } from './schema/push'
import { applyAutotune, bodyLimitBytes } from './system/autotune'

export async function startServer(): Promise<void> {
  const tuning = applyAutotune()
  if (tuning) console.log(`[autotune] ${tuning.summary}`)

  const config = configFromEnv()
  // In a cluster, index 0 is a writer that never accepts public traffic. That
  // keeps a synchronous SQLite checkpoint or lock wait out of the request path.
  const dedicatedWriter = config.workers > 1 && config.writerPort > 0
  const writer = dedicatedWriter && isWriterWorker(config)
  const databasePath = config.databasePath
  const busyTimeoutMs = dedicatedWriter && !writer ? config.readerBusyTimeoutMs : config.busyTimeoutMs

  // Before the database opens: with function isolation on, files are created private to the server.
  const sandbox = setupSandbox(databasePath)
  if (sandbox) console.log('[functions] isolation on: each function builds and runs as its own user')

  const db = openDb(databasePath, tuning?.sqliteCacheMb, undefined, undefined, busyTimeoutMs)
  const instance = bootstrapInstance(db)
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
    if (!consoleAuth.list().some((admin) => admin.email === process.env.CONSOLE_ADMIN_EMAIL!.toLowerCase())) {
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

  // In a cluster, worker 0 also accepts database writes on a loopback port.
  // The other workers run in the same network namespace and forward to it, so
  // one process owns SQLite's write connection. It does not accept public
  // traffic, so a blocking checkpoint cannot stall client connections.
  let writes: ReturnType<typeof Bun.serve> | null = null
  if (dedicatedWriter && writer && config.writerPort > 0) {
    try {
      writes = Bun.serve({
        hostname: config.writerHost,
        port: config.writerPort,
        fetch: withInflightLimit(app.fetch, config.maxInflight),
        websocket: app.websocket,
        maxRequestBodySize: tuning?.maxRequestBodyBytes ?? bodyLimitBytes(),
        idleTimeout: config.httpIdleTimeout,
      })
    } catch (error) {
      console.error(
        `[cluster] write listener ${config.writerHost}:${config.writerPort} failed to start; workers will write locally:`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  // The writer in a cluster only serves the loopback write listener.
  const servesPublic = !dedicatedWriter || !writer
  const publicLimit =
    config.maxInflight > 0 ? Math.max(1, Math.ceil(config.maxInflight / Math.max(1, config.publicWorkers))) : 0
  const server = servesPublic
    ? Bun.serve({
        hostname: config.hostname,
        port: workerPort(config.port, config.workerIndex, config.workerPorts, dedicatedWriter ? 1 : 0),
        // Several processes bind this port; the kernel spreads connections.
        // With WORKER_PORTS each process has its own port for the proxy instead.
        reusePort: config.workers > 1 && !config.workerPorts,
        fetch: withInflightLimit(app.fetch, publicLimit),
        websocket: app.websocket,
        maxRequestBodySize: tuning?.maxRequestBodyBytes ?? bodyLimitBytes(),
        idleTimeout: config.httpIdleTimeout,
      })
    : null

  const label = config.workers > 1 ? `[${writer ? 'writer' : `worker ${config.workerIndex}/${config.publicWorkers}`}] ` : ''
  if (server) {
    console.log(
      `${label}bunwrite listening on :${server.port} (${services.registry.collections.size} collections)${config.consoleEnabled ? ', console at /console' : ''}`,
    )
  }
  if (writes) console.log(`${label}database writes on ${config.writerHost}:${writes.port}`)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      lease?.stop()
      server?.stop()
      writes?.stop()
      services.writes.drain()
      services.requestLogs.flush()
      projects.close()
      db.sqlite.close()
      process.exit(0)
    })
  }
}
