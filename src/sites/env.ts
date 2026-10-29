/**
 * Environment for a site's build and runtime. Sites, like functions, run on
 * this host: they get the server's environment without the secrets that are
 * only for the server, plus the Bun-backed `bun`/`npm` shims, so a start
 * command such as `npm start` works in the small Docker image too.
 */
import { buildToolsDir } from '~/functions/runtime'
import type { Config } from '~/config'
import { siteHome } from './paths'

/** Server-only settings a site's build or app never needs to see. */
const PRIVATE_ENV = ['SECRET', 'API_KEYS', 'GOOGLE_CLIENT_SECRET', 'SMTP_PASSWORD', 'CONSOLE_ADMIN_PASSWORD']

/**
 * The base environment for building and running a site. `HOME` and `TMPDIR`
 * point at the site's own home when the sandbox is on, so package caches and
 * temporary files stay inside its folder.
 */
export function siteBaseEnv(
  config: Config,
  siteId: string,
  variables: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !PRIVATE_ENV.includes(key)) env[key] = value
  // Project variables first, then the site's own (the caller has already
  // merged them). A variable saved in the console wins over the host env.
  Object.assign(env, variables)
  env.PATH = [env.PATH, buildToolsDir(config)].filter(Boolean).join(':')
  // Most installers are less chatty and never prompt with CI set.
  env.CI ??= '1'
  if (config.functionsSandbox) env.HOME = env.TMPDIR = siteHome(config, siteId)
  return env
}

/** What a site's app gets: its build environment plus the address to listen on. */
export function siteRuntimeEnv(
  config: Config,
  siteId: string,
  port: number,
  variables: Record<string, string> = {},
): Record<string, string> {
  return {
    ...siteBaseEnv(config, siteId, variables),
    NODE_ENV: 'production',
    PORT: String(port),
    // Next and Nuxt read HOSTNAME, SvelteKit and most others read HOST.
    HOST: '127.0.0.1',
    HOSTNAME: '127.0.0.1',
    // Adapters that build absolute URLs can trust these forwarding headers.
    PROTOCOL_HEADER: 'x-forwarded-proto',
    HOST_HEADER: 'x-forwarded-host',
    BUNWRITE_SITE_ID: siteId,
  }
}
