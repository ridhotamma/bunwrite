/**
 * Environments: named targets in bunwrite.config.json, each a server and a
 * project.
 *
 *   "environments": {
 *     "staging":    { "endpoint": "https://staging.example.com/v1", "projectId": "shop-staging" },
 *     "production": { "endpoint": "https://api.example.com/v1", "projectId": "shop", "protected": true },
 *     "preview":    { "extends": "staging", "projectId": "shop-preview" }
 *   }
 *
 * The active one is the first of: --env, BUNWRITE_ENV, `bunwrite env use`
 * (saved per folder), "defaultEnvironment". Without any, the CLI uses the
 * top-level endpoint and projectId as before.
 */
import { dirname, resolve } from 'node:path'

import { configPath, currentSession, readConfig, readPrefs, sessionFor, type Environment, type ProjectConfig, type Session } from './config'
import { ask, bold, CliError, dim, red } from './ui'

export type EnvironmentSource = '--env' | 'BUNWRITE_ENV' | 'env use' | 'defaultEnvironment'

export interface Target extends Environment {
  /** null when no environment is active. */
  name: string | null
  source: EnvironmentSource | null
}

let fromFlag: string | undefined

/** Set from `--env` before a command runs. */
export function chooseEnvironment(name: string | undefined): void {
  fromFlag = name
}

/** The folder holding the config file; `env use` is remembered per folder. */
export const projectDir = (dir = process.cwd()) => resolve(dirname(configPath(dir)))

export const environmentNames = (config: ProjectConfig) => Object.keys(config.environments ?? {})

function unknown(name: string, config: ProjectConfig, source: EnvironmentSource): CliError {
  const names = environmentNames(config)
  const where = source === '--env' ? '' : ` (from ${source})`
  return new CliError(
    names.length
      ? `Unknown environment "${name}"${where}. Defined: ${names.join(', ')}.`
      : `Environment "${name}"${where} is not defined: bunwrite.config.json has no "environments".`,
  )
}

/** An environment with its `extends` chain applied. */
export function environment(config: ProjectConfig, name: string, source: EnvironmentSource = '--env'): Environment {
  const all = config.environments ?? {}
  const seen: string[] = []
  const chain: Environment[] = []
  for (let current: string | undefined = name; current; current = all[current]?.extends) {
    if (seen.includes(current)) throw new CliError(`Environments extend each other in a loop: ${[...seen, current].join(' → ')}`)
    if (!all[current]) throw unknown(current, config, source)
    seen.push(current)
    chain.unshift(all[current]!)
  }
  const merged: Environment = Object.assign({}, ...chain)
  delete merged.extends
  return merged
}

/** Which environment is active, and why. */
export function target(config = readConfig(), dir = process.cwd()): Target {
  const saved = readPrefs().folders?.[projectDir(dir)]?.environment
  const candidates: [string | undefined, EnvironmentSource][] = [
    [fromFlag, '--env'],
    [process.env.BUNWRITE_ENV || undefined, 'BUNWRITE_ENV'],
    [saved, 'env use'],
    [config.defaultEnvironment, 'defaultEnvironment'],
  ]
  for (const [name, source] of candidates) {
    if (!name) continue
    return { ...environment(config, name, source), name, source }
  }
  return { name: null, source: null }
}

/** The config with the active environment's server and project in place: what clients connect to. */
export function targetConfig(config = readConfig(), dir = process.cwd()): ProjectConfig {
  const t = target(config, dir)
  if (!t.name) return config
  return {
    ...config,
    endpoint: t.endpoint ?? config.endpoint,
    projectId: t.projectId ?? config.projectId,
    organizationId: t.organizationId ?? config.organizationId,
    // A shared projectName would rename every environment's project to it.
    projectName: t.projectName,
  }
}

/**
 * The saved sign-in to use. With an environment active, the one for its
 * server; otherwise the current session, as before environments existed.
 */
export function activeSession(config = targetConfig()): Session {
  return target().name ? sessionFor(config.endpoint) : currentSession()
}

const hostOf = (endpoint: string | undefined) => {
  try {
    return endpoint ? new URL(endpoint).host : undefined
  } catch {
    return endpoint
  }
}

/** One line naming where commands go: `→ staging · shop-staging @ api.example.com`. */
export function describeTarget(t: Target, projectId: string | undefined, endpoint: string | undefined): string {
  const where = [projectId, hostOf(endpoint)].filter(Boolean).join(' @ ')
  const name = t.protected ? red(bold(t.name ?? '')) + red(' (protected)') : bold(t.name ?? '')
  return `→ ${name}${where ? ` · ${where}` : ''}`
}

let announced = false

/** Print the target once per run, on stderr so `--json` output stays clean. */
export function announceTarget(projectId: string | undefined, endpoint: string | undefined): void {
  if (announced) return
  const t = target()
  if (!t.name) return
  announced = true
  console.error(describeTarget(t, projectId, endpoint) + (t.source === '--env' ? '' : dim(`  (${t.source})`)))
}

/**
 * Before changing a protected environment, ask for its name. `--force` or
 * `--yes` skip the question, for CI.
 */
export async function confirmProtected(skip: boolean, action: string): Promise<void> {
  const t = target()
  if (!t.name || !t.protected || skip) return
  const answer = (await ask(`${red(bold(t.name))} is protected. Type its name to ${action}: `)).trim()
  if (answer !== t.name) throw new CliError(`Stopped: nothing was changed in ${t.name}.`)
}
