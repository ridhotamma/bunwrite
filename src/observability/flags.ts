/**
 * Server-side feature flags.
 *
 * Local operators can force values with `FEATURE_FLAGS={"key":true}`, and
 * PostHog evaluates the rest per user/project. Results are cached for
 * `POSTHOG_FLAGS_TTL_MS` so a page that reads several flags does not call the
 * provider once per flag. A provider outage degrades to the local values.
 */
import type { ObservabilityConfig } from './config'
import { fetchPosthogFlags } from './providers'

interface CacheEntry {
  flags: Record<string, boolean | string>
  expires: number
}

const MAX_CACHE = 10_000

export class FlagService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<Record<string, boolean | string>>>()

  constructor(private readonly config: ObservabilityConfig) {}

  get enabled(): boolean {
    return Boolean(this.config.posthog?.flags) || Object.keys(this.config.localFlags).length > 0
  }

  /** Local overrides, then PostHog, then the provider's own defaults. */
  async evaluate(distinctId: string, groups: Record<string, string> = {}): Promise<Record<string, boolean | string>> {
    const local = this.config.localFlags
    const posthog = this.config.posthog
    if (!posthog?.flags) return { ...local }

    const key = `${distinctId}|${JSON.stringify(groups)}`
    const cached = this.cache.get(key)
    if (cached && cached.expires > Date.now()) return { ...cached.flags, ...local }

    let pending = this.inflight.get(key)
    if (!pending) {
      pending = fetchPosthogFlags(posthog, distinctId, groups, this.config.timeoutMs)
        .then((flags) => {
          if (this.cache.size >= MAX_CACHE) {
            const oldest = this.cache.keys().next().value
            if (oldest !== undefined) this.cache.delete(oldest)
          }
          this.cache.set(key, { flags, expires: Date.now() + posthog.flagsTtlMs })
          return flags
        })
        .catch((error) => {
          if (this.config.debug) console.warn('[observability] PostHog flags unavailable:', error instanceof Error ? error.message : error)
          return cached?.flags ?? {}
        })
        .finally(() => {
          this.inflight.delete(key)
        })
      this.inflight.set(key, pending)
    }
    return { ...(await pending), ...local }
  }

  async isEnabled(name: string, distinctId: string, fallback = false, groups: Record<string, string> = {}): Promise<boolean> {
    const value = (await this.evaluate(distinctId, groups))[name]
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') return value !== '' && value !== 'false' && value !== '0'
    return fallback
  }

  clear(): void {
    this.cache.clear()
  }
}
