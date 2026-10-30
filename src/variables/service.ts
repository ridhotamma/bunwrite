/**
 * Project and site variables.
 *
 * Project variables are the appwrite-compatible `/project/variables` scope:
 * every site and function sees them. Site variables are `/sites/:id/variables`
 * and win over a project value with the same name. Server environment values
 * are the base; a variable saved here overrides one from the host.
 *
 * Function variables live in `_function_vars` (see functions/service.ts) and
 * keep their own precedence: project < function.
 *
 * Every variable also has a deploy context ('' for every deployment, `live`
 * or `preview`); see context.ts.
 */
import type { Db } from '~/db/connection'
import { ENV_KEY_RE, type EnvVariable } from '~/functions/env'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { uniqueId } from '~/lib/ids'
import { resolveContext, type DeployContext, type VariableContext } from './context'

export const PROJECT_SCOPE = 'project'
export const siteScope = (siteId: string) => `site:${siteId}`

export interface VariableRow {
  seq: number
  id: string
  scope: string
  key: string
  value: string
  secret: number
  /** '' for every deployment, or live / preview. */
  context: string
  created_at: string
  updated_at: string
}

export class VariablesService {
  constructor(private db: Db) {}

  private get sql() {
    return this.db.sqlite
  }

  /** Variables in one scope, keyed by name. */
  list(scope: string): VariableRow[] {
    return this.sql.query<VariableRow, [string]>('SELECT * FROM _variables WHERE scope = ? ORDER BY key, context').all(scope)
  }

  /** `list` under the name the shared console variable routes expect. */
  variables(scope: string): VariableRow[] {
    return this.list(scope)
  }

  byId(scope: string, id: string): VariableRow | null {
    return this.sql.query<VariableRow, [string, string]>('SELECT * FROM _variables WHERE scope = ? AND id = ?').get(scope, id) ?? null
  }

  get(scope: string, id: string): VariableRow {
    const row = this.byId(scope, id)
    if (!row) throw err('variable_not_found')
    return row
  }

  /** The variable for a key in one context ('' is every deployment). */
  byKey(scope: string, key: string, context: VariableContext = ''): VariableRow | null {
    return this.sql.query<VariableRow, [string, string, string]>('SELECT * FROM _variables WHERE scope = ? AND key = ? AND context = ?').get(scope, key, context) ?? null
  }

  /** The scope as an environment record for one deploy context. */
  environment(scope: string, context: DeployContext = 'live'): Record<string, string> {
    return resolveContext(this.list(scope), context)
  }

  projectEnvironment(context: DeployContext = 'live'): Record<string, string> {
    return this.environment(PROJECT_SCOPE, context)
  }

  /**
   * Global function variables (`function_id = '*'`) used to be a separate
   * scope. Move them to project variables, which every function already reads,
   * and drop them. Safe to run on every start; a project value with the same
   * name and context wins.
   */
  adoptFunctionGlobals(): void {
    const rows = this.sql
      .query<{ key: string; value: string; secret: number; context: string; created_at: string; updated_at: string }, []>(
        "SELECT key, value, secret, context, created_at, updated_at FROM _function_vars WHERE function_id = '*'",
      )
      .all()
    if (!rows.length) return
    this.sql.transaction(() => {
      const insert = this.sql.prepare(
        `INSERT INTO _variables (id, scope, key, value, secret, context, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scope, key, context) DO NOTHING`,
      )
      for (const row of rows) {
        insert.run(uniqueId(), PROJECT_SCOPE, row.key, row.value, row.secret, row.context, row.created_at, row.updated_at)
      }
      this.sql.query("DELETE FROM _function_vars WHERE function_id = '*'").run()
    }).immediate()
  }

  /** Project values first, then the site's own — the site wins. */
  siteEnvironment(siteId: string, context: DeployContext = 'live'): Record<string, string> {
    return {
      ...this.projectEnvironment(context),
      ...this.environment(siteScope(siteId), context),
    }
  }

  /** Create one variable. `id` is Appwrite's variableId; a key is unique per scope and context. */
  create(scope: string, id: string, key: string, value: string, secret: boolean, context: VariableContext = ''): VariableRow {
    if (!ENV_KEY_RE.test(key)) {
      throw err('general_argument_invalid', 'Variable names use letters, digits and underscores.')
    }
    if (this.byId(scope, id)) throw err('variable_already_exists')
    if (this.byKey(scope, key, context)) throw err('variable_already_exists')
    const stamp = now()
    this.sql
      .query('INSERT INTO _variables (id, scope, key, value, secret, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, scope, key, value, secret ? 1 : 0, context, stamp, stamp)
    return this.get(scope, id)
  }

  /** Update by variable ID; the key and context must not collide with another variable in the scope. */
  update(scope: string, id: string, params: { key?: string; value?: string; secret?: boolean; context?: VariableContext }): VariableRow {
    const current = this.get(scope, id)
    const key = params.key ?? current.key
    const context = params.context ?? (current.context as VariableContext)
    if (!ENV_KEY_RE.test(key)) {
      throw err('general_argument_invalid', 'Variable names use letters, digits and underscores.')
    }
    const secret = params.secret ?? Boolean(current.secret)
    if (current.secret && !secret) throw err('variable_cannot_unset_secret')
    if (key !== current.key || context !== current.context) {
      const rival = this.byKey(scope, key, context)
      if (rival && rival.id !== id) throw err('variable_already_exists')
    }
    this.sql
      .query('UPDATE _variables SET key = ?, value = ?, secret = ?, context = ?, updated_at = ? WHERE scope = ? AND id = ?')
      .run(key, params.value ?? current.value, secret ? 1 : 0, context, now(), scope, id)
    return this.get(scope, id)
  }

  /**
   * Console upsert by name, used by the shared variable cards. A new variable
   * gets a generated ID; one created through the API keeps its own ID.
   */
  setVariable(scope: string, key: string, value: string, secret: boolean, context: VariableContext = ''): void {
    const existing = this.byKey(scope, key, context)
    if (existing) {
      this.sql.query('UPDATE _variables SET value = ?, secret = ?, updated_at = ? WHERE id = ?').run(value, secret ? 1 : 0, now(), existing.id)
      return
    }
    this.create(scope, uniqueId(), key, value, secret, context)
  }

  /** Bulk console import: every entry goes to one scope, one secret flag and one context. */
  setVariables(scope: string, entries: EnvVariable[], secret: boolean, context: VariableContext = ''): void {
    for (const { key, value } of entries) this.setVariable(scope, key, value, secret, context)
  }

  deleteById(scope: string, id: string): void {
    this.get(scope, id)
    this.sql.query('DELETE FROM _variables WHERE scope = ? AND id = ?').run(scope, id)
  }

  deleteVariable(scope: string, key: string, context: VariableContext = ''): void {
    this.sql.query('DELETE FROM _variables WHERE scope = ? AND key = ? AND context = ?').run(scope, key, context)
  }

  /** Forget every variable in a scope; returns how many were removed. */
  clearVariables(scope: string): number {
    return Number(this.sql.query('DELETE FROM _variables WHERE scope = ?').run(scope).changes ?? 0)
  }

  /** Site deletion removes its variables; project variables stay. */
  removeSite(siteId: string): void {
    this.sql.query('DELETE FROM _variables WHERE scope = ?').run(siteScope(siteId))
  }
}
