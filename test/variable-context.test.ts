/**
 * Deploy contexts on variables, like Vercel's Production/Preview: a value for
 * every deployment, live only, or previews only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ConsoleAuth } from '~/console/auth'
import { buildContext, parseFunctionVariableId, resolveContext } from '~/variables/context'
import { KEY, PROJECT, startServer, type TestServer } from './helpers'

let server: TestServer

beforeAll(() => {
  server = startServer()
})
afterAll(() => server.stop())

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${server.endpoint}${path}`, {
    method,
    headers: { 'x-bunwrite-project': PROJECT, 'x-bunwrite-key': KEY, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as any) }
}

describe('resolving a deploy context', () => {
  test("a context's own value wins over the every-deployment one", () => {
    const rows = [
      { key: 'A', value: 'all', context: '' },
      { key: 'A', value: 'preview', context: 'preview' },
      { key: 'B', value: 'live only', context: 'live' },
      { key: 'C', value: 'all', context: '' },
    ]
    expect(resolveContext(rows, 'live')).toEqual({ A: 'all', B: 'live only', C: 'all' })
    expect(resolveContext(rows, 'preview')).toEqual({ A: 'preview', C: 'all' })
  })

  test('builds that go live are live; others are previews', () => {
    expect(buildContext(1)).toBe('live')
    expect(buildContext(true)).toBe('live')
    expect(buildContext(0)).toBe('preview')
  })

  test('function variable IDs carry the context after a dot', () => {
    expect(parseFunctionVariableId('TOKEN')).toEqual({ key: 'TOKEN', context: '' })
    expect(parseFunctionVariableId('TOKEN.preview')).toEqual({ key: 'TOKEN', context: 'preview' })
    expect(() => parseFunctionVariableId('TOKEN.other')).toThrow()
  })
})

describe('project and site variables', () => {
  test('one name can have a value per context; the API returns the context', async () => {
    expect((await api('POST', '/project/variables', { variableId: 'unique()', key: 'MODE', value: 'all' })).body.context).toBe('')
    expect((await api('POST', '/project/variables', { variableId: 'unique()', key: 'MODE', value: 'live', context: 'live' })).status).toBe(201)
    const preview = await api('POST', '/project/variables', { variableId: 'unique()', key: 'MODE', value: 'preview', context: 'preview' })
    expect(preview.body).toMatchObject({ key: 'MODE', value: 'preview', context: 'preview' })

    expect((await api('POST', '/project/variables', { variableId: 'unique()', key: 'MODE', value: 'again', context: 'preview' })).status).toBe(409)
    expect((await api('POST', '/project/variables', { variableId: 'unique()', key: 'MODE', value: 'x', context: 'staging' })).status).toBe(400)

    const listed = (await api('GET', '/project/variables')).body.variables
    expect(listed.map((v: any) => [v.key, v.context]).sort()).toEqual([['MODE', ''], ['MODE', 'live'], ['MODE', 'preview']])

    const vars = server.services.variables
    expect(vars.projectEnvironment('live').MODE).toBe('live')
    expect(vars.projectEnvironment('preview').MODE).toBe('preview')

    // Moving a value to another context is an update; it cannot collide.
    expect((await api('PUT', `/project/variables/${preview.body.$id}`, { context: 'live' })).status).toBe(409)
    expect((await api('PUT', `/project/variables/${preview.body.$id}`, { value: 'preview 2' })).body.context).toBe('preview')
    expect(vars.projectEnvironment('preview').MODE).toBe('preview 2')

    await api('DELETE', `/project/variables/${preview.body.$id}`)
    expect(vars.projectEnvironment('preview').MODE).toBe('all')
    vars.clearVariables('project')
  })

  test('a site sees project values, then its own, each for the context', async () => {
    const vars = server.services.variables
    vars.setVariable('project', 'API', 'project-live', false, 'live')
    vars.setVariable('project', 'API', 'project-preview', false, 'preview')
    vars.setVariable('site:web', 'API', 'site-preview', false, 'preview')
    vars.setVariable('site:web', 'ONLY_LIVE', 'yes', false, 'live')
    try {
      expect(vars.siteEnvironment('web', 'live')).toEqual({ API: 'project-live', ONLY_LIVE: 'yes' })
      expect(vars.siteEnvironment('web', 'preview')).toEqual({ API: 'site-preview' })
      // Older callers get live values.
      expect(vars.siteEnvironment('web')).toEqual({ API: 'project-live', ONLY_LIVE: 'yes' })
    } finally {
      vars.clearVariables('project')
      vars.clearVariables('site:web')
    }
  })
})

describe('function variables', () => {
  test('IDs carry the context, and builds and runs see their own values', async () => {
    expect((await api('POST', '/functions', { functionId: 'ctx-fn', name: 'Context', runtime: 'node-22' })).status).toBe(201)
    try {
      await api('POST', '/functions/ctx-fn/variables', { key: 'STRIPE_KEY', value: 'sk_live', secret: true, context: 'live' })
      const preview = await api('POST', '/functions/ctx-fn/variables', { key: 'STRIPE_KEY', value: 'sk_test', context: 'preview' })
      expect(preview.status).toBe(201)
      expect(preview.body).toMatchObject({ $id: 'STRIPE_KEY.preview', key: 'STRIPE_KEY', context: 'preview' })
      await api('POST', '/functions/ctx-fn/variables', { key: 'SHARED', value: 'everywhere' })
      expect((await api('POST', '/functions/ctx-fn/variables', { key: 'STRIPE_KEY', value: 'dup', context: 'preview' })).status).toBe(409)

      expect((await api('GET', '/functions/ctx-fn/variables/STRIPE_KEY.preview')).body.value).toBe('sk_test')
      expect((await api('GET', '/functions/ctx-fn/variables/STRIPE_KEY')).status).toBe(404)
      expect((await api('PUT', '/functions/ctx-fn/variables/STRIPE_KEY.preview', { value: 'sk_test_2' })).body.$id).toBe('STRIPE_KEY.preview')

      server.services.functions.setVariable('*', 'GLOBAL', 'preview global', false, 'preview')
      const fn = server.services.functions.fn('ctx-fn')
      const live = server.services.functions.env(fn, 'http')
      const build = server.services.functions.env(fn, 'build', 'preview')
      expect([live.STRIPE_KEY, live.SHARED, live.GLOBAL]).toEqual(['sk_live', 'everywhere', undefined])
      expect([build.STRIPE_KEY, build.SHARED, build.GLOBAL]).toEqual(['sk_test_2', 'everywhere', 'preview global'])

      expect((await api('DELETE', '/functions/ctx-fn/variables/STRIPE_KEY.preview')).status).toBe(204)
      expect(server.services.functions.env(fn, 'build', 'preview').STRIPE_KEY).toBeUndefined()
      expect(server.services.functions.env(fn, 'http').STRIPE_KEY).toBe('sk_live')
    } finally {
      server.services.functions.clearVariables('*')
      await api('DELETE', '/functions/ctx-fn')
    }
  })
})

describe('console', () => {
  test('a variable can be added for previews only, shown with a badge, and removed', async () => {
    await new ConsoleAuth(server.db).upsert('ctx-admin@example.com', 'console-password')
    const base = server.endpoint.replace(/\/v1$/, '')
    const login = await fetch(`${base}/console/login`, {
      method: 'POST',
      body: new URLSearchParams({ email: 'ctx-admin@example.com', password: 'console-password' }),
      redirect: 'manual',
    })
    const cookie = `${(login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')}; console_project=${PROJECT}`
    const post = (path: string, fields: Record<string, string>) =>
      fetch(`${base}${path}`, { method: 'POST', body: new URLSearchParams(fields), redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } })

    await post('/console/settings/variables', { key: 'API_URL', value: 'https://api.example.com' })
    await post('/console/settings/variables', { key: 'API_URL', value: 'https://staging.example.com', context: 'preview' })
    const page = await (await fetch(`${base}/console/settings/variables`, { headers: { cookie } })).text()
    expect(page).toContain('Previews only')
    expect(page).toContain('https://staging.example.com')
    expect(server.services.variables.projectEnvironment('preview').API_URL).toBe('https://staging.example.com')
    expect(server.services.variables.projectEnvironment('live').API_URL).toBe('https://api.example.com')

    await post('/console/settings/variables/delete', { key: 'API_URL', context: 'preview' })
    expect(server.services.variables.list('project').map((v) => [v.key, v.context])).toEqual([['API_URL', '']])
    server.services.variables.clearVariables('project')
  })
})
