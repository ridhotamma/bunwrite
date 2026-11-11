/** Resource lists share one toolbar: search, plus Edit and Delete for the checked rows. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { ConsoleAuth } from '~/console/auth'
import { KEY, PROJECT, startServer, type TestServer } from './helpers'

let server: TestServer
let base: string
let cookie = ''

const api = (path: string, body: unknown) =>
  fetch(`${server.endpoint}${path}`, {
    method: 'POST',
    headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const get = async (path: string) => (await fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' })).text()
const post = (path: string, ids: string[]) => {
  const body = new URLSearchParams()
  for (const id of ids) body.append('ids', id)
  return fetch(`${base}${path}`, { method: 'POST', body, headers: { cookie }, redirect: 'manual' })
}
const flash = (res: Response) => new URL(res.headers.get('location') ?? '/', base).searchParams

beforeAll(async () => {
  server = startServer()
  base = server.endpoint.replace(/\/v1$/, '')
  const auth = new ConsoleAuth(server.db)
  await auth.upsert('lists@example.com', 'console-password')
  cookie = `bunwrite_console=${(await auth.login('lists@example.com', 'console-password'))!}; console_project=${PROJECT}`

  for (const [id, name] of [['alpha', 'Alpha'], ['beta', 'Beta'], ['gamma', 'Gamma']]) {
    expect((await api('/teams', { teamId: `team-${id}`, name: `${name} team` })).status).toBe(201)
    expect((await api('/databases', { databaseId: `db-${id}`, name: `${name} db` })).status).toBe(201)
    expect((await api('/storage/buckets', { bucketId: `bucket-${id}`, name: `${name} bucket` })).status).toBe(201)
    expect((await api('/users', { userId: `user-${id}`, email: `${id}@example.com`, password: 'password123', name: `${name} user` })).status).toBe(201)
  }
})
afterAll(() => server.stop())

describe('console resource lists', () => {
  const lists: [string, string, string][] = [
    ['/console/auth/users', 'user-alpha', '/console/auth/users/user-alpha/settings'],
    ['/console/auth/teams', 'team-alpha', '/console/auth/teams/team-alpha/settings'],
    ['/console/databases', 'db-alpha', '/console/databases/db-alpha/settings'],
    ['/console/storage', 'bucket-alpha', '/console/storage/bucket-alpha/settings'],
  ]

  test('each list has a search box and Edit / Delete selected tied to row checkboxes', async () => {
    for (const [path, id, edit] of lists) {
      const page = await get(path)
      expect(page).toContain('role="search"')
      expect(page).toContain(`action="${path}/bulk-delete"`)
      expect(page).toContain('data-bulk-edit')
      expect(page).toContain(`value="${id}" data-bulk-id`)
      expect(page).toContain(`data-edit="${edit}"`)
    }
    // Lists that start empty still render their search-free empty state.
    for (const path of ['/console/functions', '/console/sites', '/console/webhooks', '/console/vectors']) {
      expect(await get(path)).not.toContain('Delete selected')
    }
  })

  test('search narrows the rows, and an unmatched search offers to clear it', async () => {
    const teams = await get('/console/auth/teams?search=beta')
    expect(teams).toContain('team-beta')
    expect(teams).not.toContain('team-gamma')

    const databases = await get('/console/databases?search=gamma')
    expect(databases).toContain('db-gamma')
    expect(databases).not.toContain('db-alpha')

    const buckets = await get('/console/storage?search=nothing-here')
    expect(buckets).toContain('No buckets match')
    expect(buckets).toContain('Clear search')
  })

  test('bulk delete removes the checked rows and skips ones already gone', async () => {
    const teams = await post('/console/auth/teams/bulk-delete', ['team-alpha', 'team-beta', 'missing'])
    expect(flash(teams).get('ok')).toBe('2 teams deleted')
    expect(await get('/console/auth/teams')).not.toContain('team-alpha')
    expect(await get('/console/auth/teams')).toContain('team-gamma')

    const databases = await post('/console/databases/bulk-delete', ['db-alpha'])
    expect(flash(databases).get('ok')).toBe('1 database deleted')

    const buckets = await post('/console/storage/bulk-delete', ['bucket-alpha', 'bucket-beta'])
    expect(flash(buckets).get('ok')).toBe('2 buckets deleted')

    const users = await post('/console/auth/users/bulk-delete', ['user-gamma'])
    expect(flash(users).get('ok')).toBe('1 user deleted')

    const nothing = await post('/console/auth/teams/bulk-delete', ['missing'])
    expect(flash(nothing).get('ok')).toBe('No teams were deleted.')
  })
})
