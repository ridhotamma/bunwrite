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
}

export interface Prefs {
  current: string
  sessions: Record<string, Session>
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

// ---- Project config ----

export interface ProjectConfig {
  projectId?: string
  projectName?: string
  organizationId?: string
  endpoint?: string
  settings?: any
  functions?: any[]
  tablesDB?: any[]
  tables?: any[]
  databases?: any[]
  collections?: any[]
  buckets?: any[]
  teams?: any[]
  webhooks?: any[]
  topics?: any[]
  [key: string]: unknown
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
