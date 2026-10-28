import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { bool, json, list, noContent, num, str, type Params } from '~/lib/http'
import { uniqueId } from '~/lib/ids'
import { page } from '~/lib/paging'
import type { Router } from '~/lib/router'
import { deploymentModel, Deployments } from './deployments'
import { ENV_KEY_RE } from './env'
import { executionModel, functionModel, type FunctionRow, type FunctionSettings } from './service'

const HOP_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection'])

const strings = (value: unknown, fallback: string[]): string[] => (value === undefined || value === null ? fallback : list(value).map(String))

const deploymentsOf = (ctx: AppContext) => new Deployments(ctx.db, ctx.config, ctx.functions)

const model = (ctx: AppContext, f: FunctionRow) => functionModel(f, deploymentsOf(ctx).latest(f.id), Boolean(ctx.functions.codeDir(f).dir))

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
    entrypoint: str(p.entrypoint) || base.entrypoint,
    commands: str(p.commands) ?? base.commands,
    scopes: strings(p.scopes, base.scopes),
    buildSpecification: str(p.buildSpecification) || base.buildSpecification,
    runtimeSpecification: str(p.runtimeSpecification) || base.runtimeSpecification,
    deploymentRetention: num(p.deploymentRetention, base.deploymentRetention)!,
  }
}

const settingsOf = (f: FunctionRow): FunctionSettings => ({
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
})

interface VariableRow {
  key: string
  value: string
  secret: number
  function_id: string
  created_at: string
  updated_at: string
}

/** Function variables are keyed by name here, so a variable's $id is its key. */
const variableModel = (v: VariableRow) => ({
  $id: v.key,
  $createdAt: v.created_at,
  $updatedAt: v.updated_at,
  key: v.key,
  value: v.secret ? '' : v.value,
  secret: Boolean(v.secret),
  resourceType: 'function',
  resourceId: v.function_id,
})

function variableOf(ctx: AppContext, functionId: string, key: string): VariableRow {
  const row = ctx.db.sqlite.query<VariableRow, [string, string]>('SELECT * FROM _function_vars WHERE function_id = ? AND key = ?').get(functionId, key)
  if (!row) throw err('variable_not_found')
  return row
}

/** The URL a function answers on here, standing in for an Appwrite function domain. */
const functionRule = (ctx: AppContext, f: FunctionRow) => {
  const url = new URL(`${ctx.config.publicEndpoint}/functions/${f.id}/http`)
  return {
    $id: `fn-${f.id}`,
    $createdAt: f.created_at,
    $updatedAt: f.updated_at,
    domain: `${url.host}${url.pathname}`,
    type: 'deployment',
    trigger: 'manual',
    redirectUrl: '',
    redirectStatusCode: 301,
    deploymentId: f.deployment_id,
    deploymentResourceType: 'function',
    deploymentResourceId: f.id,
    deploymentVcsProviderBranch: '',
    status: 'verified',
    logs: '',
    renewAt: '',
  }
}

export function functionRoutes(router: Router<AppContext>): void {
  router.get('/functions', ({ ctx, params }) => {
    requireKey(ctx, 'functions.read')
    const { total, items } = page(ctx.functions.list().map((f) => model(ctx, f)), list(params.queries), { search: str(params.search), searchFields: ['$id', 'name', 'runtime'] })
    return json({ total, functions: items })
  })

  /** This server hosts no Sites; an empty list lets `appwrite pull all` and `push all` carry on. */
  router.get('/sites', ({ ctx }) => {
    requireKey(ctx, 'sites.read')
    return json({ total: 0, sites: [] })
  })

  router.post('/functions', ({ ctx, params }) => {
    requireKey(ctx, 'functions.write')
    const raw = str(params.functionId)
    if (!raw) throw err('general_argument_invalid', 'Param "functionId" is not optional.')
    const id = raw === 'unique()' ? uniqueId() : raw
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(id)) throw err('general_argument_invalid', 'Function ID: up to 36 chars of a-z, A-Z, 0-9, period, hyphen and underscore.')
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
    })
    return json(model(ctx, ctx.functions.create(id, settings)), 201)
  })

  router.get('/functions/:functionId', ({ ctx, path }) => {
    requireKey(ctx, 'functions.read')
    return json(model(ctx, ctx.functions.fn(path.functionId!)))
  })

  router.put('/functions/:functionId', ({ ctx, path, params }) => {
    requireKey(ctx, 'functions.write')
    const f = ctx.functions.fn(path.functionId!)
    return json(model(ctx, ctx.functions.save(f.id, settingsFrom(params, settingsOf(f)))))
  })

  router.delete('/functions/:functionId', ({ ctx, path }) => {
    requireKey(ctx, 'functions.write')
    ctx.functions.remove(path.functionId!)
    return noContent()
  })

  // ---- Deployments ----

  router.get('/functions/:functionId/deployments', ({ ctx, path, params }) => {
    requireKey(ctx, 'functions.read')
    ctx.functions.fn(path.functionId!)
    const { total, items } = page(deploymentsOf(ctx).list(path.functionId!).map(deploymentModel), list(params.queries), { search: str(params.search), searchFields: ['$id', 'status'] })
    return json({ total, deployments: items })
  })

  router.get('/functions/:functionId/deployments/:deploymentId/download', async ({ ctx, path, params }) => {
    requireKey(ctx, 'functions.read')
    ctx.functions.fn(path.functionId!)
    const type = str(params.type) === 'output' ? 'output' : 'source'
    const archive = await deploymentsOf(ctx).download(path.functionId!, path.deploymentId!, type)
    return new Response(archive, {
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(archive.size),
        'content-disposition': `attachment; filename="${path.deploymentId}.tar.gz"`,
      },
    })
  })

  router.post('/functions/:functionId/deployments', async ({ ctx, path, params, request }) => {
    requireKey(ctx, 'functions.write')
    const f = ctx.functions.fn(path.functionId!)
    const code = params.code
    if (!(code instanceof Blob)) throw err('general_argument_invalid', 'Param "code" must be a .tar.gz file.')
    const deployment = await deploymentsOf(ctx).upload(f, {
      code,
      entrypoint: str(params.entrypoint) || f.entrypoint,
      commands: str(params.commands) ?? f.commands,
      activate: bool(params.activate, false),
      contentRange: request.headers.get('content-range'),
      uploadId: request.headers.get('x-appwrite-id'),
    })
    return json(deploymentModel(deployment), 202)
  })

  router.get('/functions/:functionId/deployments/:deploymentId', ({ ctx, path }) => {
    requireKey(ctx, 'functions.read')
    return json(deploymentModel(deploymentsOf(ctx).get(path.functionId!, path.deploymentId!)))
  })

  router.delete('/functions/:functionId/deployments/:deploymentId', ({ ctx, path }) => {
    requireKey(ctx, 'functions.write')
    deploymentsOf(ctx).remove(path.functionId!, path.deploymentId!)
    return noContent()
  })

  router.patch('/functions/:functionId/deployment', ({ ctx, path, params }) => {
    requireKey(ctx, 'functions.write')
    ctx.functions.fn(path.functionId!)
    const deploymentId = str(params.deploymentId)
    if (!deploymentId) throw err('general_argument_invalid', 'Param "deploymentId" is not optional.')
    return json(model(ctx, deploymentsOf(ctx).activate(path.functionId!, deploymentId)))
  })

  // ---- Variables ----

  router.get('/functions/:functionId/variables', ({ ctx, path }) => {
    requireKey(ctx, 'functions.read')
    ctx.functions.fn(path.functionId!)
    const rows = ctx.db.sqlite.query<VariableRow, [string]>('SELECT * FROM _function_vars WHERE function_id = ? ORDER BY key').all(path.functionId!)
    return json({ total: rows.length, variables: rows.map(variableModel) })
  })

  router.post('/functions/:functionId/variables', ({ ctx, path, params }) => {
    requireKey(ctx, 'functions.write')
    const f = ctx.functions.fn(path.functionId!)
    const key = str(params.key) ?? ''
    if (!ENV_KEY_RE.test(key)) throw err('general_argument_invalid', 'Variable names use letters, digits and underscores.')
    if (ctx.db.sqlite.query('SELECT 1 FROM _function_vars WHERE function_id = ? AND key = ?').get(f.id, key)) throw err('variable_already_exists')
    ctx.functions.setVariable(f.id, key, str(params.value) ?? '', bool(params.secret, false))
    return json(variableModel(variableOf(ctx, f.id, key)), 201)
  })

  router.get('/functions/:functionId/variables/:variableId', ({ ctx, path }) => {
    requireKey(ctx, 'functions.read')
    ctx.functions.fn(path.functionId!)
    return json(variableModel(variableOf(ctx, path.functionId!, path.variableId!)))
  })

  router.put('/functions/:functionId/variables/:variableId', ({ ctx, path, params }) => {
    requireKey(ctx, 'functions.write')
    const f = ctx.functions.fn(path.functionId!)
    const current = variableOf(ctx, f.id, path.variableId!)
    const key = str(params.key) ?? current.key
    if (!ENV_KEY_RE.test(key)) throw err('general_argument_invalid', 'Variable names use letters, digits and underscores.')
    const secret = bool(params.secret, Boolean(current.secret))
    if (current.secret && !secret) throw err('variable_cannot_unset_secret')
    ctx.db.sqlite.transaction(() => {
      if (key !== current.key) {
        if (ctx.db.sqlite.query('SELECT 1 FROM _function_vars WHERE function_id = ? AND key = ?').get(f.id, key)) throw err('variable_already_exists')
        ctx.functions.deleteVariable(f.id, current.key)
      }
      ctx.functions.setVariable(f.id, key, str(params.value) ?? current.value, secret)
    })()
    return json(variableModel(variableOf(ctx, f.id, key)))
  })

  router.delete('/functions/:functionId/variables/:variableId', ({ ctx, path }) => {
    requireKey(ctx, 'functions.write')
    ctx.functions.fn(path.functionId!)
    variableOf(ctx, path.functionId!, path.variableId!)
    ctx.functions.deleteVariable(path.functionId!, path.variableId!)
    return noContent()
  })

  // ---- Calls `appwrite push functions` makes around a new function ----

  /** Read by the CLI (as the "console" project) to name a new function's domain. */
  router.get('/console/variables', ({ ctx }) => {
    const host = new URL(ctx.config.publicEndpoint).host
    return json({
      _APP_DOMAIN_TARGET: host,
      _APP_DOMAIN_FUNCTIONS: host,
      _APP_DOMAIN_SITES: host,
      _APP_STORAGE_LIMIT: 512 * 1024 * 1024,
      _APP_COMPUTE_SIZE_LIMIT: 512 * 1024 * 1024,
      _APP_USAGE_STATS: 'disabled',
      _APP_VCS_ENABLED: false,
      _APP_DOMAIN_ENABLED: false,
      _APP_ASSISTANT_ENABLED: false,
    })
  })

  /** Functions answer on <endpoint>/functions/<id>/http, so a function rule is accepted and nothing is stored. */
  router.post('/proxy/rules/function', ({ ctx, params }) => {
    requireKey(ctx, 'rules.write')
    return json(functionRule(ctx, ctx.functions.fn(str(params.functionId) ?? '')), 201)
  })

  router.get('/proxy/rules', ({ ctx, params }) => {
    requireKey(ctx, 'rules.read')
    let rules = ctx.functions.list().map((f) => functionRule(ctx, f))
    let limit = 25
    for (const raw of list(params.queries)) {
      const query = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { method?: string; attribute?: string; values?: unknown[] }
      if (query?.method === 'limit') limit = Number(query.values?.[0] ?? 25)
      if (query?.method === 'equal' && query.attribute) {
        rules = rules.filter((r) => (query.values ?? []).includes((r as Record<string, unknown>)[query.attribute!]))
      }
    }
    return json({ total: rules.length, rules: rules.slice(0, limit) })
  })

  router.get('/functions/:functionId/executions', ({ ctx, path, params }) => {
    requireKey(ctx, 'execution.read')
    return json(ctx.functions.listExecutions(path.functionId!, list(params.queries), bool(params.total, true)))
  })

  router.post('/functions/:functionId/executions', async ({ ctx, path, params }) => {
    const f = ctx.functions.fn(path.functionId!)
    ctx.functions.assertCanExecute(ctx.caller, f)
    if (params.scheduledAt) throw err('general_argument_invalid', 'Scheduled executions are not supported on this server.')
    const headers = params.headers && typeof params.headers === 'object' ? (params.headers as Record<string, string>) : {}
    const { execution } = await ctx.functions.execute(
      f,
      {
        trigger: 'http',
        method: str(params.method) ?? 'POST',
        path: str(params.path) ?? '/',
        headers,
        body: typeof params.body === 'string' ? params.body : params.body === undefined ? '' : JSON.stringify(params.body),
        userId: ctx.caller.user?.id ?? null,
      },
      bool(params.async, false) ? 'async' : 'sync',
    )
    return json(executionModel(execution), 201)
  })

  router.get('/functions/:functionId/executions/:executionId', ({ ctx, path }) => {
    requireKey(ctx, 'execution.read')
    return json(executionModel(ctx.functions.execution(path.functionId!, path.executionId!)))
  })

  router.delete('/functions/:functionId/executions/:executionId', ({ ctx, path }) => {
    requireKey(ctx, 'execution.write')
    ctx.functions.execution(path.functionId!, path.executionId!)
    ctx.db.sqlite.query('DELETE FROM _executions WHERE id = ?').run(path.executionId!)
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
    async ({ ctx, path, request, url }) => {
      const f = ctx.functions.fn(path.functionId!)
      ctx.functions.assertCanExecute(ctx.caller, f)
      const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text()
      const { result } = await ctx.functions.execute(
        f,
        {
          trigger: 'http',
          method: request.method,
          path: `/${path.rest ?? ''}${url.search}`,
          headers: Object.fromEntries(request.headers),
          body,
          userId: ctx.caller.user?.id ?? null,
        },
        'sync',
      )
      const headers = Object.fromEntries(Object.entries(result!.headers).filter(([k]) => !HOP_HEADERS.has(k.toLowerCase())))
      const binary = !/json|text|xml|javascript/i.test(headers['content-type'] ?? headers['Content-Type'] ?? 'text')
      const payload = binary ? Buffer.from(result!.body, 'latin1') : result!.body
      if (result!.statusCode !== 204) {
        headers['content-length'] = String(typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length)
      }
      return new Response(result!.statusCode === 204 ? null : payload, { status: result!.statusCode || 500, headers })
    },
    { raw: true },
  )
}
