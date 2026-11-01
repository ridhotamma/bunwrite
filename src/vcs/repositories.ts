/**
 * Control-database records the webhook needs, since GitHub's events carry no
 * project: which project's site or function each repository deploys
 * (`_vcs_repositories`, Appwrite's console `repositories`), and the comment
 * kept up to date on each pull request (`_vcs_comments`).
 */
import type { SqlDatabase } from '~/db/driver'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { uniqueId } from '~/lib/ids'

export type ResourceType = 'function' | 'site'

export interface RepositoryRow {
  seq: number
  id: string
  project_id: string
  installation_id: string
  provider_installation_id: string
  provider_repository_id: string
  provider_repository_name: string
  resource_type: ResourceType
  resource_id: string
  provider_pull_request_ids: string
  created_at: string
  updated_at: string
}

export interface LinkInput {
  projectId: string
  resourceType: ResourceType
  resourceId: string
  installationId: string
  providerInstallationId: string
  providerRepositoryId: string
  providerRepositoryName: string
}

export const approvedPulls = (row: RepositoryRow): string[] => {
  try {
    const list = JSON.parse(row.provider_pull_request_ids) as unknown
    return Array.isArray(list) ? list.map(String) : []
  } catch {
    return []
  }
}

export class RepositoryLinks {
  constructor(private readonly db: SqlDatabase) {}

  async get(id: string): Promise<RepositoryRow> {
    const row = await this.find(id)
    if (!row) throw err('repository_not_found')
    return row
  }

  find(id: string): Promise<RepositoryRow | null> {
    return this.db.driver.get<RepositoryRow>('SELECT * FROM _vcs_repositories WHERE id = ?', [id])
  }

  forResource(projectId: string, type: ResourceType, resourceId: string): Promise<RepositoryRow | null> {
    return this.db.driver.get<RepositoryRow>('SELECT * FROM _vcs_repositories WHERE project_id = ? AND resource_type = ? AND resource_id = ?', [
      projectId,
      type,
      resourceId,
    ])
  }

  /** Every site and function, in every project, that deploys this repository. */
  byRepository(providerRepositoryId: string): Promise<RepositoryRow[]> {
    return this.db.driver.all<RepositoryRow>('SELECT * FROM _vcs_repositories WHERE provider_repository_id = ? ORDER BY seq', [providerRepositoryId])
  }

  byProviderInstallation(providerInstallationId: string): Promise<RepositoryRow[]> {
    return this.db.driver.all<RepositoryRow>('SELECT * FROM _vcs_repositories WHERE provider_installation_id = ? ORDER BY seq', [providerInstallationId])
  }

  /** Point a resource at a repository, replacing any earlier link. Approved PRs carry over when the repository stays. */
  async link(input: LinkInput): Promise<RepositoryRow> {
    const existing = await this.forResource(input.projectId, input.resourceType, input.resourceId)
    const stamp = now()
    if (existing) {
      const keepPulls = existing.provider_repository_id === input.providerRepositoryId ? existing.provider_pull_request_ids : '[]'
      await this.db.driver.run(
        `UPDATE _vcs_repositories SET installation_id = ?, provider_installation_id = ?, provider_repository_id = ?, provider_repository_name = ?,
         provider_pull_request_ids = ?, updated_at = ? WHERE id = ?`,
        [input.installationId, input.providerInstallationId, input.providerRepositoryId, input.providerRepositoryName, keepPulls, stamp, existing.id],
      )
      return this.get(existing.id)
    }
    const id = uniqueId()
    await this.db.driver.run(
      `INSERT INTO _vcs_repositories (id, project_id, installation_id, provider_installation_id, provider_repository_id, provider_repository_name,
       resource_type, resource_id, provider_pull_request_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      [
        id,
        input.projectId,
        input.installationId,
        input.providerInstallationId,
        input.providerRepositoryId,
        input.providerRepositoryName,
        input.resourceType,
        input.resourceId,
        stamp,
        stamp,
      ],
    )
    return this.get(id)
  }

  async unlink(projectId: string, type: ResourceType, resourceId: string): Promise<void> {
    await this.db.driver.run('DELETE FROM _vcs_repositories WHERE project_id = ? AND resource_type = ? AND resource_id = ?', [projectId, type, resourceId])
  }

  /** Every link that uses an installation, across all projects. */
  async removeForInstallation(installationId: string): Promise<RepositoryRow[]> {
    const rows = await this.db.driver.all<RepositoryRow>('SELECT * FROM _vcs_repositories WHERE installation_id = ?', [installationId])
    await this.db.driver.run('DELETE FROM _vcs_repositories WHERE installation_id = ?', [installationId])
    return rows
  }

  /**
   * Point links that still reference a project-local installation ID at the
   * server-wide row. Used once when installations move out of project
   * databases.
   */
  async reassignInstallation(projectId: string, fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return
    await this.db.driver.run('UPDATE _vcs_repositories SET installation_id = ? WHERE project_id = ? AND installation_id = ?', [toId, projectId, fromId])
  }

  async removeForProject(projectId: string): Promise<void> {
    await this.db.driver.run('DELETE FROM _vcs_repositories WHERE project_id = ?', [projectId])
  }

  /** Allow builds of a fork's pull request on this link (Appwrite's updateExternalDeployments). */
  async approve(id: string, pullRequest: string): Promise<RepositoryRow> {
    const row = await this.get(id)
    const list = approvedPulls(row)
    if (list.includes(pullRequest)) throw err('provider_contribution_conflict')
    await this.db.driver.run('UPDATE _vcs_repositories SET provider_pull_request_ids = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify([...list, pullRequest]),
      now(),
      id,
    ])
    return this.get(id)
  }

  // ---- PR comments ----

  async comment(providerRepositoryId: string, pullRequest: number): Promise<string | null> {
    const row = await this.db.driver.get<{ comment_id: string }>('SELECT comment_id FROM _vcs_comments WHERE provider_repository_id = ? AND pull_request = ?', [
      providerRepositoryId,
      pullRequest,
    ])
    return row?.comment_id ?? null
  }

  async setComment(providerRepositoryId: string, pullRequest: number, commentId: string): Promise<void> {
    const stamp = now()
    await this.db.driver.run(
      `INSERT INTO _vcs_comments (provider_repository_id, pull_request, comment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider_repository_id, pull_request) DO UPDATE SET comment_id = excluded.comment_id, updated_at = excluded.updated_at`,
      [providerRepositoryId, pullRequest, commentId, stamp, stamp],
    )
  }
}
