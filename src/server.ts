import { dirname, resolve } from 'node:path'

import { createApp, createServices } from './app'
import { workerPort } from './cluster/config'
import { LeaderLease } from './cluster/leader'
import { publicWorkerIndex, stickyEnabled, stickyPortFor } from './cluster/sticky'
import { isLeader } from './cluster/role'
import { isWriterWorker } from './cluster/writer'
import { configFromEnv } from './config'
import { databaseOptionsOf, openDatabase, sqlDatabaseOf } from './db'
import type { PostgresDriver } from './db/postgres-driver'
import { withInflightLimit } from './http/load-shed'
import { bootstrapInstance, bootstrapInstanceAsync, clearInstanceApiKey, clearInstanceApiKeyAsync } from './instance/bootstrap'
import { setupSandbox } from './functions/sandbox'
import { createProjectManager } from './projects/manager'
import { pushConfig } from './schema/push'
import { pushConfigPostgres } from './schema/push-postgres'
import { applyAutotune, bodyLimitBytes } from './system/autotune'

export async function startServer(): Promise<void> {
  const config = configFromEnv()
  // `config.workers` is the child-process count; a cluster also has the
  // supervisor that spawned it. Autotune sizes each process from its share of
  // the machine, so pass the real total instead of treating it as a lone one.
  const processes = config.workers > 1 ? config.workers + 1 : 1
  const tuning = applyAutotune(process.env, undefined, processes)
  if (tuning && config.workerIndex === 0) console.log(`[autotune] ${tuning.summary}`)

  // `createServices` applies the default project's stored settings over
  // `config`; keep the environment value as the default for other projects.
  const sqliteSynchronous = config.sqliteSynchronous
  const databasePath = config.databasePath

  // Before the database opens: with function isolation on, files are created private to the server.
  const sandbox = setupSandbox(databasePath)
  if (sandbox) console.log('[functions] isolation on: each function builds and runs as its own user')

  // The network backends are async, so the whole boot path opens through the
  // same selector. SQLite still uses its synchronous migrations inside it.
  const databaseOptions = databaseOptionsOf(config)
  const database = await openDatabase({
    ...databaseOptions,
    log: (line) => console.log(`[database] ${line}`),
  })
  const db = sqlDatabaseOf(database)
  // Writer sharding exists to serialize SQLite's single-writer file. Postgres
  // has a connection pool, so every process writes directly and no loopback
  // writer listener or request forwarding is started.
  if (!database.sqlite) config.writerPort = 0
  const dedicatedWriter = Boolean(database.sqlite) && config.workers > 1 && config.writerPort > 0
  const writer = dedicatedWriter && isWriterWorker(config)
  const writerShard = writer ? config.workerIndex : 0
  const writerPort = config.writerPort + writerShard
  const instance = db.dialect === 'sqlite' ? bootstrapInstance(db) : await bootstrapInstanceAsync(db)
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
    const pushOptions = { log: (line: string) => console.log(`[schema] ${line}`), baseDir: dirname(resolve(config.schemaPath)) }
    if (database.backend === 'postgres') await pushConfigPostgres(database.sql as PostgresDriver, schema, pushOptions)
    else if (database.sqlite) pushConfig(database.sqlite, schema, pushOptions)
  }

  const services = createServices(config, db)
  const projects = createProjectManager({ config, db, services, sqliteSynchronous, database: databaseOptions })
  // Loads the control caches and every project runtime before serving.
  await projects.ready()

  // Elect one scheduler per cluster on either backend. The lease is a row in
  // `_cluster_leases`; SQLite and Postgres both decide it with one upsert.
  const lease = config.workers > 1 ? new LeaderLease(db) : null
  lease?.start()

  // First console admin from env, if given and not there yet.
  if (config.workerIndex === 0 && process.env.CONSOLE_ADMIN_EMAIL && process.env.CONSOLE_ADMIN_PASSWORD) {
    const { ConsoleAuth } = await import('./console/auth')
    const consoleAuth = new ConsoleAuth(db)
    if (!(await consoleAuth.list()).some((admin) => admin.email === process.env.CONSOLE_ADMIN_EMAIL!.toLowerCase())) {
      await consoleAuth.upsert(process.env.CONSOLE_ADMIN_EMAIL, process.env.CONSOLE_ADMIN_PASSWORD)
      if (db.dialect === 'sqlite') clearInstanceApiKey(db)
      else await clearInstanceApiKeyAsync(db)
      if (config.bootstrap) config.bootstrap.apiKey = undefined
      console.log(`[console] admin ${process.env.CONSOLE_ADMIN_EMAIL} created`)
    }
  }
  const app = createApp(projects)
  // Load the stored GitHub App and adopt any project-local installations.
  await app.hub.ready()

  // Clear out old transactions, tokens, sessions and request logs every 10 minutes.
  setInterval(
    () => {
      if (isLeader()) void projects.prune().catch((error) => console.error('[prune]', error))
    },
    10 * 60 * 1000,
  ).unref()
  projects.start()

  // In a cluster, worker 0 also accepts database writes on a loopback port.
  // The other workers run in the same network namespace and forward to it, so
  // one process owns SQLite's write connection. It does not accept public
  // traffic, so a blocking checkpoint cannot stall client connections.
  let writes: ReturnType<typeof Bun.serve> | null = null
  if (dedicatedWriter && writer && writerPort > 0) {
    try {
      writes = Bun.serve({
        hostname: config.writerHost,
        port: writerPort,
        fetch: withInflightLimit(app.fetch, config.maxInflight),
        websocket: app.websocket,
        maxRequestBodySize: tuning?.maxRequestBodyBytes ?? bodyLimitBytes(),
        idleTimeout: config.httpIdleTimeout,
      })
    } catch (error) {
      console.error(
        `[cluster] write listener ${config.writerHost}:${writerPort} failed to start; workers will write locally:`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  // The writer in a cluster only serves the loopback write listener.
  const servesPublic = !dedicatedWriter || !writer
  // MAX_INFLIGHT is per process: a worker does not know how busy its siblings
  // are, and dividing a cluster-wide budget made adding CPUs shrink each
  // worker's headroom (200 / 4 workers = 50).
  const publicLimit = config.maxInflight > 0 ? config.maxInflight : 0
  const publicIndex = publicWorkerIndex(config)
  const server = servesPublic
    ? Bun.serve({
        hostname: config.hostname,
        port: workerPort(config.port, config.workerIndex, config.workerPorts, dedicatedWriter ? config.writerShards : 0),
        // Several processes bind this port; the kernel spreads connections.
        // With WORKER_PORTS each process has its own port for the proxy instead.
        reusePort: config.workers > 1 && !config.workerPorts,
        fetch: withInflightLimit(app.fetch, publicLimit),
        websocket: app.websocket,
        maxRequestBodySize: tuning?.maxRequestBodyBytes ?? bodyLimitBytes(),
        idleTimeout: config.httpIdleTimeout,
      })
    : null

  // A private listener per public worker. Site requests that hash to another
  // worker are streamed here, so SSE/session state stays on one SSR process
  // even when SO_REUSEPORT put the original connection somewhere else.
  let sticky: ReturnType<typeof Bun.serve> | null = null
  if (server && stickyEnabled(config)) {
    const stickyPort = stickyPortFor(config, publicIndex)
    try {
      sticky = Bun.serve({
        hostname: config.stickyHost,
        port: stickyPort,
        fetch: withInflightLimit(app.fetchLocal, publicLimit),
        websocket: app.websocket,
        maxRequestBodySize: tuning?.maxRequestBodyBytes ?? bodyLimitBytes(),
        idleTimeout: config.httpIdleTimeout,
      })
    } catch (error) {
      console.error(
        `[cluster] sticky listener ${config.stickyHost}:${stickyPort} failed to start; site sessions will not stick:`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  const label = config.workers > 1 ? `[${writer ? `writer ${writerShard + 1}/${config.writerShards}` : `worker ${publicIndex + 1}/${config.publicWorkers}`}] ` : ''
  if (server) {
    console.log(
      `${label}bunwrite listening on :${server.port} (${services.registry.collections.size} collections)${config.consoleEnabled ? ', console at /console' : ''}`,
    )
  }
  if (writes) console.log(`${label}database writes on ${config.writerHost}:${writes.port}`)
  if (sticky) console.log(`${label}sticky session listener on ${config.stickyHost}:${sticky.port}`)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void (async () => {
        await lease?.stop()
        server?.stop()
        sticky?.stop()
        writes?.stop()
        await services.writes.drain()
        await services.requestLogs.flush()
        await app.observability.close()
        await projects.close()
        await database.close()
        process.exit(0)
      })()
    })
  }
}
