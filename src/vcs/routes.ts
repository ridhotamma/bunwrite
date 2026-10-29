/**
 * Appwrite's VCS API: installations, browsing a repository, framework and
 * runtime detection, and approving a fork's pull request. Plus the helper the
 * Functions and Sites APIs use to apply provider* settings.
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { err } from '~/lib/errors'
import { bool, json, noContent, str, type Params } from '~/lib/http'
import { page } from '~/lib/paging'
import type { Router } from '~/lib/router'
import type { ProjectRuntime } from '~/projects/types'
import { detectFramework, detectRuntime } from './detect'
import { GithubError, type GithubRepository } from './github'
import type { VcsHub } from './hub'
import { installationModel } from './installations'
import type { ResourceType } from './repositories'
import type { ProviderSettings } from './source'

/** The provider* settings a create or update call sends, or null when it sends none (keep what is set). */
export function providerFromParams(params: Params, current: ProviderSettings): ProviderSettings | null {
  const keys = ['installationId', 'providerRepositoryId', 'providerBranch', 'providerRootDirectory', 'providerSilentMode']
  if (!keys.some((k) => params[k] !== undefined && params[k] !== null)) return null
  return {
    installationId: str(params.installationId) ?? current.installationId,
    providerRepositoryId: str(params.providerRepositoryId) ?? current.providerRepositoryId,
    providerBranch: str(params.providerBranch) ?? current.providerBranch,
    providerRootDirectory: str(params.providerRootDirectory) ?? current.providerRootDirectory,
    providerSilentMode: bool(params.providerSilentMode, current.providerSilentMode),
  }
}

/** The project the request is for, as the hub knows it. */
export function projectOf(ctx: AppContext): ProjectRuntime {
  const project = ctx.hub.project(ctx.config.projectId)
  if (!project) throw err('project_not_found')
  return project
}

/**
 * Apply provider* params after a create or update. A new or changed
 * repository builds its production branch right away, as on Appwrite.
 */
export async function applyProvider(ctx: AppContext, type: ResourceType, id: string, params: Params, current: ProviderSettings): Promise<void> {
  const next = providerFromParams(params, current)
  if (!next) return
  const project = projectOf(ctx)
  await ctx.hub.link(project, type, id, next)
  const target = ctx.hub.target(project, type, id)
  const changed = next.providerRepositoryId !== current.providerRepositoryId || (target && target.provider.providerBranch !== current.providerBranch)
  if (target && changed) await ctx.hub.deployReference(project, type, id, 'branch', target.provider.providerBranch, true)
}

const repositoryModel = (r: GithubRepository, extra: Record<string, unknown> = {}) => ({
  id: String(r.id),
  name: r.name,
  organization: r.owner.login,
  provider: 'github',
  private: r.private,
  defaultBranch: r.default_branch,
  providerRepositoryUrl: r.html_url,
  pushedAt: r.pushed_at ?? '',
  ...extra,
})

/** GitHub errors as Appwrite's: a missing repository is 404, anything else a provider failure. */
async function github<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof GithubError) {
      if (error.status === 404) throw err('provider_repository_not_found')
      throw err('general_provider_failure', error.message)
    }
    throw error
  }
}

/** Top-level names of a folder, for detection. */
async function folderNames(hub: VcsHub, installation: string, repositoryId: string, root: string, ref = ''): Promise<string[]> {
  const entries = await hub.github.contents(installation, repositoryId, root, ref)
  return entries.map((e) => e.name)
}

const join = (root: string, name: string) => (root ? `${root.replace(/\/+$/, '')}/${name}` : name)

export function vcsRoutes(router: Router<AppContext>): void {
  router.get('/vcs/installations', ({ ctx, params }) => {
    requireKey(ctx, 'vcs.read')
    const { total, items } = page(ctx.hub.installations.list().map(installationModel), [], { search: str(params.search), searchFields: ['$id', 'organization'] })
    return json({ total, installations: items })
  })

  router.get('/vcs/installations/:installationId', ({ ctx, path }) => {
    requireKey(ctx, 'vcs.read')
    return json(installationModel(ctx.hub.installations.get(path.installationId!)))
  })

  router.delete('/vcs/installations/:installationId', ({ ctx, path }) => {
    requireKey(ctx, 'vcs.write')
    // Installations are server-wide, so this disconnects the account from
    // every project; it does not uninstall the app on GitHub.
    ctx.hub.removeInstallation(path.installationId!)
    return noContent()
  })

  router.get('/vcs/github/installations/:installationId/providerRepositories', async ({ ctx, path, params }) => {
    requireKey(ctx, 'vcs.read')
    const installation = ctx.hub.installations.get(path.installationId!)
    const repos = await github(() => ctx.hub.github.repositories(installation.provider_installation_id, str(params.search) ?? ''))
    const type = str(params.type)
    const shown = repos.slice(0, 100)
    const models = await Promise.all(
      shown.map(async (r) => {
        if (type !== 'runtime' && type !== 'framework') return repositoryModel(r)
        try {
          const names = await folderNames(ctx.hub, installation.provider_installation_id, String(r.id), '')
          const read = (p: string) => ctx.hub.github.fileText(installation.provider_installation_id, String(r.id), p)
          return type === 'runtime'
            ? repositoryModel(r, { runtime: (await detectRuntime(names, read)).runtime })
            : repositoryModel(r, { framework: (await detectFramework(names, read)).framework })
        } catch {
          return repositoryModel(r, type === 'runtime' ? { runtime: '' } : { framework: '' })
        }
      }),
    )
    const key = type === 'runtime' ? 'runtimeProviderRepositories' : type === 'framework' ? 'frameworkProviderRepositories' : 'providerRepositories'
    return json({ total: repos.length, [key]: models, providerRepositories: models })
  })

  router.get('/vcs/github/installations/:installationId/providerRepositories/:providerRepositoryId', async ({ ctx, path }) => {
    requireKey(ctx, 'vcs.read')
    const installation = ctx.hub.installations.get(path.installationId!)
    return json(repositoryModel(await github(() => ctx.hub.github.repository(installation.provider_installation_id, path.providerRepositoryId!))))
  })

  router.get('/vcs/github/installations/:installationId/providerRepositories/:providerRepositoryId/branches', async ({ ctx, path }) => {
    requireKey(ctx, 'vcs.read')
    const installation = ctx.hub.installations.get(path.installationId!)
    const names = await github(() => ctx.hub.github.branches(installation.provider_installation_id, path.providerRepositoryId!))
    return json({ total: names.length, branches: names.map((name) => ({ name })) })
  })

  router.get('/vcs/github/installations/:installationId/providerRepositories/:providerRepositoryId/contents', async ({ ctx, path, params }) => {
    requireKey(ctx, 'vcs.read')
    const installation = ctx.hub.installations.get(path.installationId!)
    const entries = await github(() =>
      ctx.hub.github.contents(installation.provider_installation_id, path.providerRepositoryId!, str(params.providerRootDirectory) ?? '', str(params.providerReference) ?? ''),
    )
    return json({ total: entries.length, contents: entries.map((e) => ({ name: e.name, isDirectory: e.type === 'dir', size: e.size })) })
  })

  router.post('/vcs/github/installations/:installationId/detections', async ({ ctx, path, params }) => {
    requireKey(ctx, 'vcs.read')
    const installation = ctx.hub.installations.get(path.installationId!)
    const repositoryId = str(params.providerRepositoryId)
    if (!repositoryId) throw err('general_argument_invalid', 'Param "providerRepositoryId" is not optional.')
    const root = (str(params.providerRootDirectory) ?? '').replace(/^\/+|\/+$/g, '')
    const id = installation.provider_installation_id
    const names = await github(() => folderNames(ctx.hub, id, repositoryId, root))
    const read = (p: string) => ctx.hub.github.fileText(id, repositoryId, join(root, p))
    if (str(params.type) === 'runtime') return json(await detectRuntime(names, read))
    return json(await detectFramework(names, read))
  })

  // Appwrite's updateExternalDeployments: approve builds of a fork's pull request.
  router.patch('/vcs/github/installations/:installationId/repositories/:repositoryId', async ({ ctx, path, params }) => {
    requireKey(ctx, 'vcs.write')
    ctx.hub.installations.get(path.installationId!)
    const pr = str(params.providerPullRequestId)
    if (!pr) throw err('general_argument_invalid', 'Param "providerPullRequestId" is not optional.')
    const link = await github(() => ctx.hub.approve(projectOf(ctx), path.repositoryId!, pr))
    return json({
      $id: link.id,
      $createdAt: link.created_at,
      $updatedAt: link.updated_at,
      installationId: link.installation_id,
      providerRepositoryId: link.provider_repository_id,
      resourceId: link.resource_id,
      resourceType: `${link.resource_type}s`,
      providerPullRequestIds: JSON.parse(link.provider_pull_request_ids),
    })
  })
}
