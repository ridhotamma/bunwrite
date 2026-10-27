import type { AuthService } from '~/auth/service'
import { validEmail } from '~/auth/service'
import type { Caller } from '~/auth/caller'
import type { MembershipRowFull, TeamRow } from '~/auth/models'
import type { Db } from '~/db/connection'
import type { DocumentStore } from '~/documents/store'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { randomSecret, resolveId, sha256, uniqueId } from '~/lib/ids'
import { listSeqs, MEMBERSHIPS, scopeEqual, TEAMS } from '~/system/list'

const MEMBERSHIP_SELECT = `SELECT m.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone,
  u.accessed_at AS user_accessed_at, u.mfa AS user_mfa, t.name AS team_name
  FROM _memberships m JOIN _users u ON u.id = m.user_id JOIN _teams t ON t.id = m.team_id`

const ROLE = /^[a-zA-Z0-9._-]{1,32}$/

export function validRoles(roles: unknown): string[] {
  if (roles === undefined || roles === null) return []
  if (!Array.isArray(roles) || roles.length > 100 || roles.some((r) => typeof r !== 'string' || !ROLE.test(r))) {
    throw err('general_argument_invalid', 'Invalid `roles` param: Value must be a valid array of up to 100 roles of 32 chars or less.')
  }
  return [...new Set(roles as string[])]
}

export class TeamService {
  constructor(
    private db: Db,
    private store: DocumentStore,
    private auth: AuthService,
  ) {}

  private get sql() {
    return this.db.sqlite
  }

  team(id: string): TeamRow {
    const team = this.sql
      .query<TeamRow, [string]>(
        `SELECT t.*, (SELECT count(*) FROM _memberships m WHERE m.team_id = t.id AND m.confirm = 1) AS total FROM _teams t WHERE t.id = ?`,
      )
      .get(id)
    if (!team) throw err('team_not_found')
    return team
  }

  membership(teamId: string, membershipId: string): MembershipRowFull {
    const row = this.sql.query<MembershipRowFull, [string, string]>(`${MEMBERSHIP_SELECT} WHERE m.id = ? AND m.team_id = ?`).get(membershipId, teamId)
    if (!row) throw err('membership_not_found')
    return row
  }

  /** Readable by API keys and the team's members; `owner` also needs the owner role. */
  assertAccess(caller: Caller, teamId: string, need: 'member' | 'owner'): void {
    this.team(teamId)
    if (caller.privileged) return
    if (!caller.user) throw err('general_unauthorized_scope', 'User (role: guests) missing scopes (["teams.read"])')
    const role = need === 'owner' ? `team:${teamId}/owner` : `team:${teamId}`
    if (!caller.roles.has(role)) {
      throw err(need === 'owner' ? 'user_unauthorized' : 'team_not_found')
    }
  }

  list(caller: Caller, queries: unknown[], search?: string, includeTotal = true): { total: number; teams: TeamRow[] } {
    const scope: string[] = []
    if (!caller.privileged) {
      if (!caller.user) throw err('general_unauthorized_scope', 'User (role: guests) missing scopes (["teams.read"])')
      const ids = [...caller.roles].filter((r) => /^team:[^/]+$/.test(r)).map((r) => r.slice(5))
      scope.push(JSON.stringify({ method: 'equal', attribute: '$id', values: ids.length ? ids : ['\u0000'] }))
    }
    const options = { scope, includeTotal, search: search ? { term: search, fields: ['name', '$id'] } : undefined }
    const { total, seqs } = listSeqs(this.store, TEAMS, queries, options)
    const rows = this.auth.bySeq<TeamRow & { seq: number }>('_teams', seqs)
    return { total, teams: rows.map((r) => this.team(r.id)) }
  }

  create(caller: Caller, input: { teamId: unknown; name: unknown; roles: unknown }): TeamRow {
    if (!caller.privileged && !caller.user) throw err('general_unauthorized_scope', 'User (role: guests) missing scopes (["teams.write"])')
    const id = resolveId(input.teamId, 'Team ID')
    if (typeof input.name !== 'string' || !input.name || input.name.length > 128) {
      throw err('general_argument_invalid', 'Invalid `name` param: Value must be a valid string and at least 1 chars and no longer than 128 chars')
    }
    const roles = input.roles === undefined ? ['owner'] : validRoles(input.roles)
    const stamp = now()
    this.sql.transaction(() => {
      try {
        this.sql.query('INSERT INTO _teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, input.name as string, stamp, stamp)
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE')) throw err('team_already_exists')
        throw error
      }
      // A user creating a team joins it; an API key does not.
      if (!caller.privileged && caller.user) {
        this.sql
          .query(
            `INSERT INTO _memberships (id, team_id, user_id, roles, invited, joined, confirm, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(uniqueId(), id, caller.user.id, JSON.stringify(roles), stamp, stamp, stamp, stamp)
      }
    })()
    return this.team(id)
  }

  update(id: string, fields: { name?: string; prefs?: string }): TeamRow {
    this.team(id)
    const keys = Object.keys(fields) as (keyof typeof fields)[]
    this.sql.query(`UPDATE _teams SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]!), now(), id)
    return this.team(id)
  }

  delete(id: string): void {
    this.team(id)
    this.sql.transaction(() => {
      this.sql.query('DELETE FROM _memberships WHERE team_id = ?').run(id)
      this.sql.query('DELETE FROM _teams WHERE id = ?').run(id)
    })()
  }

  listMemberships(scope: { teamId?: string; userId?: string }, queries: unknown[], search?: string, includeTotal = true) {
    const filters: string[] = []
    if (scope.teamId) filters.push(scopeEqual('teamId', scope.teamId))
    if (scope.userId) filters.push(scopeEqual('userId', scope.userId))
    const { total, seqs } = listSeqs(this.store, MEMBERSHIPS, queries, {
      scope: filters,
      includeTotal,
      search: search ? { term: search, fields: ['userName', 'userEmail', 'teamName', '$id'] } : undefined,
    })
    if (seqs.length === 0) return { total, memberships: [] as MembershipRowFull[] }
    const rows = this.sql
      .query<MembershipRowFull & { seq: number }, number[]>(`${MEMBERSHIP_SELECT} WHERE m.seq IN (${seqs.map(() => '?').join(', ')})`)
      .all(...seqs)
    const bySeq = new Map(rows.map((r) => [r.seq, r]))
    return { total, memberships: seqs.map((s) => bySeq.get(s)!).filter(Boolean) }
  }

  /**
   * Add someone to a team. API keys add them straight away (Appwrite's
   * behaviour, no email); a team owner sends an invitation instead, returned
   * with its secret so the route can email the accept link.
   */
  async createMembership(
    caller: Caller,
    teamId: string,
    input: { email?: unknown; userId?: unknown; phone?: unknown; roles: unknown; name?: unknown },
  ): Promise<{ membership: MembershipRowFull; secret: string | null }> {
    this.assertAccess(caller, teamId, 'owner')
    const roles = validRoles(input.roles)
    let user
    if (input.userId) {
      user = this.auth.user(String(input.userId))
    } else if (input.email) {
      const email = validEmail(input.email)
      user = this.auth.userByEmail(email) ?? (await this.auth.createUser({ email, name: input.name ?? '' }))
    } else if (input.phone) {
      user = this.sql.query<any, [string]>('SELECT * FROM _users WHERE phone = ?').get(String(input.phone))
      user ??= await this.auth.createUser({ phone: input.phone, name: input.name ?? '' })
    } else {
      throw err('general_argument_invalid', 'At least one of userId, email, or phone is required')
    }

    const existing = this.sql.query<any, [string, string]>('SELECT id FROM _memberships WHERE team_id = ? AND user_id = ?').get(teamId, user.id)
    if (existing) throw err('membership_already_exists')

    const stamp = now()
    const confirmNow = caller.privileged
    const secret = confirmNow ? null : randomSecret(64)
    const id = uniqueId()
    this.sql
      .query(
        `INSERT INTO _memberships (id, team_id, user_id, roles, invited, joined, confirm, secret_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, teamId, user.id, JSON.stringify(roles), stamp, confirmNow ? stamp : null, confirmNow ? 1 : 0, secret ? sha256(secret) : null, stamp, stamp)
    return { membership: this.membership(teamId, id), secret }
  }

  updateMembership(caller: Caller, teamId: string, membershipId: string, roles: unknown): MembershipRowFull {
    this.assertAccess(caller, teamId, 'owner')
    this.membership(teamId, membershipId)
    this.sql.query('UPDATE _memberships SET roles = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(validRoles(roles)), now(), membershipId)
    return this.membership(teamId, membershipId)
  }

  deleteMembership(caller: Caller, teamId: string, membershipId: string): void {
    const membership = this.membership(teamId, membershipId)
    // Members may leave on their own; removing others needs the owner role.
    if (!(caller.user && caller.user.id === membership.user_id)) this.assertAccess(caller, teamId, 'owner')
    this.sql.query('DELETE FROM _memberships WHERE id = ?').run(membershipId)
  }

  /** Accept an invitation with the emailed secret. */
  confirmMembership(teamId: string, membershipId: string, userId: unknown, secret: unknown): MembershipRowFull {
    const membership = this.membership(teamId, membershipId)
    if (membership.user_id !== userId) throw err('team_invite_mismatch')
    if (membership.confirm) throw err('membership_already_confirmed')
    const row = this.sql.query<{ secret_hash: string | null }, [string]>('SELECT secret_hash FROM _memberships WHERE id = ?').get(membershipId)
    if (typeof secret !== 'string' || !row?.secret_hash || row.secret_hash !== sha256(secret)) throw err('team_invalid_secret')
    const stamp = now()
    this.sql.transaction(() => {
      this.sql.query('UPDATE _memberships SET confirm = 1, joined = ?, secret_hash = NULL, updated_at = ? WHERE id = ?').run(stamp, stamp, membershipId)
      this.sql.query('UPDATE _users SET email_verification = 1, updated_at = ? WHERE id = ?').run(stamp, membership.user_id)
    })()
    return this.membership(teamId, membershipId)
  }
}
