/** Service graph shared by the API and the console. */
import { OAuthService } from './auth/oauth'
import { AuthService } from './auth/service'
import { BackupService } from './backups/service'
import { VersionMonitor } from './cluster/versions'
import type { Config } from './config'
import type { SqlDatabase } from './db/driver'
import { WriteBatcher } from './documents/batcher'
import { DocumentStore, type DocumentBackend } from './documents/store'
import { FunctionService, readEnvFile } from './functions/service'
import { siteHost } from './lib/hosts'
import { randomSecret, sha256 } from './lib/ids'
import { RequestLogService } from './logs/service'
import { DisabledMailer, SmtpMailer, type Mailer } from './mail/mailer'
import { createObservability, type Observability } from './observability'
import { ObservabilitySettingsStore, telemetryOptionsOf } from './observability/settings'
import { TelemetryStore } from './observability/store'
import { ProxyService } from './proxy/service'
import { QueueService } from './queue/service'
import { RealtimeHub } from './realtime/hub'
import { Registry } from './schema/registry'
import { SettingsService } from './settings/service'
import { SiteService } from './sites/service'
import { RenderService } from './render/service'
import { StorageService } from './storage/service'
import { TeamService } from './teams/service'
import { TransactionService } from './transactions/service'
import { VariablesService } from './variables/service'
import { VectorService } from './vectors/service'
import { AccessService } from './settings/access'
import { TopicService } from './messaging/topics'
import { WebhookService } from './webhooks/service'
import { EmailTemplateService } from './mail/templates'

export interface Services {
  config: Config
  db: SqlDatabase
  /** Counters that reveal settings/schema changes made by another process. */
  versions: VersionMonitor
  registry: Registry
  store: DocumentBackend
  /** Groups concurrent document writes into one transaction (WRITE_BATCH_MS). */
  writes: WriteBatcher
  transactions: TransactionService
  auth: AuthService
  teams: TeamService
  oauth: OAuthService
  /** Project mail: verification, recovery, OTP sessions and team invitations. */
  mailer: Mailer
  /** Console mail: sign-in codes, MFA codes and organization invitations. */
  consoleMailer: Mailer
  realtime: RealtimeHub
  storage: StorageService
  functions: FunctionService
  /** Project and site environment variables. */
  variables: VariablesService
  /** Static sites served by Host header. */
  sites: SiteService
  /** Custom domains for sites and functions (Appwrite proxy rules). */
  proxy: ProxyService
  settings: SettingsService
  /** Services, protocols, sign-in methods and policies (`appwrite push settings`). */
  access: AccessService
  webhooks: WebhookService
  topics: TopicService
  /** Editable emails sent to project users (verification, recovery, OTP, invitations). */
  templates: EmailTemplateService
  requestLogs: RequestLogService
  /** Bounded local telemetry for the console's Observability pages. */
  telemetry: TelemetryStore
  /** Per-project provider configuration edited in the console. */
  observabilitySettings: ObservabilitySettingsStore
  /** This project's exporters, sampling and feature flags. */
  observability: Observability
  backups: BackupService
  render: RenderService
  /** Durable job queue for SDK workers (docs/QUEUE.md). */
  queue: QueueService
  /** Built-in vector store and RAG (docs/VECTORS.md). */
  vectors: VectorService
  /**
   * Load the database-backed caches. SQLite constructors load synchronously, so
   * this is a no-op there; a network backend must await it before serving
   * (`services.ready()` is the boot seam).
   */
  ready(): Promise<void>
}

export function createServices(config: Config, db: SqlDatabase, overrides: Partial<Services> = {}): Services {
  // Every process must hand the same key to function runs: a run started by
  // one worker may call back through another. Deriving it from the shared
  // secret keeps that true without storing another secret.
  config.internalKey ??= config.secret ? `internal_${sha256(`${config.secret}:internal`)}` : `internal_${randomSecret(32)}`
  const versions = new VersionMonitor(db, config.cacheCheckMs)
  const registry = new Registry(db)
  const store = new DocumentStore(db)
  const writes = new WriteBatcher(store, config.writeBatchMs)
  const transactions = new TransactionService(db, registry, store)
  const auth = new AuthService(db, config, store)
  const teams = new TeamService(db, store, auth)
  const proxy = new ProxyService(db, config)
  const variables = new VariablesService(db)
  // One-time legacy migration; it is idempotent and must not block the SQLite
  // boot. A network backend awaits it in ready().
  if (db.dialect === 'sqlite') {
    void variables.adoptFunctionGlobals().catch((error) => console.error('[variables] could not adopt global function variables:', error))
  }
  const sites = new SiteService(db, config, proxy, variables)
  const oauth = new OAuthService(db, config, auth, () => sites.allowedOrigins())
  const makeMailer = () => (config.smtp ? new SmtpMailer(config.smtp) : new DisabledMailer())
  const makeConsoleMailer = () => (config.consoleSmtp ? new SmtpMailer(config.consoleSmtp) : new DisabledMailer())
  const realtime = new RealtimeHub(db, {
    projectId: config.projectId,
    realtimeEventRetentionSeconds: config.realtimeEventRetentionSeconds,
    // SQLite uses `_realtime_events`; Postgres uses LISTEN/NOTIFY.
    bus: config.workers > 1 && db.capabilities.eventBus ? { projectId: config.projectId, pollMs: config.realtimeBusPollMs } : undefined,
    collectionOf: (databaseId, collectionId) => registry.collections.get(`${databaseId}/${collectionId}`) ?? null,
  })
  const storage = new StorageService(db, config, store)
  const functions = new FunctionService(db, config, store, proxy, {
    functionEnv: readEnvFile(config.functionsEnvFile),
    projectVariables: (context) => variables.projectEnvironment(context),
  })
  const requestLogs = new RequestLogService(db, config)
  const observabilitySettings = new ObservabilitySettingsStore(db)
  const telemetry = new TelemetryStore(db, telemetryOptionsOf(observabilitySettings.config))
  const observability = createObservability(observabilitySettings.config, { projectId: config.projectId })
  const backups = new BackupService(config, db.capabilities.localFile)
  const queue = new QueueService(db)
  const vectors = new VectorService(db, config.vectors)
  vectors.startJobs()
  // Async renders are jobs in the queue, saved to storage when done.
  const render = new RenderService(config, { queue, storage })
  const webhooks = new WebhookService(
    db,
    () => config.projectId,
    () => config.apiCompat,
  )
  const topics = new TopicService(db)
  const templates = new EmailTemplateService(db, config)
  proxy.reservedHosts = () => [...sites.list().map((site) => siteHost(config, site.id)), ...functions.hosts()]
  const services = {
    config,
    db,
    versions,
    registry,
    store,
    writes,
    transactions,
    auth,
    teams,
    oauth,
    mailer: overrides.mailer ?? new DisabledMailer(),
    consoleMailer: overrides.consoleMailer ?? new DisabledMailer(),
    realtime,
    storage,
    functions,
    variables,
    sites,
    proxy,
    requestLogs,
    telemetry,
    observabilitySettings,
    observability,
    backups,
    render,
    webhooks,
    topics,
    templates,
    queue,
    vectors,
  } as unknown as Services
  services.access = new AccessService(db, config, () => services.settings)
  // Settings saved in the console apply over env; SMTP settings rebuild their mailer.
  services.settings = new SettingsService(db, config, (key) => {
    if (key === 'smtp' && !overrides.mailer) services.mailer = makeMailer()
    if (key === 'consoleSmtp' && !overrides.consoleMailer) services.consoleMailer = makeConsoleMailer()
    // Turning HTML rendering off frees Chromium's memory right away; turning
    // it on runs the jobs that waited meanwhile.
    if (key === 'render') {
      if (config.render.enabled) services.render.drain()
      else services.render.shutdown()
    }
  })
  // Vector providers are built once from the config. Rebuild them when the
  // project's Vectors & RAG settings change, including changes made in another
  // process and picked up by `settings.load()`.
  services.settings.subscribe((key) => {
    if (key === 'vectors') services.vectors.reload(config.vectors)
  })
  // SQLite applies stored settings in the SettingsService constructor, which
  // runs after the vector service was built. Pick those values up on boot.
  services.vectors.reload(config.vectors)
  // Each project's exporters and local telemetry limits follow its own
  // observability settings, including changes made in another process.
  observabilitySettings.subscribe(async () => {
    const current = observabilitySettings.config
    await observability.reconfigure(current)
    telemetry.configure(telemetryOptionsOf(current))
  })
  if (!overrides.mailer) services.mailer = makeMailer()
  if (!overrides.consoleMailer) services.consoleMailer = makeConsoleMailer()
  services.ready = async () => {
    await proxy.ready()
    await sites.ready()
    await functions.ready()
    await observabilitySettings.load()
    telemetry.configure(telemetryOptionsOf(observabilitySettings.config))
    if (db.dialect === 'sqlite') return
    // Order matters: settings feed access, and both feed the config overlay
    // that the other caches read.
    await versions.load()
    await services.settings.load()
    await services.access.load()
    await registry.load()
    await templates.load()
    await variables.adoptFunctionGlobals()
  }
  return Object.assign(services, overrides)
}
