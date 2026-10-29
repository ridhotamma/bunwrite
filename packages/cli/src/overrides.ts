/**
 * How one environment sees the shared config: `idSuffix` and `overrides`.
 *
 * Site and function IDs are addresses (`<id>.<SITES_DOMAIN>`), so they are
 * unique across every project on a server. Two environments on one server
 * therefore need different IDs; `idSuffix` adds one to every site and
 * function (`landing` → `landing-staging`), and `apiFunctionId` follows.
 *
 * `overrides` changes fields of one entry, by its shared `$id`, for one
 * environment, such as a site's domains:
 *
 *   "overrides": {
 *     "sites": { "landing": { "domains": ["staging.example.com"] } },
 *     "functions": { "backup": { "schedule": "" } },
 *     "settings": { ... }
 *   }
 *
 * Pushes send the environment's view. Pulls map what comes back to the
 * shared IDs and keep the shared values of overridden fields, so the config
 * file stays the same whichever environment it was pulled from.
 */
import type { Environment, ProjectConfig } from './config'
import { CliError } from './ui'

/** Kinds whose IDs are server-wide addresses; `idSuffix` applies to these. */
const SUFFIXED = ['sites', 'functions']

type Item = Record<string, any>

export interface EnvironmentView {
  /** The config as this environment pushes it. */
  config: ProjectConfig
  /** A shared ID as this environment names it on the server. */
  envId(kind: string, id: string): string
  /** A pulled config back in shared terms: shared IDs and shared values of overridden fields. */
  restore(pulled: ProjectConfig): ProjectConfig
}

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)))
const isItems = (value: unknown): value is Item[] => Array.isArray(value) && value.every((v) => v && typeof v === 'object' && typeof v.$id === 'string')

export function environmentView(config: ProjectConfig, env: Environment | null): EnvironmentView {
  const suffix = env?.idSuffix ?? ''
  const overrides: Record<string, any> = env?.overrides ?? {}
  if (!suffix && !Object.keys(overrides).length) {
    return { config, envId: (_kind, id) => id, restore: (pulled) => pulled }
  }

  const toEnv = new Map<string, Map<string, string>>()
  const out = clone(config) as ProjectConfig
  for (const [kind, value] of Object.entries(out)) {
    if (!isItems(value)) continue
    const ids = new Map<string, string>()
    for (const item of value) {
      const base = item.$id as string
      const override = overrides[kind]?.[base]
      let id = suffix && SUFFIXED.includes(kind) ? `${base}${suffix}` : base
      if (override) {
        Object.assign(item, clone(override))
        if (typeof override.$id === 'string') id = override.$id
      }
      item.$id = id
      if (id !== base) ids.set(base, id)
    }
    toEnv.set(kind, ids)
  }
  // Overrides must name entries the config has, or a typo would silently do nothing.
  for (const [kind, entries] of Object.entries(overrides)) {
    if (kind === 'settings') continue
    if (!isItems((config as Item)[kind])) throw new CliError(`overrides.${kind}: the config has no "${kind}" list.`)
    for (const id of Object.keys(entries ?? {})) {
      if (!((config as Item)[kind] as Item[]).some((item) => item.$id === id)) throw new CliError(`overrides.${kind}.${id}: no entry with that $id in "${kind}".`)
    }
  }
  if (overrides.settings) out.settings = { ...(out.settings ?? {}), ...clone(overrides.settings) }
  const functionIds = toEnv.get('functions') ?? new Map<string, string>()
  for (const site of (out.sites ?? []) as Item[]) {
    if (site.apiFunctionId && functionIds.has(site.apiFunctionId)) site.apiFunctionId = functionIds.get(site.apiFunctionId)
  }

  const envId = (kind: string, id: string) => toEnv.get(kind)?.get(id) ?? id

  const restore = (pulled: ProjectConfig): ProjectConfig => {
    const back = clone(pulled) as ProjectConfig
    for (const [kind, value] of Object.entries(back)) {
      if (!isItems(value)) continue
      const reverse = new Map([...(toEnv.get(kind) ?? new Map<string, string>())].map(([base, id]) => [id, base]))
      const shared = isItems((config as Item)[kind]) ? ((config as Item)[kind] as Item[]) : []
      for (const item of value) {
        const id: string = item.$id
        // A new entry pulled from this environment (not in the config yet) loses the suffix too.
        const stripped = suffix && SUFFIXED.includes(kind) && id.endsWith(suffix) ? id.slice(0, -suffix.length) : id
        const base: string = reverse.get(id) ?? stripped
        const override = overrides[kind]?.[base]
        if (override) {
          const original = shared.find((s) => s.$id === base)
          for (const field of Object.keys(override)) {
            if (field === '$id') continue
            if (original && field in original) item[field] = clone(original[field])
            else delete item[field]
          }
        }
        item.$id = base
      }
    }
    if (overrides.settings && back.settings) {
      for (const field of Object.keys(overrides.settings)) {
        if (config.settings && field in config.settings) back.settings[field] = clone(config.settings[field])
        else delete back.settings[field]
      }
    }
    const reverseFunctions = new Map([...functionIds].map(([base, id]) => [id, base]))
    for (const site of (back.sites ?? []) as Item[]) {
      if (site.apiFunctionId && reverseFunctions.has(site.apiFunctionId)) site.apiFunctionId = reverseFunctions.get(site.apiFunctionId)
    }
    return back
  }

  return { config: out, envId, restore }
}
