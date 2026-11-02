/** Organizations, their console members and email invitations. */
import type { Mailer } from '~/mail/mailer'
import { organizationInviteMail, sendMailLater } from '~/mail/mailer'
import { validEmail } from '~/auth/service'
import type { SqlDatabase } from '~/db/driver'
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
  constructor(private db: SqlDatabase) {}

  async ensure(id: string, defaultName: string): Promise<OrganizationInfo> {
    const stamp = now()
    await this.db.driver.run('INSERT INTO _organizations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING', [
      id,
      defaultName,
      stamp,
      stamp,
    ])
    return (await this.get(id))!
  }

  async get(id: string): Promise<OrganizationInfo | null> {
    const row = await this.db.driver.get<OrgRow>('SELECT id, name, created_at, updated_at FROM _organizations WHERE id = ?', [id])
    return row ? infoOf(row) : null
  }

  async updateName(id: string, name: string): Promise<OrganizationInfo> {
    const value = name.trim()
    if (!value || value.length > 128) throw err('general_argument_invalid', 'An organization needs a name of 128 characters or less.')
    await this.get(id)
    await this.db.driver.run('UPDATE _organizations SET name = ?, updated_at = ? WHERE id = ?', [value, now(), id])
    return (await this.get(id))!
  }

  async members(orgId: string, search = ''): Promise<OrganizationMember[]> {
    const term = search.trim()
    const rows = term
      ? await this.db.driver.all<MemberRow>(
          `SELECT * FROM _organization_members WHERE organization_id = ? AND (email LIKE ? OR name LIKE ?)
           ORDER BY status = 'active' DESC, role = 'owner' DESC, email`,
          [orgId, `%${term}%`, `%${term}%`],
        )
      : await this.db.driver.all<MemberRow>(
          "SELECT * FROM _organization_members WHERE organization_id = ? ORDER BY status = 'active' DESC, role = 'owner' DESC, email",
          [orgId],
        )
    return rows.map(memberOf)
  }

  async findMember(orgId: string, id: string): Promise<OrganizationMember> {
    const row = await this.db.driver.get<MemberRow>('SELECT * FROM _organization_members WHERE organization_id = ? AND id = ?', [orgId, id])
    if (!row) throw err('general_argument_invalid', 'Unknown organization member.')
    return memberOf(row)
  }

  async findByEmail(orgId: string, email: string): Promise<OrganizationMember | null> {
    const row = await this.db.driver.get<MemberRow>('SELECT * FROM _organization_members WHERE organization_id = ? AND email = ?', [orgId, email.toLowerCase()])
    return row ? memberOf(row) : null
  }

  async roleOf(orgId: string, email: string): Promise<OrganizationRole | null> {
    const row = await this.db.driver.get<{ role: string }>(
      "SELECT role FROM _organization_members WHERE organization_id = ? AND email = ? AND status = 'active'",
      [orgId, email.toLowerCase()],
    )
    return row ? (row.role === 'owner' ? 'owner' : 'developer') : null
  }

  /** Make sure an existing console admin has an active organization row. */
  async ensureAdmin(orgId: string, email: string): Promise<OrganizationMember> {
    const address = email.toLowerCase()
    const existing = await this.findByEmail(orgId, address)
    if (existing) {
      if (existing.status === 'invited') {
        const stamp = now()
        await this.db.driver.run(
          "UPDATE _organization_members SET status = 'active', name = ?, joined_at = ?, invite_hash = NULL, updated_at = ? WHERE id = ?",
          [existing.name || displayName(address), stamp, stamp, existing.id],
        )
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
    await this.db.driver.run(
      `INSERT INTO _organization_members (id, organization_id, email, name, role, status, invited_at, joined_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [member.id, orgId, member.email, member.name, member.role, member.status, stamp, stamp, stamp, stamp],
    )
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
      if ((await this.findByEmail(orgId, email))?.status === 'active') {
        throw err('general_argument_invalid', `${email} is already a member.`)
      }
    }

    const results: InviteResult[] = []
    for (const { email, role } of pending) {
      const existing = await this.findByEmail(orgId, email)
      const token = randomSecret(32)
      const stamp = now()
      let member: OrganizationMember
      if (existing) {
        await this.db.driver.run('UPDATE _organization_members SET role = ?, invite_hash = ?, invited_at = ?, updated_at = ? WHERE id = ?', [
          role,
          sha256(token),
          stamp,
          stamp,
          existing.id,
        ])
        member = await this.findMember(orgId, existing.id)
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
        await this.db.driver.run(
          `INSERT INTO _organization_members (id, organization_id, email, name, role, status, invite_hash, invited_at, created_at, updated_at)
           VALUES (?, ?, ?, '', ?, 'invited', ?, ?, ?, ?)`,
          [member.id, orgId, email, role, sha256(token), stamp, stamp, stamp],
        )
      }

      const link = `${options.baseUrl.replace(/\/$/, '')}/console/invite/${token}`
      // Skip SMTP from the request path: the invitation is persisted and the
      // link is returned immediately, while delivery continues in the background.
      const sent = options.notify !== false && options.mailer.enabled
      if (sent) sendMailLater(options.mailer, organizationInviteMail(options.orgName, options.inviter, email, link), 'organization invitation')
      results.push({ member, token, link, sent })
    }
    return results
  }

  async inviteByToken(token: string): Promise<OrganizationMember | null> {
    const row = await this.db.driver.get<MemberRow>("SELECT * FROM _organization_members WHERE invite_hash = ? AND status = 'invited'", [sha256(token)])
    return row ? memberOf(row) : null
  }

  async accept(memberId: string, name?: string): Promise<OrganizationMember> {
    const row = await this.db.driver.get<MemberRow>('SELECT * FROM _organization_members WHERE id = ?', [memberId])
    if (!row) throw err('general_argument_invalid', 'Invitation not found.')
    const stamp = now()
    await this.db.driver.run("UPDATE _organization_members SET status = 'active', name = ?, joined_at = ?, invite_hash = NULL, updated_at = ? WHERE id = ?", [
      name?.trim() || row.name || displayName(row.email),
      stamp,
      stamp,
      memberId,
    ])
    return memberOf((await this.db.driver.get<MemberRow>('SELECT * FROM _organization_members WHERE id = ?', [memberId]))!)
  }

  async updateRole(orgId: string, memberId: string, role: OrganizationRole, actorEmail: string): Promise<OrganizationMember> {
    if (role !== 'owner' && role !== 'developer') throw err('general_argument_invalid', 'Unknown organization role.')
    const member = await this.findMember(orgId, memberId)
    if (member.email === actorEmail.toLowerCase()) throw err('general_argument_invalid', 'You cannot change your own role.')
    if (member.role === 'owner' && role !== 'owner' && (await this.ownerCount(orgId)) <= 1) {
      throw err('general_argument_invalid', 'The last owner cannot be demoted.')
    }
    await this.db.driver.run('UPDATE _organization_members SET role = ?, updated_at = ? WHERE id = ?', [role, now(), memberId])
    return this.findMember(orgId, memberId)
  }

  async remove(orgId: string, memberId: string, actorEmail: string): Promise<void> {
    const member = await this.findMember(orgId, memberId)
    if (member.email === actorEmail.toLowerCase()) throw err('general_argument_invalid', 'You cannot remove yourself.')
    if (member.status === 'active' && member.role === 'owner' && (await this.ownerCount(orgId)) <= 1) {
      throw err('general_argument_invalid', 'The last owner cannot be removed.')
    }

    await this.db.driver.transaction(async (tx) => {
      const admin = await tx.get<{ seq: number }>('SELECT seq FROM _console_admins WHERE email = ?', [member.email])
      if (admin) {
        const count = Number((await tx.get<{ n: number }>('SELECT count(*) AS n FROM _console_admins'))?.n ?? 0)
        if (count <= 1) throw err('general_argument_invalid', 'The last console admin cannot be removed.')
        await tx.run('DELETE FROM _console_sessions WHERE admin_id = ?', [admin.seq])
        await tx.run('DELETE FROM _console_admins WHERE seq = ?', [admin.seq])
      }
      await tx.run('DELETE FROM _organization_members WHERE id = ?', [memberId])
    })
  }

  async ownerCount(orgId: string): Promise<number> {
    const row = await this.db.driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM _organization_members WHERE organization_id = ? AND status = 'active' AND role = 'owner'",
      [orgId],
    )
    return Number(row?.n ?? 0)
  }
}
