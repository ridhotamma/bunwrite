import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { value } from '~/console/forms'
import { html } from '~/console/html'
import { organizationHeader } from '~/console/views/organization'
import { projectEditView, projectsView, type CreatedProject } from '~/console/views/projects'
import { addSeconds } from '~/lib/datetime'
import { err } from '~/lib/errors'

function projectsPage(ctx: ConsoleContext, url: URL, created?: CreatedProject) {
  const query = (url.searchParams.get('q') ?? '').trim()
  const view = url.searchParams.get('view') === 'list' ? 'list' : 'grid'
  const all = ctx.projects.list()
  const filtered = query
    ? all.filter((project) => project.info.name.toLowerCase().includes(query.toLowerCase()) || project.info.id.toLowerCase().includes(query.toLowerCase()))
    : all

  const now = new Date()
  now.setUTCMinutes(0, 0, 0)
  const hours = Array.from({ length: 12 }, (_, i) => new Date(now.getTime() - (11 - i) * 3600_000).toISOString().slice(0, 13))
  const since = addSeconds(-12 * 3600)
  const stats = new Map<string, { requests: number; spark: number[] }>()
  for (const project of filtered) {
    const logs = project.services.requestLogs
    const requests = logs.list({ page: 1, limit: 1, project: project.info.id }).total
    const perHour = new Map(logs.requestsByHour(since, project.info.id).map((row) => [row.hour, row.count]))
    stats.set(project.info.id, { requests, spark: hours.map((hour) => perHour.get(hour) ?? 0) })
  }

  const org = ctx.organizations.ensure(ctx.projects.control.config.orgId, ctx.projects.control.config.projectName)
  const members = ctx.organizations.members(org.id).filter((member) => member.status === 'active').length
  const manager = ctx.organizations.roleOf(org.id, ctx.admin.email) === 'owner'
  return ctx.render(
    org.name,
    'projects',
    html`${organizationHeader(org, { projects: all.length, members }, 'projects', manager)}${projectsView({
      projects: filtered.map((project) => project.info),
      currentId: ctx.selectedProjectId ?? '',
      defaultId: ctx.projects.defaultProject().info.id,
      query,
      view,
      stats,
      created,
      createOpen: url.searchParams.get('create') === '1',
    })}`,
  )
}

const projectCookie = (id: string, secure: boolean) =>
  `console_project=${encodeURIComponent(id)}; Path=/console; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
const clearProjectCookie = 'console_project=; Path=/console; HttpOnly; SameSite=Strict; Max-Age=0'

/** Project selection at /console, plus project create, edit, delete and switch. */
export function projectPages(router: ConsoleRouter): void {
  router.get('/console', ({ ctx, url }) => projectsPage(ctx, url))
  router.get('/console/projects', ({ ctx }) => ctx.go('/console'))

  router.post('/console', ({ ctx }) => {
    const created = ctx.projects.create({
      id: value(ctx.form, 'id'),
      name: value(ctx.form, 'name'),
      orgId: ctx.projects.control.config.orgId,
    })
    return projectsPage(ctx, ctx.url, { project: created.project.info, apiKey: created.apiKey })
  })

  router.get('/console/projects/:id/open', ({ ctx, path }) => {
    const project = ctx.projects.get(path.id!)
    if (!project) throw err('general_argument_invalid', 'Unknown project.')
    return new Response(null, {
      status: 303,
      headers: {
        location: '/console/overview',
        'set-cookie': projectCookie(project.info.id, ctx.services.config.publicEndpoint.startsWith('https')),
      },
    })
  })

  router.get('/console/projects/:id/edit', ({ ctx, path }) => {
    const project = ctx.projects.get(path.id!)
    if (!project) throw err('general_argument_invalid', 'Unknown project.')
    return ctx.render(`Rename ${project.info.name}`, 'projects', projectEditView(project.info))
  })

  router.post('/console/projects/:id/edit', ({ ctx, path }) => {
    const project = ctx.projects.get(path.id!)
    if (!project) throw err('general_argument_invalid', 'Unknown project.')
    const name = value(ctx.form, 'name')
    if (!name || name.length > 128) throw err('general_argument_invalid', 'A project needs a name of 128 characters or less.')
    project.services.settings.set('project', {
      projectName: name,
      allowedOrigins: project.services.config.allowedOrigins,
      sessionDuration: project.services.config.sessionDuration,
      sessionsLimit: project.services.config.sessionsLimit,
    })
    ctx.projects.update(path.id!, { name })
    return ctx.go('/console', { tone: 'success', text: 'Project renamed' })
  })

  router.post('/console/projects/:id/delete', async ({ ctx, path }) => {
    const id = path.id!
    const wasCurrent = ctx.currentProject.id === id
    await ctx.projects.delete(id)
    const response = ctx.go('/console', { tone: 'success', text: 'Project deleted' })
    if (wasCurrent) response.headers.set('set-cookie', clearProjectCookie)
    return response
  })

  router.post('/console/projects/select', ({ ctx }) => {
    const project = ctx.projects.get(value(ctx.form, 'project'))
    if (!project) throw err('general_argument_invalid', 'Unknown project.')
    const next = value(ctx.form, 'next')
    const location = (next === '/console' || next.startsWith('/console/')) && !next.startsWith('//') ? next : '/console/overview'
    return new Response(null, {
      status: 303,
      headers: {
        location,
        'set-cookie': projectCookie(project.info.id, ctx.services.config.publicEndpoint.startsWith('https')),
      },
    })
  })
}
