/**
 * Messaging topics, so `appwrite pull/push topics` round-trips. This server
 * sends no email, SMS or push messages through topics, so subscriber totals
 * stay at zero and there are no providers or subscribers.
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import type { SqlDatabase } from '~/db/driver'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { json, list, noContent, str } from '~/lib/http'
import { resolveId } from '~/lib/ids'
import { page } from '~/lib/paging'
import type { Router } from '~/lib/router'

interface TopicRow {
  id: string
  name: string
  subscribe: string
  created_at: string
  updated_at: string
}

export function topicModel(t: TopicRow) {
  return {
    $id: t.id,
    $createdAt: t.created_at,
    $updatedAt: t.updated_at,
    name: t.name,
    emailTotal: 0,
    smsTotal: 0,
    pushTotal: 0,
    subscribe: JSON.parse(t.subscribe) as string[],
  }
}

function validName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128)
    throw err('general_argument_invalid', 'Invalid `name` param: Value must be a valid string and at least 1 chars and no longer than 128 chars')
  return value
}

/** Roles allowed to subscribe, such as `users` or `team:abc`. */
function validRoles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((r) => typeof r !== 'string' || !r || r.length > 256)) {
    throw err('general_argument_invalid', 'Invalid `subscribe` param: Value must be a valid array of up to 100 roles.')
  }
  return [...new Set(value as string[])]
}

export class TopicService {
  constructor(private db: SqlDatabase) {}

  async list(): Promise<TopicRow[]> {
    return this.db.driver.all<TopicRow>('SELECT * FROM _topics ORDER BY seq')
  }

  async get(id: string): Promise<TopicRow> {
    const row = await this.db.driver.get<TopicRow>('SELECT * FROM _topics WHERE id = ?', [id])
    if (!row) throw err('topic_not_found')
    return row
  }

  async create(id: unknown, name: unknown, subscribe: unknown): Promise<TopicRow> {
    const topicId = resolveId(id, 'Topic ID')
    if (await this.db.driver.get('SELECT 1 FROM _topics WHERE id = ?', [topicId])) throw err('topic_already_exists')
    const stamp = now()
    await this.db.driver.run('INSERT INTO _topics (id, name, subscribe, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      topicId,
      validName(name),
      JSON.stringify(subscribe === undefined || subscribe === null ? ['users'] : validRoles(subscribe)),
      stamp,
      stamp,
    ])
    return this.get(topicId)
  }

  async update(id: string, name: unknown, subscribe: unknown): Promise<TopicRow> {
    const t = await this.get(id)
    await this.db.driver.run('UPDATE _topics SET name = ?, subscribe = ?, updated_at = ? WHERE id = ?', [
      name === undefined || name === null ? t.name : validName(name),
      subscribe === undefined || subscribe === null ? t.subscribe : JSON.stringify(validRoles(subscribe)),
      now(),
      id,
    ])
    return this.get(id)
  }

  async delete(id: string): Promise<void> {
    await this.get(id)
    await this.db.driver.run('DELETE FROM _topics WHERE id = ?', [id])
  }
}

export function topicRoutes(router: Router<AppContext>): void {
  router.get('/messaging/topics', async ({ ctx, params }) => {
    requireKey(ctx, 'topics.read')
    const { total, items } = page((await ctx.topics.list()).map(topicModel), list(params.queries), {
      search: str(params.search),
      searchFields: ['$id', 'name'],
    })
    return json({ total, topics: items })
  })

  router.post('/messaging/topics', async ({ ctx, params }) => {
    requireKey(ctx, 'topics.write')
    return json(topicModel(await ctx.topics.create(params.topicId, params.name, params.subscribe)), 201)
  })

  router.get('/messaging/topics/:topicId', async ({ ctx, path }) => {
    requireKey(ctx, 'topics.read')
    return json(topicModel(await ctx.topics.get(path.topicId!)))
  })

  router.patch('/messaging/topics/:topicId', async ({ ctx, path, params }) => {
    requireKey(ctx, 'topics.write')
    return json(topicModel(await ctx.topics.update(path.topicId!, params.name, params.subscribe)))
  })

  router.delete('/messaging/topics/:topicId', async ({ ctx, path }) => {
    requireKey(ctx, 'topics.write')
    await ctx.topics.delete(path.topicId!)
    return noContent()
  })
}
