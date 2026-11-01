/**
 * Route normalisation for metric, trace and console labels.
 *
 * Raw API paths contain database, collection and document IDs, which would
 * make every request its own metric series. Replace those with `:id`, keeping
 * the static shape of the route.
 */
const NUMERIC = /^\d+$/
const OPAQUE_ID = /^(?=.*[\d_-])[A-Za-z0-9_-]{10,}$/

/** Segments that name a resource immediately followed by that resource's ID. */
const ID_AFTER = new Set([
  'databases',
  'collections',
  'documents',
  'buckets',
  'files',
  'teams',
  'users',
  'functions',
  'sites',
  'deployments',
  'executions',
  'memberships',
  'targets',
  'providers',
  'topics',
  'subscribers',
  'variables',
  'webhooks',
  'keys',
  'projects',
  'organizations',
  'messages',
  'jobs',
  'rules',
  'subscriptions',
])

export function normalizePath(pathname: string): string {
  const path = pathname.replace(/^\/v1(?=\/|$)/, '') || '/'
  const parts = path.split('/')
  for (let index = 1; index < parts.length; index++) {
    const part = parts[index]!
    const previous = parts[index - 1]!
    if (NUMERIC.test(part) || OPAQUE_ID.test(part) || ID_AFTER.has(previous)) parts[index] = ':id'
  }
  return parts.join('/')
}
