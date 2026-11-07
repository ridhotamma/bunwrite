import { dirname, join, resolve } from 'node:path'

import { createApp, createServices } from './app'
import { workerPort } from './cluster/config'
import { LeaderLease } from './cluster/leader'
import { publicWorkerIndex, stickyEnabled, stickyPortFor } from './cluster/sticky'
import { isLeader } from './cluster/role'
import { isWriterWorker } from './cluster/writer'
import { configFromEnv, type Config } from './config'
import { databaseOptionsOf, openDatabase, sqlDatabaseOf, type Db } from './db'
import type { PostgresDriver } from './db/postgres-driver'
import { withInflightLimit } from './http/load-shed'
import { setupSandbox } from './functions/sandbox'
import { CONTROL_PROJECT_ID, controlDatabaseOptions, controlDatabasePath, initialiseControlStore } from './projects/control'
import { createProjectManager } from './projects/manager'
import { dataDirOf } from './projects/paths'
import { pushConfig } from './schema/push'
import { pushConfigPostgres } from './schema/push-postgres'
import { applyAutotune, bodyLimitBytes } from './system/autotune'

export async function startServer(): Promise<void> {
  const baseConfig = configFromEnv()
  // `baseConfig.workers` is the child-process count; a cluster also has the
  // supervisor that spawned it. Autotune sizes each process from its share of
  // the machine, so pass the real total instead of treating it as a lone one.
  const processes = baseConfig.workers > 1 ? baseConfig.workers + 1 : 1
  const tuning = applyAutotune(process.env, undefined, processes)
  if (tuning && baseConfig.workerIndex === 0) console.log(`[autotune] ${tuning.summary}`)

  // `createServices` applies the control store's stored settings over
  // `baseConfig`; keep the built-in values as the default for other projects.
  const sqliteSynchronous = baseConfig.sqliteSynchronous
  const databasePath = baseConfig.databasePath
  const dataDir = dataDirOf(databasePath)

  // Before the database opens: with function isolation on, files are created private to the server.
  const sandbox = setupSandbox(databasePath)
  if (sandbox) {
    console.log(
      `[functions] isolation on (${sandbox.kind}${sandbox.kind === 'bwrap' ? ', bubblewrap namespaces' : ''}): each function builds and runs as its own user`,
    )
  }

  // The network backends are async, so the whole boot path opens through the
  // same selector. SQLite still uses its synchronous migrations inside it.
  const databaseOptions = databaseOptionsOf(baseConfig)
  const controlOptions = controlDatabaseOptions(baseConfig, databaseOptions)
  const controlDatabase = await openDatabase({
    ...controlOptions,
    log: (line) => console.log(`[control] ${line}`),
  })
  const controlDb = sqlDatabaseOf(controlDatabase)
  if (!controlDatabase.sqlite) baseConfig.writerPort = 0

  const store = await initialiseControlStore({
    config: baseConfig,
    databaseOptions,
    control: controlDb,
    log: (line) => console.log(line),
  })
  await store.legacy?.close().catch(() => {})

  const controlPath = controlDatabasePath(baseConfig)
  const controlConfig: Config = {
    ...baseConfig,
    databasePath: controlPath,
    databaseNamespace: controlOptions.namespace,
    controlDatabasePath: controlPath,
    controlDatabaseNamespace: controlOptions.namespace,
    legacyDatabasePath: databasePath,
    projectId: CONTROL_PROJECT_ID,
    orgId: store.instance.orgId,
    projectName: store.instance.projectName,
    secret: store.instance.secret,
    storagePath: join(dirname(controlPath), 'storage'),
    // Instance backups stay in BACKUPS_PATH; project backups live with their
    // own database and stay inert for additional projects.
    backupsPath: baseConfig.backupsPath,
    functionsDir: join(dirname(controlPath), 'functions'),
    functionsEnvFile: undefined,
    schemaPath: undefined,
    schemaSyncOnStart: false,
    instanceBackups: true,
    functionsSandbox: sandbox,
    bootstrap: {
      orgId: store.instance.orgId,
      projectId: store.instance.projectId,
      apiKey: undefined,
      generated: store.instance.generated,
    },
  }
  const config = controlConfig
  // Writer sharding exists to serialize SQLite's single-writer file. Postgres
  // has a connection pool, so every process writes directly and no loopback
  // writer listener or request forwarding is started.
  const dedicatedWriter = Boolean(controlDatabase.sqlite) && config.workers > 1 && config.writerPort > 0
  const writer = dedicatedWriter && isWriterWorker(config)
  const writerShard = writer ? config.workerIndex : 0
  const writerPort = config.writerPort + writerShard
  const services = createServices(config, controlDb)
  const projects = createProjectManager({
    config: baseConfig,
    db: controlDb,
    services,
    dataDir,
    sqliteSynchronous,
    database: databaseOptions,
  })
  // Loads the control caches and every project runtime before serving.
  await projects.ready()

  // The setup page and API key belong to the first project, not to the
  // synthetic control identity. A console can legitimately have no projects.
  const firstProject = projects.list().length ? projects.defaultProject() : null
  const firstBootstrap = firstProject?.services.config.bootstrap
  if (firstBootstrap && firstProject) {
    config.bootstrap = {
      orgId: config.orgId,
      projectId: firstProject.info.id,
      apiKey: firstBootstrap.apiKey,
      generated: firstBootstrap.generated,
    }
  }
  if (store.legacyInstance?.ignoredEnv.length) {
    console.warn(
      `[bootstrap] ignoring ${store.legacyInstance.ignoredEnv.join(', ')} from the environment: the stored instance identity wins. Remove them from .env.`,
    )
  }
  if (config.workerIndex === 0 && (store.instance.generated || store.instance.created || config.bootstrap?.apiKey)) {
    console.log(`[bootstrap] instance credentials stored in the database${store.instance.generated ? ' (generated)' : ''}`)
    if (firstProject) console.log(`[bootstrap] ORG_ID=${firstProject.info.orgId} PROJECT_ID=${firstProject.info.id}`)
    if (config.bootstrap?.apiKey) console.log(`[bootstrap] API key: ${config.bootstrap.apiKey} (shown until the first admin is created)`)
  }

  // One worker applies the config file; the others wait for the schema version
  // bump and reload their registries.
  if (firstProject && baseConfig.schemaPath && baseConfig.schemaSyncOnStart && config.workerIndex === 0) {
    const schema = await Bun.file(baseConfig.schemaPath).json()
    const pushOptions = { log: (line: string) => console.log(`[schema] ${line}`), baseDir: dirname(resolve(baseConfig.schemaPath)) }
    if (firstProject.services.db.sqlite) pushConfig(firstProject.services.db as unknown as Db, schema, pushOptions)
    else await pushConfigPostgres(firstProject.services.db.driver as PostgresDriver, schema, pushOptions)
    firstProject.services.registry.reload()
  }

  // Elect one scheduler per cluster on either backend. The lease is a row in
  // `_cluster_leases`; SQLite and Postgres both decide it with one upsert.
  const lease = config.workers > 1 ? new LeaderLease(controlDb) : null
  lease?.start()

  // First console admin from env, if given and not there yet.
  if (config.workerIndex === 0 && process.env.CONSOLE_ADMIN_EMAIL && process.env.CONSOLE_ADMIN_PASSWORD) {
    const { ConsoleAuth } = await import('./console/auth')
    const consoleAuth = new ConsoleAuth(controlDb)
    if (!(await consoleAuth.list()).some((admin) => admin.email === process.env.CONSOLE_ADMIN_EMAIL!.toLowerCase())) {
      await consoleAuth.upsert(process.env.CONSOLE_ADMIN_EMAIL, process.env.CONSOLE_ADMIN_PASSWORD)
      if (firstProject) await projects.clearDefaultApiKey()
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

  const label =
    config.workers > 1 ? `[${writer ? `writer ${writerShard + 1}/${config.writerShards}` : `worker ${publicIndex + 1}/${config.publicWorkers}`}] ` : ''
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
        await controlDatabase.close()
        process.exit(0)
      })()
    })
  }
}
