/**
 * Host names for sites and functions. A site or function answers on
 * `<id>.<sitesDomain>` / `<id>.<functionsDomain>`; the domains default to
 * `sites.<DOMAIN>` and `functions.<DOMAIN>` (or `sites.localhost` locally).
 */
import type { Config } from '~/config'

/** `value` as a host name: lowercase, no scheme, path, port or trailing dot. */
export function hostOf(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
}

export const sitesDomainOf = (config: Pick<Config, 'sitesDomain'>): string =>
  hostOf(config.sitesDomain || 'sites.localhost')

export const functionsDomainOf = (config: Pick<Config, 'functionsDomain'>): string =>
  hostOf(config.functionsDomain || 'functions.localhost')

export const siteHost = (config: Pick<Config, 'sitesDomain'>, id: string): string => `${id}.${sitesDomainOf(config)}`

export const functionHost = (config: Pick<Config, 'functionsDomain'>, id: string): string => `${id}.${functionsDomainOf(config)}`

/** The scheme and port a host is reachable on, from PUBLIC_ENDPOINT. */
export function urlForHost(config: Pick<Config, 'publicEndpoint'>, host: string): string {
  const api = new URL(config.publicEndpoint)
  return `${api.protocol}//${host}${api.port ? `:${api.port}` : ''}`
}
