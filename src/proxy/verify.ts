/**
 * DNS checks behind the custom-domain table: a domain counts as verified when
 * it points at this server, either through a CNAME to the resource's default
 * host or through an A record for the server's IPv4 address.
 */
import { randomUUID } from 'node:crypto'
import { resolve4, resolveCname } from 'node:dns/promises'

import { hostOf } from '~/lib/hosts'

export type DomainStatus = 'verified' | 'unverified'

export interface DomainCheck {
  domain: string
  status: DomainStatus
}

export interface CustomDomainOverview {
  /** The host a CNAME should point at. */
  cnameTarget: string
  /** The server's public IPv4 address, when it can be resolved. */
  ipv4: string | null
  domains: DomainCheck[]
}

export interface DomainResolver {
  /** IPv4 addresses a host resolves to, following CNAMEs. */
  addresses(host: string): Promise<string[]>
  /** CNAME targets for a host. */
  cnames(host: string): Promise<string[]>
}

/** DNS is best-effort: a slow or missing record should not hold up the settings page. */
const TIMEOUT_MS = 2_000

const systemResolver: DomainResolver = {
  // Query DNS directly. `lookup` goes through getaddrinfo, so its cache (and
  // /etc/hosts) can keep returning an answer from before the record changed.
  addresses: async (host) => resolve4(host),
  cnames: async (host) => (await resolveCname(host)).map(hostOf),
}

/** A fresh probe label per check, so an NXDOMAIN cached before the wildcard existed is not reused. */
const wildcardProbe = (base: string) => `wildcard-check-${randomUUID().slice(0, 8)}.${base}`

/** Resolve without throwing; rejections and timeouts become `fallback`. */
async function settle<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface CustomDomainCheckOptions {
  /** Default site/function host, e.g. `landing.sites.example.com`. */
  target: string
  /** Used to discover the server's IPv4 address for the A record instructions. */
  publicEndpoint: string
  /** Tests pass a fake resolver so no real DNS is needed. */
  resolver?: DomainResolver
}

/** Check every domain in one batch, sharing the target and server lookups. */
export async function checkCustomDomains(
  domains: string[],
  options: CustomDomainCheckOptions,
): Promise<CustomDomainOverview> {
  const resolver = options.resolver ?? systemResolver
  const target = hostOf(options.target)
  const endpoint = hostOf(new URL(options.publicEndpoint).hostname)
  const [targetAddresses, endpointAddresses] = await Promise.all([
    settle(resolver.addresses(target), []),
    endpoint === target ? Promise.resolve<string[]>([]) : settle(resolver.addresses(endpoint), []),
  ])
  // A CNAME to the target and an A record for either address both prove the domain points here.
  const serverAddresses = new Set([...targetAddresses, ...endpointAddresses])
  const checks = await Promise.all(
    domains.map(async (domain): Promise<DomainCheck> => {
      const host = hostOf(domain)
      // `*.example.com` is not a name DNS can resolve; probe a label it covers.
      const probe = host.startsWith('*.') ? wildcardProbe(host.slice(2)) : host
      const [cnames, addresses] = await Promise.all([
        settle(resolver.cnames(probe), []),
        settle(resolver.addresses(probe), []),
      ])
      const verified = cnames.includes(target) || addresses.some((address) => serverAddresses.has(address))
      return { domain: host, status: verified ? 'verified' : 'unverified' }
    }),
  )
  return {
    cnameTarget: target,
    ipv4: targetAddresses[0] ?? endpointAddresses[0] ?? null,
    domains: checks,
  }
}
