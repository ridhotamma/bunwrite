/**
 * Who may use what in a project: services, protocols, sign-in methods and
 * security policies, as `appwrite push settings` and the Project API set them.
 * Stored as one JSON row (`access`) in `_settings`; session duration and the
 * per-user session limit live in the `project` setting the console edits.
 *
 * Enforced: services, the REST and WebSocket protocols, the email-password,
 * email-otp, jwt and invites sign-in methods, the user limit, and the
 * password personal-data check. Like Appwrite, API keys and console admins
 * are exempt from service, protocol and sign-in-method switches. The other
 * policies and mock phone numbers are stored and read back, but this server
 * has no phone sign-in, password dictionary, password history or session
 * alert emails to apply them to.
 */
import type { Config } from '~/config'
import type { Db } from '~/db/connection'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import type { SettingsService } from './service'

export const SERVICE_IDS = [
  'account', 'avatars', 'databases', 'tablesdb', 'locale', 'health', 'project', 'storage', 'teams', 'users',
  'vcs', 'sites', 'functions', 'proxy', 'graphql', 'migrations', 'messaging', 'advisor', 'oauth2',
] as const
export const PROTOCOL_IDS = ['rest', 'graphql', 'websocket'] as const
export const AUTH_METHOD_IDS = ['email-password', 'magic-url', 'email-otp', 'anonymous', 'invites', 'jwt', 'phone'] as const

export type ServiceId = (typeof SERVICE_IDS)[number]
export type ProtocolId = (typeof PROTOCOL_IDS)[number]
export type AuthMethodId = (typeof AUTH_METHOD_IDS)[number]

export interface MembershipPrivacy {
  userId: boolean
  userEmail: boolean
  userPhone: boolean
  userName: boolean
  userMFA: boolean
  userAccessedAt: boolean
}

export interface MockPhone {
  number: string
  otp: string
  createdAt: string
  updatedAt: string
}

interface Stored {
  services: Partial<Record<ServiceId, boolean>>
  protocols: Partial<Record<ProtocolId, boolean>>
  authMethods: Partial<Record<AuthMethodId, boolean>>
  passwordDictionary: boolean
  passwordHistory: number
  passwordPersonalData: boolean
  sessionAlert: boolean
  sessionInvalidation: boolean
  userLimit: number
  membershipPrivacy: MembershipPrivacy
  denyAliasedEmail: boolean
  denyDisposableEmail: boolean
  denyFreeEmail: boolean
  mockPhones: MockPhone[]
}

const DEFAULTS: Stored = {
  services: {},
  protocols: {},
  authMethods: {},
  passwordDictionary: false,
  passwordHistory: 0,
  passwordPersonalData: false,
  sessionAlert: false,
  sessionInvalidation: false,
  userLimit: 0,
  membershipPrivacy: { userId: true, userEmail: true, userPhone: true, userName: true, userMFA: true, userAccessedAt: true },
  denyAliasedEmail: false,
  denyDisposableEmail: false,
  denyFreeEmail: false,
  mockPhones: [],
}

/** Policies the CLI and SDKs can read and set. */
export const POLICY_IDS = [
  'password-dictionary',
  'password-history',
  'password-personal-data',
  'session-alert',
  'session-duration',
  'session-invalidation',
  'session-limit',
  'user-limit',
  'membership-privacy',
  'deny-aliased-email',
  'deny-disposable-email',
  'deny-free-email',
] as const
export type PolicyId = (typeof POLICY_IDS)[number]

/** First path segment → the service that serves it. */
const SERVICE_OF_PATH: Record<string, ServiceId[]> = {
  account: ['account'],
  avatars: ['avatars'],
  databases: ['databases'],
  tablesdb: ['databases', 'tablesdb'],
  locale: ['locale'],
  health: ['health'],
  storage: ['storage'],
  teams: ['teams'],
  users: ['users'],
  functions: ['functions'],
  sites: ['sites'],
  messaging: ['messaging'],
  graphql: ['graphql'],
}

const MAX_MOCK_PHONES = 10

export class AccessService {
  private cache: Stored | null = null

  constructor(
    private db: Db,
    private config: Config,
    private settings: () => SettingsService,
  ) {}

  private read(): Stored {
    if (this.cache) return this.cache
    const row = this.db.sqlite.query<{ value: string }, [string]>('SELECT value FROM _settings WHERE key = ?').get('access')
    const saved = row ? (JSON.parse(row.value) as Partial<Stored>) : {}
    this.cache = { ...structuredClone(DEFAULTS), ...saved, membershipPrivacy: { ...DEFAULTS.membershipPrivacy, ...saved.membershipPrivacy } }
    return this.cache
  }

  private write(change: (s: Stored) => void): void {
    const next = structuredClone(this.read())
    change(next)
    this.db.sqlite
      .query("INSERT INTO _settings (key, value, updated_at) VALUES ('access', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(JSON.stringify(next), now())
    this.cache = next
  }

  // ------------------------------------------------------------ switches

  serviceEnabled(id: ServiceId): boolean {
    return this.read().services[id] ?? true
  }

  protocolEnabled(id: ProtocolId): boolean {
    return this.read().protocols[id] ?? true
  }

  authMethodEnabled(id: AuthMethodId): boolean {
    return this.read().authMethods[id] ?? true
  }

  setService(id: string, enabled: boolean): void {
    if (!(SERVICE_IDS as readonly string[]).includes(id)) throw err('general_argument_invalid', `Invalid \`serviceId\` param: must be one of ${SERVICE_IDS.join(', ')}`)
    this.write((s) => (s.services[id as ServiceId] = enabled))
  }

  setProtocol(id: string, enabled: boolean): void {
    if (!(PROTOCOL_IDS as readonly string[]).includes(id)) throw err('general_argument_invalid', `Invalid \`protocolId\` param: must be one of ${PROTOCOL_IDS.join(', ')}`)
    this.write((s) => (s.protocols[id as ProtocolId] = enabled))
  }

  setAuthMethod(id: string, enabled: boolean): void {
    if (!(AUTH_METHOD_IDS as readonly string[]).includes(id)) throw err('general_argument_invalid', `Invalid \`methodId\` param: must be one of ${AUTH_METHOD_IDS.join(', ')}`)
    this.write((s) => (s.authMethods[id as AuthMethodId] = enabled))
  }

  services() {
    return SERVICE_IDS.map((id) => ({ $id: id, enabled: this.serviceEnabled(id) }))
  }

  protocols() {
    return PROTOCOL_IDS.map((id) => ({ $id: id, enabled: this.protocolEnabled(id) }))
  }

  authMethods() {
    return AUTH_METHOD_IDS.map((id) => ({ $id: id, enabled: this.authMethodEnabled(id) }))
  }

  // ------------------------------------------------------------ enforcement (non-privileged callers only)

  /** Throw when the service behind this API path is switched off. */
  assertService(pathname: string): void {
    const first = pathname.split('/')[1] ?? ''
    for (const id of SERVICE_OF_PATH[first] ?? []) if (!this.serviceEnabled(id)) throw err('general_service_disabled')
  }

  assertProtocol(id: ProtocolId): void {
    if (!this.protocolEnabled(id)) throw err('general_api_disabled')
  }

  assertAuthMethod(id: AuthMethodId): void {
    if (!this.authMethodEnabled(id)) throw err('user_auth_method_unsupported')
  }

  /** Sign-ups stop once the project has `user-limit` users (0 means no limit). */
  assertUserLimit(): void {
    const limit = this.read().userLimit
    if (limit <= 0) return
    const { n } = this.db.sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM _users').get()!
    if (n >= limit) throw err('user_count_exceeded')
  }

  /** With the personal-data policy on, a password may not contain the user's ID, name, email or phone. */
  assertPasswordPersonalData(password: unknown, user: { id?: unknown; name?: unknown; email?: unknown; phone?: unknown }): void {
    if (!this.read().passwordPersonalData || typeof password !== 'string') return
    const lower = password.toLowerCase()
    const email = typeof user.email === 'string' ? user.email.toLowerCase() : ''
    const parts = [user.id, user.name, email, email.split('@')[0], typeof user.phone === 'string' ? user.phone.replace(/^\+/, '') : '']
    for (const part of parts) {
      const value = typeof part === 'string' ? part.trim().toLowerCase() : ''
      if (value.length >= 3 && lower.includes(value)) throw err('password_personal_data')
    }
  }

  // ------------------------------------------------------------ policies

  policies() {
    const s = this.read()
    return [
      { $id: 'password-dictionary', enabled: s.passwordDictionary },
      { $id: 'password-history', total: s.passwordHistory },
      { $id: 'password-personal-data', enabled: s.passwordPersonalData },
      { $id: 'session-alert', enabled: s.sessionAlert },
      { $id: 'session-duration', duration: this.config.sessionDuration },
      { $id: 'session-invalidation', enabled: s.sessionInvalidation },
      { $id: 'session-limit', total: this.config.sessionsLimit },
      { $id: 'user-limit', total: s.userLimit },
      { $id: 'membership-privacy', ...s.membershipPrivacy },
      { $id: 'deny-aliased-email', enabled: s.denyAliasedEmail },
      { $id: 'deny-disposable-email', enabled: s.denyDisposableEmail },
      { $id: 'deny-free-email', enabled: s.denyFreeEmail },
    ] as ({ $id: PolicyId } & Record<string, unknown>)[]
  }

  policy(id: string) {
    const found = this.policies().find((p) => p.$id === id)
    if (!found) throw err('general_argument_invalid', `Invalid \`policyId\` param: must be one of ${POLICY_IDS.join(', ')}`)
    return found
  }

  /** Apply one policy update; `params` is the request body. */
  updatePolicy(id: string, params: Record<string, unknown>) {
    const flag = () => {
      if (typeof params.enabled !== 'boolean') throw err('general_argument_invalid', 'Invalid `enabled` param: Value must be a valid boolean')
      return params.enabled
    }
    const count = (key: string, max: number) => {
      const n = Number(params[key])
      if (!Number.isInteger(n) || n < 0 || n > max) throw err('general_argument_invalid', `Invalid \`${key}\` param: Value must be a valid range between 0 and ${max.toLocaleString('en')}`)
      return n
    }
    switch (id) {
      case 'password-dictionary': {
        const v = flag()
        this.write((s) => (s.passwordDictionary = v))
        break
      }
      case 'password-history': {
        const v = count('total', 20)
        this.write((s) => (s.passwordHistory = v))
        break
      }
      case 'password-personal-data': {
        const v = flag()
        this.write((s) => (s.passwordPersonalData = v))
        break
      }
      case 'session-alert': {
        const v = flag()
        this.write((s) => (s.sessionAlert = v))
        break
      }
      case 'session-invalidation': {
        const v = flag()
        this.write((s) => (s.sessionInvalidation = v))
        break
      }
      case 'user-limit': {
        const v = count('total', 10_000)
        this.write((s) => (s.userLimit = v))
        break
      }
      case 'deny-aliased-email': {
        const v = flag()
        this.write((s) => (s.denyAliasedEmail = v))
        break
      }
      case 'deny-disposable-email': {
        const v = flag()
        this.write((s) => (s.denyDisposableEmail = v))
        break
      }
      case 'deny-free-email': {
        const v = flag()
        this.write((s) => (s.denyFreeEmail = v))
        break
      }
      case 'membership-privacy': {
        const next: Partial<MembershipPrivacy> = {}
        for (const key of Object.keys(DEFAULTS.membershipPrivacy) as (keyof MembershipPrivacy)[]) {
          if (params[key] !== undefined && params[key] !== null) next[key] = Boolean(params[key])
        }
        this.write((s) => Object.assign(s.membershipPrivacy, next))
        break
      }
      case 'session-duration':
        this.saveProject({ sessionDuration: count('duration', 31_536_000) })
        break
      case 'session-limit':
        this.saveProject({ sessionsLimit: count('total', 100) })
        break
      default:
        throw err('general_argument_invalid', `Invalid \`policyId\` param: must be one of ${POLICY_IDS.join(', ')}`)
    }
    return this.policy(id)
  }

  /** Session duration and limit share the console's `project` setting. */
  private saveProject(change: { sessionDuration?: number; sessionsLimit?: number }): void {
    if (change.sessionDuration !== undefined && change.sessionDuration < 5) {
      throw err('general_argument_invalid', 'Invalid `duration` param: Value must be a valid range between 5 and 31,536,000')
    }
    const c = this.config
    this.settings().set('project', {
      projectName: c.projectName,
      allowedOrigins: c.allowedOrigins,
      sessionDuration: change.sessionDuration ?? c.sessionDuration,
      sessionsLimit: change.sessionsLimit ?? c.sessionsLimit,
    })
  }

  // ------------------------------------------------------------ mock phone numbers

  mockPhones(): MockPhone[] {
    return this.read().mockPhones
  }

  mockPhone(number: string): MockPhone {
    const found = this.read().mockPhones.find((m) => m.number === number)
    if (!found) throw err('mock_number_not_found')
    return found
  }

  createMockPhone(number: unknown, otp: unknown): MockPhone {
    const phone = validPhoneNumber(number)
    const code = validOtp(otp)
    if (this.read().mockPhones.some((m) => m.number === phone)) throw err('mock_number_already_exists')
    if (this.read().mockPhones.length >= MAX_MOCK_PHONES) throw err('mock_number_limit_exceeded')
    const stamp = now()
    const created = { number: phone, otp: code, createdAt: stamp, updatedAt: stamp }
    this.write((s) => s.mockPhones.push(created))
    return created
  }

  updateMockPhone(number: string, otp: unknown): MockPhone {
    this.mockPhone(number)
    const code = validOtp(otp)
    this.write((s) => {
      const m = s.mockPhones.find((p) => p.number === number)!
      m.otp = code
      m.updatedAt = now()
    })
    return this.mockPhone(number)
  }

  deleteMockPhone(number: string): void {
    this.mockPhone(number)
    this.write((s) => (s.mockPhones = s.mockPhones.filter((m) => m.number !== number)))
  }
}

function validPhoneNumber(value: unknown): string {
  if (typeof value !== 'string' || !/^\+[1-9]\d{6,14}$/.test(value)) {
    throw err('general_argument_invalid', 'Invalid `number` param: Phone number must start with a \'+\' and can have a maximum of fifteen digits.')
  }
  return value
}

function validOtp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value)) throw err('general_argument_invalid', 'Invalid `otp` param: Value must be a valid string of 6 digits.')
  return value
}
