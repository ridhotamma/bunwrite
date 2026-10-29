/** Loads the branch and commit choices a connected resource's deploy page shows. */
import type { ConsoleContext } from './context'
import type { GitDeploySource } from './views/vcs'
import type { ResourceType } from '~/vcs/repositories'

/** The repository data for `type`/`id`, or null when it has no Git connection. */
export async function gitDeploySource(ctx: ConsoleContext, type: ResourceType, id: string): Promise<GitDeploySource | null> {
  const project = ctx.projects.get(ctx.currentProject.id)
  const target = project ? ctx.hub.target(project, type, id) : null
  if (!target) return null
  return {
    repository: target.link.provider_repository_name,
    repositoryUrl: `${ctx.hub.github.webUrl}/${target.link.provider_repository_name}`,
    branch: target.provider.providerBranch,
    ...(await ctx.hub.deployOptions(target)),
  }
}
