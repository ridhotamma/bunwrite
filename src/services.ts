/** Service graph shared by the API and the console. */
import { OAuthService } from './auth/oauth'
import { AuthService } from './auth/service'
import { BackupService } from './backups/service'
import { VersionMonitor } from './cluster/versions'
import type { Config } from './config'
import type { Db } from './db/connection'
import { WriteBatcher } from './documents/batcher'
import { DocumentStore } from './documents/store'
import { FunctionService, readEnvFile } from './functions/service'
import { functionHost, siteHost } from './lib/hosts'
import { randomSecret, sha256 } from './lib/ids'
import { RequestLogService } from './logs/service'
import { DisabledMailer, SmtpMailer, type Mailer } from './mail/mailer'
import { ProxyService } from './proxy/service'
import { QueueService } from './queue/service'
import { RealtimeHub } from './realtime/hub'
import { Registry } from './schema/registry'
import { SettingsService, type SettingsOptions } from './settings/service'
import { SiteService } from './sites/service'
import { RenderService } from './render/service'
import { StorageService } from './storage/service'
import { TeamService } from './teams/service'
import { TransactionService } from './transactions/service'
import { VariablesService } from './variables/service'
import { AccessService } from './settings/access'
import { TopicService } from './messaging/topics'
import { WebhookService } from './webhooks/service'
import { EmailTemplateService } from './mail/templates'

export interface Services {
  config: Config
  db: Db
  /** Counters that reveal settings/schema changes made by another process. */
  versions: VersionMonitor
  registry: Registry
  store: DocumentStore
  /** Groups concurrent document writes into one transaction (WRITE_BATCH_MS). */
  writes: WriteBatcher
  transactions: TransactionService
  auth: AuthService
  teams: TeamService
  oauth: OAuthService
  mailer: Mailer
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
  backups: BackupService
  render: RenderService
  /** Durable job queue for SDK workers (docs/QUEUE.md). */
  queue: QueueService
}

export function createServices(config: Config, db: Db, overrides: Partial<Services> = {}, settingsOptions: SettingsOptions = {}): Services {
  // Every process must hand the same key to function runs: a run started by
  // one worker may call back through another. Deriving it from the shared
  // secret keeps that true without storing another secret.
  config.internalKey ??= config.secret
    ? `internal_${sha256(`${config.secret}:internal`)}`
    : `internal_${randomSecret(32)}`
  const versions = new VersionMonitor(db, config.cacheCheckMs)
  const registry = new Registry(db)
  const store = new DocumentStore(db)
  const writes = new WriteBatcher(store, config.writeBatchMs)
  const transactions = new TransactionService(db, registry, store)
  const auth = new AuthService(db, config, store)
  const teams = new TeamService(db, store, auth)
  const proxy = new ProxyService(db, config)
  const variables = new VariablesService(db)
  variables.adoptFunctionGlobals()
  const sites = new SiteService(db, config, proxy, variables)
  const oauth = new OAuthService(db, config, auth, () => sites.allowedOrigins())
  const makeMailer = () => (config.smtp ? new SmtpMailer(config.smtp) : new DisabledMailer())
  const realtime = new RealtimeHub(db, {
    bus: config.workers > 1 ? { projectId: config.projectId, pollMs: config.realtimeBusPollMs } : undefined,
    collectionOf: (databaseId, collectionId) => registry.collections.get(`${databaseId}/${collectionId}`) ?? null,
  })
  const storage = new StorageService(db, config, store)
  const functions = new FunctionService(db, config, store, proxy, {
    functionEnv: readEnvFile(config.functionsEnvFile),
    projectVariables: (context) => variables.projectEnvironment(context),
  })
  const requestLogs = new RequestLogService(db, config)
  const backups = new BackupService(db, config)
  const queue = new QueueService(db)
  // Async renders are jobs in the queue, saved to storage when done.
  const render = new RenderService(config, { queue, storage })
  const webhooks = new WebhookService(db, () => config.projectId, () => config.apiCompat)
  const topics = new TopicService(db)
  const templates = new EmailTemplateService(db, config)
  proxy.reservedHosts = () => [...sites.list().map((site) => siteHost(config, site.id)), ...functions.list().map((fn) => functionHost(config, fn.id))]
  const services = { config, db, versions, registry, store, writes, transactions, auth, teams, oauth, mailer: overrides.mailer ?? new DisabledMailer(), realtime, storage, functions, variables, sites, proxy, requestLogs, backups, render, webhooks, topics, templates, queue } as Services
  services.access = new AccessService(db, config, () => services.settings)
  // Settings saved in the console apply over env; a new SMTP setting rebuilds the mailer.
  services.settings = new SettingsService(
    db,
    config,
    (key) => {
      if (key === 'smtp' && !overrides.mailer) services.mailer = makeMailer()
      // Turning HTML rendering off frees Chromium's memory right away; turning
      // it on runs the jobs that waited meanwhile.
      if (key === 'render') {
        if (config.render.enabled) services.render.drain()
        else services.render.shutdown()
      }
    },
    settingsOptions,
  )
  if (!overrides.mailer) services.mailer = makeMailer()
  return Object.assign(services, overrides)
}
