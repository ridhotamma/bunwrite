/** Organizations, their console members and email invitations. */
import type { Mailer } from '~/mail/mailer'
import { organizationInviteMail } from '~/mail/mailer'
import { validEmail } from '~/auth/service'
import type { Db } from '~/db/connection'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { randomSecret, sha256, uniqueId } from '~/lib/ids'

export type OrganizationRole = 'owner' | 'developer'
export type OrganizationMemberStatus = 'invited' | 'active'

export interface OrganizationInfo {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface OrganizationMember {
  id: string
  organizationId: string
  email: string
  name: string
  role: OrganizationRole
  status: OrganizationMemberStatus
  invitedAt: string
  joinedAt: string | null
}

export interface InviteInput {
  email: string
  role: OrganizationRole
}

export interface InviteResult {
  member: OrganizationMember
  token: string
  link: string
  sent: boolean
}

export interface InviteOptions {
  baseUrl: string
  orgName: string
  inviter: string
  mailer: Mailer
  /** Email the invitation. `false` mints a link to show in the console instead. */
  notify?: boolean
}

interface OrgRow {
  id: string
  name: string
  created_at: string
  updated_at: string
}

interface MemberRow {
  id: string
  organization_id: string
  email: string
  name: string
  role: string
  status: string
  invite_hash: string | null
  invited_at: string
  joined_at: string | null
}

const infoOf = (row: OrgRow): OrganizationInfo => ({ id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at })
const memberOf = (row: MemberRow): OrganizationMember => ({
  id: row.id,
  organizationId: row.organization_id,
  email: row.email,
  name: row.name,
  role: row.role === 'owner' ? 'owner' : 'developer',
  status: row.status === 'active' ? 'active' : 'invited',
  invitedAt: row.invited_at,
  joinedAt: row.joined_at,
})

export function displayName(email: string): string {
  const local = email.split('@')[0] ?? ''
  const name = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ')
  return name || email
}

export class OrganizationService {
  constructor(private db: Db) {}

  private get sql() {
    return this.db.sqlite
  }

  ensure(id: string, defaultName: string): OrganizationInfo {
    const stamp = now()
    this.sql
      .query('INSERT INTO _organizations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .run(id, defaultName, stamp, stamp)
    return this.get(id)!
  }

  get(id: string): OrganizationInfo | null {
    const row = this.sql.query<OrgRow, [string]>('SELECT id, name, created_at, updated_at FROM _organizations WHERE id = ?').get(id)
    return row ? infoOf(row) : null
  }

  updateName(id: string, name: string): OrganizationInfo {
    const value = name.trim()
    if (!value || value.length > 128) throw err('general_argument_invalid', 'An organization needs a name of 128 characters or less.')
    this.get(id)
    this.sql.query('UPDATE _organizations SET name = ?, updated_at = ? WHERE id = ?').run(value, now(), id)
    return this.get(id)!
  }

  members(orgId: string, search = ''): OrganizationMember[] {
    const term = search.trim()
    const rows = term
      ? this.sql
          .query<MemberRow, [string, string, string]>(
            `SELECT * FROM _organization_members WHERE organization_id = ? AND (email LIKE ? OR name LIKE ?)
             ORDER BY status = 'active' DESC, role = 'owner' DESC, email`,
          )
          .all(orgId, `%${term}%`, `%${term}%`)
      : this.sql
          .query<MemberRow, [string]>(
            "SELECT * FROM _organization_members WHERE organization_id = ? ORDER BY status = 'active' DESC, role = 'owner' DESC, email",
          )
          .all(orgId)
    return rows.map(memberOf)
  }

  findMember(orgId: string, id: string): OrganizationMember {
    const row = this.sql.query<MemberRow, [string, string]>('SELECT * FROM _organization_members WHERE organization_id = ? AND id = ?').get(orgId, id)
    if (!row) throw err('general_argument_invalid', 'Unknown organization member.')
    return memberOf(row)
  }

  findByEmail(orgId: string, email: string): OrganizationMember | null {
    const row = this.sql
      .query<MemberRow, [string, string]>('SELECT * FROM _organization_members WHERE organization_id = ? AND email = ?')
      .get(orgId, email.toLowerCase())
    return row ? memberOf(row) : null
  }

  roleOf(orgId: string, email: string): OrganizationRole | null {
    const row = this.sql
      .query<{ role: string }, [string, string]>(
        "SELECT role FROM _organization_members WHERE organization_id = ? AND email = ? AND status = 'active'",
      )
      .get(orgId, email.toLowerCase())
    return row ? (row.role === 'owner' ? 'owner' : 'developer') : null
  }

  /** Make sure an existing console admin has an active organization row. */
  ensureAdmin(orgId: string, email: string): OrganizationMember {
    const address = email.toLowerCase()
    const existing = this.findByEmail(orgId, address)
    if (existing) {
      if (existing.status === 'invited') {
        const stamp = now()
        this.sql
          .query("UPDATE _organization_members SET status = 'active', name = ?, joined_at = ?, invite_hash = NULL, updated_at = ? WHERE id = ?")
          .run(existing.name || displayName(address), stamp, stamp, existing.id)
        return this.findMember(orgId, existing.id)
      }
      return existing
    }
    const stamp = now()
    const member: OrganizationMember = {
      id: uniqueId(),
      organizationId: orgId,
      email: address,
      name: displayName(address),
      role: 'owner',
      status: 'active',
      invitedAt: stamp,
      joinedAt: stamp,
    }
    this.sql
      .query(
        `INSERT INTO _organization_members (id, organization_id, email, name, role, status, invited_at, joined_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(member.id, orgId, member.email, member.name, member.role, member.status, stamp, stamp, stamp, stamp)
    return member
  }

  async invite(orgId: string, inputs: InviteInput[], options: InviteOptions): Promise<InviteResult[]> {
    const pending = inputs.map((input) => {
      const role: OrganizationRole = input.role === 'owner' ? 'owner' : 'developer'
      return { email: validEmail(input.email), role }
    })
    const seen = new Set<string>()
    for (const { email } of pending) {
      if (seen.has(email)) throw err('general_argument_invalid', `${email} is listed more than once.`)
      seen.add(email)
      if (this.findByEmail(orgId, email)?.status === 'active') {
        throw err('general_argument_invalid', `${email} is already a member.`)
      }
    }

    const results: InviteResult[] = []
    for (const { email, role } of pending) {
      const existing = this.findByEmail(orgId, email)
      const token = randomSecret(32)
      const stamp = now()
      let member: OrganizationMember
      if (existing) {
        this.sql
          .query("UPDATE _organization_members SET role = ?, invite_hash = ?, invited_at = ?, updated_at = ? WHERE id = ?")
          .run(role, sha256(token), stamp, stamp, existing.id)
        member = this.findMember(orgId, existing.id)
      } else {
        member = {
          id: uniqueId(),
          organizationId: orgId,
          email,
          name: '',
          role,
          status: 'invited',
          invitedAt: stamp,
          joinedAt: null,
        }
        this.sql
          .query(
            `INSERT INTO _organization_members (id, organization_id, email, name, role, status, invite_hash, invited_at, created_at, updated_at)
             VALUES (?, ?, ?, '', ?, 'invited', ?, ?, ?, ?)`,
          )
          .run(member.id, orgId, email, role, sha256(token), stamp, stamp, stamp)
      }

      const link = `${options.baseUrl.replace(/\/$/, '')}/console/invite/${token}`
      let sent = false
      if (options.notify !== false && options.mailer.enabled) {
        try {
          await options.mailer.send(organizationInviteMail(options.orgName, options.inviter, email, link))
          sent = true
        } catch {
          sent = false
        }
      }
      results.push({ member, token, link, sent })
    }
    return results
  }

  inviteByToken(token: string): OrganizationMember | null {
    const row = this.sql
      .query<MemberRow, [string]>("SELECT * FROM _organization_members WHERE invite_hash = ? AND status = 'invited'")
      .get(sha256(token))
    return row ? memberOf(row) : null
  }

  accept(memberId: string, name?: string): OrganizationMember {
    const row = this.sql.query<MemberRow, [string]>('SELECT * FROM _organization_members WHERE id = ?').get(memberId)
    if (!row) throw err('general_argument_invalid', 'Invitation not found.')
    const stamp = now()
    this.sql
      .query("UPDATE _organization_members SET status = 'active', name = ?, joined_at = ?, invite_hash = NULL, updated_at = ? WHERE id = ?")
      .run(name?.trim() || row.name || displayName(row.email), stamp, stamp, memberId)
    return memberOf(this.sql.query<MemberRow, [string]>('SELECT * FROM _organization_members WHERE id = ?').get(memberId)!)
  }

  updateRole(orgId: string, memberId: string, role: OrganizationRole, actorEmail: string): OrganizationMember {
    if (role !== 'owner' && role !== 'developer') throw err('general_argument_invalid', 'Unknown organization role.')
    const member = this.findMember(orgId, memberId)
    if (member.email === actorEmail.toLowerCase()) throw err('general_argument_invalid', 'You cannot change your own role.')
    if (member.role === 'owner' && role !== 'owner' && this.ownerCount(orgId) <= 1) {
      throw err('general_argument_invalid', 'The last owner cannot be demoted.')
    }
    this.sql.query('UPDATE _organization_members SET role = ?, updated_at = ? WHERE id = ?').run(role, now(), memberId)
    return this.findMember(orgId, memberId)
  }

  remove(orgId: string, memberId: string, actorEmail: string): void {
    const member = this.findMember(orgId, memberId)
    if (member.email === actorEmail.toLowerCase()) throw err('general_argument_invalid', 'You cannot remove yourself.')
    if (member.status === 'active' && member.role === 'owner' && this.ownerCount(orgId) <= 1) {
      throw err('general_argument_invalid', 'The last owner cannot be removed.')
    }

    this.sql.transaction(() => {
      const admin = this.sql.query<{ seq: number }, [string]>('SELECT seq FROM _console_admins WHERE email = ?').get(member.email)
      if (admin) {
        const count = (this.sql.query('SELECT count(*) AS n FROM _console_admins').get() as { n: number }).n
        if (count <= 1) throw err('general_argument_invalid', 'The last console admin cannot be removed.')
        this.sql.query('DELETE FROM _console_sessions WHERE admin_id = ?').run(admin.seq)
        this.sql.query('DELETE FROM _console_admins WHERE seq = ?').run(admin.seq)
      }
      this.sql.query('DELETE FROM _organization_members WHERE id = ?').run(memberId)
    }).immediate()
  }

  ownerCount(orgId: string): number {
    return (
      this.sql
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM _organization_members WHERE organization_id = ? AND status = 'active' AND role = 'owner'",
        )
        .get(orgId) as { n: number }
    ).n
  }
}
