/**
 * Scopes an API key may carry. A key without scopes (legacy console keys)
 * keeps full access; a scoped key may only call the operations whose scope it
 * holds. Names follow the `requireKey()` calls in the routes.
 */
import { err } from '~/lib/errors'

export interface ApiKeyScopeGroup {
  label: string
  scopes: { id: string; label: string }[]
}

export const API_KEY_SCOPE_GROUPS: ApiKeyScopeGroup[] = [
  {
    label: 'Account',
    scopes: [
      { id: 'users.read', label: 'Read users' },
      { id: 'users.write', label: 'Create, update and delete users' },
      { id: 'users.secrets', label: 'Read password hashes and provider tokens (legacy Appwrite mode)' },
      { id: 'teams.read', label: 'Read teams and memberships' },
      { id: 'teams.write', label: 'Create, update and delete teams and memberships' },
    ],
  },
  {
    label: 'Databases',
    scopes: [
      { id: 'databases.read', label: 'Read databases' },
      { id: 'databases.write', label: 'Create, update and delete databases' },
      { id: 'collections.read', label: 'Read collections, attributes and indexes' },
      { id: 'collections.write', label: 'Create, update and delete collections, attributes and indexes' },
      { id: 'documents.read', label: 'Read documents' },
      { id: 'documents.write', label: 'Create, update and delete documents and transactions' },
    ],
  },
  {
    label: 'Vectors and RAG',
    scopes: [
      { id: 'vectorsdb.collections.read', label: 'Read vector collections' },
      { id: 'vectorsdb.collections.write', label: 'Create and delete vector collections' },
      { id: 'vectorsdb.documents.read', label: 'Search vectors, read points and query RAG' },
      { id: 'vectorsdb.documents.write', label: 'Upsert and delete points, ingest documents' },
    ],
  },
  {
    label: 'Storage',
    scopes: [
      { id: 'buckets.read', label: 'Read buckets' },
      { id: 'buckets.write', label: 'Create, update and delete buckets' },
      { id: 'files.read', label: 'Read and download files' },
      { id: 'files.write', label: 'Upload, update and delete files' },
    ],
  },
  {
    label: 'Functions',
    scopes: [
      { id: 'functions.read', label: 'Read functions, deployments and variables' },
      { id: 'functions.write', label: 'Create, deploy, update and delete functions' },
      { id: 'execution.read', label: 'Read executions' },
      { id: 'execution.write', label: 'Run and delete executions' },
    ],
  },
  {
    label: 'Sites',
    scopes: [
      { id: 'sites.read', label: 'Read sites and deployments' },
      { id: 'sites.write', label: 'Create, deploy, update and delete sites' },
      { id: 'rules.read', label: 'Read custom domains' },
      { id: 'rules.write', label: 'Create, verify and delete custom domains' },
    ],
  },
  {
    label: 'Messaging and delivery',
    scopes: [
      { id: 'topics.read', label: 'Read topics' },
      { id: 'topics.write', label: 'Create, update and delete topics and subscribers' },
      { id: 'queue.read', label: 'Read queue messages' },
      { id: 'queue.write', label: 'Publish, requeue and delete queue messages' },
      { id: 'webhooks.read', label: 'Read webhooks' },
      { id: 'webhooks.write', label: 'Create, update, test and delete webhooks' },
      { id: 'vcs.read', label: 'Read Git installations and repositories' },
      { id: 'vcs.write', label: 'Manage Git installations and repository links' },
      { id: 'render.read', label: 'Render images' },
      { id: 'render.write', label: 'Render PDFs' },
    ],
  },
  {
    label: 'Project',
    scopes: [
      { id: 'project.read', label: 'Read project settings' },
      { id: 'project.write', label: 'Update project settings and variables' },
      { id: 'policies.read', label: 'Read project policies' },
      { id: 'policies.write', label: 'Update project policies' },
      { id: 'templates.read', label: 'Read email templates' },
      { id: 'templates.write', label: 'Update email templates' },
    ],
  },
]

export const API_KEY_SCOPES = API_KEY_SCOPE_GROUPS.flatMap((group) => group.scopes.map((scope) => scope.id))

const KNOWN = new Set(API_KEY_SCOPES)

/** Validate scopes submitted from the console; null means full access. */
export function apiKeyScopes(input: unknown): string[] | null {
  if (input === null || input === undefined) return null
  const raw = (Array.isArray(input) ? input : [input]).map(String).filter((scope) => scope.trim() !== '')
  if (raw.some((scope) => !KNOWN.has(scope))) {
    throw err('general_argument_invalid', 'One of the API key scopes is not valid.')
  }
  const scopes = [...new Set(raw)]
  if (scopes.length === 0) throw err('general_argument_invalid', 'Pick at least one API key scope.')
  return scopes
}

/**
 * Parse a stored JSON scope list. Only an absent value means "legacy/full
 * access"; a corrupt or non-array value fails closed (no scopes) instead of
 * silently upgrading a restricted key to full access.
 */
export function storedApiKeyScopes(value: unknown): string[] | null {
  if (value === null || value === undefined || value === '') return null
  try {
    const parsed = JSON.parse(String(value)) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map(String).filter((scope) => KNOWN.has(scope))
  } catch {
    return []
  }
}
