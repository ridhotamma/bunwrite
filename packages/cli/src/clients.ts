import { BunwriteException, Client } from '@bunwrite/sdk'

import type { ProjectConfig, Session } from './config'
import { activeSession, announceTarget, target, targetConfig } from './environments'
import { CliError } from './ui'

export const CONSOLE_PROJECT = 'console'

function base(session: Session, config: ProjectConfig): Client {
  const endpoint = config.endpoint ?? session.endpoint
  if (!endpoint) throw new CliError('No endpoint set. Run `bunwrite client --endpoint https://your-server/v1` or `bunwrite login`.')
  const client = new Client().setEndpoint(endpoint)
  if (session.selfSigned) client.setSelfSigned(true)
  return client
}

export interface ProjectClient {
  client: Client
  projectId: string
  /** How the calls are authorised. */
  auth: 'key' | 'console'
}

/**
 * The API key for a project: BUNWRITE_API_KEY, one saved for that project,
 * or the session's key. With an environment active, the session's key is
 * used only for the project it was saved with.
 */
function keyFor(session: Session, projectId: string): string | undefined {
  if (process.env.BUNWRITE_API_KEY) return process.env.BUNWRITE_API_KEY
  if (session.keys?.[projectId]) return session.keys[projectId]
  if (!session.key) return undefined
  if (target().name && session.projectId && session.projectId !== projectId) return undefined
  return session.key
}

/**
 * A client for the linked project (or the active environment's): the API key
 * if there is one, else the console sign-in in admin mode.
 */
export function projectClient(config = targetConfig(), session = activeSession(config)): ProjectClient {
  const client = base(session, config)
  const projectId = config.projectId ?? session.projectId
  if (!projectId) throw new CliError('No project. Run `bunwrite init project --project-id <id>` here, or `bunwrite client --project-id <id>`.')
  client.setProject(projectId)
  announceTarget(projectId, config.endpoint ?? session.endpoint)
  const key = keyFor(session, projectId)
  if (key) {
    client.setKey(key)
    return { client, projectId, auth: 'key' }
  }
  if (session.cookie) {
    client.setCookie(session.cookie).addHeader('X-Bunwrite-Mode', 'admin')
    if (config.organizationId) client.setOrganization(config.organizationId)
    return { client, projectId, auth: 'console' }
  }
  const env = target().name
  throw new CliError(
    env
      ? `Not signed in to ${config.endpoint ?? 'the server'} for ${env}. Run \`bunwrite login --env ${env}\`, or \`bunwrite client --env ${env} --key <key>\`.`
      : 'Not signed in. Run `bunwrite login`, or set an API key with `bunwrite client --key <key>`.',
  )
}

/** A client for the console API: needs `bunwrite login`. */
export function consoleClient(config = targetConfig(), session = activeSession(config)): Client {
  if (!session.cookie) throw new CliError('This needs a console sign-in. Run `bunwrite login` first.')
  const client = base(session, config).setProject(CONSOLE_PROJECT).setCookie(session.cookie)
  if (config.organizationId) client.setOrganization(config.organizationId)
  return client
}

/** Errors from the server, shown as one line. */
export function describe(error: unknown): string {
  if (error instanceof BunwriteException) {
    if (error.code === 401 && /role: guests/.test(error.message)) return `${error.message}. Sign in again with \`bunwrite login\`.`
    return error.type ? `${error.message} (${error.code} ${error.type})` : error.message
  }
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause
    if (cause?.code === 'ECONNREFUSED' || /Unable to connect|ECONNREFUSED|fetch failed/i.test(error.message)) {
      return `Could not reach the server: ${error.message}`
    }
    return error.message
  }
  return String(error)
}
