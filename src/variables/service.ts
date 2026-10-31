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
 *
 * All database access goes through `db.driver`, so this service runs on SQLite
 * and Postgres alike.
 */
import type { SqlDatabase } from '~/db/driver'
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
  constructor(private db: SqlDatabase) {}

  private get sql() {
    return this.db.driver
  }

  /** Variables in one scope, keyed by name. */
  list(scope: string): Promise<VariableRow[]> {
    return this.sql.all<VariableRow>('SELECT * FROM _variables WHERE scope = ? ORDER BY key, context', [scope])
  }

  /** `list` under the name the shared console variable routes expect. */
  variables(scope: string): Promise<VariableRow[]> {
    return this.list(scope)
  }

  async byId(scope: string, id: string): Promise<VariableRow | null> {
    return this.sql.get<VariableRow>('SELECT * FROM _variables WHERE scope = ? AND id = ?', [scope, id])
  }

  async get(scope: string, id: string): Promise<VariableRow> {
    const row = await this.byId(scope, id)
    if (!row) throw err('variable_not_found')
    return row
  }

  /** The variable for a key in one context ('' is every deployment). */
  async byKey(scope: string, key: string, context: VariableContext = ''): Promise<VariableRow | null> {
    return this.sql.get<VariableRow>('SELECT * FROM _variables WHERE scope = ? AND key = ? AND context = ?', [scope, key, context])
  }

  /** The scope as an environment record for one deploy context. */
  async environment(scope: string, context: DeployContext = 'live'): Promise<Record<string, string>> {
    return resolveContext(await this.list(scope), context)
  }

  projectEnvironment(context: DeployContext = 'live'): Promise<Record<string, string>> {
    return this.environment(PROJECT_SCOPE, context)
  }

  /**
   * Global function variables (`function_id = '*'`) used to be a separate
   * scope. Move them to project variables, which every function already reads,
   * and drop them. Safe to run on every start; a project value with the same
   * name and context wins.
   */
  async adoptFunctionGlobals(): Promise<void> {
    const rows = await this.sql.all<{ key: string; value: string; secret: number; context: string; created_at: string; updated_at: string }>(
      "SELECT key, value, secret, context, created_at, updated_at FROM _function_vars WHERE function_id = '*'",
    )
    if (!rows.length) return
    await this.sql.transaction(async (tx) => {
      for (const row of rows) {
        await tx.run(
          `INSERT INTO _variables (id, scope, key, value, secret, context, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scope, key, context) DO NOTHING`,
          [uniqueId(), PROJECT_SCOPE, row.key, row.value, row.secret, row.context, row.created_at, row.updated_at],
        )
      }
      await tx.run("DELETE FROM _function_vars WHERE function_id = '*'")
    })
  }

  /** Project values first, then the site's own — the site wins. */
  async siteEnvironment(siteId: string, context: DeployContext = 'live'): Promise<Record<string, string>> {
    return {
      ...(await this.projectEnvironment(context)),
      ...(await this.environment(siteScope(siteId), context)),
    }
  }

  /** Create one variable. `id` is Appwrite's variableId; a key is unique per scope and context. */
  async create(scope: string, id: string, key: string, value: string, secret: boolean, context: VariableContext = ''): Promise<VariableRow> {
    if (!ENV_KEY_RE.test(key)) {
      throw err('general_argument_invalid', 'Variable names use letters, digits and underscores.')
    }
    if (await this.byId(scope, id)) throw err('variable_already_exists')
    if (await this.byKey(scope, key, context)) throw err('variable_already_exists')
    const stamp = now()
    await this.sql.run('INSERT INTO _variables (id, scope, key, value, secret, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      scope,
      key,
      value,
      secret ? 1 : 0,
      context,
      stamp,
      stamp,
    ])
    return this.get(scope, id)
  }

  /** Update by variable ID; the key and context must not collide with another variable in the scope. */
  async update(scope: string, id: string, params: { key?: string; value?: string; secret?: boolean; context?: VariableContext }): Promise<VariableRow> {
    const current = await this.get(scope, id)
    const key = params.key ?? current.key
    const context = params.context ?? (current.context as VariableContext)
    if (!ENV_KEY_RE.test(key)) {
      throw err('general_argument_invalid', 'Variable names use letters, digits and underscores.')
    }
    const secret = params.secret ?? Boolean(current.secret)
    if (current.secret && !secret) throw err('variable_cannot_unset_secret')
    if (key !== current.key || context !== current.context) {
      const rival = await this.byKey(scope, key, context)
      if (rival && rival.id !== id) throw err('variable_already_exists')
    }
    await this.sql.run('UPDATE _variables SET key = ?, value = ?, secret = ?, context = ?, updated_at = ? WHERE scope = ? AND id = ?', [
      key,
      params.value ?? current.value,
      secret ? 1 : 0,
      context,
      now(),
      scope,
      id,
    ])
    return this.get(scope, id)
  }

  /**
   * Console upsert by name, used by the shared variable cards. A new variable
   * gets a generated ID; one created through the API keeps its own ID.
   */
  async setVariable(scope: string, key: string, value: string, secret: boolean, context: VariableContext = ''): Promise<void> {
    const existing = await this.byKey(scope, key, context)
    if (existing) {
      await this.sql.run('UPDATE _variables SET value = ?, secret = ?, updated_at = ? WHERE id = ?', [value, secret ? 1 : 0, now(), existing.id])
      return
    }
    await this.create(scope, uniqueId(), key, value, secret, context)
  }

  /** Bulk console import: every entry goes to one scope, one secret flag and one context. */
  async setVariables(scope: string, entries: EnvVariable[], secret: boolean, context: VariableContext = ''): Promise<void> {
    for (const { key, value } of entries) await this.setVariable(scope, key, value, secret, context)
  }

  async deleteById(scope: string, id: string): Promise<void> {
    await this.get(scope, id)
    await this.sql.run('DELETE FROM _variables WHERE scope = ? AND id = ?', [scope, id])
  }

  async deleteVariable(scope: string, key: string, context: VariableContext = ''): Promise<void> {
    await this.sql.run('DELETE FROM _variables WHERE scope = ? AND key = ? AND context = ?', [scope, key, context])
  }

  /** Forget every variable in a scope; returns how many were removed. */
  async clearVariables(scope: string): Promise<number> {
    const result = await this.sql.run('DELETE FROM _variables WHERE scope = ?', [scope])
    return Number(result.changes ?? 0)
  }

  /** Site deletion removes its variables; project variables stay. */
  async removeSite(siteId: string): Promise<void> {
    await this.sql.run('DELETE FROM _variables WHERE scope = ?', [siteScope(siteId)])
  }
}
