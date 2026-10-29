/**
 * `bunwrite env`: variables kept in .env files, per environment.
 *
 *   env list               environments, their targets and files
 *   env add <name>         add one: server, project, files (see env-add.ts)
 *   env use <name>         remember an environment for this folder (--clear forgets it)
 *   env diff               what `env push` would change
 *   env push [--prune]     apply the files to the variables on the server
 *   env pull [--prune]     write the variables on the server into the files
 *   env check              list variables some environments set and others miss
 *
 * Each scope has its own files: the project's in `envDir`, and each function's
 * and site's in its `path` (from the config). `.live` and `.preview` files hold
 * values for one deploy context (see envfiles.ts). Secret values cannot be read back
 * from the server, so pull writes them as empty placeholders in the `.local`
 * file, and push never sends an empty `.local` value: a pull followed by a
 * push leaves secrets as they are.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { BunwriteException, Client, Functions, Project, Query, Sites } from '@bunwrite/sdk'

import { bool, flagList, type Args } from '../args'
import { projectClient } from '../clients'
import { readConfig, readPrefs, writePrefs, type ProjectConfig } from '../config'
import { editEnv, envFiles, FILE_CONTEXTS, filesIn, ignoreLocalFiles, mergeEnv, readEnvFile, SECRET_NAME, writeEnvFile, type EnvFile, type EnvValue, type FileContext } from '../envfiles'
import { changeCount, planPush, type Plan, type Variable } from '../envplan'
import { confirmProtected, environment, environmentNames, projectDir, target, targetConfig } from '../environments'
import { bold, CliError, confirm, dim, green, info, log, red, success, table, warn, yellow } from '../ui'
import { envAdd } from './env-add'
import { environmentView } from '../overrides'
import { slug } from './sync'

// ---- Scopes ----

type Kind = 'project' | 'functions' | 'sites'
const KINDS: Kind[] = ['project', 'functions', 'sites']

/** A set of variables on the server and the .env files that describe it. */
interface Scope {
  kind: Kind
  /** `project`, `function hello`, `site web`. */
  label: string
  folder: string
  files: EnvFile[]
  /** null when the function or site is not on the server yet. */
  list(): Promise<Variable[] | null>
  create(key: string, value: string, secret: boolean, context: FileContext): Promise<unknown>
  update(variable: Variable, value: string, secret: boolean): Promise<unknown>
  remove(variable: Variable): Promise<unknown>
}

/** Every page of a variable list; function variables come back all at once. */
async function listAll(page: (queries: string[]) => Promise<{ total: number; variables: Variable[] }>): Promise<Variable[]> {
  const out: Variable[] = []
  for (let offset = 0; ; offset += 100) {
    const { total, variables } = await page([Query.limit(100), Query.offset(offset)])
    out.push(...variables)
    if (variables.length < 100 || out.length >= total) return out
  }
}

const orMissing = async (list: Promise<Variable[]>): Promise<Variable[] | null> => {
  try {
    return await list
  } catch (error) {
    if (error instanceof BunwriteException && error.code === 404) return null
    throw error
  }
}

/** Which kinds to work on: --scope, or the kinds --function-id / --site-id name, or all. */
function kindsOf(args: Args): Kind[] {
  const given = flagList(args, 'scope')
  if (given.length) {
    const bad = given.filter((k) => !(KINDS as string[]).includes(k))
    if (bad.length) throw new CliError(`Unknown --scope ${bad.join(', ')}. Use project, functions or sites.`)
    return given as Kind[]
  }
  const named: Kind[] = []
  if (flagList(args, 'function-id').length) named.push('functions')
  if (flagList(args, 'site-id').length) named.push('sites')
  return named.length ? named : KINDS
}

interface Clients {
  client: Client
  project: Project
  functions: Functions
  sites: Sites
}

/**
 * Create a variable with a deploy context. `context` is a Bunwrite extension
 * the generated SDK methods do not send, so this calls the API directly.
 */
function createWithContext(clients: Clients, path: string, key: string, value: string, secret: boolean, context: FileContext): Promise<unknown> {
  const url = new URL(clients.client.config.endpoint + path)
  return clients.client.call('post', url, { 'content-type': 'application/json' }, { variableId: 'unique()', key, value, secret, context })
}

/** The scopes in the config, with their files for one environment. Clients are needed only to talk to the server. */
export function scopesOf(config: ProjectConfig, name: string | null, args: Args, clients?: Clients): Scope[] {
  const kinds = kindsOf(args)
  const root = projectDir()
  const reserved = environmentNames(config)
  const out: Scope[] = []
  const need = (): Clients => {
    if (!clients) throw new Error('No server client')
    return clients
  }
  if (kinds.includes('project')) {
    out.push({
      kind: 'project',
      label: 'project',
      folder: root,
      files: envFiles(config, name),
      list: () => listAll((queries) => need().project.listVariables({ queries })),
      create: (key, value, secret, context) =>
        context ? createWithContext(need(), '/project/variables', key, value, secret, context) : need().project.createVariable({ variableId: 'unique()', key, value, secret }),
      update: (v, value, secret) => need().project.updateVariable({ variableId: v.$id, key: v.key, value, secret }),
      remove: (v) => need().project.deleteVariable({ variableId: v.$id }),
    })
  }
  const pick = (items: any[] | undefined, ids: string[]) => (items ?? []).filter((item) => item?.$id && (!ids.length || ids.includes(item.$id)))
  if (kinds.includes('functions')) {
    for (const fn of pick(config.functions, flagList(args, 'function-id'))) {
      const folder = resolve(root, fn.path ?? `functions/${slug(fn.name ?? fn.$id)}`)
      const functionId: string = fn.$id
      out.push({
        kind: 'functions',
        label: `function ${functionId}`,
        folder,
        files: filesIn(folder, name, root, reserved),
        list: () => orMissing(listAll((queries) => need().functions.listVariables({ functionId, queries }))),
        create: (key, value, secret, context) =>
          context
            ? createWithContext(need(), `/functions/${encodeURIComponent(functionId)}/variables`, key, value, secret, context)
            : need().functions.createVariable({ functionId, variableId: 'unique()', key, value, secret }),
        update: (v, value, secret) => need().functions.updateVariable({ functionId, variableId: v.$id, key: v.key, value, secret }),
        remove: (v) => need().functions.deleteVariable({ functionId, variableId: v.$id }),
      })
    }
  }
  if (kinds.includes('sites')) {
    for (const site of pick(config.sites, flagList(args, 'site-id'))) {
      const folder = resolve(root, site.path ?? `sites/${slug(site.name ?? site.$id)}`)
      const siteId: string = site.$id
      out.push({
        kind: 'sites',
        label: `site ${siteId}`,
        folder,
        files: filesIn(folder, name, root, reserved),
        list: () => orMissing(listAll((queries) => need().sites.listVariables({ siteId, queries }))),
        create: (key, value, secret, context) =>
          context
            ? createWithContext(need(), `/sites/${encodeURIComponent(siteId)}/variables`, key, value, secret, context)
            : need().sites.createVariable({ siteId, variableId: 'unique()', key, value, secret }),
        update: (v, value, secret) => need().sites.updateVariable({ siteId, variableId: v.$id, key: v.key, value, secret }),
        remove: (v) => need().sites.deleteVariable({ siteId, variableId: v.$id }),
      })
    }
  }
  return out
}

const filesOf = (scope: Scope, context: FileContext) => scope.files.filter((f) => f.context === context)
const hasFiles = (scope: Scope, context?: FileContext) => (context === undefined ? scope.files : filesOf(scope, context)).some((f) => existsSync(f.path))
const secretFileOf = (scope: Scope, context: FileContext = '') => filesOf(scope, context).find((f) => f.own && f.secret)!

const CONTEXT_NOTE: Record<FileContext, string> = { '': '', live: 'live only', preview: 'previews only' }
/** `KEY`, or `KEY (previews only)` for a context's variable. */
const keyLabel = (key: string, context: FileContext) => (context ? `${key} (${CONTEXT_NOTE[context]})` : key)

// ---- Output ----

type Row = [string, string, string]

function printRows(rows: Row[]): void {
  const width = Math.max(0, ...rows.map((r) => r[1].length))
  for (const [mark, key, note] of rows) log(`  ${mark} ${key.padEnd(width)}  ${dim(note)}`)
}

function planRows(plan: Plan, prune: boolean): Row[] {
  const rows: Row[] = []
  const k = (key: string) => keyLabel(key, plan.context)
  for (const c of plan.create) rows.push([green('+'), k(c.key), c.secret ? 'new, secret' : 'new'])
  for (const u of plan.update) rows.push([yellow('~'), k(u.variable.key), u.becomesSecret ? 'becomes secret' : 'changed'])
  for (const r of plan.resend) rows.push([yellow('↻'), k(r.variable.key), "secret, sent again (its value can't be read back to compare)"])
  for (const v of plan.remove) rows.push([red('-'), k(v.key), prune ? 'removed' : 'only on the server (removed with --prune)'])
  for (const m of plan.missing) rows.push([yellow('!'), k(m.key), `no value: set it in ${m.file.label}`])
  return rows
}

/** Values that look like credentials but sit in a file that is usually committed. */
function warnCommittedSecrets(scope: Scope, local: Map<string, EnvValue>, context: FileContext): void {
  const exposed = [...local].filter(([key, v]) => !v.secret && v.value && SECRET_NAME.test(key) && !key.startsWith('VITE_') && !key.startsWith('PUBLIC_'))
  for (const [key, v] of exposed) {
    warn(`${key} looks like a secret but is in ${v.file.label}. Move it to ${secretFileOf(scope, context).label} to store it as secret.`)
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function joinList(items: string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

// ---- Context ----

interface EnvContext {
  config: ProjectConfig
  name: string | null
  scopes: Scope[]
  skip: boolean
  prune: boolean
}

function context(args: Args): EnvContext {
  const config = readConfig()
  const t = target(config)
  // Functions and sites by the IDs this environment uses on the server (idSuffix, overrides).
  const view = environmentView(config, t.name ? t : null)
  for (const [flag, kind] of [['function-id', 'functions'], ['site-id', 'sites']] as const) {
    const ids = flagList(args, flag)
    if (ids.length) args.flags.set(flag, ids.map((id) => view.envId(kind, id)))
  }
  const { client } = projectClient(targetConfig(config))
  const clients = { client, project: new Project(client), functions: new Functions(client), sites: new Sites(client) }
  return { config, name: t.name, scopes: scopesOf(view.config, t.name, args, clients), skip: bool(args, 'yes') || bool(args, 'force'), prune: bool(args, 'prune') }
}

const where = (ctx: EnvContext) => ctx.name ?? 'the project'

interface ScopePlan {
  scope: Scope
  plan: Plan
}

/**
 * Plans for every scope and deploy context that has files: a context nobody
 * keeps files for is left alone. A function or site not on the server yet is
 * skipped with a warning.
 */
async function plans(ctx: EnvContext): Promise<ScopePlan[]> {
  const withFiles = ctx.scopes.filter((scope) => hasFiles(scope))
  if (!withFiles.length) {
    const project = ctx.scopes.find((s) => s.kind === 'project')
    const looked = project ? project.files.map((f) => f.label).join(', ') : 'the selected functions and sites'
    throw new CliError(`No env files: looked for ${looked}. Create one, or run \`bunwrite env pull\`.`)
  }
  const out: ScopePlan[] = []
  for (const scope of withFiles) {
    const server = await scope.list()
    if (!server) {
      warn(`${scope.label} is not on the server yet; push it first (\`bunwrite push ${scope.kind}\`). Its variables were skipped.`)
      continue
    }
    for (const context of FILE_CONTEXTS) {
      if (!hasFiles(scope, context)) continue
      const local = mergeEnv(scope.files, context)
      warnCommittedSecrets(scope, local, context)
      out.push({ scope, plan: planPush(local, server, context) })
    }
  }
  return out
}

function printPlans(all: ScopePlan[], prune: boolean): void {
  // Headings only when more than the project is involved.
  const many = all.some((p) => p.scope.kind !== 'project')
  let last: Scope | null = null
  for (const { scope, plan } of all) {
    const rows = planRows(plan, prune)
    if (!rows.length && !plan.unchanged) continue
    if (many && scope !== last) log(bold(scope.label))
    last = scope
    printRows(rows)
    if (plan.unchanged) log(dim(`  = ${plan.unchanged} unchanged${plan.context ? ` (${CONTEXT_NOTE[plan.context]})` : ''}`))
  }
}

// ---- Commands ----

async function diff(args: Args): Promise<void> {
  const ctx = context(args)
  const all = await plans(ctx)
  const pending = all.some(({ plan }) => changeCount(plan, ctx.prune) || plan.remove.length || plan.missing.length)
  if (!pending) {
    success(`No changes: ${where(ctx)} matches your env files`)
    return
  }
  printPlans(all, ctx.prune)
}

async function push(args: Args): Promise<void> {
  const ctx = context(args)
  const all = await plans(ctx)
  const count = all.reduce((n, { plan }) => n + changeCount(plan, ctx.prune), 0)
  if (!count) {
    if (all.some(({ plan }) => plan.remove.length || plan.missing.length)) printPlans(all, ctx.prune)
    success(`No changes to push to ${where(ctx)}`)
    return
  }
  printPlans(all, ctx.prune)
  const t = target(ctx.config)
  if (t.protected) await confirmProtected(ctx.skip, 'push these variables')
  else if (!ctx.skip && !(await confirm(`Apply ${plural(count, 'change')} to ${where(ctx)}?`))) {
    info('Nothing was changed.')
    return
  }

  for (const { scope, plan } of all) {
    for (const c of plan.create) await scope.create(c.key, c.value, c.secret, plan.context)
    for (const u of plan.update) await scope.update(u.variable, u.value, u.secret || u.variable.secret)
    for (const r of plan.resend) await scope.update(r.variable, r.value, true)
    if (ctx.prune) for (const v of plan.remove) await scope.remove(v)
  }
  success(`Pushed ${plural(count, 'change')} to ${where(ctx)}`)
}

interface PullWrite {
  file: EnvFile
  changes: Map<string, string | null>
  comments: Map<string, string>
}

interface ScopePull {
  scope: Scope
  rows: Row[]
  writes: PullWrite[]
  /** Local values that would be replaced or removed. */
  overwrites: number
}

/** What pull would write for one scope's files of one deploy context. */
function pullScope(scope: Scope, context: FileContext, all: Variable[], prune: boolean): ScopePull {
  const server = all.filter((v) => (v.context ?? '') === context)
  const files = filesOf(scope, context)
  const own = files.find((f) => f.own && !f.secret)!
  const secretFile = files.find((f) => f.own && f.secret)!
  const shared = files.find((f) => !f.own)
  const k = (key: string) => keyLabel(key, context)
  const sharedValues = shared ? readEnvFile(shared.path) : new Map<string, string>()
  const ownValues = readEnvFile(own.path)
  const secretValues = readEnvFile(secretFile.path)
  const ownWrite: PullWrite = { file: own, changes: new Map(), comments: new Map() }
  const secretWrite: PullWrite = { file: secretFile, changes: new Map(), comments: new Map() }
  const rows: Row[] = []
  let overwrites = 0

  for (const v of server) {
    if (v.secret) {
      if (secretValues.has(v.key)) continue
      secretWrite.changes.set(v.key, '')
      secretWrite.comments.set(v.key, 'secret: set on the server')
      rows.push([green('+'), k(v.key), `secret placeholder in ${secretFile.label}`])
      continue
    }
    const [values, write] = secretValues.has(v.key) ? [secretValues, secretWrite] : [ownValues, ownWrite]
    if (values.has(v.key)) {
      if (values.get(v.key) === v.value) continue
      write.changes.set(v.key, v.value)
      overwrites++
      rows.push([yellow('~'), k(v.key), `your value in ${write.file.label} is replaced`])
    } else if (shared && sharedValues.get(v.key) === v.value) {
      continue
    } else {
      write.changes.set(v.key, v.value)
      rows.push([green('+'), k(v.key), `added to ${write.file.label}`])
    }
  }

  const onServer = new Set(server.map((v) => v.key))
  for (const [values, write] of [[ownValues, ownWrite], [secretValues, secretWrite]] as const) {
    for (const key of values.keys()) {
      if (onServer.has(key)) continue
      if (prune) {
        write.changes.set(key, null)
        overwrites++
        rows.push([red('-'), k(key), `removed from ${write.file.label}`])
      } else {
        rows.push([dim('?'), k(key), `only in ${write.file.label} (kept; push adds it, pull --prune removes it)`])
      }
    }
  }
  for (const key of sharedValues.keys()) {
    if (!onServer.has(key)) rows.push([dim('?'), k(key), `only in ${shared!.label} (kept; pull never writes the shared file)`])
  }
  return { scope, rows, writes: [ownWrite, secretWrite].filter((w) => w.changes.size), overwrites }
}

async function pull(args: Args): Promise<void> {
  const ctx = context(args)
  const pulls: ScopePull[] = []
  for (const scope of ctx.scopes) {
    // A function or site pulls into its folder only when the folder is there.
    if (scope.kind !== 'project' && !existsSync(scope.folder)) continue
    const server = await scope.list()
    if (!server) continue
    for (const context of FILE_CONTEXTS) {
      // The project's every-deployment files are always pulled; anything else only when there is something to write.
      const always = scope.kind === 'project' && context === ''
      if (!always && !server.some((v) => (v.context ?? '') === context) && !hasFiles(scope, context)) continue
      pulls.push(pullScope(scope, context, server, ctx.prune))
    }
  }

  const many = pulls.some((p) => p.scope.kind !== 'project' && p.rows.length)
  let last: Scope | null = null
  for (const p of pulls) {
    if (!p.rows.length) continue
    if (many && p.scope !== last) log(bold(p.scope.label))
    last = p.scope
    printRows(p.rows)
  }
  const writes = pulls.flatMap((p) => p.writes)
  if (!writes.length) {
    success(`Your files already match ${where(ctx)}`)
    return
  }
  if (pulls.some((p) => p.overwrites) && !ctx.skip) {
    if (!(await confirm("Overwrite your local values with the server's?"))) {
      info('Nothing was written.')
      return
    }
  }

  for (const { file, changes, comments } of writes) {
    const text = existsSync(file.path) ? readFileSync(file.path, 'utf8') : ''
    writeEnvFile(file, editEnv(text, changes, comments))
  }
  if (writes.some((w) => w.file.secret)) {
    const ignored = ignoreLocalFiles()
    if (ignored) info(`Added .env*.local to ${ignored} so secrets stay out of git`)
  }
  success(`Pulled ${where(ctx)} into ${joinList(writes.map((w) => w.file.label))}`)
}

/**
 * `env check`: for each scope, the variables some environment sets in its
 * files that another one does not. Works on the files only, so it can run in
 * CI before a deploy. Exits 1 when something is missing.
 */
function check(args: Args): void {
  const config = readConfig()
  const all = environmentNames(config)
  if (!all.length) {
    info('No environments to compare. Add "environments" to bunwrite.config.json first.')
    return
  }
  const t = target(config)
  const chosen = t.source === '--env' ? [t.name!] : all
  const missing = new Map<string, string[]>(chosen.map((n) => [n, []]))
  let compared = 0

  // The scopes are the same for every environment; only their files differ.
  for (const scope of scopesOf(config, null, args)) {
    const keysByEnv = new Map(
      all.map((name) => {
        const files = scope.kind === 'project' ? envFiles(config, name) : filesIn(scope.folder, name, projectDir(), environmentNames(config))
        return [name, new Set(mergeEnv(files).keys())] as const
      }),
    )
    const union = new Set([...keysByEnv.values()].flatMap((keys) => [...keys]))
    if (!union.size) continue
    compared++
    for (const name of chosen) {
      for (const key of union) {
        if (!keysByEnv.get(name)!.has(key)) missing.get(name)!.push(scope.kind === 'project' ? key : `${key} (${scope.label})`)
      }
    }
  }

  if (!compared) {
    info('No env files to compare yet.')
    return
  }
  let failed = 0
  for (const [name, keys] of missing) {
    if (keys.length) {
      failed++
      log(`${red('✗')} ${bold(name)} is missing ${keys.join(', ')}`)
    } else {
      log(`${green('✓')} ${bold(name)} sets every variable`)
    }
  }
  if (failed) {
    throw new CliError(`${plural(failed, 'environment')} ${failed === 1 ? 'is' : 'are'} missing variables. Add them to that environment's .env file, or to the shared .env.`)
  }
}

function list(): void {
  const config = readConfig()
  const names = environmentNames(config)
  if (!names.length) {
    info('No environments yet. Add one with `bunwrite env add staging`, or in bunwrite.config.json:')
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
  const none: Args = { positional: [], flags: new Map() }
  const rows = names.map((name) => {
    const env = environment(config, name)
    const files = scopesOf(config, name, none).flatMap((s) => s.files.filter((f) => f.own && existsSync(f.path)).map((f) => f.label))
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
    case 'check':
      return check(args)
    case 'add':
      return envAdd(args)
    default:
      throw new CliError(`Unknown env command "${sub}". Use list, add, use, diff, push, pull or check.`)
  }
}
