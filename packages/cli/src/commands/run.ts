/**
 * `bunwrite run [--env <name>] [--function-id <id> | --site-id <id>] [--preview] -- <command>`:
 * start a local command with the variables the server would use, from the
 * same .env files as `bunwrite env`. The project's files apply first, then a
 * function's or site's own, over the shell's environment. Live values by
 * default; `--preview` uses what a Git preview build sees instead.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import { bool, flagList, type Args } from '../args'
import { readConfig } from '../config'
import { envFiles, mergeEnv, type EnvFile, type EnvValue } from '../envfiles'
import { target } from '../environments'
import { CliError, closeAsk, dim, warn } from '../ui'
import { scopesOf } from './env'

/** The variables for a run, and the files they came from. */
export function runEnvironment(args: Args): { values: Map<string, string>; files: EnvFile[]; placeholders: string[] } {
  const config = readConfig()
  const name = target(config).name
  const files = [...envFiles(config, name)]
  const ids = [...flagList(args, 'function-id'), ...flagList(args, 'site-id')]
  if (ids.length > 1) throw new CliError('Give one --function-id or --site-id: a run is one process.')
  if (ids.length) {
    const scope = scopesOf(config, name, args).find((s) => s.kind !== 'project')
    if (!scope) throw new CliError(`${ids[0]} is not a function or site in the config.`)
    files.push(...scope.files)
  }
  // Like the server: a variable's live or preview value wins over its every-deployment one.
  const context = bool(args, 'preview') ? 'preview' : 'live'
  const merged = new Map<string, EnvValue>([...mergeEnv(files), ...mergeEnv(files, context)])
  const values = new Map<string, string>()
  const placeholders: string[] = []
  for (const [key, { value, secret }] of merged) {
    // A pulled secret is an empty placeholder: leave it unset rather than empty.
    if (secret && value === '') {
      placeholders.push(key)
      values.delete(key)
      continue
    }
    values.set(key, value)
  }
  return { values, files: files.filter((f) => (f.context === '' || f.context === context) && existsSync(f.path)), placeholders }
}

export async function run(args: Args): Promise<number> {
  const command = args.positional.slice(1)
  if (!command.length) throw new CliError('Usage: bunwrite run [--env <name>] [--function-id <id>] -- <command> [args...]')
  const { values, files, placeholders } = runEnvironment(args)
  const name = target().name
  const preview = bool(args, 'preview') ? ' (preview)' : ''
  console.error(dim(`→ ${name ?? 'local'}${preview}: ${values.size} variable${values.size === 1 ? '' : 's'} from ${files.map((f) => f.label).join(', ') || 'no env files'}`))
  if (placeholders.length) {
    warn(`${placeholders.join(', ')} ${placeholders.length === 1 ? 'is a secret' : 'are secrets'} set only on the server; put a value in the .local file to use it here.`)
  }

  closeAsk()
  const env = { ...process.env, ...Object.fromEntries(values) }
  const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit', env })
  // The terminal sends Ctrl-C to both; let the child decide, then exit with it.
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
  const onInt = forward('SIGINT')
  const onTerm = forward('SIGTERM')
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  try {
    return await new Promise<number>((resolve, reject) => {
      child.on('error', (error: NodeJS.ErrnoException) =>
        reject(error.code === 'ENOENT' ? new CliError(`Command not found: ${command[0]}`) : error),
      )
      child.on('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)))
    })
  } finally {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
  }
}
