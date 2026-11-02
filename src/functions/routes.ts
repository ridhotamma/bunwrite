import type { AppContext } from '~/app'
import { requireKey, requireScope } from '~/auth/routes'
import { apiHeader } from '~/lib/compat'
import { normalizeDate } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { bool, json, list, noContent, num, str, type Params } from '~/lib/http'
import { uniqueId } from '~/lib/ids'
import { isSafeRelativePath } from '~/lib/paths'
import { page } from '~/lib/paging'
import type { Router } from '~/lib/router'
import { deploymentModel, Deployments } from './deployments'
import { functionHttpResponse } from './http'
import { ENV_KEY_RE } from './env'
import { executionModel, functionModel, type FunctionRow, type FunctionSettings } from './service'
import { applyProvider, projectOf } from '~/vcs/routes'
import { NO_PROVIDER, providerOf } from '~/vcs/source'
import { functionVariableId, parseFunctionVariableId, variableContext, type VariableContext } from '~/variables/context'

const strings = (value: unknown, fallback: string[]): string[] => (value === undefined || value === null ? fallback : list(value).map(String))

const deploymentsOf = (ctx: AppContext) => new Deployments(ctx.db, ctx.config, ctx.functions)

async function model(ctx: AppContext, f: FunctionRow) {
  const deployments = deploymentsOf(ctx)
  return functionModel(f, await deployments.latest(f.id), Boolean((await ctx.functions.codeDir(f)).dir), ctx.functions.domains(f), ctx.functions.url(f))
}

/** An entrypoint is a path inside the deployment, never an absolute or escaping path. */
function validEntrypoint(value: string): string {
  if (value && !isSafeRelativePath(value)) throw err('general_argument_invalid', `Invalid entrypoint: ${value}`)
  return value
}

/** Settings from a create or update call; anything left out keeps `base`. */
function settingsFrom(p: Params, base: FunctionSettings): FunctionSettings {
  return {
    name: str(p.name) ?? base.name,
    runtime: str(p.runtime) ?? base.runtime,
    execute: strings(p.execute, base.execute),
    events: strings(p.events, base.events),
    schedule: str(p.schedule) ?? base.schedule,
    timeout: num(p.timeout, base.timeout)!,
    enabled: bool(p.enabled, base.enabled),
    logging: bool(p.logging, base.logging),
    entrypoint: validEntrypoint(str(p.entrypoint) || base.entrypoint),
    commands: str(p.commands) ?? base.commands,
    scopes: strings(p.scopes, base.scopes),
    buildSpecification: str(p.buildSpecification) || base.buildSpecification,
    runtimeSpecification: str(p.runtimeSpecification) || base.runtimeSpecification,
    deploymentRetention: num(p.deploymentRetention, base.deploymentRetention)!,
    domains: p.domains !== undefined ? list(p.domains).map(String) : p.domain !== undefined ? (str(p.domain) ? [str(p.domain)!] : []) : base.domains,
  }
}

const settingsOf = (ctx: AppContext, f: FunctionRow): FunctionSettings => ({
  name: f.name,
  runtime: f.runtime,
  execute: JSON.parse(f.execute),
  events: JSON.parse(f.events),
  schedule: f.schedule,
  timeout: f.timeout,
  enabled: Boolean(f.enabled),
  logging: Boolean(f.logging),
  entrypoint: f.entrypoint,
  commands: f.commands,
  scopes: JSON.parse(f.scopes),
  buildSpecification: f.build_specification,
  runtimeSpecification: f.runtime_specification,
  deploymentRetention: f.deployment_retention,
  domains: ctx.functions.domains(f),
})

interface VariableRow {
  key: string
  value: string
  secret: number
  function_id: string
  context: string
  created_at: string
  updated_at: string
}

/** Function variables are keyed by name here, so a variable's $id is its key (plus `.live` / `.preview`). */
const variableModel = (v: VariableRow) => ({
  $id: functionVariableId(v.key, v.context),
  $createdAt: v.created_at,
  $updatedAt: v.updated_at,
  key: v.key,
  value: v.secret ? '' : v.value,
  secret: Boolean(v.secret),
  // Bunwrite: '' for every deployment, or live / preview.
  context: v.context,
  resourceType: 'function',
  resourceId: v.function_id,
})

async function variableOf(ctx: AppContext, functionId: string, id: string): Promise<VariableRow> {
  const { key, context } = parseFunctionVariableId(id)
  const row = await ctx.db.driver.get<VariableRow>('SELECT * FROM _function_vars WHERE function_id = ? AND key = ? AND context = ?', [functionId, key, context])
  if (!row) throw err('variable_not_found')
  return row
}

const variableExists = async (ctx: AppContext, functionId: string, key: string, context: string) =>
  Boolean(await ctx.db.driver.get('SELECT 1 FROM _function_vars WHERE function_id = ? AND key = ? AND context = ?', [functionId, key, context]))

export function functionRoutes(router: Router<AppContext>): void {
  router.get('/functions', async ({ ctx, params }) => {
    requireKey(ctx, 'functions.read')
    const functions = await ctx.functions.list()
    const models = await Promise.all(functions.map((f) => model(ctx, f)))
    const { total, items } = page(models, list(params.queries), { search: str(params.search), searchFields: ['$id', 'name', 'runtime'] })
    return json({ total, functions: items })
  })

  router.post('/functions', async ({ ctx, params }) => {
    requireKey(ctx, 'functions.write')
    const raw = str(params.functionId)
    if (!raw) throw err('general_argument_invalid', 'Param "functionId" is not optional.')
    const id = raw === 'unique()' ? uniqueId() : raw
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(id))
      throw err('general_argument_invalid', 'Function ID: up to 36 chars of a-z, A-Z, 0-9, period, hyphen and underscore.')
    if (!str(params.runtime)) throw err('general_argument_invalid', 'Param "runtime" is not optional.')
    const settings = settingsFrom(params, {
      name: id,
      runtime: '',
      // Appwrite's default: client SDKs and guests may call it until the admin narrows this.
      execute: ['any'],
      events: [],
      schedule: '',
      timeout: 15,
      enabled: true,
      logging: true,
      entrypoint: '',
      commands: '',
      scopes: [],
      buildSpecification: 's-1vcpu-512mb',
      runtimeSpecification: 's-1vcpu-512mb',
      deploymentRetention: 0,
      domains: [],
    })
    const created = await ctx.functions.create(id, settings)
    try {
      await applyProvider(ctx, 'function', created.id, params, NO_PROVIDER)
    } catch (error) {
      // A repository that cannot be connected fails the whole create, as on Appwrite.
      await ctx.hub.forget(ctx.config.projectId, 'function', created.id)
      await ctx.functions.remove(created.id)
      throw error
    }
    return json(await model(ctx, await ctx.functions.fn(created.id)), 201)
  })

  router.get('/functions/:functionId', async ({ ctx, path }) => {
    requireKey(ctx, 'functions.read')
    return json(await model(ctx, await ctx.functions.fn(path.functionId!)))
  })

  router.put('/functions/:functionId', async ({ ctx, path, params }) => {
    requireKey(ctx, 'functions.write')
    const f = await ctx.functions.fn(path.functionId!)
    const saved = await ctx.functions.save(f.id, settingsFrom(params, settingsOf(ctx, f)))
    await applyProvider(ctx, 'function', saved.id, params, providerOf(f))
    return json(await model(ctx, await ctx.functions.fn(saved.id)))
  })

  router.delete('/functions/:functionId', async ({ ctx, path }) => {
    requireKey(ctx, 'functions.write')
    await ctx.functions.remove(path.functionId!)
    await ctx.hub.forget(ctx.config.projectId, 'function', path.functionId!)
    return noContent()
  })

  // Appwrite's createVcsDeployment: build a branch, tag or commit of the connected repository.
  router.post('/functions/:functionId/deployments/vcs', async ({ ctx, path, params }) => {
    requireKey(ctx, 'functions.write')
    const f = await ctx.functions.fn(path.functionId!)
    const d = await ctx.hub.deployReference(
      projectOf(ctx),
      'function',
      f.id,
      str(params.type) ?? 'branch',
      str(params.reference) ?? '',
      bool(params.activate, false),
    )
    return json(deploymentModel(await deploymentsOf(ctx).get(f.id, d.id)), 202)
  })

  // ---- Deployments ----

  router.get('/functions/:functionId/deployments', async ({ ctx, path, params }) => {
    requireKey(ctx, 'functions.read')
    await ctx.functions.fn(path.functionId!)
    const deployments = await deploymentsOf(ctx).list(path.functionId!)
    const { total, items } = page(deployments.map(deploymentModel), list(params.queries), { search: str(params.search), searchFields: ['$id', 'status'] })
    return json({ total, deployments: items })
  })

  router.get('/functions/:functionId/deployments/:deploymentId/download', async ({ ctx, path, params }) => {
    requireKey(ctx, 'functions.read')
    await ctx.functions.fn(path.functionId!)
    const type = str(params.type) === 'output' ? 'output' : 'source'
    const archive = await deploymentsOf(ctx).download(path.functionId!, path.deploymentId!, type)
    return new Response(archive, {
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(archive.size),
        'content-disposition': `attachment; filename="${encodeURIComponent(path.deploymentId!)}.tar.gz"`,
      },
    })
  })

  router.post('/functions/:functionId/deployments', async ({ ctx, path, params, request }) => {
    requireKey(ctx, 'functions.write')
    const f = await ctx.functions.fn(path.functionId!)
    const code = params.code
    if (!(code instanceof Blob)) throw err('general_argument_invalid', 'Param "code" must be a .tar.gz file.')
    const deployment = await deploymentsOf(ctx).upload(f, {
      code,
      entrypoint: str(params.entrypoint) || f.entrypoint,
      commands: str(params.commands) ?? f.commands,
      activate: bool(params.activate, false),
      contentRange: request.headers.get('content-range'),
      uploadId: apiHeader(request, 'id'),
    })
    return json(deploymentModel(deployment), 202)
  })

  router.get('/functions/:functionId/deployments/:deploymentId', async ({ ctx, path }) => {
    requireKey(ctx, 'functions.read')
    return json(deploymentModel(await deploymentsOf(ctx).get(path.functionId!, path.deploymentId!)))
  })

  router.delete('/functions/:functionId/deployments/:deploymentId', async ({ ctx, path }) => {
    requireKey(ctx, 'functions.write')
    await deploymentsOf(ctx).remove(path.functionId!, path.deploymentId!)
    return noContent()
  })

  router.patch('/functions/:functionId/deployment', async ({ ctx, path, params }) => {
    requireKey(ctx, 'functions.write')
    await ctx.functions.fn(path.functionId!)
    const deploymentId = str(params.deploymentId)
    if (!deploymentId) throw err('general_argument_invalid', 'Param "deploymentId" is not optional.')
    return json(await model(ctx, await deploymentsOf(ctx).activate(path.functionId!, deploymentId)))
  })

  // ---- Variables ----

  router.get('/functions/:functionId/variables', async ({ ctx, path }) => {
    requireKey(ctx, 'functions.read')
    await ctx.functions.fn(path.functionId!)
    const rows = await ctx.db.driver.all<VariableRow>('SELECT * FROM _function_vars WHERE function_id = ? ORDER BY key, context', [path.functionId!])
    return json({ total: rows.length, variables: rows.map(variableModel) })
  })

  router.post('/functions/:functionId/variables', async ({ ctx, path, params }) => {
    requireKey(ctx, 'functions.write')
    const f = await ctx.functions.fn(path.functionId!)
    const key = str(params.key) ?? ''
    if (!ENV_KEY_RE.test(key)) throw err('general_argument_invalid', 'Variable names use letters, digits and underscores.')
    const context = variableContext(params.context)
    if (await variableExists(ctx, f.id, key, context)) throw err('variable_already_exists')
    await ctx.functions.setVariable(f.id, key, str(params.value) ?? '', bool(params.secret, false), context)
    return json(variableModel(await variableOf(ctx, f.id, functionVariableId(key, context))), 201)
  })

  router.get('/functions/:functionId/variables/:variableId', async ({ ctx, path }) => {
    requireKey(ctx, 'functions.read')
    await ctx.functions.fn(path.functionId!)
    return json(variableModel(await variableOf(ctx, path.functionId!, path.variableId!)))
  })

  router.put('/functions/:functionId/variables/:variableId', async ({ ctx, path, params }) => {
    requireKey(ctx, 'functions.write')
    const f = await ctx.functions.fn(path.functionId!)
    const current = await variableOf(ctx, f.id, path.variableId!)
    const key = str(params.key) ?? current.key
    if (!ENV_KEY_RE.test(key)) throw err('general_argument_invalid', 'Variable names use letters, digits and underscores.')
    const secret = bool(params.secret, Boolean(current.secret))
    if (current.secret && !secret) throw err('variable_cannot_unset_secret')
    const context = params.context === undefined ? (current.context as VariableContext) : variableContext(params.context)
    await ctx.db.driver.transaction(async (tx) => {
      if (key !== current.key || context !== current.context) {
        if (await variableExists(ctx, f.id, key, context)) throw err('variable_already_exists')
        await tx.run('DELETE FROM _function_vars WHERE function_id = ? AND key = ? AND context = ?', [f.id, current.key, current.context])
      }
      await ctx.functions.setVariable(f.id, key, str(params.value) ?? current.value, secret, context)
    })
    return json(variableModel(await variableOf(ctx, f.id, functionVariableId(key, context))))
  })

  router.delete('/functions/:functionId/variables/:variableId', async ({ ctx, path }) => {
    requireKey(ctx, 'functions.write')
    await ctx.functions.fn(path.functionId!)
    const current = await variableOf(ctx, path.functionId!, path.variableId!)
    await ctx.functions.deleteVariable(path.functionId!, current.key, current.context as VariableContext)
    return noContent()
  })

  // ---- Calls `appwrite push functions` makes around a new function ----

  /** Read by the CLI (as the "console" project) to name a new function or site domain. */
  router.get('/console/variables', ({ ctx }) => {
    const host = new URL(ctx.config.publicEndpoint).host
    return json({
      _APP_DOMAIN_TARGET: host,
      _APP_DOMAIN_FUNCTIONS: ctx.config.functionsDomain,
      _APP_DOMAIN_SITES: ctx.config.sitesDomain,
      _APP_STORAGE_LIMIT: 512 * 1024 * 1024,
      _APP_COMPUTE_SIZE_LIMIT: 512 * 1024 * 1024,
      _APP_USAGE_STATS: 'disabled',
      _APP_VCS_ENABLED: false,
      _APP_DOMAIN_ENABLED: true,
      _APP_ASSISTANT_ENABLED: false,
    })
  })

  router.get('/functions/:functionId/executions', async ({ ctx, path, params }) => {
    requireKey(ctx, 'execution.read')
    return json(await ctx.functions.listExecutions(path.functionId!, list(params.queries), bool(params.total, true)))
  })

  router.post('/functions/:functionId/executions', async ({ ctx, path, params }) => {
    requireScope(ctx, 'execution.write')
    const f = await ctx.functions.fn(path.functionId!)
    ctx.functions.assertCanExecute(ctx.caller, f)
    const headers = params.headers && typeof params.headers === 'object' ? (params.headers as Record<string, string>) : {}
    const request = {
      trigger: 'http' as const,
      method: str(params.method) ?? 'POST',
      path: str(params.path) ?? '/',
      headers,
      body: typeof params.body === 'string' ? params.body : params.body === undefined ? '' : JSON.stringify(params.body),
      userId: ctx.caller.user?.id ?? null,
    }

    // Deferred execution: the row is created now and run when its time comes,
    // so the id returned here is the one that eventually runs.
    const scheduledAt = str(params.scheduledAt)?.trim()
    if (scheduledAt) {
      if (!bool(params.async, false)) {
        throw err('general_bad_request', 'Scheduled executions must run asynchronously. Set scheduledAt to a future date, or set async to true.')
      }
      const when = normalizeDate(scheduledAt)
      if (!when || Date.parse(when) < Date.now() + 60_000) {
        throw err('general_bad_request', 'Execution schedule must be a valid date, and at least 1 minute from now')
      }
      return json(executionModel(await ctx.functions.schedule(f, request, when)), 202)
    }

    const { execution } = await ctx.functions.execute(f, request, bool(params.async, false) ? 'async' : 'sync')
    return json(executionModel(execution), 201)
  })

  router.get('/functions/:functionId/executions/:executionId', async ({ ctx, path }) => {
    requireKey(ctx, 'execution.read')
    return json(executionModel(await ctx.functions.execution(path.functionId!, path.executionId!)))
  })

  router.delete('/functions/:functionId/executions/:executionId', async ({ ctx, path }) => {
    requireKey(ctx, 'execution.write')
    await ctx.functions.execution(path.functionId!, path.executionId!)
    await ctx.db.driver.run('DELETE FROM _executions WHERE id = ?', [path.executionId!])
    return noContent()
  })

  /**
   * A function's own HTTP endpoint, standing in for Appwrite's function
   * domain: RENDER_FUNCTION_URL becomes `<endpoint>/functions/render/http`.
   * The request is passed through as-is and the function's response returned.
   */
  router.on(
    'ANY',
    '/functions/:functionId/http/*',
    async ({ ctx, path, request, url }) =>
      functionHttpResponse(ctx, await ctx.functions.fn(path.functionId!), ctx.caller, request, `/${path.rest ?? ''}${url.search}`),
    { raw: true },
  )
}
