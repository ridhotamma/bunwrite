/**
 * Shapes shared by functions and sites: a resource's Git settings (Appwrite's
 * provider* fields) and where a deployment's code came from.
 */

/** A function's or site's repository settings; all empty when not connected. */
export interface ProviderSettings {
  installationId: string
  providerRepositoryId: string
  providerBranch: string
  providerRootDirectory: string
  providerSilentMode: boolean
}

export interface ProviderColumns {
  installation_id: string
  provider_repository_id: string
  provider_branch: string
  provider_root_directory: string
  provider_silent_mode: number
}

export const NO_PROVIDER: ProviderSettings = { installationId: '', providerRepositoryId: '', providerBranch: '', providerRootDirectory: '', providerSilentMode: false }

export const providerOf = (row: ProviderColumns): ProviderSettings => ({
  installationId: row.installation_id,
  providerRepositoryId: row.provider_repository_id,
  providerBranch: row.provider_branch,
  providerRootDirectory: row.provider_root_directory,
  providerSilentMode: Boolean(row.provider_silent_mode),
})

/** A commit a deployment was built from. */
export interface DeploymentSource {
  /** `owner/name` */
  repository: string
  branch: string
  commitHash: string
  commitMessage: string
  commitAuthor: string
  commitAuthorUrl: string
  commitUrl: string
  /** Pull request number of a fork's PR; 0 for branches of the repository itself. */
  pullRequest: number
}

export interface SourceColumns {
  type: string
  provider_repository: string
  provider_branch: string
  provider_commit_hash: string
  provider_commit_message: string
  provider_commit_author: string
  provider_commit_author_url: string
  provider_commit_url: string
  provider_pull_request: number
}

/** The deployment model's provider* fields, as Appwrite returns them. */
export function sourceModel(row: SourceColumns) {
  const [owner = '', name = ''] = row.provider_repository.split('/')
  // The commit URL is <github>/<owner>/<name>/commit/<sha>, also on GitHub Enterprise.
  const repoUrl = row.provider_commit_url.replace(/\/commit\/[^/]+$/, '')
  return {
    type: row.type || 'manual',
    providerRepositoryName: name,
    providerRepositoryOwner: owner,
    providerRepositoryUrl: repoUrl,
    providerCommitHash: row.provider_commit_hash,
    providerCommitAuthorUrl: row.provider_commit_author_url,
    providerCommitAuthor: row.provider_commit_author,
    providerCommitMessage: row.provider_commit_message,
    providerCommitUrl: row.provider_commit_url,
    providerBranch: row.provider_branch,
    providerBranchUrl: repoUrl && row.provider_branch ? `${repoUrl}/tree/${row.provider_branch}` : '',
  }
}

/** Values for the source columns, in this order: type and the eight provider_* columns. */
export const SOURCE_COLUMNS = 'type, provider_repository, provider_branch, provider_commit_hash, provider_commit_message, provider_commit_author, provider_commit_author_url, provider_commit_url, provider_pull_request'

export const sourceValues = (s: DeploymentSource) =>
  ['vcs', s.repository, s.branch, s.commitHash, s.commitMessage.slice(0, 10_000), s.commitAuthor, s.commitAuthorUrl, s.commitUrl, s.pullRequest] as const

/** The first line of a commit message, for lists and statuses. */
export const firstLine = (message: string) => message.split('\n')[0]!.trim()
