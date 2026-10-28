import { BunwriteException, Client } from '@bunwrite/sdk'

import { currentSession, readConfig, type ProjectConfig, type Session } from './config'
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

/** A client for the linked project: the API key if there is one, else the console sign-in in admin mode. */
export function projectClient(config = readConfig(), session = currentSession()): ProjectClient {
  const client = base(session, config)
  const projectId = config.projectId ?? session.projectId
  if (!projectId) throw new CliError('No project. Run `bunwrite init project --project-id <id>` here, or `bunwrite client --project-id <id>`.')
  client.setProject(projectId)
  if (session.key) {
    client.setKey(session.key)
    return { client, projectId, auth: 'key' }
  }
  if (session.cookie) {
    client.setCookie(session.cookie).addHeader('X-Bunwrite-Mode', 'admin')
    if (config.organizationId) client.setOrganization(config.organizationId)
    return { client, projectId, auth: 'console' }
  }
  throw new CliError('Not signed in. Run `bunwrite login`, or set an API key with `bunwrite client --key <key>`.')
}

/** A client for the console API: needs `bunwrite login`. */
export function consoleClient(config = readConfig(), session = currentSession()): Client {
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
