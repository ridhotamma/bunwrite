import type { AppContext } from '../app'
import { requireKey } from '../auth/routes'
import { err } from '../lib/errors'
import { bool, json, list, noContent, str } from '../lib/http'
import type { Router } from '../lib/router'
import { executionModel, functionModel } from './service'

const HOP_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection'])

export function functionRoutes(router: Router<AppContext>): void {
  router.get('/functions', ({ ctx }) => {
    requireKey(ctx, 'functions.read')
    const functions = ctx.functions.list().map(functionModel)
    return json({ total: functions.length, functions })
  })

  router.get('/functions/:functionId', ({ ctx, path }) => {
    requireKey(ctx, 'functions.read')
    return json(functionModel(ctx.functions.fn(path.functionId!)))
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
      return new Response(result!.statusCode === 204 ? null : payload, { status: result!.statusCode || 500, headers })
    },
    { raw: true },
  )
}
