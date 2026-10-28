/** Service graph shared by the API and the console. */
import { OAuthService } from './auth/oauth'
import { AuthService } from './auth/service'
import { BackupService } from './backups/service'
import type { Config } from './config'
import type { Db } from './db/connection'
import { DocumentStore } from './documents/store'
import { FunctionService, readEnvFile } from './functions/service'
import { functionHost, siteHost } from './lib/hosts'
import { randomSecret } from './lib/ids'
import { RequestLogService } from './logs/service'
import { DisabledMailer, SmtpMailer, type Mailer } from './mail/mailer'
import { ProxyService } from './proxy/service'
import { RealtimeHub } from './realtime/hub'
import { Registry } from './schema/registry'
import { SettingsService } from './settings/service'
import { SiteService } from './sites/service'
import { RenderService } from './render/service'
import { StorageService } from './storage/service'
import { TeamService } from './teams/service'
import { TransactionService } from './transactions/service'
import { AccessService } from './settings/access'
import { TopicService } from './messaging/topics'
import { WebhookService } from './webhooks/service'
import { EmailTemplateService } from './mail/templates'
import { VcsInstallations } from './vcs/installations'

export interface Services {
  config: Config
  db: Db
  registry: Registry
  store: DocumentStore
  transactions: TransactionService
  auth: AuthService
  teams: TeamService
  oauth: OAuthService
  mailer: Mailer
  realtime: RealtimeHub
  storage: StorageService
  functions: FunctionService
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
  /** GitHub App installations connected to this project. */
  vcs: VcsInstallations
}

export function createServices(config: Config, db: Db, overrides: Partial<Services> = {}): Services {
  config.internalKey ??= `internal_${randomSecret(32)}`
  const registry = new Registry(db)
  const store = new DocumentStore(db)
  const transactions = new TransactionService(db, registry, store)
  const auth = new AuthService(db, config, store)
  const teams = new TeamService(db, store, auth)
  const proxy = new ProxyService(db, config)
  const sites = new SiteService(db, config, proxy)
  const oauth = new OAuthService(db, config, auth, () => sites.allowedOrigins())
  const makeMailer = () => (config.smtp ? new SmtpMailer(config.smtp) : new DisabledMailer())
  const realtime = new RealtimeHub(db)
  const storage = new StorageService(db, config, store)
  const functions = new FunctionService(db, config, store, proxy, {
    functionEnv: readEnvFile(config.functionsEnvFile),
  })
  const requestLogs = new RequestLogService(db, config)
  const backups = new BackupService(db, config)
  const render = new RenderService(config)
  const webhooks = new WebhookService(db, () => config.projectId, () => config.apiCompat)
  const topics = new TopicService(db)
  const templates = new EmailTemplateService(db, config)
  const vcs = new VcsInstallations(db)
  proxy.reservedHosts = () => [...sites.list().map((site) => siteHost(config, site.id)), ...functions.list().map((fn) => functionHost(config, fn.id))]
  const services = { config, db, registry, store, transactions, auth, teams, oauth, mailer: overrides.mailer ?? new DisabledMailer(), realtime, storage, functions, sites, proxy, requestLogs, backups, render, webhooks, topics, templates, vcs } as Services
  services.access = new AccessService(db, config, () => services.settings)
  // Settings saved in the console apply over env; a new SMTP setting rebuilds the mailer.
  services.settings = new SettingsService(db, config, (key) => {
    if (key === 'smtp' && !overrides.mailer) services.mailer = makeMailer()
    // Turning HTML rendering off frees Chromium's memory right away.
    if (key === 'render' && !config.render.enabled) services.render.shutdown()
  })
  if (!overrides.mailer) services.mailer = makeMailer()
  return Object.assign(services, overrides)
}
