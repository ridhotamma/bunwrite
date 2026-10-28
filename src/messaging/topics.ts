/**
 * Messaging topics, so `appwrite pull/push topics` round-trips. This server
 * sends no email, SMS or push messages through topics, so subscriber totals
 * stay at zero and there are no providers or subscribers.
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import type { Db } from '~/db/connection'
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
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw err('general_argument_invalid', 'Invalid `name` param: Value must be a valid string and at least 1 chars and no longer than 128 chars')
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
  constructor(private db: Db) {}

  private get sql() {
    return this.db.sqlite
  }

  list(): TopicRow[] {
    return this.sql.query<TopicRow, []>('SELECT * FROM _topics ORDER BY seq').all()
  }

  get(id: string): TopicRow {
    const row = this.sql.query<TopicRow, [string]>('SELECT * FROM _topics WHERE id = ?').get(id)
    if (!row) throw err('topic_not_found')
    return row
  }

  create(id: unknown, name: unknown, subscribe: unknown): TopicRow {
    const topicId = resolveId(id, 'Topic ID')
    if (this.sql.query('SELECT 1 FROM _topics WHERE id = ?').get(topicId)) throw err('topic_already_exists')
    const stamp = now()
    this.sql
      .query('INSERT INTO _topics (id, name, subscribe, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(topicId, validName(name), JSON.stringify(subscribe === undefined || subscribe === null ? ['users'] : validRoles(subscribe)), stamp, stamp)
    return this.get(topicId)
  }

  update(id: string, name: unknown, subscribe: unknown): TopicRow {
    const t = this.get(id)
    this.sql
      .query('UPDATE _topics SET name = ?, subscribe = ?, updated_at = ? WHERE id = ?')
      .run(
        name === undefined || name === null ? t.name : validName(name),
        subscribe === undefined || subscribe === null ? t.subscribe : JSON.stringify(validRoles(subscribe)),
        now(),
        id,
      )
    return this.get(id)
  }

  delete(id: string): void {
    this.get(id)
    this.sql.query('DELETE FROM _topics WHERE id = ?').run(id)
  }
}

export function topicRoutes(router: Router<AppContext>): void {
  router.get('/messaging/topics', ({ ctx, params }) => {
    requireKey(ctx, 'topics.read')
    const { total, items } = page(ctx.topics.list().map(topicModel), list(params.queries), { search: str(params.search), searchFields: ['$id', 'name'] })
    return json({ total, topics: items })
  })

  router.post('/messaging/topics', ({ ctx, params }) => {
    requireKey(ctx, 'topics.write')
    return json(topicModel(ctx.topics.create(params.topicId, params.name, params.subscribe)), 201)
  })

  router.get('/messaging/topics/:topicId', ({ ctx, path }) => {
    requireKey(ctx, 'topics.read')
    return json(topicModel(ctx.topics.get(path.topicId!)))
  })

  router.patch('/messaging/topics/:topicId', ({ ctx, path, params }) => {
    requireKey(ctx, 'topics.write')
    return json(topicModel(ctx.topics.update(path.topicId!, params.name, params.subscribe)))
  })

  router.delete('/messaging/topics/:topicId', ({ ctx, path }) => {
    requireKey(ctx, 'topics.write')
    ctx.topics.delete(path.topicId!)
    return noContent()
  })
}
