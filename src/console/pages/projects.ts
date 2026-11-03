import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { value } from '~/console/forms'
import { html } from '~/console/html'
import { icon } from '~/console/ui'
import { organizationHeader } from '~/console/views/organization'
import { projectEditView, projectsView, type CreatedProject } from '~/console/views/projects'
import { addSeconds } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { sendMailLater } from '~/mail/mailer'

/** Projects belong to the organization; only its owners may create, rename or delete them. */
const isOwner = async (ctx: ConsoleContext) => (await ctx.organizations.roleOf(ctx.projects.control.config.orgId, ctx.admin.email)) === 'owner'

async function projectsPage(ctx: ConsoleContext, url: URL, created?: CreatedProject) {
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
    const requests = (await logs.list({ page: 1, limit: 1, project: project.info.id })).total
    const perHour = new Map((await logs.requestsByHour(since, project.info.id)).map((row) => [row.hour, row.count]))
    stats.set(project.info.id, { requests, spark: hours.map((hour) => perHour.get(hour) ?? 0) })
  }

  const org = await ctx.organizations.ensure(ctx.projects.control.config.orgId, ctx.projects.control.config.projectName)
  const members = (await ctx.organizations.members(org.id)).filter((member) => member.status === 'active').length
  const manager = (await ctx.organizations.roleOf(org.id, ctx.admin.email)) === 'owner'
  const defaultId = ctx.projects.list().length ? ctx.projects.defaultProject().info.id : ''
  const deleteId = (url.searchParams.get('delete') ?? '').trim()
  const deleteTarget = manager && ctx.admin.mfa ? all.find((project) => project.info.id === deleteId)?.info : undefined
  const create = manager ? html`<button class="primary" type="button" data-dialog-open="#create-project">${icon('plus')}<span>Create project</span></button>` : undefined
  return ctx.render(
    org.name,
    'projects',
    html`${organizationHeader(org, { projects: all.length, members }, 'projects', manager, create)}${projectsView({
      projects: filtered.map((project) => project.info),
      currentId: ctx.selectedProjectId ?? '',
      defaultId,
      query,
      view,
      stats,
      created,
      createOpen: url.searchParams.get('create') === '1',
      canManage: manager,
      deleteTarget,
    })}`,
  )
}

// Lax, like the session cookie, so the project survives a return from GitHub.
const projectCookie = (id: string, secure: boolean) =>
  `console_project=${encodeURIComponent(id)}; Path=/console; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
const clearProjectCookie = 'console_project=; Path=/console; HttpOnly; SameSite=Lax; Max-Age=0'

/** Project selection at /console, plus project create, edit, delete and switch. */
export function projectPages(router: ConsoleRouter): void {
  router.get('/console', ({ ctx, url }) => projectsPage(ctx, url))
  router.get('/console/projects', ({ ctx }) => ctx.go('/console'))

  router.post('/console', async ({ ctx }) => {
    if (!(await isOwner(ctx))) throw err('general_argument_invalid', 'Only an organization owner can create a project.')
    const created = await ctx.projects.create({
      id: value(ctx.form, 'id'),
      name: value(ctx.form, 'name'),
      orgId: ctx.projects.control.config.orgId,
    })
    return projectsPage(ctx, ctx.url, { project: created.project.info, apiKey: created.apiKey })
  })

  router.get('/console/projects/:id/open', ({ ctx, path }) => {
    const project = ctx.projects.get(path.id!)
    if (!project) throw err('general_argument_invalid', 'Unknown project.')
    // Links from outside (a GitHub PR comment) open a page inside the project.
    const next = ctx.url.searchParams.get('next') ?? ''
    return new Response(null, {
      status: 303,
      headers: {
        location: /^\/console\/[\w\-/.?=&%]*$/.test(next) && !next.includes('//') ? next : '/console/overview',
        'set-cookie': projectCookie(project.info.id, ctx.services.config.publicEndpoint.startsWith('https')),
      },
    })
  })

  router.get('/console/projects/:id/edit', async ({ ctx, path }) => {
    if (!(await isOwner(ctx))) return ctx.go('/console')
    const project = ctx.projects.get(path.id!)
    if (!project) throw err('general_argument_invalid', 'Unknown project.')
    return ctx.render(`Rename ${project.info.name}`, 'projects', projectEditView(project.info))
  })

  router.post('/console/projects/:id/edit', async ({ ctx, path }) => {
    if (!(await isOwner(ctx))) throw err('general_argument_invalid', 'Only an organization owner can edit a project.')
    const project = ctx.projects.get(path.id!)
    if (!project) throw err('general_argument_invalid', 'Unknown project.')
    const name = value(ctx.form, 'name')
    if (!name || name.length > 128) throw err('general_argument_invalid', 'A project needs a name of 128 characters or less.')
    await project.services.settings.set('project', {
      projectName: name,
      allowedOrigins: project.services.config.allowedOrigins,
      sessionDuration: project.services.config.sessionDuration,
      sessionsLimit: project.services.config.sessionsLimit,
    })
    await ctx.projects.update(path.id!, { name })
    return ctx.go('/console', { tone: 'success', text: 'Project renamed' })
  })

  router.post('/console/projects/:id/delete', async ({ ctx, path }) => {
    const id = path.id!
    if (!(await isOwner(ctx))) throw err('general_argument_invalid', 'Only an organization owner can delete a project.')
    const project = ctx.projects.get(id)
    if (!project) throw err('general_argument_invalid', 'Unknown project.')

    // With email MFA on, a project deletion needs a fresh code, not just the session cookie.
    const confirmLocation = `/console?delete=${encodeURIComponent(id)}`
    if (ctx.admin.mfa) {
      const otp = value(ctx.form, 'otp')
      const resend = value(ctx.form, 'resend') === '1'
      if (resend || !otp) {
        const control = ctx.projects.control
        if (!control.consoleMailer.enabled) {
          return ctx.go(confirmLocation, { tone: 'critical', text: 'Email is not configured, so the deletion code could not be sent.' })
        }
        // Bound both resends and the lifetime of one admin's challenge cycle.
        try {
          await ctx.limiter.hit(`console-delete-code:${ctx.admin.seq}:${ctx.ip}`, 10, 900)
        } catch {
          return ctx.go(confirmLocation, { tone: 'critical', text: 'Too many codes requested. Try again in 15 minutes.' })
        }
        const { code } = await ctx.auth.startMfaChallenge(ctx.admin.seq)
        sendMailLater(control.consoleMailer, control.templates.render('mfaChallenge', ctx.admin.email, { user: ctx.admin.email, otp: code }), 'project-delete code')
        return ctx.go(confirmLocation, {
          tone: 'success',
          text: `We emailed a six-digit code to ${ctx.admin.email}. Enter it to delete ${project.info.name}.`,
        })
      }
      try {
        await ctx.limiter.hit(`console-delete-verify:${ctx.admin.seq}:${ctx.ip}`, 10, 900)
      } catch {
        return ctx.go(confirmLocation, { tone: 'critical', text: 'Too many attempts. Try again in 15 minutes.' })
      }
      if (!(await ctx.auth.verifyMfaForAdmin(ctx.admin.seq, otp))) {
        return ctx.go(confirmLocation, {
          tone: 'critical',
          text: 'That code is not valid or has expired. Try again, or choose “Resend code”.',
        })
      }
    }

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
