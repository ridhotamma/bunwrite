/**
 * Control-database records the webhook needs, since GitHub's events carry no
 * project: which project's site or function each repository deploys
 * (`_vcs_repositories`, Appwrite's console `repositories`), and the comment
 * kept up to date on each pull request (`_vcs_comments`).
 */
import type { Db } from '~/db/connection'
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
  constructor(private readonly db: Db) {}

  private get sql() {
    return this.db.sqlite
  }

  get(id: string): RepositoryRow {
    const row = this.sql.query<RepositoryRow, [string]>('SELECT * FROM _vcs_repositories WHERE id = ?').get(id)
    if (!row) throw err('repository_not_found')
    return row
  }

  forResource(projectId: string, type: ResourceType, resourceId: string): RepositoryRow | null {
    return this.sql
      .query<RepositoryRow, [string, string, string]>('SELECT * FROM _vcs_repositories WHERE project_id = ? AND resource_type = ? AND resource_id = ?')
      .get(projectId, type, resourceId)
  }

  /** Every site and function, in every project, that deploys this repository. */
  byRepository(providerRepositoryId: string): RepositoryRow[] {
    return this.sql.query<RepositoryRow, [string]>('SELECT * FROM _vcs_repositories WHERE provider_repository_id = ? ORDER BY seq').all(providerRepositoryId)
  }

  byProviderInstallation(providerInstallationId: string): RepositoryRow[] {
    return this.sql.query<RepositoryRow, [string]>('SELECT * FROM _vcs_repositories WHERE provider_installation_id = ? ORDER BY seq').all(providerInstallationId)
  }

  /** Point a resource at a repository, replacing any earlier link. Approved PRs carry over when the repository stays. */
  link(input: LinkInput): RepositoryRow {
    const existing = this.forResource(input.projectId, input.resourceType, input.resourceId)
    const stamp = now()
    if (existing) {
      const keepPulls = existing.provider_repository_id === input.providerRepositoryId ? existing.provider_pull_request_ids : '[]'
      this.sql
        .query(
          `UPDATE _vcs_repositories SET installation_id = ?, provider_installation_id = ?, provider_repository_id = ?, provider_repository_name = ?,
           provider_pull_request_ids = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.installationId, input.providerInstallationId, input.providerRepositoryId, input.providerRepositoryName, keepPulls, stamp, existing.id)
      return this.get(existing.id)
    }
    const id = uniqueId()
    this.sql
      .query(
        `INSERT INTO _vcs_repositories (id, project_id, installation_id, provider_installation_id, provider_repository_id, provider_repository_name,
         resource_type, resource_id, provider_pull_request_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      )
      .run(id, input.projectId, input.installationId, input.providerInstallationId, input.providerRepositoryId, input.providerRepositoryName, input.resourceType, input.resourceId, stamp, stamp)
    return this.get(id)
  }

  unlink(projectId: string, type: ResourceType, resourceId: string): void {
    this.sql.query('DELETE FROM _vcs_repositories WHERE project_id = ? AND resource_type = ? AND resource_id = ?').run(projectId, type, resourceId)
  }

  /** Every link that uses an installation, across all projects. */
  removeForInstallation(installationId: string): RepositoryRow[] {
    const rows = this.sql.query<RepositoryRow, [string]>('SELECT * FROM _vcs_repositories WHERE installation_id = ?').all(installationId)
    this.sql.query('DELETE FROM _vcs_repositories WHERE installation_id = ?').run(installationId)
    return rows
  }

  /**
   * Point links that still reference a project-local installation ID at the
   * server-wide row. Used once when installations move out of project
   * databases.
   */
  reassignInstallation(projectId: string, fromId: string, toId: string): void {
    if (fromId === toId) return
    this.sql
      .query('UPDATE _vcs_repositories SET installation_id = ? WHERE project_id = ? AND installation_id = ?')
      .run(toId, projectId, fromId)
  }

  removeForProject(projectId: string): void {
    this.sql.query('DELETE FROM _vcs_repositories WHERE project_id = ?').run(projectId)
  }

  /** Allow builds of a fork's pull request on this link (Appwrite's updateExternalDeployments). */
  approve(id: string, pullRequest: string): RepositoryRow {
    const row = this.get(id)
    const list = approvedPulls(row)
    if (list.includes(pullRequest)) throw err('provider_contribution_conflict')
    this.sql.query('UPDATE _vcs_repositories SET provider_pull_request_ids = ?, updated_at = ? WHERE id = ?').run(JSON.stringify([...list, pullRequest]), now(), id)
    return this.get(id)
  }

  // ---- PR comments ----

  comment(providerRepositoryId: string, pullRequest: number): string | null {
    return (
      this.sql
        .query<{ comment_id: string }, [string, number]>('SELECT comment_id FROM _vcs_comments WHERE provider_repository_id = ? AND pull_request = ?')
        .get(providerRepositoryId, pullRequest)?.comment_id ?? null
    )
  }

  setComment(providerRepositoryId: string, pullRequest: number, commentId: string): void {
    const stamp = now()
    this.sql
      .query(
        `INSERT INTO _vcs_comments (provider_repository_id, pull_request, comment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_repository_id, pull_request) DO UPDATE SET comment_id = excluded.comment_id, updated_at = excluded.updated_at`,
      )
      .run(providerRepositoryId, pullRequest, commentId, stamp, stamp)
  }
}
