/**
 * `bunwrite env add <name>`: add an environment in one step. Asks for the
 * server and project (with sensible defaults), checks the server, creates or
 * labels the project when you are signed in to its console, writes the
 * config, and creates the environment's .env files.
 *
 *   --endpoint <url>  --project-id <id>  --protected / --no-protected
 *   --create          create the project when it does not exist
 *   --yes             take the defaults without asking
 */
import { existsSync, writeFileSync } from 'node:fs'

import { BunwriteException, Organization } from '@bunwrite/sdk'

import { bool, flag, type Args } from '../args'
import { consoleClient, describe } from '../clients'
import { currentSession, readConfig, sessionFor, writeConfig, type Environment } from '../config'
import { envFiles, ignoreLocalFiles, writeEnvFile } from '../envfiles'
import { ask, bold, CliError, confirm, dim, info, log, success, warn } from '../ui'
import { checkEndpoint } from './account'

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/
const PRODUCTION = /^(prod|production|live)$/

const hostOf = (endpoint: string) => {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

export async function envAdd(args: Args): Promise<void> {
  const config = readConfig()
  const yes = bool(args, 'yes')
  const askFor = async (question: string, fallback?: string): Promise<string | undefined> => {
    if (yes) return fallback
    const answer = (await ask(`${question}${fallback ? dim(` (${fallback})`) : ''}: `)).trim()
    return answer || fallback
  }

  const name = (args.positional[2] ?? (yes ? '' : await askFor('Environment name, e.g. staging')) ?? '').trim()
  if (!name) throw new CliError('Usage: bunwrite env add <name>')
  if (!NAME.test(name)) throw new CliError(`"${name}" is not a valid environment name: lowercase letters, digits, - and _, up to 32.`)
  if (config.environments?.[name]) throw new CliError(`${name} is already in bunwrite.config.json. Edit it there, or pick another name.`)

  const production = PRODUCTION.test(name)
  const endpoint = flag(args, 'endpoint') ?? (await askFor('Server endpoint', config.endpoint ?? currentSession().endpoint))
  if (!endpoint) throw new CliError('Give the server with --endpoint https://your-server/v1')
  const session = sessionFor(endpoint)
  await checkEndpoint(endpoint, session.selfSigned ?? false)

  // Production usually is the project this folder already uses; others get their own.
  const suggested = config.projectId ? (production ? config.projectId : `${config.projectId}-${name}`) : undefined
  const projectId = flag(args, 'project-id') ?? (await askFor('Project ID', suggested))
  if (!projectId) throw new CliError('Give the project with --project-id <id>')
  const protect = args.flags.has('protected')
    ? bool(args, 'protected')
    : yes
      ? production
      : await confirm(`Protect ${name}? Pushes then ask you to type its name.`, production)

  // With a console sign-in for this server, make sure the project is there and label it.
  let labelled = false
  if (session.cookie) {
    const client = consoleClient({ ...config, endpoint }, session)
    const organization = new Organization(client)
    let exists = true
    try {
      await organization.getProject({ projectId })
    } catch (error) {
      if (!(error instanceof BunwriteException && error.code === 404)) throw error
      exists = false
    }
    if (!exists) {
      const create = bool(args, 'create') || (!yes && (await confirm(`Project ${projectId} does not exist on ${hostOf(endpoint)}. Create it?`, true)))
      if (!create) throw new CliError(`Project ${projectId} does not exist on ${hostOf(endpoint)}. Pass --create, or give an existing --project-id.`)
      const projectName = `${config.projectName ?? config.projectId ?? projectId} (${name})`
      await organization.createProject({ projectId, name: projectName } as any)
      success(`Created project ${projectName} ( ${projectId} )`)
    }
    try {
      const url = new URL(`${client.config.endpoint}/organization/projects/${encodeURIComponent(projectId)}`)
      await client.call('patch', url, { 'content-type': 'application/json' }, { environment: name })
      labelled = true
    } catch (error) {
      warn(`The project was not labelled ${name} in the console: ${describe(error)}`)
    }
  }

  const entry: Environment = {}
  if (endpoint !== config.endpoint) entry.endpoint = endpoint
  entry.projectId = projectId
  if (protect) entry.protected = true
  writeConfig({ ...config, environments: { ...config.environments, [name]: entry } })
  success(`Added ${bold(name)} → ${projectId} @ ${hostOf(endpoint)}${protect ? ' (protected)' : ''}${labelled ? `, labelled ${name} in the console` : ''}`)

  // The live/preview files are optional; only the everyday pair is made.
  const files = envFiles(config, name).filter((f) => f.own && f.context === '')
  const created: string[] = []
  for (const file of files) {
    if (existsSync(file.path)) continue
    const header = file.secret
      ? `# ${name}: secrets, stored as secret on the server. Never commit this file.\n`
      : `# ${name}: variables for every function and site. Commit this file; secrets go in the .local file.\n`
    if (file.secret) writeEnvFile(file, header)
    else writeFileSync(file.path, header)
    created.push(file.label)
  }
  if (created.length) info(`Created ${created.join(' and ')}`)
  const ignored = ignoreLocalFiles()
  if (ignored) info(`Added .env*.local to ${ignored} so secrets stay out of git`)

  log('\nNext:')
  if (!session.cookie && !session.keys?.[projectId]) {
    log(`  bunwrite login --env ${name}          ${dim('sign in to this server (or: bunwrite client --env ' + name + ' --key <key>)')}`)
  }
  log(`  bunwrite env use ${name}              ${dim('use it in this folder (or --env ' + name + ' per command)')}`)
  log(`  bunwrite env push                    ${dim('send the variables in its .env files')}`)
}
