/** Console markup for Git deployments: the GitHub App, installations, a resource's repository, and where a deployment came from. */
import type { ConsoleContext } from '~/console/context'
import { html, type Html } from '~/console/html'
import { alert, badge, cardHead, copyableId, destroy, emptyState, icon, settingsSection, when } from '~/console/ui'
import type { FunctionRow } from '~/functions/service'
import type { SiteRow } from '~/sites/service'
import type { GithubCommit, GithubPull } from '~/vcs/github'
import type { RepositoryRow, ResourceType } from '~/vcs/repositories'
import { firstLine, type SourceColumns } from '~/vcs/source'

/** The repository part of a commit URL: <github>/<owner>/<name>. */
const repoUrlOf = (d: SourceColumns) => d.provider_commit_url.replace(/\/commit\/[^/]+$/, '')

/** A short "branch · sha message" line for deployment lists; empty for uploads. */
export function sourceCell(d: SourceColumns): Html {
  if (d.type !== 'vcs') return html`<span class="subdued">Manual</span>`
  const label = d.provider_pull_request ? `PR #${d.provider_pull_request}` : d.provider_branch
  return html`<span class="mono">${label}</span> · <a class="mono" href="${d.provider_commit_url}" target="_blank" rel="noopener">${d.provider_commit_hash.slice(0, 7)}</a>
    <div class="subdued cell-sub" title="${firstLine(d.provider_commit_message)}">${firstLine(d.provider_commit_message)}</div>`
}

/** The commit a deployment was built from, for its detail page. */
export function sourceCard(d: SourceColumns, previewUrl = ''): Html {
  if (d.type !== 'vcs') return html``
  const repoUrl = repoUrlOf(d)
  return html`<div class="card" style="margin-bottom:16px"><h2>Source</h2>
    <ul class="list">
      <li><span class="subdued">Repository</span><a href="${repoUrl}" target="_blank" rel="noopener">${d.provider_repository}</a></li>
      <li><span class="subdued">${d.provider_pull_request ? 'Pull request' : 'Branch'}</span>${
        d.provider_pull_request
          ? html`<a href="${repoUrl}/pull/${d.provider_pull_request}" target="_blank" rel="noopener">#${d.provider_pull_request}</a> <span class="mono subdued">${d.provider_branch}</span>`
          : html`<a class="mono" href="${repoUrl}/tree/${d.provider_branch}" target="_blank" rel="noopener">${d.provider_branch}</a>`
      }</li>
      <li><span class="subdued">Commit</span><span><a class="mono" href="${d.provider_commit_url}" target="_blank" rel="noopener">${d.provider_commit_hash.slice(0, 7)}</a> ${firstLine(d.provider_commit_message)}</span></li>
      ${d.provider_commit_author ? html`<li><span class="subdued">Author</span>${d.provider_commit_author_url ? html`<a href="${d.provider_commit_author_url}" target="_blank" rel="noopener">${d.provider_commit_author}</a>` : d.provider_commit_author}</li>` : ''}
      ${previewUrl ? html`<li><span class="subdued">Preview</span>${copyableId(previewUrl, 'deployment-preview-url', 'Copy preview URL')}</li>` : ''}
    </ul></div>`
}

// ---- Deploying from a connected repository ----

/** What a connected resource needs to deploy a branch or one of its commits. */
export interface GitDeploySource {
  repository: string
  repositoryUrl: string
  /** The production branch, selected by default. */
  branch: string
  branches: string[]
  commits: GithubCommit[]
  /** Why a list could not be read; that field then takes a typed value. */
  branchError?: string
  commitError?: string
}

/** A commit picker: recent commits of the selected branch, or a free-form SHA. */
export function commitOptions(commits: GithubCommit[], selected = '', branch = '', error = ''): Html {
  if (error) {
    return html`<input name="provider_commit" class="mono" value="${selected}" placeholder="A commit SHA, or empty for the newest">
      <small style="color:var(--critical)">Could not read the commits (${error}). Type a SHA instead.</small>`
  }
  if (!commits.length) {
    return html`<input name="provider_commit" class="mono" value="${selected}" placeholder="A commit SHA, or empty for the newest">
      <small>No commits found${branch ? ` on ${branch}` : ''}; empty deploys the branch's newest commit.</small>`
  }
  const labelled = commits.map((commit) => {
    const meta = [commit.author, commit.date ? when(commit.date) : ''].filter(Boolean).join(', ')
    return { value: commit.sha, label: `${commit.sha.slice(0, 7)} · ${firstLine(commit.message)}${meta ? ` — ${meta}` : ''}` }
  })
  // A commit chosen in the URL stays selected even when it is not in the list.
  if (selected && !labelled.some((commit) => commit.value === selected)) labelled.unshift({ value: selected, label: selected.slice(0, 7) })
  return html`<select name="provider_commit" class="mono" data-combobox="Commit">
    <option value="">Newest commit${branch ? ` on ${branch}` : ''}</option>
    ${labelled.map((commit) => html`<option value="${commit.value}" ${commit.value === selected ? 'selected' : ''}>${commit.label}</option>`)}
  </select>`
}

/**
 * The source part of a deploy form for a connected site or function: the
 * repository, a branch, and either its newest commit or one of its recent
 * commits. Changing the branch refreshes the commit list through htmx.
 */
export function gitDeployFields(type: ResourceType, id: string, source: GitDeploySource): Html {
  const branchId = 'deploy-branch'
  const commitsId = 'deploy-commits'
  const branchField = source.branches.length
    ? html`<select name="provider_branch" id="${branchId}" class="mono" data-combobox="Branch"
        hx-get="/console/vcs/deploy-commits?type=${type}&id=${encodeURIComponent(id)}"
        hx-target="#${commitsId}" hx-include="this" hx-trigger="change" hx-swap="innerHTML">
        ${source.branches.map((branch) => html`<option value="${branch}" ${branch === source.branch ? 'selected' : ''}>${branch}</option>`)}
      </select>`
    : html`<input name="provider_branch" class="mono" value="${source.branch}" placeholder="main">`
  return html`<p class="subdued" style="margin:0">Builds from <a href="${source.repositoryUrl}" target="_blank" rel="noopener">${source.repository}</a>. Choose a branch, then its newest commit or a specific one.</p>
    <div class="fields">
      <label>Branch${branchField}<small>Pushes to the production branch still deploy on their own.</small></label>
      <label>Commit<span id="${commitsId}" class="repo-select">${commitOptions(source.commits, '', source.branch, source.commitError)}</span><small>Pick an older commit to rebuild exactly that version.</small></label>
    </div>
    ${source.branchError ? alert('warning', html`GitHub could not list the branches (${source.branchError}). Type one instead; it is read from the repository when you deploy.`) : ''}`
}

// ---- Organization → GitHub App ----

export function githubAppSection(ctx: ConsoleContext): Html {
  const hub = ctx.hub
  const app = hub.apps.get()
  const base = hub.publicBase
  const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(base)
  const webhook = `${base}/v1/vcs/github/events`
  const body = app
    ? html`<ul class="list">
        <li><span class="subdued">App</span>${app.htmlUrl ? html`<a href="${app.htmlUrl}" target="_blank" rel="noopener">${app.name || app.slug}</a>` : app.slug || app.appId}</li>
        <li><span class="subdued">App ID</span><span class="mono">${app.appId}</span></li>
        <li><span class="subdued">Set by</span>${app.source === 'env' ? badge('VCS_GITHUB_* variables', 'info') : badge('This console', 'success')}</li>
        <li><span class="subdued">Webhook URL</span>${copyableId(webhook, 'github-webhook-url', 'Copy webhook URL')}</li>
        ${app.webhookSecret ? '' : html`<li>${badge('No webhook secret', 'critical')}<span class="subdued">Set VCS_GITHUB_WEBHOOK_SECRET, or pushes cannot be verified.</span></li>`}
      </ul>
      <p class="help">Install it from any project's <a href="/console/settings/git">Settings → Git</a>. One installation serves every project on this server.</p>`
    : html`${local ? alert('warning', html`This server's address is <code>${base}</code>. GitHub must reach <code>${webhook}</code> to send pushes, so set <code>PUBLIC_ENDPOINT</code> (or <code>DOMAIN</code>) to a public address first, or use a tunnel.`) : ''}
      <form method="post" action="/console/organization/github-app" hx-boost="false" class="stack-fields">
        <fieldset class="code-source"><legend>Owner</legend>
          <div class="choice two">
            <label><input type="radio" name="owner_type" value="user" data-show-by checked><div><b>My personal account</b><span>The app belongs to your GitHub user.</span></div></label>
            <label><input type="radio" name="owner_type" value="org" data-show-by><div><b>An organization</b><span>You need to be an owner of it.</span></div></label>
          </div>
        </fieldset>
        <div data-show-for="org" data-for-select="owner_type" hidden>
          <label>Organization<input name="org" class="mono" placeholder="acme" required><small>The organization's GitHub login.</small></label>
        </div>
        <p class="help" style="margin:0">GitHub asks you to confirm the name, then sends you back here. Or register an app yourself and set the <code>VCS_GITHUB_*</code> variables.</p>
        <div class="foot"><button class="primary">Create GitHub App</button></div>
      </form>`
  const section = settingsSection('GitHub App', 'Deploy sites and functions from GitHub: pushes build and go live, other branches get previews, and pull requests get a status comment.', body, {
    id: 'github-app',
  })
  if (!app || app.source === 'env' || !hub.apps.stored()) return section
  return html`${section}${settingsSection(
    'Remove GitHub App',
    'Connected sites and functions stop deploying. Delete the app on GitHub too.',
    destroy('/console/organization/github-app/delete', 'Remove GitHub App', 'Forget this GitHub App? Connected sites and functions stop deploying.'),
  )}`
}

/** A page that posts the manifest to GitHub on load. */
export function manifestRedirect(action: string, manifest: string): Html {
  return html`<form id="github-manifest" method="post" action="${action}">
      <input type="hidden" name="manifest" value="${manifest}">
      <p>Opening GitHub… <button class="primary">Continue to GitHub</button></p>
    </form>
    <script>document.getElementById('github-manifest').submit()</script>`
}

// ---- Project settings → Git ----

export function gitTabView(ctx: ConsoleContext): Html {
  const app = ctx.hub.apps.get()
  const installations = ctx.hub.installations.list()
  const title = 'GitHub installations'
  const hint = 'Accounts and organizations where the GitHub App is installed. Install an account once and every project on this server can deploy from its repositories.'
  if (!app) {
    return settingsSection(
      title,
      hint,
      emptyState('No GitHub App yet', 'An organization owner sets up the GitHub App once for this server.', html`<a class="btn primary" href="/console/organization#github-app">Set up the GitHub App</a>`),
      { flush: true },
    )
  }
  // GitHub is another site: a boosted (htmx) request cannot follow the redirect there.
  const toolbar = html`<div class="toolbar"><h2 style="margin:0">Installations</h2>
    <a class="btn primary" href="/console/vcs/install" hx-boost="false" style="margin-left:auto">${icon('plus')}<span>Add installation</span></a></div>`
  return settingsSection(
    title,
    hint,
    html`${toolbar}${installations.length
      ? html`<div class="scroll"><table><thead><tr><th>Account</th><th class="hide-sm">Installation ID</th><th class="hide-sm">Added</th><th class="actions-col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
          ${installations.map(
            (i) => html`<tr><td>${i.organization || '—'}<div class="subdued cell-sub">${i.account_type === 'Organization' ? 'Organization' : 'Personal account'}</div></td>
              <td class="mono subdued hide-sm">${i.provider_installation_id}</td>
              <td class="subdued hide-sm">${when(i.created_at)}</td>
              <td class="num">${destroy(`/console/vcs/installations/${i.id}/delete`, 'Remove', `Remove ${i.organization || 'this installation'}? Sites and functions that deploy from it are disconnected. The app stays installed on GitHub.`)}</td></tr>`,
          )}
        </tbody></table></div>`
      : emptyState('No installations', 'Install the GitHub App on an account or organization to pick its repositories here.')}`,
    { flush: true },
  )
}

// ---- A site's or function's repository ----

export interface GitTarget {
  type: ResourceType
  row: FunctionRow | SiteRow
  /** The resource's console URL, such as /console/sites/web. */
  base: string
}

export function gitSection(ctx: ConsoleContext, target: GitTarget): Html {
  const { row, base } = target
  const link = ctx.hub.links.forResource(ctx.currentProject.id, target.type, row.id)
  const silent = Boolean(row.provider_silent_mode)
  const hint = target.type === 'site'
    ? 'Pushes to the production branch build and go live. Other branches get a preview address, and pull requests a status comment.'
    : 'Pushes to the production branch build and become the active code. Other branches are built as checks.'
  if (link && row.provider_repository_id) {
    const repoUrl = `${ctx.hub.github.webUrl}/${link.provider_repository_name}`
    const card = settingsSection(
      'Git repository',
      hint,
      html`${cardHead(
          html`<a href="${repoUrl}" target="_blank" rel="noopener">${link.provider_repository_name}</a>`,
          html`<form method="post" action="${base}/git/deploy" class="inline"><input type="hidden" name="activate" value="on"><button>${icon('lightning')}<span>Deploy ${row.provider_branch} now</span></button></form>`,
        )}
        <form method="post" action="${base}/git" class="stack-fields">
          <input type="hidden" name="installation_id" value="${row.installation_id}">
          <input type="hidden" name="provider_repository_id" value="${row.provider_repository_id}">
          <div class="fields">
            <label>Production branch${branchField(row.provider_branch, base, { installationId: row.installation_id, repositoryId: row.provider_repository_id, required: true })}</label>
            <label>Root directory<input name="provider_root_directory" class="mono" value="${row.provider_root_directory}" placeholder="./"><small>The folder the ${target.type} is in, for monorepos.</small></label>
          </div>
          <label class="check"><input type="checkbox" name="provider_silent_mode" ${silent ? 'checked' : ''}>Silent mode: no commit statuses or pull request comments</label>
          <div class="foot"><button class="primary">Save</button></div>
        </form>`,
      { id: 'git-repository' },
    )
    const disconnect = settingsSection(
      'Disconnect repository',
      `Pushes stop deploying this ${target.type}. What is deployed now keeps running.`,
      destroy(`${base}/git/disconnect`, 'Disconnect repository', `Stop deploying from ${link.provider_repository_name}?`),
    )
    return html`${card}${disconnect}`
  }
  const installations = ctx.hub.installations.list()
  if (!ctx.hub.apps.get()) {
    return settingsSection(
      'Git repository',
      hint,
      html`<p class="subdued" style="margin:0">Set up the GitHub App once in <a href="/console/organization#github-app">Organization → GitHub App</a>, then connect this ${target.type} to a repository.</p>`,
      { id: 'git-repository' },
    )
  }
  if (!installations.length) {
    const next = encodeURIComponent(`${base}/settings`)
    return settingsSection(
      'Git repository',
      hint,
      html`<p class="subdued" style="margin:0">Connect a GitHub account once; every project can then deploy from its repositories.</p>
        <div class="foot"><a class="btn primary" href="/console/vcs/install?next=${next}" hx-boost="false">Connect GitHub</a></div>`,
      { id: 'git-repository' },
    )
  }
  return settingsSection(
    'Git repository',
    hint,
    html`<form method="post" action="${base}/git" class="stack-fields">
      ${repositoryPicker(installations, base)}
      <div class="fields">
        <label>Production branch${branchField('', base)}</label>
        <label>Root directory<input name="provider_root_directory" class="mono" placeholder="./"><small>The folder the ${target.type} is in, for monorepos.</small></label>
      </div>
      <label class="check"><input type="checkbox" name="provider_silent_mode">Silent mode: no commit statuses or pull request comments</label>
      <div class="foot"><button class="primary">Connect and deploy</button></div>
    </form>`,
    { id: 'git-repository' },
  )
}

/** DOM ids of one picker's repository select and branch select. */
function pickerIds(idBase: string): { repository: string; branch: string } {
  const slug = idBase.replace(/[^a-z0-9]+/gi, '-')
  return { repository: `repo-${slug}`, branch: `branch-${slug}` }
}

/** Installation and repository selects; the repository list loads from GitHub. */
export function repositoryPicker(installations: { id: string; organization: string }[], idBase: string): Html {
  const ids = pickerIds(idBase)
  return html`<div class="fields">
    <label>Account<select name="installation_id" hx-get="/console/vcs/repositories" hx-target="#${ids.repository}" hx-swap="innerHTML" hx-trigger="change" hx-include="this">
      ${installations.map((i) => html`<option value="${i.id}">${i.organization}</option>`)}
    </select></label>
    <label>Repository<span class="repo-select" id="${ids.repository}" hx-get="/console/vcs/repositories?installation_id=${installations[0]?.id ?? ''}&branch_target=${ids.branch}" hx-trigger="intersect once" hx-target="this" hx-swap="innerHTML">
      <select name="provider_repository_id" disabled><option>Loading…</option></select></span></label>
  </div>`
}

/**
 * The Production branch select. It starts with the branch the resource
 * already uses, so saving never silently changes it, and `GET
 * /console/vcs/branches` replaces it with the repository's branches. With
 * `installationId` and `repositoryId` the list loads on its own (a connected
 * repository); otherwise the repository select fills it through its id.
 */
function branchField(current: string, idBase: string, options: { installationId?: string; repositoryId?: string; required?: boolean } = {}): Html {
  const load =
    options.installationId && options.repositoryId
      ? html`hx-get="/console/vcs/branches?installation_id=${options.installationId}&provider_repository_id=${options.repositoryId}&selected=${current}" hx-trigger="load" hx-target="this" hx-swap="innerHTML"`
      : html``
  return html`<span class="repo-select" id="${pickerIds(idBase).branch}" ${load}>
    <select name="provider_branch" class="mono" data-combobox="Production branch" ${options.required ? 'required' : ''}>${current ? html`<option value="${current}" selected>${current}</option>` : html`<option value="">The default branch</option>`}</select></span>`
}

/**
 * The "GitHub repository" source of a create page: account, repository,
 * branch and folder. With `detectInto`, picking or changing any of them asks
 * the server to detect the build settings and swaps them into that element.
 * Otherwise a checkbox says whether the server detects them on create.
 */
export function gitSourceFields(
  installations: { id: string; organization: string }[],
  idBase: string,
  options: { detectInto?: string; detectLabel?: string; connectTo?: string; open?: boolean } = {},
): Html {
  const hidden = options.open ? '' : 'hidden'
  // The app is set up but no account is installed yet: keep the GitHub choice
  // visible and take the user through the one GitHub step.
  if (!installations.length) {
    const next = encodeURIComponent(options.connectTo ?? '/console/settings/git')
    return html`<div class="stack-fields" data-show-for="github" data-for-select="source" ${hidden}>
      <p class="subdued" style="margin:0">Connect a GitHub account once; every project on this server can then deploy from its repositories.</p>
      <div class="foot"><a class="btn primary" href="/console/vcs/install?next=${next}" hx-boost="false">Connect GitHub</a></div>
    </div>`
  }
  // hx-disinherit: the detect target belongs to the build fields, not to the
  // repository and branch requests below, whose responses swap into themselves.
  const detect = options.detectInto
    ? html`hx-get="/console/vcs/detect-site" hx-trigger="change delay:300ms, repos-loaded" hx-include="this" hx-target="#${options.detectInto}" hx-swap="innerHTML" hx-sync="this:replace" hx-disinherit="*"`
    : html``
  return html`<div class="stack-fields" data-show-for="github" data-for-select="source" ${hidden} ${detect}>
    ${repositoryPicker(installations, idBase)}
    <div class="fields">
      <label>Production branch${branchField('', idBase)}</label>
      <label>Root directory<input name="provider_root_directory" class="mono" placeholder="./"><small>For monorepos: the folder with the app's package.json.</small></label>
    </div>
    ${options.detectLabel ? html`<label class="check"><input type="checkbox" name="detect" checked>${options.detectLabel}</label>` : ''}
  </div>`
}

/** The repository select, from the installation's repositories. */
export function repositoryOptions(
  repos: { id: number; full_name: string; private: boolean }[],
  error = '',
  options: { installationId?: string; branchTarget?: string } = {},
): Html {
  if (error) return html`<select name="provider_repository_id" disabled><option>Could not load</option></select><small style="color:var(--critical)">${error}</small>`
  if (!repos.length) return html`<select name="provider_repository_id" disabled><option>No repositories</option></select><small>Give the app access to a repository on GitHub.</small>`
  // A repository is picked (on load) or changed: load its branches into the branch field.
  const branches =
    options.installationId && options.branchTarget
      ? html`hx-get="/console/vcs/branches?installation_id=${options.installationId}" hx-target="#${options.branchTarget}" hx-swap="innerHTML" hx-trigger="load, change"`
      : html``
  return html`<select name="provider_repository_id" required data-combobox="Repository" ${branches}>${repos.map((r) => html`<option value="${r.id}">${r.full_name}${r.private ? ' (private)' : ''}</option>`)}</select>`
}

/**
 * The branch select for `GET /console/vcs/branches`. The default branch comes
 * first and is labelled; a branch that is no longer listed stays selected.
 * When GitHub could not be read, a text input keeps the form usable.
 */
export function branchOptions(branches: string[], current = '', defaultBranch = '', error = ''): Html {
  if (error) return html`<input name="provider_branch" class="mono" value="${current}" placeholder="The default branch"><small style="color:var(--critical)">Could not read the branches (${error}). Type one instead.</small>`
  const ordered = defaultBranch ? [defaultBranch, ...branches.filter((name) => name !== defaultBranch)] : branches
  const names = current && !ordered.includes(current) ? [current, ...ordered] : ordered
  if (!names.length) return html`<input name="provider_branch" class="mono" value="${current}" placeholder="The default branch">`
  return html`<select name="provider_branch" class="mono" data-combobox="Production branch">${names.map((name) => html`<option value="${name}" ${name === current ? 'selected' : ''}>${name}${name === defaultBranch ? ' (default)' : ''}</option>`)}</select>`
}

// ---- Fork pull request approval ----

export function approveView(link: RepositoryRow, pull: GithubPull | null, number: number, resourceName: string, approved: boolean): Html {
  const prUrl = pull?.html_url ?? ''
  return html`<div class="card" style="max-width:640px">
    <h2>Build a pull request from a fork?</h2>
    <p>Builds run the repository's install and build commands on this server, so pull requests from forks wait for a project admin.</p>
    <ul class="list">
      <li><span class="subdued">Repository</span>${link.provider_repository_name}</li>
      <li><span class="subdued">Pull request</span>${prUrl ? html`<a href="${prUrl}" target="_blank" rel="noopener">#${number} ${pull?.title ?? ''}</a>` : `#${number}`}</li>
      ${pull ? html`<li><span class="subdued">From</span><span class="mono">${pull.head.repo?.full_name ?? 'a deleted fork'}:${pull.head.ref}</span></li>
        <li><span class="subdued">Author</span><a href="${pull.user.html_url}" target="_blank" rel="noopener">${pull.user.login}</a></li>
        <li><span class="subdued">Head commit</span><span class="mono">${pull.head.sha.slice(0, 7)}</span></li>` : ''}
      <li><span class="subdued">Builds</span>${link.resource_type === 'site' ? 'Site' : 'Function'} ${resourceName}</li>
    </ul>
    ${approved
      ? alert('success', html`This pull request is approved. New pushes to it build on their own.`)
      : html`<form method="post" action="/console/vcs/approve" class="foot">
          <input type="hidden" name="repository" value="${link.id}"><input type="hidden" name="pr" value="${String(number)}">
          <button class="primary">Approve and build</button></form>`}
  </div>`
}
