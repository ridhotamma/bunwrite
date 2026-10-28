/** Console handlers for Git deployments. Markup lives in console/views/vcs. */
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { checked, value } from '~/console/forms'
import { html, page } from '~/console/html'
import { header } from '~/console/ui'
import { approveView, manifestRedirect, repositoryOptions } from '~/console/views/vcs'
import { SITES } from '~/console/views/sites'
import { err } from '~/lib/errors'
import type { ProjectRuntime } from '~/projects/types'
import type { GithubPull } from '~/vcs/github'
import { approvedPulls, type ResourceType } from '~/vcs/repositories'
import { providerOf, type ProviderSettings } from '~/vcs/source'

const FN = '/console/functions'

const isOwner = (ctx: ConsoleContext) => ctx.organizations.roleOf(ctx.projects.control.config.orgId, ctx.admin.email) === 'owner'

function projectOf(ctx: ConsoleContext): ProjectRuntime {
  const project = ctx.projects.get(ctx.currentProject.id)
  if (!project) throw err('project_not_found')
  return project
}

const redirect = (location: string) => new Response(null, { status: 303, headers: { location } })

/** The provider settings a resource's Git form posts. */
function providerFromForm(ctx: ConsoleContext): ProviderSettings {
  return {
    installationId: value(ctx.form, 'installation_id'),
    providerRepositoryId: value(ctx.form, 'provider_repository_id'),
    providerBranch: value(ctx.form, 'provider_branch'),
    providerRootDirectory: value(ctx.form, 'provider_root_directory'),
    providerSilentMode: checked(ctx.form.provider_silent_mode),
  }
}

export function vcsPages(router: ConsoleRouter): void {
  // ---- The server's GitHub App ----

  router.post('/console/organization/github-app', ({ ctx }) => {
    if (!isOwner(ctx)) throw err('general_argument_invalid', 'Only an organization owner can set up the GitHub App.')
    const org = value(ctx.form, 'owner_type') === 'org' ? value(ctx.form, 'org') : ''
    if (value(ctx.form, 'owner_type') === 'org' && !org) throw err('general_argument_invalid', 'Enter the GitHub organization the app belongs to.')
    const { action, manifest } = ctx.hub.manifestForm(org, '/console/organization')
    return ctx.render('GitHub App', 'organization', html`${header('GitHub App', { back: '/console/organization' })}<div class="card">${manifestRedirect(action, manifest)}</div>`)
  })

  router.post('/console/organization/github-app/delete', ({ ctx }) => {
    if (!isOwner(ctx)) throw err('general_argument_invalid', 'Only an organization owner can remove the GitHub App.')
    ctx.hub.apps.remove()
    return ctx.go('/console/organization', { tone: 'success', text: 'GitHub App removed. Delete it on GitHub too.' })
  })

  // ---- Installations ----

  router.get('/console/vcs/install', ({ ctx }) => redirect(ctx.hub.installUrl(ctx.currentProject.id, '/console/settings/git')))

  router.post('/console/vcs/installations/:id/delete', ({ ctx, path }) => {
    const installation = ctx.services.vcs.get(path.id!)
    ctx.hub.removeInstallation(projectOf(ctx), installation.id)
    return ctx.go('/console/settings/git', { tone: 'success', text: `${installation.organization || 'Installation'} removed` })
  })

  /** htmx partial: the repository select for an installation. */
  router.get('/console/vcs/repositories', async ({ ctx, url }) => {
    const installation = ctx.services.vcs.find(url.searchParams.get('installation_id') ?? '')
    if (!installation) return page(repositoryOptions([], 'Pick an account.'))
    try {
      return page(repositoryOptions(await ctx.hub.github.repositories(installation.provider_installation_id)))
    } catch (error) {
      return page(repositoryOptions([], error instanceof Error ? error.message : String(error)))
    }
  })

  // ---- Approving a fork's pull request ----

  router.get('/console/vcs/approve', async ({ ctx, url }) => {
    const link = ctx.hub.links.get(url.searchParams.get('repository') ?? '')
    if (link.project_id !== ctx.currentProject.id) throw err('repository_not_found')
    const number = Number(url.searchParams.get('pr'))
    let pull: GithubPull | null = null
    try {
      pull = await ctx.hub.github.pull(link.provider_installation_id, link.provider_repository_id, number)
    } catch {
      /* show what we know */
    }
    const target = ctx.hub.target(projectOf(ctx), link.resource_type, link.resource_id)
    return ctx.render(
      'Approve pull request',
      link.resource_type === 'site' ? 'sites' : 'functions',
      html`${header('Approve pull request')}${approveView(link, pull, number, target?.name ?? link.resource_id, approvedPulls(link).includes(String(number)))}`,
    )
  })

  router.post('/console/vcs/approve', async ({ ctx }) => {
    const link = await ctx.hub.approve(projectOf(ctx), value(ctx.form, 'repository'), value(ctx.form, 'pr'))
    const base = link.resource_type === 'site' ? `${SITES}/${link.resource_id}` : `${FN}/${link.resource_id}/deployments`
    return ctx.go(base, { tone: 'success', text: `Pull request #${value(ctx.form, 'pr')} approved; building now` })
  })

  // ---- A site's or function's repository ----

  const resources: { type: ResourceType; prefix: string; back: (id: string) => string; current: (ctx: ConsoleContext, id: string) => ProviderSettings }[] = [
    { type: 'site', prefix: SITES, back: (id) => `${SITES}/${id}/settings`, current: (ctx, id) => providerOf(ctx.services.sites.site(id)) },
    { type: 'function', prefix: FN, back: (id) => `${FN}/${id}/settings`, current: (ctx, id) => providerOf(ctx.services.functions.fn(id)) },
  ]
  for (const resource of resources) {
    router.post(`${resource.prefix}/:id/git`, async ({ ctx, path }) => {
      const before = resource.current(ctx, path.id!)
      const next = providerFromForm(ctx)
      if (!next.installationId || !next.providerRepositoryId) throw err('general_argument_invalid', 'Pick an account and a repository.')
      const project = projectOf(ctx)
      await ctx.hub.link(project, resource.type, path.id!, next)
      const after = resource.current(ctx, path.id!)
      // A new repository or production branch deploys straight away.
      if (after.providerRepositoryId !== before.providerRepositoryId || after.providerBranch !== before.providerBranch) {
        await ctx.hub.deployReference(project, resource.type, path.id!, 'branch', after.providerBranch, true)
        return ctx.go(resource.back(path.id!), { tone: 'success', text: `Connected; deploying ${after.providerBranch}` })
      }
      return ctx.go(resource.back(path.id!), { tone: 'success', text: 'Saved' })
    })

    router.post(`${resource.prefix}/:id/git/disconnect`, ({ ctx, path }) => {
      ctx.hub.unlink(projectOf(ctx), resource.type, path.id!)
      return ctx.go(resource.back(path.id!), { tone: 'success', text: 'Disconnected from Git' })
    })

    router.post(`${resource.prefix}/:id/git/deploy`, async ({ ctx, path }) => {
      const current = resource.current(ctx, path.id!)
      const d = await ctx.hub.deployReference(projectOf(ctx), resource.type, path.id!, 'branch', current.providerBranch, true)
      return ctx.go(`${resource.prefix}/${path.id}/deployments/${d.id}`, { tone: 'success', text: `Deploying ${current.providerBranch}` })
    })
  }
}
