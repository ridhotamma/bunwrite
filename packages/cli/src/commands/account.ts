import { Account, BunwriteException, Client, Health, Organization, Project } from '@bunwrite/sdk'

import { bool, flag, type Args } from '../args'
import { consoleClient, CONSOLE_PROJECT, describe, projectClient } from '../clients'
import { currentSession, readConfig, updateSession, writeConfig } from '../config'
import { ask, bold, CliError, dim, info, log, success, warn } from '../ui'
import { offerSkills } from './skills'

const mask = (key: string) => (key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : '••••')

/** Refuse an endpoint that is not a Bunwrite API. */
async function checkEndpoint(endpoint: string, selfSigned: boolean): Promise<void> {
  try {
    const client = new Client().setEndpoint(endpoint)
    if (selfSigned) client.setSelfSigned(true)
    const { version } = await new Health(client).getVersion()
    if (!version) throw new Error('no version')
  } catch (error) {
    const reason = error instanceof BunwriteException ? 'it does not answer /health/version' : describe(error)
    throw new CliError(`Invalid endpoint ${endpoint}: ${reason}. Use the API address ending in /v1.`)
  }
}

/** `bunwrite client`: set the endpoint, project and API key, or show them. */
export async function client(args: Args): Promise<void> {
  if (bool(args, 'reset')) {
    updateSession((s) => {
      delete s.endpoint
      delete s.projectId
      delete s.key
      delete s.selfSigned
    })
    success('Client settings cleared')
    return
  }
  const endpoint = flag(args, 'endpoint')
  const projectId = flag(args, 'project-id')
  const key = flag(args, 'key')
  const selfSigned = args.flags.has('self-signed') ? bool(args, 'self-signed') : undefined
  if (!endpoint && !projectId && !key && selfSigned === undefined) {
    const s = currentSession()
    log(`Endpoint    ${s.endpoint ?? dim('not set')}`)
    log(`Project ID  ${s.projectId ?? dim('not set')}`)
    log(`API key     ${s.key ? mask(s.key) : dim('not set')}`)
    if (s.email) log(`Signed in   ${s.email}`)
    return
  }
  if (endpoint) await checkEndpoint(endpoint, selfSigned ?? currentSession().selfSigned ?? false)
  updateSession((s) => {
    if (endpoint) s.endpoint = endpoint
    if (projectId) s.projectId = projectId
    if (key) s.key = key
    if (selfSigned !== undefined) s.selfSigned = selfSigned
  })
  success('Client settings saved')
}

/** `bunwrite login`: sign in as a console admin. */
export async function login(args: Args): Promise<void> {
  const session = currentSession()
  const endpoint = flag(args, 'endpoint') ?? readConfig().endpoint ?? session.endpoint
  if (!endpoint) throw new CliError('Give the server with --endpoint https://your-server/v1')
  const email = flag(args, 'email') ?? (await ask('Email: ')).trim()
  const password = flag(args, 'password') ?? (await ask('Password: '))
  if (!email || !password) throw new CliError('Email and password are required.')

  // The SDK returns the session, not its cookie; sign in with fetch to keep it.
  const response = await fetch(`${endpoint}/account/sessions/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bunwrite-project': CONSOLE_PROJECT },
    body: JSON.stringify({ email, password }),
  }).catch((error) => {
    throw new CliError(describe(error))
  })
  const body = (await response.json().catch(() => ({}))) as { message?: string; type?: string }
  if (!response.ok) throw new BunwriteException(body.message ?? `Sign-in failed (${response.status})`, response.status, body.type ?? '')
  const raw = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? '']
  const cookie = raw.map((c) => c.split(';')[0]!).find((c) => /^(bw|a)_session_console=/.test(c))
  if (!cookie) throw new CliError('The server did not return a console session. Is this a Bunwrite server?')

  updateSession((s) => {
    s.endpoint = endpoint
    s.email = email
    s.cookie = cookie
  })
  success(`Signed in as ${email}`)
}

/** `bunwrite whoami` */
export async function whoami(): Promise<void> {
  const session = currentSession()
  if (!session.cookie) {
    if (session.key) info(`No user is signed in; using an API key for project ${session.projectId ?? '(not set)'} at ${session.endpoint}`)
    else info('No user is signed in. Run `bunwrite login`.')
    return
  }
  try {
    const account = await new Account(consoleClient()).get()
    log(`${bold(account.email)} at ${session.endpoint}`)
  } catch (error) {
    if (error instanceof BunwriteException && error.code === 401) {
      info('No user is signed in: the session has ended. Run `bunwrite login`.')
      return
    }
    throw error
  }
}

/** `bunwrite logout`: end the console session here and on the server. */
export async function logout(): Promise<void> {
  const session = currentSession()
  if (!session.cookie) {
    info('No user is signed in.')
    return
  }
  try {
    await new Account(consoleClient()).deleteSession({ sessionId: 'current' })
  } catch (error) {
    if (!(error instanceof BunwriteException && error.code === 401)) warn(`The server did not end the session: ${describe(error)}`)
  }
  updateSession((s) => {
    delete s.cookie
    delete s.email
  })
  success('Logged out')
}

/** `bunwrite init project`: link this folder to a project. */
export async function initProject(args: Args): Promise<void> {
  const config = readConfig()
  const projectId = flag(args, 'project-id') ?? config.projectId ?? (await ask('Project ID: ')).trim()
  if (!projectId) throw new CliError('Give the project with --project-id')
  const organizationId = flag(args, 'organization-id')
  const session = currentSession()

  let name: string
  let orgId: string | undefined = organizationId
  if (session.cookie) {
    const console = consoleClient({ ...config, organizationId })
    const organization = new Organization(console)
    try {
      const project = await organization.getProject({ projectId })
      name = project.name
      orgId = project.teamId
    } catch (error) {
      if (!(error instanceof BunwriteException && error.code === 404 && bool(args, 'create'))) throw error
      name = flag(args, 'project-name') ?? projectId
      const created = await organization.createProject({ projectId, name } as any)
      orgId = created.teamId
      success(`Created project ${name} ( ${projectId} )`)
    }
  } else if (session.key) {
    const { client } = projectClient({ ...config, projectId }, session)
    name = (await new Project(client).get()).name
  } else {
    throw new CliError('Not signed in. Run `bunwrite login`, or set an API key with `bunwrite client --key <key>`.')
  }

  const next = { ...config, ...(orgId ? { organizationId: orgId } : {}), projectId, projectName: name }
  const path = writeConfig(next)
  success(`Linked this folder to ${name} ( ${projectId} ) in ${path.split('/').at(-1)}`)
  await offerSkills(args)
}
