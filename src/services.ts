/** Service graph shared by the API and the console. */
import { OAuthService } from './auth/oauth'
import { AuthService } from './auth/service'
import { BackupService } from './backups/service'
import type { Config } from './config'
import type { Db } from './db/connection'
import { DocumentStore } from './documents/store'
import { FunctionService, readEnvFile } from './functions/service'
import { randomSecret } from './lib/ids'
import { RequestLogService } from './logs/service'
import { DisabledMailer, SmtpMailer, type Mailer } from './mail/mailer'
import { RealtimeHub } from './realtime/hub'
import { Registry } from './schema/registry'
import { SettingsService } from './settings/service'
import { PdfService } from './pdf/service'
import { StorageService } from './storage/service'
import { TeamService } from './teams/service'
import { TransactionService } from './transactions/service'

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
  settings: SettingsService
  requestLogs: RequestLogService
  backups: BackupService
  pdf: PdfService
}

export function createServices(config: Config, db: Db, overrides: Partial<Services> = {}): Services {
  config.internalKey ??= `internal_${randomSecret(32)}`
  const registry = new Registry(db)
  const store = new DocumentStore(db)
  const transactions = new TransactionService(db, registry, store)
  const auth = new AuthService(db, config, store)
  const teams = new TeamService(db, store, auth)
  const oauth = new OAuthService(db, config, auth)
  const makeMailer = () => (config.smtp ? new SmtpMailer(config.smtp) : new DisabledMailer())
  const realtime = new RealtimeHub(db)
  const storage = new StorageService(db, config, store)
  const functions = new FunctionService(db, config, store, {
    functionEnv: readEnvFile(config.functionsEnvFile),
    skipSchedules: config.skipSchedules,
  })
  const requestLogs = new RequestLogService(db, config)
  const backups = new BackupService(db, config)
  const pdf = new PdfService(config)
  const services = { config, db, registry, store, transactions, auth, teams, oauth, mailer: overrides.mailer ?? new DisabledMailer(), realtime, storage, functions, requestLogs, backups, pdf } as Services
  // Settings saved in the console apply over env; a new SMTP setting rebuilds the mailer.
  services.settings = new SettingsService(db, config, (key) => {
    if (key === 'smtp' && !overrides.mailer) services.mailer = makeMailer()
    // Turning PDF rendering off frees Chromium's memory right away.
    if (key === 'pdf' && !config.pdf.enabled) services.pdf.shutdown()
  })
  if (!overrides.mailer) services.mailer = makeMailer()
  return Object.assign(services, overrides)
}
