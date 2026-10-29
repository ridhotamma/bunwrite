/**
 * Two files:
 *
 * - Global preferences, `~/.bunwrite/prefs.json` (or `$BUNWRITE_HOME/prefs.json`):
 *   the endpoint, and an API key and/or a console sign-in.
 * - The project config in the current folder: `bunwrite.config.json` or
 *   `bunwrite.json`. An existing `appwrite.config.json` (Appwrite's CLI) is read
 *   and written too; its format is the same.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { CliError } from './ui'

export interface Session {
  endpoint?: string
  projectId?: string
  key?: string
  email?: string
  /** The console session cookie (`bw_session_console=...`, or `a_session_console=...` from an Appwrite-mode server). */
  cookie?: string
  selfSigned?: boolean
  /** API keys by project ID, saved with `bunwrite client --env <name> --key <key>`. */
  keys?: Record<string, string>
}

export interface Prefs {
  current: string
  sessions: Record<string, Session>
  /** The environment chosen with `bunwrite env use`, by project folder. */
  folders?: Record<string, { environment?: string }>
}

const home = () => process.env.BUNWRITE_HOME ?? join(homedir(), '.bunwrite')
export const prefsPath = () => join(home(), 'prefs.json')

export function readPrefs(): Prefs {
  try {
    const prefs = JSON.parse(readFileSync(prefsPath(), 'utf8')) as Prefs
    if (prefs && typeof prefs.sessions === 'object') return prefs
  } catch {
    /* none yet */
  }
  return { current: 'default', sessions: { default: {} } }
}

export function writePrefs(prefs: Prefs): void {
  mkdirSync(home(), { recursive: true, mode: 0o700 })
  writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2) + '\n', { mode: 0o600 })
}

export function currentSession(prefs = readPrefs()): Session {
  return prefs.sessions[prefs.current] ?? {}
}

export function updateSession(change: (session: Session) => void): Session {
  const prefs = readPrefs()
  const session = (prefs.sessions[prefs.current] ??= {})
  change(session)
  for (const key of Object.keys(session) as (keyof Session)[]) if (session[key] === undefined) delete session[key]
  writePrefs(prefs)
  return session
}

const sameEndpoint = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/** Name of the saved session for a server: the current one when it matches (or has no server yet). */
function sessionNameFor(prefs: Prefs, endpoint: string | undefined): string | undefined {
  const current = prefs.sessions[prefs.current]
  if (!endpoint || !current?.endpoint || sameEndpoint(current.endpoint, endpoint)) return prefs.current
  return Object.entries(prefs.sessions).find(([, s]) => s.endpoint && sameEndpoint(s.endpoint, endpoint))?.[0]
}

/** The sign-in and keys for a server, so environments on different servers each use their own. */
export function sessionFor(endpoint: string | undefined, prefs = readPrefs()): Session {
  const name = sessionNameFor(prefs, endpoint)
  return name ? (prefs.sessions[name] ?? {}) : { endpoint }
}

/** Change the session for a server, adding one named after its host when there is none. */
export function updateSessionFor(endpoint: string | undefined, change: (session: Session) => void): Session {
  const prefs = readPrefs()
  let name = sessionNameFor(prefs, endpoint)
  if (!name) {
    const host = new URL(endpoint!).host
    name = host
    for (let n = 2; prefs.sessions[name]; n++) name = `${host}-${n}`
  }
  const session = (prefs.sessions[name] ??= {})
  change(session)
  for (const key of Object.keys(session) as (keyof Session)[]) if (session[key] === undefined) delete session[key]
  writePrefs(prefs)
  return session
}

// ---- Project config ----

export interface ProjectConfig {
  projectId?: string
  projectName?: string
  organizationId?: string
  endpoint?: string
  settings?: any
  functions?: any[]
  sites?: any[]
  tablesDB?: any[]
  tables?: any[]
  databases?: any[]
  collections?: any[]
  buckets?: any[]
  teams?: any[]
  webhooks?: any[]
  topics?: any[]
  /** Named targets such as staging and production; see environments.ts. */
  environments?: Record<string, Environment>
  /** Used when no environment is chosen with --env, BUNWRITE_ENV or `env use`. */
  defaultEnvironment?: string
  /** Folder with the .env files, relative to the config file. Default: the config file's folder. */
  envDir?: string
  [key: string]: unknown
}

export interface Environment {
  /** Copy another environment's settings, then change some. */
  extends?: string
  endpoint?: string
  projectId?: string
  projectName?: string
  organizationId?: string
  /** Push asks you to type the environment's name first. */
  protected?: boolean
}

/** Looked for in this order; a new file is bunwrite.config.json. */
export const CONFIG_FILES = ['bunwrite.config.json', 'bunwrite.json', 'appwrite.config.json']

export function configPath(dir = process.cwd()): string {
  for (const name of CONFIG_FILES) if (existsSync(join(dir, name))) return join(dir, name)
  return join(dir, CONFIG_FILES[0]!)
}

export function readConfig(dir = process.cwd()): ProjectConfig {
  const path = configPath(dir)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new CliError(`${path} is not valid JSON: ${(error as Error).message}`)
  }
}

export function writeConfig(config: ProjectConfig, dir = process.cwd()): string {
  const path = configPath(dir)
  writeFileSync(path, JSON.stringify(config, null, 4) + '\n')
  return path
}
