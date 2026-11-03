import { dialog } from '~/console/dialog'
import { html, type Html } from '~/console/html'
import { badge, day, destroy, emptyState, header, icon, menu, tile } from '~/console/ui'
import type { ProjectInfo } from '~/projects/types'

export interface CreatedProject {
  project: ProjectInfo
  apiKey?: string
}

export interface ProjectStats {
  requests: number
  /** Request counts for the last 12 hours, oldest first. */
  spark: number[]
}

export interface ProjectsViewOptions {
  projects: ProjectInfo[]
  currentId: string
  defaultId: string
  query: string
  view: 'grid' | 'list'
  stats: Map<string, ProjectStats>
  created?: CreatedProject
  /** Open the create dialog on load, e.g. from the sidebar's "New project". */
  createOpen?: boolean
  /** Organization owners may create, rename and delete projects. */
  canManage: boolean
  /** Set when deletion needs the emailed code; opens the confirmation dialog. */
  deleteTarget?: ProjectInfo
}

const compact = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const statsFor = (options: ProjectsViewOptions, project: ProjectInfo): ProjectStats =>
  options.stats.get(project.id) ?? { requests: 0, spark: [] }

function sparkline(values: number[]): Html {
  const width = 220
  const height = 32
  const pad = 2
  const idle = !values.some((value) => value > 0)
  const max = Math.max(1, ...values)
  const points = (values.length ? values : [0, 0])
    .map((value, index, all) => {
      const x = pad + (index / Math.max(1, all.length - 1)) * (width - pad * 2)
      const y = height - pad - (value / max) * (height - pad * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return html`<svg class="project-spark ${idle ? 'idle' : ''}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`
}

function badges(project: ProjectInfo, currentId: string, defaultId: string): Html {
  return html`${project.id === currentId ? badge('Current', 'info') : ''}${project.id === defaultId ? badge('Default') : ''}`
}

/** Dialog IDs must be valid CSS selectors, and project IDs may contain dots. */
const renameId = (index: number) => `rename-project-${index}`

function projectActions(project: ProjectInfo, index: number, options: ProjectsViewOptions): Html {
  const id = encodeURIComponent(project.id)
  // Developers cannot rename or delete projects, so there is nothing to show.
  if (!options.canManage) return html``
  return menu(
    html`<button type="button" class="menu-item" data-dialog-open="#${renameId(index)}">Rename</button>
      <hr>${destroy(`/console/projects/${id}/delete`, 'Delete project', `Delete ${project.name}? This removes its database, files and backups.`)}`,
    { label: `Actions for ${project.name}` },
  )
}

function projectCard(project: ProjectInfo, index: number, options: ProjectsViewOptions): Html {
  const stats = statsFor(options, project)
  return html`<article class="project-card">
    <a class="project-card-link" href="/console/projects/${encodeURIComponent(project.id)}/open" aria-label="Open ${project.name}"></a>
    <div class="project-card-head">
      ${tile(project.name, project.id, 'lg')}
      <div class="project-card-name">
        <h3>${project.name}</h3>
        <span class="mono subdued">${project.id}</span>
      </div>
      ${projectActions(project, index, options)}
    </div>
    <div class="project-card-badges">${badges(project, options.currentId, options.defaultId)}</div>
    <div class="project-card-stats">
      <div class="project-card-requests"><b>${compact(stats.requests)}</b><span class="subdued">requests</span></div>
      <div class="project-spark-wrap">${sparkline(stats.spark)}<span class="subdued">Last 12 hours</span></div>
    </div>
  </article>`
}

function projectList(options: ProjectsViewOptions): Html {
  return html`<div class="card flush"><div class="scroll"><table><thead><tr><th>Project</th><th class="num">Requests</th><th class="hide-sm">Created</th>${options.canManage ? html`<th class="actions-col"><span class="visually-hidden">Actions</span></th>` : ''}</tr></thead><tbody>
    ${options.projects.map((project, index) => {
      const id = encodeURIComponent(project.id)
      return html`<tr>
        <td><a class="project-row" href="/console/projects/${id}/open">${tile(project.name, project.id, 'sm')}<span><b>${project.name}</b><span class="mono subdued">${project.id}</span></span></a> ${badges(project, options.currentId, options.defaultId)}</td>
        <td class="num">${compact(statsFor(options, project).requests)}</td>
        <td class="subdued hide-sm">${day(project.createdAt)}</td>
        ${options.canManage ? html`<td class="num">${projectActions(project, index, options)}</td>` : ''}
      </tr>`
    })}
  </tbody></table></div></div>`
}

function renameDialogs(projects: ProjectInfo[]): Html {
  return html`${projects.map((project, index) =>
    dialog({
      id: renameId(index),
      title: 'Rename project',
      body: html`<form id="${renameId(index)}-form" method="post" action="/console/projects/${encodeURIComponent(project.id)}/edit">
        <label>Name<input name="name" value="${project.name}" required maxlength="128"></label>
        <p class="help">The project ID <code>${project.id}</code> stays the same, so apps keep working.</p>
      </form>`,
      actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="${renameId(index)}-form" class="primary">Save</button>`,
    }),
  )}`
}

function createProjectDialog(open: boolean): Html {
  return dialog({
    id: 'create-project',
    title: 'Create project',
    open,
    body: html`<form id="create-project-form" method="post" action="/console" hx-boost="false">
      <p class="dialog-message">Each project has its own users, databases, files, functions and API keys.</p>
      <div class="stack-fields">
        <label>Name<input name="name" required data-slug-source placeholder="My app" autofocus></label>
        <label>Project ID<input name="id" class="mono" required data-slug-from="name" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}" placeholder="my-app"><small>Apps send this in <code>X-Bunwrite-Project</code> (or <code>X-Appwrite-Project</code>). It cannot change later.</small></label>
      </div>
    </form>`,
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="create-project-form" class="primary">Create project</button>`,
  })
}

function projectKeyDialog(created: CreatedProject): Html {
  const key = created.apiKey!
  return dialog({
    id: 'project-key-dialog',
    title: `${created.project.name} is ready`,
    open: true,
    body: html`<p class="dialog-message">Copy the API key now. It is shown only once.</p>
      <div class="stack-fields">
        <label>Project ID<input class="mono" readonly value="${created.project.id}"></label>
        <label>API key<span class="copy-row"><input id="project-api-key" class="mono" readonly autocomplete="off" spellcheck="false" value="${key}"><button type="button" data-copy-target="#project-api-key">${icon('copy')}<span data-copy-label>Copy</span></button></span></label>
      </div>`,
    actions: html`<button type="button" data-dialog-close>Close</button>
      <a class="btn primary" href="/console/projects/${encodeURIComponent(created.project.id)}/open">Open project</a>`,
  })
}

/** Second step of deleting a project while the admin has email MFA on. */
function deleteProjectDialog(project: ProjectInfo): Html {
  const id = encodeURIComponent(project.id)
  return dialog({
    id: 'delete-project-otp',
    title: 'Delete project',
    open: true,
    body: html`<p class="dialog-message">
        Enter the six-digit code we emailed you to delete <b>${project.name}</b>. This removes its database, files and backups, and cannot be undone.
      </p>
      <form id="delete-project-otp-form" method="post" action="/console/projects/${id}/delete">
        <label>One-time code<input name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>
        <p class="help">The code expires in 10 minutes. Choose “Resend code” if it did not arrive.</p>
      </form>`,
    actions: html`<button type="button" data-dialog-close>Cancel</button>
      <button type="submit" form="delete-project-otp-form" name="resend" value="1" formnovalidate>Resend code</button>
      <button type="submit" form="delete-project-otp-form" class="destructive">Delete project</button>`,
  })
}

export function projectsView(options: ProjectsViewOptions): Html {
  const { projects, query, view } = options
  const queryString = query ? `q=${encodeURIComponent(query)}&` : ''
  return html`<div class="page-toolbar">
      <form
        class="search-field"
        method="get"
        action="/console"
        hx-get="/console"
        hx-target="#projects-page"
        hx-select="#projects-page"
        hx-swap="outerHTML"
        hx-push-url="true"
        hx-trigger="submit">
        <span class="search-field-icon">${icon('magnifying-glass')}</span>
        <input type="search" name="q" value="${query}" placeholder="Search projects..." autocomplete="off" aria-label="Search projects">
        <input type="hidden" name="view" value="${view}">
      </form>
      <div class="page-toolbar-actions">
        <div class="seg-links" role="group" aria-label="Project layout">
          <a href="?${queryString}view=grid" class="${view === 'grid' ? 'on' : ''}" aria-label="Grid view" title="Grid">${icon('squares-four')}</a>
          <a href="?${queryString}view=list" class="${view === 'list' ? 'on' : ''}" aria-label="List view" title="List">${icon('list')}</a>
        </div>
      </div>
    </div>
    <div id="projects-page">
      ${projects.length
        ? view === 'list'
          ? projectList(options)
          : html`<div class="project-grid">${projects.map((project, index) => projectCard(project, index, options))}</div>`
        : html`<div class="card">${emptyState(
            query ? 'No matching projects' : 'No projects yet',
            query ? `Nothing matches “${query}”.` : options.canManage ? 'Create a project to get started.' : 'Ask an organization owner to create a project.',
            query
              ? html`<a class="btn" href="/console">Clear search</a>`
              : options.canManage
                ? html`<button class="primary" type="button" data-dialog-open="#create-project">Create project</button>`
                : undefined,
          )}</div>`}
      ${options.canManage ? renameDialogs(projects) : ''}
    </div>
    ${options.canManage ? createProjectDialog(Boolean(options.createOpen)) : ''}
    ${options.deleteTarget ? deleteProjectDialog(options.deleteTarget) : ''}
    ${options.created ? (options.created.apiKey ? projectKeyDialog(options.created) : html`<div class="toast" role="status">${icon('check-circle')}<span>${options.created.project.name} created</span></div>`) : ''}`
}

/** No-JavaScript fallback for the rename dialog. */
export function projectEditView(project: ProjectInfo): Html {
  return html`${header('Rename project', { back: '/console' })}
    <form method="post" action="/console/projects/${encodeURIComponent(project.id)}/edit" class="card narrow" hx-boost="false">
      <label>Name<input name="name" value="${project.name}" required autofocus maxlength="128"></label>
      <label>Project ID<input class="mono" value="${project.id}" readonly><small>Project IDs cannot change.</small></label>
      <div class="foot"><a class="btn" href="/console">Cancel</a><button class="primary">Save</button></div>
    </form>`
}
