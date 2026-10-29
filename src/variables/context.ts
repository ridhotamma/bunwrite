/**
 * Deploy contexts, like Vercel's Production/Preview: a variable can apply to
 * every deployment (''), only to live ones, or only to previews.
 *
 * - live: what serves the site or runs the function: the active deployment,
 *   and builds that go live (the production branch, `bunwrite push`).
 * - preview: builds that do not go live (other Git branches, `--activate
 *   false`) and SSR previews of those builds.
 *
 * A context's own value wins over the every-deployment one. Scopes keep their
 * order on top: project < (global function) < function or site.
 */
import { err } from '~/lib/errors'

export type DeployContext = 'live' | 'preview'
export type VariableContext = '' | DeployContext

export const VARIABLE_CONTEXTS: VariableContext[] = ['', 'live', 'preview']

export const CONTEXT_LABELS: Record<VariableContext, string> = { '': 'All deployments', live: 'Live only', preview: 'Previews only' }

/** '' for absent, empty or "all"; otherwise live or preview. */
export function variableContext(value: unknown): VariableContext {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text || text === 'all') return ''
  if (text === 'live' || text === 'preview') return text
  throw err('general_argument_invalid', 'Invalid `context` param: use "", "live" or "preview".')
}

/** The deployments a build serves: one that goes live builds with live values. */
export const buildContext = (activate: unknown): DeployContext => (activate ? 'live' : 'preview')

/** Values for one deploy context: its own row for a key wins over the every-deployment one. */
export function resolveContext(rows: { key: string; value: string; context?: string | null }[], context: DeployContext): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) if (!row.context) out[row.key] = row.value
  for (const row of rows) if (row.context === context) out[row.key] = row.value
  return out
}

/**
 * Function variables are keyed by name, so a variable's ID is its key, plus
 * `.live` or `.preview` for a context (keys never contain a dot).
 */
export const functionVariableId = (key: string, context: string | null | undefined) => (context ? `${key}.${context}` : key)

export function parseFunctionVariableId(id: string): { key: string; context: VariableContext } {
  const dot = id.indexOf('.')
  if (dot < 0) return { key: id, context: '' }
  return { key: id.slice(0, dot), context: variableContext(id.slice(dot + 1)) }
}
