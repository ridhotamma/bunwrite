/** Appwrite response models for auth resources, built from SQLite rows. */

const FREE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.id', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'ymail.com', 'gmx.com', 'mail.com',
])

function canonicalEmail(email: string): string {
  const [local = '', domain = ''] = email.toLowerCase().split('@')
  let name = local.split('+')[0]!
  if (domain === 'gmail.com' || domain === 'googlemail.com') name = name.replace(/\./g, '')
  return `${name}@${domain === 'googlemail.com' ? 'gmail.com' : domain}`
}

const parse = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string') return (value as T) ?? fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export interface UserRowFull {
  seq: number
  id: string
  name: string
  email: string | null
  phone: string | null
  password: string | null
  hash: string
  hash_options: string
  registration: string
  status: number
  labels: string
  password_update: string | null
  email_verification: number
  phone_verification: number
  mfa: number
  prefs: string
  accessed_at: string | null
  created_at: string
  updated_at: string
}

/** The Account model (`account.get`): a user without password fields. */
export function accountModel(u: UserRowFull) {
  const email = u.email ?? ''
  const canonical = email ? canonicalEmail(email) : null
  const domain = email.split('@')[1] ?? ''
  return {
    $id: u.id,
    $createdAt: u.created_at,
    $updatedAt: u.updated_at,
    name: u.name,
    registration: u.registration,
    status: Boolean(u.status),
    labels: parse<string[]>(u.labels, []),
    passwordUpdate: u.password_update ?? '',
    email,
    phone: u.phone ?? '',
    emailVerification: Boolean(u.email_verification),
    emailCanonical: canonical,
    emailIsFree: email ? FREE_DOMAINS.has(domain) : null,
    emailIsDisposable: email ? false : null,
    emailIsCorporate: email ? !FREE_DOMAINS.has(domain) : null,
    emailIsCanonical: email ? email === canonical : null,
    passwordPwned: false,
    phoneVerification: Boolean(u.phone_verification),
    mfa: Boolean(u.mfa),
    prefs: parse<Record<string, unknown>>(u.prefs, {}),
    targets: [] as unknown[],
    accessedAt: u.accessed_at ?? '',
    impersonator: false,
    impersonatorUserId: null,
  }
}

const LIVE_ORDER = [
  '$id', '$createdAt', '$updatedAt', 'name', 'registration', 'status', 'labels', 'passwordUpdate', 'email', 'phone',
  'emailVerification', 'phoneVerification', 'mfa', 'targets', 'accessedAt', 'password', 'hash', 'hashOptions',
  'emailCanonical', 'emailIsFree', 'emailIsDisposable', 'emailIsCorporate', 'emailIsCanonical', 'passwordPwned',
  'prefs', 'impersonator', 'impersonatorUserId',
]

/** The User model (`users.*`): the account plus its password hash, in the live server's field order. */
export function userModel(u: UserRowFull) {
  const all: Record<string, unknown> = {
    ...accountModel(u),
    password: u.password ?? '',
    hash: u.hash,
    hashOptions: parse<Record<string, unknown>>(u.hash_options, {}),
  }
  return Object.fromEntries(LIVE_ORDER.map((k) => [k, all[k]]))
}

export interface SessionRow {
  id: string
  user_id: string
  provider: string
  provider_uid: string
  provider_access_token: string
  provider_access_token_expiry: string
  provider_refresh_token: string
  ip: string
  user_agent: string
  factors: string
  expire: string
  created_at: string
  updated_at: string
}

export function sessionModel(s: SessionRow, opts: { secret?: string; current?: boolean; country?: string } = {}) {
  return {
    $id: s.id,
    $createdAt: s.created_at,
    $updatedAt: s.updated_at,
    userId: s.user_id,
    expire: s.expire,
    provider: s.provider,
    providerUid: s.provider_uid,
    providerAccessToken: s.provider_access_token,
    providerAccessTokenExpiry: s.provider_access_token_expiry,
    providerRefreshToken: s.provider_refresh_token,
    ip: s.ip,
    osCode: '',
    osName: '',
    osVersion: '',
    clientType: '',
    clientCode: '',
    clientName: '',
    clientVersion: '',
    clientEngine: '',
    clientEngineVersion: '',
    deviceName: '',
    deviceBrand: '',
    deviceModel: '',
    countryCode: opts.country ?? '--',
    countryName: opts.country ? opts.country.toUpperCase() : 'Unknown',
    current: opts.current ?? false,
    factors: parse<string[]>(s.factors, []),
    secret: opts.secret ?? '',
    mfaUpdatedAt: '',
  }
}

export interface TokenRow {
  id: string
  user_id: string
  expire: string
  created_at: string
}

export function tokenModel(t: TokenRow, secret = '', phrase = '') {
  return { $id: t.id, $createdAt: t.created_at, userId: t.user_id, secret, expire: t.expire, phrase }
}

export interface TeamRow {
  id: string
  name: string
  prefs: string
  total?: number
  created_at: string
  updated_at: string
}

export function teamModel(t: TeamRow) {
  return {
    $id: t.id,
    $createdAt: t.created_at,
    $updatedAt: t.updated_at,
    name: t.name,
    total: t.total ?? 0,
    prefs: parse<Record<string, unknown>>(t.prefs, {}),
  }
}

export interface MembershipRowFull {
  id: string
  team_id: string
  user_id: string
  roles: string
  invited: string
  joined: string | null
  confirm: number
  created_at: string
  updated_at: string
  user_name: string
  user_email: string | null
  user_phone: string | null
  user_accessed_at: string | null
  user_mfa: number
  team_name: string
}

export function membershipModel(m: MembershipRowFull) {
  return {
    $id: m.id,
    $createdAt: m.created_at,
    $updatedAt: m.updated_at,
    userId: m.user_id,
    userName: m.user_name,
    userEmail: m.user_email ?? '',
    userPhone: m.user_phone ?? '',
    teamId: m.team_id,
    teamName: m.team_name,
    invited: m.invited,
    joined: m.joined ?? '',
    confirm: Boolean(m.confirm),
    mfa: Boolean(m.user_mfa),
    userAccessedAt: m.user_accessed_at ?? '',
    roles: parse<string[]>(m.roles, []),
  }
}
