/**
 * `bunwrite env`: project variables kept in .env files, per environment.
 *
 *   env list               environments, their targets and files
 *   env use <name>         remember an environment for this folder (--clear forgets it)
 *   env diff               what `env push` would change
 *   env push [--prune]     apply the files to the project's variables
 *   env pull [--prune]     write the project's variables into the files
 *
 * Secret values cannot be read back from the server, so pull writes them as
 * empty placeholders in the `.local` file, and push never sends an empty
 * `.local` value: a pull followed by a push leaves secrets as they are.
 */
import { existsSync, readFileSync } from 'node:fs'

import { Project, Query } from '@bunwrite/sdk'

import { bool, flag, type Args } from '../args'
import { projectClient } from '../clients'
import { readConfig, readPrefs, writePrefs, type ProjectConfig } from '../config'
import { editEnv, envFiles, ignoreLocalFiles, mergeEnv, readEnvFile, SECRET_NAME, writeEnvFile, type EnvFile, type EnvValue } from '../envfiles'
import { changeCount, planPush, type Plan, type Variable } from '../envplan'
import { confirmProtected, environment, environmentNames, projectDir, target, targetConfig } from '../environments'
import { bold, CliError, confirm, dim, green, info, log, red, success, table, warn, yellow } from '../ui'


async function serverVariables(project: Project): Promise<Variable[]> {
  const out: Variable[] = []
  for (let offset = 0; ; offset += 100) {
    const { variables } = await project.listVariables({ queries: [Query.limit(100), Query.offset(offset)] })
    out.push(...variables)
    if (variables.length < 100) return out
  }
}

function printRows(rows: [string, string, string][]): void {
  const width = Math.max(0, ...rows.map((r) => r[1].length))
  for (const [mark, key, note] of rows) log(`  ${mark} ${key.padEnd(width)}  ${dim(note)}`)
}

function printPlan(plan: Plan, prune: boolean): void {
  const rows: [string, string, string][] = []
  for (const c of plan.create) rows.push([green('+'), c.key, c.secret ? 'new, secret' : 'new'])
  for (const u of plan.update) rows.push([yellow('~'), u.variable.key, u.becomesSecret ? 'becomes secret' : 'changed'])
  for (const r of plan.resend) rows.push([yellow('↻'), r.variable.key, "secret, sent again (its value can't be read back to compare)"])
  for (const v of plan.remove) rows.push([red('-'), v.key, prune ? 'removed' : 'only on the server (removed with --prune)'])
  for (const m of plan.missing) rows.push([yellow('!'), m.key, `no value: set it in ${m.file.label}`])
  printRows(rows)
  if (plan.unchanged) log(dim(`  = ${plan.unchanged} unchanged`))
}

/** Values that look like credentials but sit in a file that is usually committed. */
function warnCommittedSecrets(ctx: EnvContext, local: Map<string, EnvValue>): void {
  const secretFile = ctx.files.find((f) => f.own && f.secret)!
  const exposed = [...local].filter(([key, v]) => !v.secret && v.value && SECRET_NAME.test(key) && !key.startsWith('VITE_') && !key.startsWith('PUBLIC_'))
  for (const [key, v] of exposed) {
    warn(`${key} looks like a secret but is in ${v.file.label}. Move it to ${secretFile.label} to store it as secret.`)
  }
}

// ---- Shared ----

interface EnvContext {
  config: ProjectConfig
  name: string | null
  files: EnvFile[]
  project: Project
  skip: boolean
  prune: boolean
}

function context(args: Args): EnvContext {
  const config = readConfig()
  const t = target(config)
  const files = envFiles(config, t.name)
  const { client } = projectClient(targetConfig(config))
  return { config, name: t.name, files, project: new Project(client), skip: bool(args, 'yes') || bool(args, 'force'), prune: bool(args, 'prune') }
}

const where = (ctx: EnvContext) => ctx.name ?? 'the project'

function localValues(ctx: EnvContext): Map<string, EnvValue> {
  const found = ctx.files.filter((f) => existsSync(f.path))
  if (!found.length) {
    throw new CliError(`No env files: looked for ${ctx.files.map((f) => f.label).join(', ')}. Create one, or run \`bunwrite env pull\`.`)
  }
  return mergeEnv(ctx.files)
}

// ---- Commands ----

async function diff(args: Args): Promise<void> {
  const ctx = context(args)
  const local = localValues(ctx)
  const plan = planPush(local, await serverVariables(ctx.project))
  warnCommittedSecrets(ctx, local)
  if (!changeCount(plan, ctx.prune) && !plan.remove.length && !plan.missing.length) {
    success(`No changes: ${where(ctx)} matches ${ctx.files.filter((f) => existsSync(f.path)).map((f) => f.label).join(', ')}`)
    return
  }
  printPlan(plan, ctx.prune)
}

async function push(args: Args): Promise<void> {
  const ctx = context(args)
  const local = localValues(ctx)
  const plan = planPush(local, await serverVariables(ctx.project))
  warnCommittedSecrets(ctx, local)
  const count = changeCount(plan, ctx.prune)
  if (!count) {
    if (plan.remove.length || plan.missing.length) printPlan(plan, ctx.prune)
    success(`No changes to push to ${where(ctx)}`)
    return
  }
  printPlan(plan, ctx.prune)
  const t = target(ctx.config)
  if (t.protected) await confirmProtected(ctx.skip, 'push these variables')
  else if (!ctx.skip && !(await confirm(`Apply ${count} change${count === 1 ? '' : 's'} to ${where(ctx)}?`))) {
    info('Nothing was changed.')
    return
  }

  for (const c of plan.create) await ctx.project.createVariable({ variableId: 'unique()', key: c.key, value: c.value, secret: c.secret })
  for (const u of plan.update) await ctx.project.updateVariable({ variableId: u.variable.$id, key: u.variable.key, value: u.value, secret: u.secret || u.variable.secret })
  for (const r of plan.resend) await ctx.project.updateVariable({ variableId: r.variable.$id, key: r.variable.key, value: r.value, secret: true })
  if (ctx.prune) for (const v of plan.remove) await ctx.project.deleteVariable({ variableId: v.$id })
  success(`Pushed ${count} change${count === 1 ? '' : 's'} to ${where(ctx)}`)
}

async function pull(args: Args): Promise<void> {
  const ctx = context(args)
  const server = await serverVariables(ctx.project)
  const own = ctx.files.find((f) => f.own && !f.secret)!
  const secretFile = ctx.files.find((f) => f.own && f.secret)!
  const shared = ctx.files.find((f) => !f.own)
  const sharedValues = shared ? readEnvFile(shared.path) : new Map<string, string>()
  const ownValues = readEnvFile(own.path)
  const secretValues = readEnvFile(secretFile.path)

  const ownChanges = new Map<string, string | null>()
  const secretChanges = new Map<string, string | null>()
  const secretComments = new Map<string, string>()
  const rows: [string, string, string][] = []
  const replaced: string[] = []
  let removing = false

  for (const v of server) {
    if (v.secret) {
      if (secretValues.has(v.key)) continue
      secretChanges.set(v.key, '')
      secretComments.set(v.key, 'secret: set on the server')
      rows.push([green('+'), v.key, `secret placeholder in ${secretFile.label}`])
      continue
    }
    const [file, values, changes] = secretValues.has(v.key) ? [secretFile, secretValues, secretChanges] : [own, ownValues, ownChanges]
    if (values.has(v.key)) {
      if (values.get(v.key) === v.value) continue
      changes.set(v.key, v.value)
      replaced.push(v.key)
      rows.push([yellow('~'), v.key, `your value in ${file.label} is replaced`])
    } else if (shared && sharedValues.get(v.key) === v.value) {
      continue
    } else {
      changes.set(v.key, v.value)
      rows.push([green('+'), v.key, `added to ${file.label}`])
    }
  }

  const onServer = new Set(server.map((v) => v.key))
  for (const [values, changes, file] of [[ownValues, ownChanges, own], [secretValues, secretChanges, secretFile]] as const) {
    for (const key of values.keys()) {
      if (onServer.has(key)) continue
      if (ctx.prune) {
        changes.set(key, null)
        removing = true
        rows.push([red('-'), key, `removed from ${file.label}`])
      } else {
        rows.push([dim('?'), key, `only in ${file.label} (kept; push adds it, pull --prune removes it)`])
      }
    }
  }
  for (const key of sharedValues.keys()) {
    if (!onServer.has(key)) rows.push([dim('?'), key, `only in ${shared!.label} (kept; pull never writes the shared file)`])
  }

  printRows(rows)
  if (!ownChanges.size && !secretChanges.size) {
    success(`Your files already match ${where(ctx)}`)
    return
  }
  if ((replaced.length || removing) && !ctx.skip) {
    if (!(await confirm('Overwrite your local values with the server\'s?'))) {
      info('Nothing was written.')
      return
    }
  }

  const write = (file: EnvFile, changes: Map<string, string | null>, comments?: Map<string, string>) => {
    if (!changes.size) return
    const text = existsSync(file.path) ? readFileSync(file.path, 'utf8') : ''
    writeEnvFile(file, editEnv(text, changes, comments))
  }
  write(own, ownChanges)
  write(secretFile, secretChanges, secretComments)
  if (secretChanges.size) {
    const ignored = ignoreLocalFiles()
    if (ignored) info(`Added .env*.local to ${ignored} so secrets stay out of git`)
  }
  const files = [ownChanges.size ? own.label : '', secretChanges.size ? secretFile.label : ''].filter(Boolean)
  success(`Pulled ${where(ctx)} into ${files.join(' and ')}`)
}

function list(): void {
  const config = readConfig()
  const names = environmentNames(config)
  if (!names.length) {
    info('No environments yet. Add them to bunwrite.config.json, for example:')
    log(
      dim(`  "environments": {
    "staging":    { "endpoint": "https://staging.example.com/v1", "projectId": "my-app-staging" },
    "production": { "endpoint": "https://api.example.com/v1", "projectId": "my-app", "protected": true }
  }`),
    )
    log(dim(`Until then, \`bunwrite env\` uses .env and .env.local for the project ${config.projectId ?? ''}.`))
    return
  }
  const t = target(config)
  const rows = names.map((name) => {
    const env = environment(config, name)
    const files = envFiles(config, name).filter((f) => f.own && existsSync(f.path)).map((f) => f.label)
    return {
      ' ': name === t.name ? '*' : '',
      name,
      project: env.projectId ?? config.projectId ?? '',
      endpoint: env.endpoint ?? config.endpoint ?? dim('(signed-in server)'),
      protected: env.protected ? 'yes' : '',
      files: files.join(', ') || dim('none yet'),
    }
  })
  log(table(rows, [' ', 'name', 'project', 'endpoint', 'protected', 'files']))
  log('')
  if (t.name) log(`Active: ${bold(t.name)} ${dim(`(from ${t.source})`)}`)
  else log(dim('No environment active: commands use the top-level projectId. Pick one with `bunwrite env use <name>` or --env <name>.'))
}

function use(args: Args): void {
  const config = readConfig()
  const name = args.positional[2]
  const prefs = readPrefs()
  const folder = projectDir()
  if (bool(args, 'clear') || name === undefined) {
    if (!bool(args, 'clear')) throw new CliError(`Usage: bunwrite env use <name>, or env use --clear. Defined: ${environmentNames(config).join(', ') || 'none'}`)
    if (prefs.folders) delete prefs.folders[folder]
    writePrefs(prefs)
    success('This folder no longer has a chosen environment')
    return
  }
  environment(config, name)
  ;(prefs.folders ??= {})[folder] = { environment: name }
  writePrefs(prefs)
  success(`Using ${bold(name)} in this folder`)
  if (process.env.BUNWRITE_ENV && process.env.BUNWRITE_ENV !== name) warn(`BUNWRITE_ENV=${process.env.BUNWRITE_ENV} is set and wins over this.`)
}

export async function env(args: Args): Promise<void> {
  const sub = args.positional[1] ?? 'list'
  switch (sub) {
    case 'list':
      return list()
    case 'use':
      return use(args)
    case 'diff':
      return diff(args)
    case 'push':
      return push(args)
    case 'pull':
      return pull(args)
    default:
      throw new CliError(`Unknown env command "${sub}". Use list, use, diff, push or pull.${flag(args, 'help') ? '' : ' Run `bunwrite help`.'}`)
  }
}
