/**
 * `bunwrite <service> <method> --param value ...`: any SDK call from the
 * command line. Method and flag names are the SDK's in kebab-case:
 * `databases list-documents --database-id main`.
 */
import { existsSync, writeFileSync } from 'node:fs'

import * as sdk from '@bunwrite/sdk'

import { camelToKebab, flag, kebabToCamel, type Args } from '../args'
import { consoleClient, projectClient } from '../clients'
import { readConfig } from '../config'
import { bold, CliError, dim, log, success } from '../ui'

export const SERVICES: Record<string, new (client: sdk.Client) => object> = {
  account: sdk.Account,
  databases: sdk.Databases,
  'tables-db': sdk.TablesDB,
  storage: sdk.Storage,
  functions: sdk.Functions,
  teams: sdk.Teams,
  users: sdk.Users,
  messaging: sdk.Messaging,
  webhooks: sdk.Webhooks,
  project: sdk.Project,
  organization: sdk.Organization,
  health: sdk.Health,
  render: sdk.Render,
}

/** Flags that belong to the CLI, not the call. */
const OWN = new Set(['json', 'output', 'help', 'console'])

/** Params that take a file: given a path that exists, the file is uploaded. */
const FILE_PARAMS = new Set(['file', 'code'])

function methodsOf(service: object): string[] {
  const proto = Object.getPrototypeOf(service)
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && typeof proto[name] === 'function' && !name.startsWith('_'))
    .sort()
}

/** A flag value: JSON when it parses (numbers, booleans, arrays, objects), else the string. */
function value(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export function serviceHelp(name: string): void {
  const Service = SERVICES[name]!
  const methods = methodsOf(new Service(new sdk.Client()))
  log(`${bold(`bunwrite ${name}`)} <command> [--param value ...]\n`)
  for (const m of methods) log(`  ${camelToKebab(m)}`)
  log(dim(`\nFlags are the SDK's params in kebab-case. Values are JSON when they parse; repeat a flag for a list.`))
}

export async function runService(args: Args): Promise<void> {
  const [name, command] = args.positional
  const Service = SERVICES[name!]
  if (!Service) throw new CliError(`Unknown command "${name}". Run \`bunwrite help\`.`)
  if (!command || flag(args, 'help') === 'true') return serviceHelp(name!)

  const method = kebabToCamel(command)
  const config = readConfig()
  // `organization` and the console's own account live in the console project.
  const client = name === 'organization' || flag(args, 'console') === 'true' ? consoleClient(config) : projectClient(config).client
  const service = new Service(client) as Record<string, unknown>
  if (typeof service[method] !== 'function') throw new CliError(`"${name}" has no command "${command}". Run \`bunwrite ${name} --help\`.`)

  const params: Record<string, unknown> = {}
  for (const [key, values] of args.flags) {
    if (OWN.has(key)) continue
    const param = kebabToCamel(key)
    if (param === 'queries') {
      // Each query is a JSON string, as Query.* makes them; a JSON array of them works too.
      params.queries = values.flatMap((v) => {
        const parsed = value(v)
        return Array.isArray(parsed) ? parsed.map((q) => (typeof q === 'string' ? q : JSON.stringify(q))) : [v]
      })
      continue
    }
    if (FILE_PARAMS.has(param) && values.length === 1 && existsSync(values[0]!)) {
      params[param] = sdk.InputFile.fromPath(values[0]!)
      continue
    }
    params[param] = values.length > 1 ? values.map(value) : value(values[0]!)
  }

  const result = await (service[method] as (p: object) => unknown).call(service, params)
  if (result instanceof ArrayBuffer) {
    const output = flag(args, 'output')
    if (output) {
      writeFileSync(output, new Uint8Array(result))
      success(`Saved ${result.byteLength} bytes to ${output}`)
    } else {
      process.stdout.write(new Uint8Array(result))
    }
    return
  }
  if (result === undefined || result === '' || (typeof result === 'object' && result && !Object.keys(result).length)) {
    success('Done')
    return
  }
  log(flag(args, 'json') === 'true' ? JSON.stringify(result) : typeof result === 'string' ? result : JSON.stringify(result, null, 2))
}
