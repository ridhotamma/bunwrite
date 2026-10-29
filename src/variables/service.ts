/**
 * Project and site variables.
 *
 * Project variables are the appwrite-compatible `/project/variables` scope:
 * every site and function sees them. Site variables are `/sites/:id/variables`
 * and win over a project value with the same name. Server environment values
 * are the base; a variable saved here overrides one from the host.
 *
 * Function variables live in `_function_vars` (see functions/service.ts) and
 * keep their own precedence: project < global function (`'*'`) < function.
 */
import type { Db } from '~/db/connection'
import { ENV_KEY_RE, type EnvVariable } from '~/functions/env'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { uniqueId } from '~/lib/ids'

export const PROJECT_SCOPE = 'project'
export const siteScope = (siteId: string) => `site:${siteId}`

export interface VariableRow {
  seq: number
  id: string
  scope: string
  key: string
  value: string
  secret: number
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
    return this.sql.query<VariableRow, [string]>('SELECT * FROM _variables WHERE scope = ? ORDER BY key').all(scope)
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

  byKey(scope: string, key: string): VariableRow | null {
    return this.sql.query<VariableRow, [string, string]>('SELECT * FROM _variables WHERE scope = ? AND key = ?').get(scope, key) ?? null
  }

  /** The scope as an environment record. */
  environment(scope: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const row of this.list(scope)) out[row.key] = row.value
    return out
  }

  projectEnvironment(): Record<string, string> {
    return this.environment(PROJECT_SCOPE)
  }

  /** Project values first, then the site's own — the site wins. */
  siteEnvironment(siteId: string): Record<string, string> {
    return {
      ...this.projectEnvironment(),
      ...this.environment(siteScope(siteId)),
    }
  }

  /** Create one variable. `id` is Appwrite's variableId; the key is unique per scope. */
  create(scope: string, id: string, key: string, value: string, secret: boolean): VariableRow {
    if (!ENV_KEY_RE.test(key)) {
      throw err('general_argument_invalid', 'Variable names use letters, digits and underscores.')
    }
    if (this.byId(scope, id)) throw err('variable_already_exists')
    if (this.byKey(scope, key)) throw err('variable_already_exists')
    const stamp = now()
    this.sql.query('INSERT INTO _variables (id, scope, key, value, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, scope, key, value, secret ? 1 : 0, stamp, stamp)
    return this.get(scope, id)
  }

  /** Update by variable ID; a new key must not collide with another variable in the scope. */
  update(scope: string, id: string, params: { key?: string; value?: string; secret?: boolean }): VariableRow {
    const current = this.get(scope, id)
    const key = params.key ?? current.key
    if (!ENV_KEY_RE.test(key)) {
      throw err('general_argument_invalid', 'Variable names use letters, digits and underscores.')
    }
    const secret = params.secret ?? Boolean(current.secret)
    if (current.secret && !secret) throw err('variable_cannot_unset_secret')
    if (key !== current.key) {
      const rival = this.byKey(scope, key)
      if (rival && rival.id !== id) throw err('variable_already_exists')
    }
    this.sql.query('UPDATE _variables SET key = ?, value = ?, secret = ?, updated_at = ? WHERE scope = ? AND id = ?').run(key, params.value ?? current.value, secret ? 1 : 0, now(), scope, id)
    return this.get(scope, id)
  }

  /**
   * Console upsert by name, used by the shared variable cards. A new variable
   * gets a generated ID; one created through the API keeps its own ID.
   */
  setVariable(scope: string, key: string, value: string, secret: boolean): void {
    const existing = this.byKey(scope, key)
    if (existing) {
      this.sql.query('UPDATE _variables SET value = ?, secret = ?, updated_at = ? WHERE scope = ? AND key = ?').run(value, secret ? 1 : 0, now(), scope, key)
      return
    }
    this.create(scope, uniqueId(), key, value, secret)
  }

  /** Bulk console import: every entry goes to one scope and one secret flag. */
  setVariables(scope: string, entries: EnvVariable[], secret: boolean): void {
    for (const { key, value } of entries) this.setVariable(scope, key, value, secret)
  }

  deleteById(scope: string, id: string): void {
    this.get(scope, id)
    this.sql.query('DELETE FROM _variables WHERE scope = ? AND id = ?').run(scope, id)
  }

  deleteVariable(scope: string, key: string): void {
    this.sql.query('DELETE FROM _variables WHERE scope = ? AND key = ?').run(scope, key)
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
