/**
 * Bunwrite CLI: `client`, `login`, `whoami`, `logout`, `init project`,
 * `init skill` / `skills`, `pull`/`push` of the project config, and one
 * command per SDK service.
 */
import { SDK_VERSION } from '@bunwrite/sdk'

import { bool, flag, parseArgs } from './args'
import { describe } from './clients'
import { client, initProject, login, logout, whoami } from './commands/account'
import { env } from './commands/env'
import { runService, SERVICES } from './commands/services'
import { skills } from './commands/skills'
import { sync } from './commands/sync'
import { chooseEnvironment } from './environments'
import { bold, CliError, dim, fail, log } from './ui'

// Set from package.json by scripts/build.ts; running from source, it is a dev version.
declare const __BUNWRITE_CLI_VERSION__: string | undefined
export const VERSION: string = typeof __BUNWRITE_CLI_VERSION__ === 'string' ? __BUNWRITE_CLI_VERSION__ : '0.0.0-dev'

const HELP = `${bold('bunwrite')} <command> [options]

${bold('Connect')}
  client --endpoint <url> --project-id <id> --key <api-key>   Use an API key
  client                                                       Show the settings
  client --reset                                               Forget them
  login --endpoint <url> --email <email> --password <pass>    Sign in as a console admin
  whoami                                                       Who is signed in
  logout                                                       Sign out, here and on the server

${bold('Project config')} (bunwrite.config.json or bunwrite.json; an existing appwrite.config.json works too)
  init project --project-id <id> [--organization-id <id>] [--create --project-name <name>]
                 [--skills | --no-skills]
  pull <what>     Write the server's state into the config
  push <what>     Apply the config to the server

  <what> is settings, tables, collections, functions, sites, buckets, teams,
  webhooks, topics or all.

  --function-id <id>   pull/push only these functions (repeat, or comma-separate)
  --site-id <id>       pull/push only these sites
  --table-id <id>      push only these tables (--collection-id for collections)
  --no-code            pull/push functions and sites without their code or files
  --with-variables     push sites with the variables in their .env
  --activate false     push functions and sites without making the new version live
  --prune              push: delete what is on the server but not in the config
  --force              push: delete without asking

${bold('Environments')} ("environments" in the config: a server and project per name)
  env list             Environments, their targets and .env files
  env use <name>       Use this environment in this folder (--clear forgets it)
  env diff             What env push would change
  env push             Apply .env, .env.<name> and .env.<name>.local to the project's variables
  env pull             Write the project's variables into those files

  --env <name>         Any command: run against this environment (or set BUNWRITE_ENV)
  --prune              env push/pull: also remove what the other side does not have
  --yes                env push/pull, push: apply without asking (CI)

  Values in a .local file are stored as secret. Secrets cannot be read back, so
  pull writes them as empty placeholders, and push never sends an empty one.

${bold('AI agents')}
  skills               Install Bunwrite agent skills with the Skills CLI
  init skill           Same as skills
    --skill <name>     Only these skills (repeat)
    --agent <name>     Only these agents, e.g. claude-code, cursor, codex
    --global           Install for every project
    --copy             Copy files instead of symlinking
    --list             List the available skills without installing
    --all              Install all skills to all agents without prompts
    --yes              Skip confirmation prompts
    --print            Print the npx command instead of running it

${bold('Services')}
  ${Object.keys(SERVICES).join(', ')}

  bunwrite <service> --help             List its commands
  bunwrite <service> <command> --flags  Call the SDK, e.g.
  bunwrite databases list-documents --database-id main --collection-id products
  bunwrite storage create-file --bucket-id photos --file-id unique() --file ./cat.png

  --json     Print compact JSON
  --output   Save a download to this file

${dim(`SDK ${SDK_VERSION}`)}`

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)
  const [command, sub] = args.positional
  try {
    chooseEnvironment(flag(args, 'env'))
    if (bool(args, 'version')) {
      log(VERSION)
      return 0
    }
    if (!command || command === 'help' || (bool(args, 'help') && !SERVICES[command])) {
      log(HELP)
      return 0
    }
    switch (command) {
      case 'client':
        await client(args)
        break
      case 'login':
        await login(args)
        break
      case 'whoami':
        await whoami()
        break
      case 'logout':
        await logout()
        break
      case 'init':
        if (sub === 'skill' || sub === 'skills') {
          await skills(args)
          break
        }
        if (sub !== 'project') throw new CliError('Usage: bunwrite init project --project-id <id>, or bunwrite init skill')
        await initProject(args)
        break
      case 'skills':
        await skills(args)
        break
      case 'pull':
      case 'push':
        await sync(command, args)
        break
      case 'env':
        await env(args)
        break
      default:
        await runService(args)
    }
    return 0
  } catch (error) {
    fail(error instanceof CliError ? error.message : describe(error))
    if (process.env.BUNWRITE_DEBUG && error instanceof Error && error.stack) console.error(dim(error.stack))
    return 1
  }
}

const code = await main()
process.exit(code)
