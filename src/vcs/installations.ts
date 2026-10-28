/** GitHub App installations connected to one project (Appwrite's `installations`). */
import type { Db } from '~/db/connection'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { uniqueId } from '~/lib/ids'

export interface InstallationRow {
  seq: number
  id: string
  provider: string
  provider_installation_id: string
  organization: string
  account_type: string
  created_at: string
  updated_at: string
}

export function installationModel(row: InstallationRow) {
  return {
    $id: row.id,
    $createdAt: row.created_at,
    $updatedAt: row.updated_at,
    provider: row.provider,
    organization: row.organization,
    providerInstallationId: row.provider_installation_id,
  }
}

export class VcsInstallations {
  constructor(private readonly db: Db) {}

  private get sql() {
    return this.db.sqlite
  }

  list(): InstallationRow[] {
    return this.sql.query<InstallationRow, []>('SELECT * FROM _vcs_installations ORDER BY seq').all()
  }

  get(id: string): InstallationRow {
    const row = this.sql.query<InstallationRow, [string]>('SELECT * FROM _vcs_installations WHERE id = ?').get(id)
    if (!row) throw err('installation_not_found')
    return row
  }

  find(id: string): InstallationRow | null {
    return this.sql.query<InstallationRow, [string]>('SELECT * FROM _vcs_installations WHERE id = ?').get(id)
  }

  byProvider(providerInstallationId: string): InstallationRow | null {
    return this.sql.query<InstallationRow, [string]>('SELECT * FROM _vcs_installations WHERE provider_installation_id = ?').get(providerInstallationId)
  }

  /** Add an installation, or refresh the account name of one already added. */
  add(input: { providerInstallationId: string; organization: string; accountType: string }): InstallationRow {
    const existing = this.byProvider(input.providerInstallationId)
    const stamp = now()
    if (existing) {
      this.sql.query('UPDATE _vcs_installations SET organization = ?, account_type = ?, updated_at = ? WHERE id = ?').run(input.organization, input.accountType, stamp, existing.id)
      return this.get(existing.id)
    }
    const id = uniqueId()
    this.sql
      .query(
        `INSERT INTO _vcs_installations (id, provider, provider_installation_id, organization, account_type, created_at, updated_at)
         VALUES (?, 'github', ?, ?, ?, ?, ?)`,
      )
      .run(id, input.providerInstallationId, input.organization, input.accountType, stamp, stamp)
    return this.get(id)
  }

  remove(id: string): void {
    this.sql.query('DELETE FROM _vcs_installations WHERE id = ?').run(id)
  }
}
