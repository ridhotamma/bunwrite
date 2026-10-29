/**
 * Git deployments for the whole server. One hub owns the GitHub App and
 * answers GitHub's webhooks, which carry no project: `_vcs_repositories` in
 * the control database says which project's sites and functions a repository
 * deploys.
 *
 * - A push to a resource's production branch builds and goes live; a push to
 *   another branch builds a preview (sites get `<siteId>--git-<branch>` hosts,
 *   functions a build that is not made active).
 * - A pull request from a fork builds nothing until a project admin approves
 *   it, since builds run the repository's commands on this server.
 * - Each build sets a commit status, and one comment on the pull request lists
 *   every linked resource; `providerSilentMode` turns both off.
 *
 * Builds of one repository run one after another, in the background.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

import { deploymentDir, Deployments, unpackArchive, type DeploymentRow } from '~/functions/deployments'
import type { FunctionRow } from '~/functions/service'
import { err } from '~/lib/errors'
import type { ProjectResolver, ProjectRuntime } from '~/projects/types'
import { sitesDir } from '~/sites/paths'
import type { SiteDeploymentRow, SiteRow } from '~/sites/service'
import { GithubAppStore } from './credentials'
import { GithubClient, GithubError, verifyWebhookSignature, type GithubCommit, type GithubPull } from './github'
import { VcsInstallations, type InstallationRow } from './installations'
import { approvedPulls, RepositoryLinks, type RepositoryRow, type ResourceType } from './repositories'
import { firstLine, NO_PROVIDER, providerOf, type DeploymentSource, type ProviderSettings } from './source'
import { readState, signState } from './state'

/** A site or function that a repository deploys. */
export interface HubTarget {
  project: ProjectRuntime
  link: RepositoryRow
  type: ResourceType
  id: string
  name: string
  provider: ProviderSettings
}

interface BuildOptions {
  /** `owner/name` */
  repository: string
  branch: string
  activate: boolean
  pullRequest: number
  /** The preview host's branch: the branch itself, or `pr-<n>` for a fork's pull request. */
  previewBranch: string
  /** The pull request to keep the comment of, if any. */
  comment: PullRef | null
}

interface PullRef {
  number: number
  branch: string
  fork: boolean
}

type AnyDeployment = DeploymentRow | SiteDeploymentRow

const IN_PROGRESS = new Set(['waiting', 'processing', 'building'])

/** A folder inside the repository: no `..`, no leading slash; '' for the top. */
export function rootDirectory(value: string): string {
  const cleaned = value.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '')
  if (!cleaned || cleaned === '.') return ''
  if (isAbsolute(cleaned) || cleaned.split('/').includes('..')) throw err('general_argument_invalid', 'The root directory must be a folder inside the repository.')
  return cleaned
}

export class VcsHub {
  readonly apps: GithubAppStore
  readonly github: GithubClient
  readonly links: RepositoryLinks
  /** Server-wide installations: one account install serves every project. */
  readonly installations: VcsInstallations
  /** Milliseconds a PR comment waits for more changes before it is written. */
  commentDelayMs = 1500
  private readonly queues = new Map<string, Promise<void>>()
  private readonly background = new Set<Promise<unknown>>()
  private readonly comments = new Map<string, { pull: PullRef; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly projects: ProjectResolver) {
    const control = projects.control
    this.apps = new GithubAppStore(control.db, control.config)
    this.github = new GithubClient(
      () => this.apps.get(),
      () => ({ apiUrl: control.config.vcsGithub.apiUrl, url: control.config.vcsGithub.url }),
    )
    this.links = new RepositoryLinks(control.db)
    this.installations = new VcsInstallations(control.db)
    this.importLegacyInstallations()
  }

  /**
   * Installations used to live in each project's database. Copy them into the
   * control database and repoint their links, so upgrading does not ask an
   * admin to install the same account again. Safe to run on every start.
   */
  private importLegacyInstallations(): void {
    for (const project of this.projects.list()) {
      if (project.services.db === this.projects.control.db) continue
      let rows: InstallationRow[]
      try {
        rows = project.services.db.sqlite.query<InstallationRow, []>('SELECT * FROM _vcs_installations ORDER BY seq').all()
      } catch {
        continue
      }
      for (const row of rows) {
        const shared = this.installations.add({
          providerInstallationId: row.provider_installation_id,
          organization: row.organization,
          accountType: row.account_type,
        })
        this.links.reassignInstallation(project.info.id, row.id, shared.id)
      }
    }
  }

  private get secret(): string {
    return this.projects.control.config.secret
  }

  project(id: string): ProjectRuntime | null {
    return this.projects.get(id)
  }

  /** The server's public origin, such as https://api.example.com. */
  get publicBase(): string {
    return this.projects.control.config.publicEndpoint.replace(/\/v1\/?$/, '')
  }

  /** A link into the console that first opens `projectId`. */
  consoleUrl(projectId: string, path: string): string {
    return `${this.publicBase}/console/projects/${encodeURIComponent(projectId)}/open?next=${encodeURIComponent(path)}`
  }

  /** Wait until every queued build and pending comment is done (tests, shutdown). */
  async settled(): Promise<void> {
    for (let round = 0; round < 50; round++) {
      // Write pending comments now instead of waiting out their delay.
      const pending = [...this.comments.entries()]
      this.comments.clear()
      for (const [key, { pull, timer }] of pending) {
        clearTimeout(timer)
        this.queueComment(key, pull)
      }
      if (!this.queues.size && !this.background.size) return
      await Promise.all([...this.queues.values(), ...this.background])
    }
  }

  private track<T>(promise: Promise<T>): void {
    const p = promise.catch((error) => console.error('[vcs]', error))
    this.background.add(p)
    void p.finally(() => this.background.delete(p))
  }

  private enqueue(key: string, job: () => Promise<void>): void {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(job).catch((error) => console.error('[vcs]', error))
    this.queues.set(key, next)
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key)
    })
  }

  // ---- App setup ----

  /** The form that asks GitHub to create the server's app from a manifest. `owner` is an organization login, or '' for a personal account. */
  manifestForm(owner: string, returnTo: string): { action: string; manifest: string } {
    const base = this.publicBase
    const host = new URL(base).host
    const manifest = {
      name: `Bunwrite ${host}`.slice(0, 34),
      url: base,
      hook_attributes: { url: `${base}/v1/vcs/github/events`, active: true },
      redirect_url: `${base}/v1/vcs/github/manifest`,
      callback_urls: [`${base}/v1/vcs/github/callback`],
      request_oauth_on_install: true,
      public: false,
      default_permissions: { contents: 'read', metadata: 'read', pull_requests: 'write', statuses: 'write' },
      default_events: ['push', 'pull_request', 'delete'],
    }
    const state = signState(this.secret, { kind: 'manifest', returnTo })
    const path = owner.trim() ? `/organizations/${encodeURIComponent(owner.trim())}/settings/apps/new` : '/settings/apps/new'
    return { action: `${this.github.webUrl}${path}?state=${encodeURIComponent(state)}`, manifest: JSON.stringify(manifest) }
  }

  /**
   * GitHub made the app: store its keys and continue straight into the
   * install screen. The app is useless until it is installed, so asking for
   * one more click on the console in between only adds friction.
   */
  async completeManifest(url: URL): Promise<Response> {
    const state = readState<{ kind: string; returnTo: string }>(this.secret, url.searchParams.get('state'))
    if (state?.kind !== 'manifest') return new Response('This link has expired. Start the GitHub App setup again from the console.', { status: 400 })
    const code = url.searchParams.get('code')
    if (!code) return redirect(withFlash(state.returnTo, 'err', 'GitHub did not create the app.'))
    try {
      const app = await this.github.convertManifest(code)
      this.apps.save(app)
      return redirect(this.installUrl(state.returnTo))
    } catch (error) {
      return redirect(withFlash(state.returnTo, 'err', error instanceof Error ? error.message : String(error)))
    }
  }

  /** Where to send an admin to install the app; the installation serves every project. */
  installUrl(returnTo: string): string {
    const app = this.apps.get()
    if (!app?.slug) throw err('general_argument_invalid', 'Set up the GitHub App first (Organization → GitHub App).')
    const state = signState(this.secret, { kind: 'install', returnTo })
    return `${this.github.webUrl}/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(state)}`
  }

  /**
   * GitHub's redirect after an install. The installation is added to the
   * project only when the signed-in GitHub user can access it, so nobody can
   * connect someone else's installation by changing `installation_id`.
   */
  async completeInstall(url: URL): Promise<Response> {
    const state = readState<{ kind: string; returnTo: string; installationId?: string }>(this.secret, url.searchParams.get('state'))
    if (state?.kind !== 'install') return new Response('This link has expired. Start the installation again from the console.', { status: 400 })
    const back = (key: 'ok' | 'err', text: string) => redirect(withFlash(state.returnTo, key, text))
    if (url.searchParams.get('setup_action') === 'request') return back('ok', 'GitHub asked an organization owner to approve the installation. Add it again once they have.')
    const installationId = url.searchParams.get('installation_id') || state.installationId || ''
    if (!/^\d+$/.test(installationId)) return back('err', 'GitHub did not say which installation to add.')
    const app = this.apps.get()
    if (!app) return back('err', 'The GitHub App is not set up any more.')
    const code = url.searchParams.get('code')
    if (!code) {
      if (!app.clientId) return back('err', 'The GitHub App has no client ID, so this server cannot check who installed it. Set VCS_GITHUB_CLIENT_ID and VCS_GITHUB_CLIENT_SECRET.')
      // Ask GitHub who is signed in, then come back here with the installation in the state.
      const next = signState(this.secret, { kind: 'install', returnTo: state.returnTo, installationId }, 600)
      const authorize = `${this.github.webUrl}/login/oauth/authorize?client_id=${encodeURIComponent(app.clientId)}&state=${encodeURIComponent(next)}&redirect_uri=${encodeURIComponent(`${this.publicBase}/v1/vcs/github/callback`)}`
      return redirect(authorize)
    }
    try {
      const token = await this.github.userToken(code)
      const mine = await this.github.userInstallationIds(token)
      if (!mine.includes(installationId)) return back('err', 'Your GitHub account cannot access that installation.')
      const installation = await this.github.installation(installationId)
      this.installations.add({
        providerInstallationId: installationId,
        organization: installation.account?.login ?? '',
        accountType: installation.account?.type ?? '',
      })
      return back('ok', `Connected GitHub ${installation.account?.login ?? 'installation'}. Every project can use it now.`)
    } catch (error) {
      return back('err', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Remove a server-wide installation and disconnect every site and function
   * that deployed from it. GitHub keeps the app installed.
   */
  removeInstallation(installationId: string): void {
    const installation = this.installations.get(installationId)
    for (const link of this.links.removeForInstallation(installation.id)) {
      const project = this.projects.get(link.project_id)
      if (project) this.clearProvider(project, link.resource_type, link.resource_id)
    }
    this.installations.remove(installation.id)
    this.github.forget(installation.provider_installation_id)
  }

  // ---- Linking ----

  /**
   * Connect a function or site to a repository, or disconnect it when no
   * repository is given. Checks that the project's installation can see it.
   */
  async link(project: ProjectRuntime, type: ResourceType, id: string, provider: ProviderSettings): Promise<void> {
    this.resource(project, type, id)
    if (!provider.installationId || !provider.providerRepositoryId) {
      this.unlink(project, type, id)
      return
    }
    const installation = this.installations.get(provider.installationId)
    let repo
    try {
      repo = await this.github.repository(installation.provider_installation_id, provider.providerRepositoryId)
    } catch (error) {
      if (error instanceof GithubError && error.status === 404) throw err('provider_repository_not_found')
      throw error
    }
    const settings: ProviderSettings = {
      installationId: installation.id,
      providerRepositoryId: String(repo.id),
      providerBranch: provider.providerBranch.trim() || repo.default_branch,
      providerRootDirectory: rootDirectory(provider.providerRootDirectory),
      providerSilentMode: provider.providerSilentMode,
    }
    if (type === 'function') project.services.functions.setProvider(id, settings)
    else project.services.sites.setProvider(id, settings)
    this.links.link({
      projectId: project.info.id,
      resourceType: type,
      resourceId: id,
      installationId: installation.id,
      providerInstallationId: installation.provider_installation_id,
      providerRepositoryId: String(repo.id),
      providerRepositoryName: repo.full_name,
    })
  }

  unlink(project: ProjectRuntime, type: ResourceType, id: string): void {
    this.links.unlink(project.info.id, type, id)
    this.clearProvider(project, type, id)
  }

  /** The resource was deleted: forget its link. */
  forget(projectId: string, type: ResourceType, id: string): void {
    this.links.unlink(projectId, type, id)
  }

  private clearProvider(project: ProjectRuntime, type: ResourceType, id: string): void {
    try {
      if (type === 'function') project.services.functions.setProvider(id, NO_PROVIDER)
      else project.services.sites.setProvider(id, NO_PROVIDER)
    } catch {
      /* the resource is gone */
    }
  }

  private resource(project: ProjectRuntime, type: ResourceType, id: string): FunctionRow | SiteRow {
    return type === 'function' ? project.services.functions.fn(id) : project.services.sites.site(id)
  }

  /** The linked target for one resource, or null when it has no repository. */
  target(project: ProjectRuntime, type: ResourceType, id: string): HubTarget | null {
    const link = this.links.forResource(project.info.id, type, id)
    return link ? this.toTarget(link) : null
  }

  /** Every resource a repository deploys. Links to deleted projects or resources are dropped. */
  targets(providerRepositoryId: string): HubTarget[] {
    const out: HubTarget[] = []
    for (const link of this.links.byRepository(providerRepositoryId)) {
      const target = this.toTarget(link)
      if (target) out.push(target)
    }
    return out
  }

  private toTarget(link: RepositoryRow): HubTarget | null {
    const project = this.projects.get(link.project_id)
    if (!project) {
      this.links.removeForProject(link.project_id)
      return null
    }
    let row: FunctionRow | SiteRow
    try {
      row = this.resource(project, link.resource_type, link.resource_id)
    } catch {
      this.links.unlink(link.project_id, link.resource_type, link.resource_id)
      return null
    }
    const provider = providerOf(row)
    if (provider.providerRepositoryId !== link.provider_repository_id) return null
    return { project, link, type: link.resource_type, id: row.id, name: row.name, provider }
  }

  // ---- Deploying ----

  /** createVcsDeployment: build a branch, tag or commit of the linked repository. */
  async deployReference(project: ProjectRuntime, type: ResourceType, id: string, refType: string, reference: string, activate: boolean): Promise<AnyDeployment> {
    this.resource(project, type, id)
    const target = this.target(project, type, id)
    if (!target) throw err('general_argument_invalid', 'Connect a Git repository first (installationId and providerRepositoryId).')
    if (!['branch', 'commit', 'tag'].includes(refType)) throw err('general_argument_invalid', 'Type must be one of: branch, commit, tag.')
    const ref = reference.trim() || target.provider.providerBranch
    if (!ref) throw err('general_argument_invalid', 'Param "reference" is not optional.')
    let commit: GithubCommit
    try {
      commit = await this.github.commit(target.link.provider_installation_id, target.link.provider_repository_id, ref)
    } catch (error) {
      if (error instanceof GithubError && (error.status === 404 || error.status === 422)) throw err('general_argument_invalid', `"${ref}" is not a ${refType} of ${target.link.provider_repository_name}.`)
      throw error
    }
    const branch = refType === 'branch' ? ref : target.provider.providerBranch
    return this.start(target, commit, {
      repository: target.link.provider_repository_name,
      branch,
      activate,
      pullRequest: 0,
      previewBranch: branch,
      comment: null,
    })
  }

  /** Create the deployment now; fetch the code and build it in the background. */
  private start(target: HubTarget, commit: GithubCommit, options: BuildOptions): AnyDeployment {
    const source: DeploymentSource = {
      repository: options.repository,
      branch: options.branch,
      commitHash: commit.sha,
      commitMessage: commit.message,
      commitAuthor: commit.author,
      commitAuthorUrl: commit.authorUrl,
      commitUrl: commit.url,
      pullRequest: options.pullRequest,
    }
    const services = target.project.services
    const row =
      target.type === 'function'
        ? this.deploymentsOf(target.project).startGit(services.functions.fn(target.id), source, options.activate)
        : services.sites.startGit(services.sites.site(target.id), source, options.activate)
    this.enqueue(target.link.provider_repository_id, () => this.finish(target, row.id, commit, options))
    if (options.comment) this.scheduleComment(target.link.provider_repository_id, options.comment)
    return row
  }

  private deploymentsOf(project: ProjectRuntime): Deployments {
    return new Deployments(project.services.db, project.services.config, project.services.functions)
  }

  private consoleDeploymentUrl(target: HubTarget, deploymentId: string): string {
    return this.consoleUrl(target.project.info.id, `/console/${target.type === 'function' ? 'functions' : 'sites'}/${target.id}/deployments/${deploymentId}`)
  }

  private async finish(target: HubTarget, deploymentId: string, commit: GithubCommit, options: BuildOptions): Promise<void> {
    const services = target.project.services
    const installationId = target.link.provider_installation_id
    const repositoryId = target.link.provider_repository_id
    const logsUrl = this.consoleDeploymentUrl(target, deploymentId)
    const context = `bunwrite/${target.project.info.id}/${target.type}s/${target.id}`
    const report = async (state: 'pending' | 'success' | 'failure', description: string, targetUrl: string) => {
      if (target.provider.providerSilentMode) return
      try {
        await this.github.setStatus(installationId, repositoryId, commit.sha, { state, context, description, targetUrl })
      } catch (error) {
        console.warn(`[vcs] commit status for ${target.link.provider_repository_name}@${commit.sha.slice(0, 7)}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await report('pending', `Building ${target.name}…`, logsUrl)

    const deployments = this.deploymentsOf(target.project)
    const dir = target.type === 'function' ? deploymentDir(services.config, target.id, deploymentId) : sitesDir(services.config, target.id, deploymentId)
    let final: AnyDeployment
    try {
      const bytes = await this.fetchSource(installationId, repositoryId, commit.sha, target.provider.providerRootDirectory, dir)
      if (target.type === 'function') {
        deployments.setSourceSize(deploymentId, bytes)
        final = await deployments.build(target.id, deploymentId, { unpacked: true })
      } else {
        services.sites.setSourceSize(deploymentId, bytes)
        final = await services.sites.process(target.id, deploymentId, { unpacked: true })
      }
    } catch (error) {
      const message = `Could not fetch ${target.link.provider_repository_name}@${commit.sha.slice(0, 7)}: ${error instanceof Error ? error.message : String(error)}`
      final = target.type === 'function' ? deployments.fail(target.id, deploymentId, message) : services.sites.fail(target.id, deploymentId, message)
    }

    const ok = final.status === 'ready'
    let url = logsUrl
    if (target.type === 'site') {
      const site = services.sites.site(target.id)
      if (ok && !options.activate) services.sites.setBranchPreview(target.id, options.previewBranch, deploymentId)
      if (ok) url = options.activate ? services.sites.url(site) : services.sites.deploymentUrl(site, deploymentId)
    } else if (!options.activate) {
      deployments.prune(target.id)
    }
    await report(ok ? 'success' : 'failure', ok ? (options.activate ? 'Deployed' : 'Preview ready') : 'Build failed', url)
    if (options.comment) this.scheduleComment(repositoryId, options.comment)
  }

  /** Download the commit and move `<repo>/<rootDirectory>` into `dir`. Returns the archive size. */
  private async fetchSource(installationId: string, repositoryId: string, sha: string, root: string, dir: string): Promise<number> {
    const work = `${dir}.git`
    const archive = `${work}.tar.gz`
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    mkdirSync(dir, { recursive: true })
    try {
      const bytes = await this.github.downloadTarball(installationId, repositoryId, sha, archive)
      await unpackArchive(archive, work)
      // GitHub puts everything under one `<owner>-<repo>-<sha>/` folder.
      const entries = readdirSync(work).filter((name) => name !== 'pax_global_header')
      const top = entries.length === 1 && statSync(join(work, entries[0]!)).isDirectory() ? join(work, entries[0]!) : work
      const from = resolve(top, root || '.')
      if (from !== resolve(top) && !from.startsWith(resolve(top) + sep)) throw new Error('The root directory must be inside the repository.')
      if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(`The root directory "${root}" is not in this commit.`)
      for (const name of readdirSync(from)) renameSync(join(from, name), join(dir, name))
      return bytes
    } finally {
      rmSync(work, { recursive: true, force: true })
      rmSync(archive, { force: true })
    }
  }

  // ---- Webhooks ----

  /** POST /v1/vcs/github/events. Answers at once; the work runs in the background. */
  async webhook(request: Request): Promise<Response> {
    const app = this.apps.get()
    if (!app) return Response.json({ message: 'No GitHub App is set up on this server.', code: 404 }, { status: 404 })
    const body = new Uint8Array(await request.arrayBuffer())
    if (!verifyWebhookSignature(app.webhookSecret, body, request.headers.get('x-hub-signature-256'))) {
      return Response.json({ message: 'The webhook signature does not match.', code: 401 }, { status: 401 })
    }
    let payload: any
    try {
      payload = JSON.parse(new TextDecoder().decode(body))
    } catch {
      return Response.json({ message: 'The webhook body is not JSON.', code: 400 }, { status: 400 })
    }
    const event = request.headers.get('x-github-event') ?? ''
    this.track(this.onEvent(event, payload))
    return Response.json({ received: event }, { status: 202 })
  }

  private async onEvent(event: string, payload: any): Promise<void> {
    if (event === 'push') return this.onPush(payload)
    if (event === 'pull_request') return this.onPullRequest(payload)
    if (event === 'delete' && payload.ref_type === 'branch') return this.onBranchDeleted(String(payload.repository?.id ?? ''), String(payload.ref ?? ''))
    if (event === 'installation' && (payload.action === 'deleted' || payload.action === 'suspend')) return this.onInstallationGone(String(payload.installation?.id ?? ''))
    if (event === 'installation_repositories' && payload.action === 'removed') {
      for (const repo of payload.repositories_removed ?? []) {
        for (const link of this.links.byRepository(String(repo.id))) {
          const project = this.projects.get(link.project_id)
          if (project && link.provider_installation_id === String(payload.installation?.id)) this.unlink(project, link.resource_type, link.resource_id)
        }
      }
    }
  }

  private async onPush(payload: any): Promise<void> {
    const ref = String(payload.ref ?? '')
    if (!ref.startsWith('refs/heads/')) return
    const branch = ref.slice('refs/heads/'.length)
    const repositoryId = String(payload.repository?.id ?? '')
    if (payload.deleted) return this.onBranchDeleted(repositoryId, branch)
    const head = payload.head_commit
    if (!head || !payload.after) return
    if (/\[(skip ci|ci skip)\]/i.test(String(head.message ?? ''))) return
    const targets = this.targets(repositoryId)
    if (!targets.length) return
    const username = head.author?.username ? String(head.author.username) : ''
    const commit: GithubCommit = {
      sha: String(payload.after),
      message: String(head.message ?? ''),
      author: username || String(head.author?.name ?? ''),
      authorUrl: username ? `${this.github.webUrl}/${username}` : '',
      url: String(head.url ?? ''),
    }
    // A branch with an open pull request gets the PR comment.
    let pull: GithubPull | null = null
    if (targets.some((t) => !t.provider.providerSilentMode && branch !== t.provider.providerBranch)) {
      try {
        pull = await this.github.openPullForBranch(targets[0]!.link.provider_installation_id, repositoryId, branch)
      } catch (error) {
        console.warn(`[vcs] could not look up pull requests for ${branch}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const target of targets) {
      const production = branch === target.provider.providerBranch
      this.start(target, commit, {
        repository: String(payload.repository?.full_name ?? target.link.provider_repository_name),
        branch,
        activate: production,
        pullRequest: 0,
        previewBranch: branch,
        comment: pull && !production ? { number: pull.number, branch, fork: false } : null,
      })
    }
  }

  private async onPullRequest(payload: any): Promise<void> {
    const pr = payload.pull_request as GithubPull | undefined
    if (!pr) return
    const repositoryId = String(payload.repository?.id ?? pr.base.repo.id)
    const fork = pr.head.repo?.id !== pr.base.repo.id
    const targets = this.targets(repositoryId)
    if (!targets.length) return
    if (payload.action === 'closed') {
      if (fork) for (const t of targets) if (t.type === 'site') t.project.services.sites.removeBranch(t.id, `pr-${pr.number}`)
      return
    }
    if (!['opened', 'reopened', 'synchronize'].includes(payload.action)) return
    const pull: PullRef = { number: pr.number, branch: pr.head.ref, fork }
    // Branches of the repository itself build on push; the comment just needs to exist.
    if (!fork) {
      this.scheduleComment(repositoryId, pull)
      return
    }
    const approved = targets.filter((t) => approvedPulls(t.link).includes(String(pr.number)))
    if (approved.length) await this.buildPull(approved, pr)
    this.scheduleComment(repositoryId, pull)
  }

  /** Build a fork's pull request head on each approved target. */
  private async buildPull(targets: HubTarget[], pr: GithubPull): Promise<void> {
    const first = targets[0]!
    const commit = await this.github.commit(first.link.provider_installation_id, first.link.provider_repository_id, pr.head.sha)
    for (const target of targets) {
      this.start(target, commit, {
        repository: target.link.provider_repository_name,
        branch: pr.head.ref,
        activate: false,
        pullRequest: pr.number,
        previewBranch: `pr-${pr.number}`,
        comment: { number: pr.number, branch: pr.head.ref, fork: true },
      })
    }
  }

  /**
   * An admin approved a fork's pull request for one linked resource
   * (Appwrite's updateExternalDeployments): remember it and build the PR now.
   */
  async approve(project: ProjectRuntime, repositoryLinkId: string, pullRequest: string): Promise<RepositoryRow> {
    const link = this.links.get(repositoryLinkId)
    if (link.project_id !== project.info.id) throw err('repository_not_found')
    const number = Number(pullRequest)
    if (!Number.isInteger(number) || number < 1) throw err('general_argument_invalid', 'Param "providerPullRequestId" must be a pull request number.')
    const pr = await this.github.pull(link.provider_installation_id, link.provider_repository_id, number)
    const updated = this.links.approve(link.id, String(number))
    const target = this.toTarget(updated)
    if (target && pr.state === 'open') await this.buildPull([target], pr)
    return updated
  }

  private onBranchDeleted(repositoryId: string, branch: string): void {
    for (const target of this.targets(repositoryId)) {
      if (target.type === 'site') target.project.services.sites.removeBranch(target.id, branch)
    }
  }

  private onInstallationGone(providerInstallationId: string): void {
    const installation = this.installations.byProvider(providerInstallationId)
    if (installation) this.removeInstallation(installation.id)
    this.github.forget(providerInstallationId)
  }

  // ---- Pull request comment ----

  private scheduleComment(repositoryId: string, pull: PullRef): void {
    const key = `${repositoryId}#${pull.number}`
    const pending = this.comments.get(key)
    if (pending) clearTimeout(pending.timer)
    const timer = setTimeout(() => {
      this.comments.delete(key)
      this.queueComment(key, pull)
    }, this.commentDelayMs)
    timer.unref?.()
    this.comments.set(key, { pull, timer })
  }

  /** One write at a time per pull request, so two writes never both create a comment. */
  private queueComment(key: string, pull: PullRef): void {
    this.enqueue(`comment:${key}`, () => this.writeComment(key.split('#')[0]!, pull))
  }

  /** Create or edit the one comment that lists every linked resource for a pull request. */
  private async writeComment(repositoryId: string, pull: PullRef): Promise<void> {
    const targets = this.targets(repositoryId).filter((t) => !t.provider.providerSilentMode)
    if (!targets.length) return
    const body = this.commentBody(targets, pull)
    const installationId = targets[0]!.link.provider_installation_id
    const existing = this.links.comment(repositoryId, pull.number)
    if (existing && (await this.github.updateComment(installationId, repositoryId, existing, body))) return
    const id = await this.github.createComment(installationId, repositoryId, pull.number, body)
    this.links.setComment(repositoryId, pull.number, id)
  }

  /** The comment's Markdown. */
  commentBody(targets: HubTarget[], pull: PullRef): string {
    const rows = targets.map((t) => {
      const kind = t.type === 'site' ? 'Site' : 'Function'
      const resource = `${kind} **${escapeCell(t.name)}** \`${t.id}\``
      const project = escapeCell(t.project.info.name)
      if (pull.fork && !approvedPulls(t.link).includes(String(pull.number))) {
        const approve = this.consoleUrl(t.project.info.id, `/console/vcs/approve?repository=${t.link.id}&pr=${pull.number}`)
        return `| ${project} | ${resource} | 🔒 Waiting for approval | [Approve builds](${approve}) | |`
      }
      const d = t.type === 'site' ? t.project.services.sites.latestForBranch(t.id, pull.branch, pull.fork ? pull.number : 0) : this.deploymentsOf(t.project).latestForBranch(t.id, pull.branch, pull.fork ? pull.number : 0)
      if (!d) return `| ${project} | ${resource} | ⏳ Waiting | | |`
      const status = d.status === 'ready' ? '✅ Ready' : d.status === 'failed' ? '❌ Failed' : IN_PROGRESS.has(d.status) ? '⏳ Building' : escapeCell(d.status)
      const links = [`[Logs](${this.consoleDeploymentUrl(t, d.id)})`]
      if (t.type === 'site' && d.status === 'ready') {
        const site = t.project.services.sites.site(t.id)
        links.unshift(`[Preview](${t.project.services.sites.branchUrl(site, pull.fork ? `pr-${pull.number}` : pull.branch)})`)
      }
      const commit = d.provider_commit_hash ? `\`${d.provider_commit_hash.slice(0, 7)}\` ${escapeCell(firstLine(d.provider_commit_message)).slice(0, 60)}` : ''
      return `| ${project} | ${resource} | ${status} | ${links.join(' · ')} | ${commit} |`
    })
    return [
      '### Bunwrite deployments',
      '',
      '| Project | Resource | Status | Links | Commit |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      '',
      pull.fork ? '<sub>Pull requests from forks build only after a project admin approves them, because builds run on the server.</sub>' : '<sub>Updated on every push to this branch.</sub>',
    ].join('\n')
  }
}

const escapeCell = (value: string) => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } })

/** `path` plus `?ok=` or `?err=`, the console's flash message. */
function withFlash(path: string, key: 'ok' | 'err', text: string): string {
  const safe = path.startsWith('/console') && !path.startsWith('//') ? path : '/console'
  return `${safe}${safe.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(text)}`
}
