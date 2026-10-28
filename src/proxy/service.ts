/**
 * Custom domains ("proxy rules" in Appwrite): one row per domain, pointing at
 * a site or a function. A resource may have any number of them; the default
 * `<id>.<sitesDomain>` / `<id>.<functionsDomain>` addresses are not rows.
 */
import type { Config } from '~/config'
import type { Db } from '~/db/connection'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { functionHost, functionsDomainOf, hostOf, siteHost, sitesDomainOf } from '~/lib/hosts'
import { uniqueId } from '~/lib/ids'

export type ProxyResourceType = 'site' | 'function'

export interface ProxyRuleRow {
  seq: number
  id: string
  resource_type: ProxyResourceType
  resource_id: string
  domain: string
  created_at: string
  updated_at: string
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** A user-entered domain as a host: lowercase, no scheme, path, port or trailing dot. */
export function normalizeDomain(value: string): string {
  const domain = hostOf(value)
  if (!domain) return ''
  if (!DOMAIN.test(domain)) throw err('general_argument_invalid', `"${value}" is not a valid domain.`)
  return domain
}

export class ProxyService {
  /** Other projects, so a domain cannot point at two resources on this server. */
  peers: () => ProxyService[] = () => []
  /** Default `<id>.<sites/functions domain>` hosts that already belong to a resource. */
  reservedHosts: () => string[] = () => []
  private byId: Map<string, ProxyRuleRow> | null = null
  private byHost: Map<string, ProxyRuleRow> | null = null

  constructor(
    private db: Db,
    private config: Config,
  ) {}

  private get sql() {
    return this.db.sqlite
  }

  private cache() {
    if (!this.byId || !this.byHost) {
      const rows = this.sql.query<ProxyRuleRow, []>('SELECT * FROM _proxy_rules ORDER BY seq').all()
      this.byId = new Map(rows.map((row) => [row.id, row]))
      this.byHost = new Map(rows.map((row) => [row.domain, row]))
    }
    return { byId: this.byId, byHost: this.byHost }
  }

  private changed() {
    this.byId = this.byHost = null
  }

  list(): ProxyRuleRow[] {
    return [...this.cache().byId.values()]
  }

  forResource(type: ProxyResourceType, id: string): ProxyRuleRow[] {
    return this.list().filter((row) => row.resource_type === type && row.resource_id === id)
  }

  domainsFor(type: ProxyResourceType, id: string): string[] {
    return this.forResource(type, id).map((row) => row.domain)
  }

  get(id: string): ProxyRuleRow {
    const row = this.cache().byId.get(id)
    if (!row) throw err('rule_not_found')
    return row
  }

  byDomain(host: string): ProxyRuleRow | null {
    return this.cache().byHost.get(hostOf(host)) ?? null
  }

  /** The normalized, de-duplicated domains a resource should have, checked for conflicts. */
  normalizeAll(domains: unknown[], self?: { type: ProxyResourceType; id: string }): string[] {
    const out: string[] = []
    for (const value of domains) {
      const domain = normalizeDomain(String(value ?? ''))
      if (!domain || out.includes(domain)) continue
      this.assertAvailable(domain, self)
      out.push(domain)
    }
    return out
  }

  /** Replace every custom domain of a resource; unchanged rows keep their rule ID. */
  set(type: ProxyResourceType, id: string, domains: string[]): ProxyRuleRow[] {
    const wanted = this.normalizeAll(domains, { type, id })
    const current = this.forResource(type, id)
    const stamp = now()
    this.sql.transaction(() => {
      for (const row of current) {
        if (!wanted.includes(row.domain)) this.sql.query('DELETE FROM _proxy_rules WHERE id = ?').run(row.id)
      }
      const have = new Set(current.map((row) => row.domain))
      for (const domain of wanted) {
        if (have.has(domain)) continue
        this.sql
          .query('INSERT INTO _proxy_rules (id, resource_type, resource_id, domain, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(uniqueId(), type, id, domain, stamp, stamp)
      }
    })()
    this.changed()
    return this.forResource(type, id)
  }

  create(type: ProxyResourceType, id: string, domain: string): ProxyRuleRow {
    const host = normalizeDomain(domain)
    if (!host) throw err('general_argument_invalid', 'Param "domain" is not optional.')
    this.assertAvailable(host)
    const stamp = now()
    const ruleId = uniqueId()
    this.sql
      .query('INSERT INTO _proxy_rules (id, resource_type, resource_id, domain, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ruleId, type, id, host, stamp, stamp)
    this.changed()
    return this.get(ruleId)
  }

  remove(id: string): void {
    this.get(id)
    this.sql.query('DELETE FROM _proxy_rules WHERE id = ?').run(id)
    this.changed()
  }

  removeFor(type: ProxyResourceType, id: string): void {
    this.sql.query('DELETE FROM _proxy_rules WHERE resource_type = ? AND resource_id = ?').run(type, id)
    this.changed()
  }

  /**
   * Refuse a domain that is the API host, a site/function base domain, or
   * already used by another rule on this server.
   */
  private assertAvailable(domain: string, self?: { type: ProxyResourceType; id: string }): void {
    const server = hostOf(new URL(this.config.publicEndpoint).host)
    const reserved = new Set([server, sitesDomainOf(this.config), functionsDomainOf(this.config)])
    if (reserved.has(domain)) throw err('general_argument_invalid', `${domain} is this server's own domain.`)

    const own = self ? (self.type === 'site' ? siteHost(this.config, self.id) : functionHost(this.config, self.id)) : ''
    if (domain !== own && this.reservedHosts().includes(domain)) {
      throw err('general_argument_invalid', `${domain} is already the default address of another site or function.`)
    }

    const everyone = [this, ...this.peers().filter((peer) => peer !== this)]
    const used = (peer: ProxyService) =>
      peer.list().some((row) => row.domain === domain && !(row.resource_type === self?.type && row.resource_id === self?.id))
    if (everyone.some(used)) throw err('rule_already_exists')
  }

  /** Do not let a new site/function ID collide with an existing custom domain. */
  assertDefaultHost(type: ProxyResourceType, id: string): void {
    const host = type === 'site' ? `${id}.${sitesDomainOf(this.config)}` : `${id}.${functionsDomainOf(this.config)}`
    const everyone = [this, ...this.peers().filter((peer) => peer !== this)]
    if (everyone.some((peer) => peer.list().some((row) => row.domain === host))) {
      throw err('general_argument_invalid', `${host} is already used by a custom domain.`)
    }
  }
}
