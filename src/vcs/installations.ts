/**
 * GitHub App installations connected to the server (Appwrite's
 * `installations`). They live in the control database, so installing an
 * account once makes its repositories available to every project.
 */
import type { SqlDatabase } from '~/db/driver'
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
  constructor(private readonly db: SqlDatabase) {}

  list(): Promise<InstallationRow[]> {
    return this.db.driver.all<InstallationRow>('SELECT * FROM _vcs_installations ORDER BY seq')
  }

  async get(id: string): Promise<InstallationRow> {
    const row = await this.find(id)
    if (!row) throw err('installation_not_found')
    return row
  }

  find(id: string): Promise<InstallationRow | null> {
    return this.db.driver.get<InstallationRow>('SELECT * FROM _vcs_installations WHERE id = ?', [id])
  }

  byProvider(providerInstallationId: string): Promise<InstallationRow | null> {
    return this.db.driver.get<InstallationRow>('SELECT * FROM _vcs_installations WHERE provider_installation_id = ?', [providerInstallationId])
  }

  /** Add an installation, or refresh the account name of one already added. */
  async add(input: { providerInstallationId: string; organization: string; accountType: string }): Promise<InstallationRow> {
    const existing = await this.byProvider(input.providerInstallationId)
    const stamp = now()
    if (existing) {
      await this.db.driver.run('UPDATE _vcs_installations SET organization = ?, account_type = ?, updated_at = ? WHERE id = ?', [
        input.organization,
        input.accountType,
        stamp,
        existing.id,
      ])
      return this.get(existing.id)
    }
    const id = uniqueId()
    await this.db.driver.run(
      `INSERT INTO _vcs_installations (id, provider, provider_installation_id, organization, account_type, created_at, updated_at)
       VALUES (?, 'github', ?, ?, ?, ?, ?)`,
      [id, input.providerInstallationId, input.organization, input.accountType, stamp, stamp],
    )
    return this.get(id)
  }

  async remove(id: string): Promise<void> {
    await this.db.driver.run('DELETE FROM _vcs_installations WHERE id = ?', [id])
  }
}
