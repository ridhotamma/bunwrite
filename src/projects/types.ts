import type { Services } from '~/services'
import { clearInstanceApiKey, clearInstanceApiKeyAsync } from '~/instance/bootstrap'
import { err } from '~/lib/errors'
import type { FunctionRow } from '~/functions/service'
import type { SiteRow } from '~/sites/service'

export interface ProjectInfo {
  id: string
  name: string
  orgId: string
  createdAt: string
  updatedAt: string
  /** True for the project used when a request does not name one. */
  isDefault?: boolean
}

export interface ProjectRuntime {
  info: ProjectInfo
  services: Services
}

export interface ProjectCreateInput {
  id: unknown
  name: unknown
  orgId: string
}

/** What the API and console need from the project registry. */
export interface ProjectResolver {
  /** The default project's services; also owns console admins and shared request logs. */
  control: Services
  defaultProject(): ProjectRuntime
  get(id: string): ProjectRuntime | null
  list(): ProjectRuntime[]
  /** Function HTTP endpoints have no project header, so find the owner by function ID. */
  findFunction(functionId: string): Promise<ProjectRuntime | null>
  /** The project and function a request's Host header points at, if any. */
  findFunctionByHost(host: string): Promise<{ project: ProjectRuntime; fn: FunctionRow } | null>
  /** The project and site a request's Host header points at, if any. */
  findSite(host: string): Promise<{ project: ProjectRuntime; site: SiteRow; deploymentId: string | null } | null>
  /** Notice projects added, removed or changed by another process. */
  sync?(): void | Promise<void>
  create(input: ProjectCreateInput): Promise<{ project: ProjectRuntime; apiKey?: string }>
  /** Keep the registry in step with a project's Settings page. */
  update(id: string, fields: { name?: string; orgId?: string }): Promise<ProjectInfo>
  /** Delete a project and its database, uploads and backups. */
  delete(id: string): Promise<void>
  /** Revoke the setup API key from the default project, once an admin exists. */
  clearDefaultApiKey(revoke?: boolean): Promise<void>
}

export function singleProjectResolver(services: Services): ProjectResolver {
  const info: ProjectInfo = {
    id: services.config.projectId,
    name: services.config.projectName,
    orgId: services.config.orgId,
    createdAt: '',
    updatedAt: '',
  }
  const runtime: ProjectRuntime = { info, services }
  return {
    control: services,
    defaultProject: () => runtime,
    get: (id) => (id === info.id ? runtime : null),
    list: () => [runtime],
    findFunction: async (functionId) => ((await services.functions.list()).some((f) => f.id === functionId) ? runtime : null),
    findFunctionByHost: async (host) => {
      const fn = await services.functions.byHost(host)
      return fn ? { project: runtime, fn } : null
    },
    findSite: async (host) => {
      const found = await services.sites.resolveHost(host)
      return found ? { project: runtime, ...found } : null
    },
    create: async () => {
      throw new Error('Project creation needs a ProjectManager.')
    },
    update: async (id, fields) => {
      if (id !== info.id) throw new Error('Unknown project.')
      if (fields.name !== undefined) {
        info.name = fields.name
        services.config.projectName = fields.name
      }
      if (fields.orgId !== undefined) {
        info.orgId = fields.orgId
        services.config.orgId = fields.orgId
      }
      return info
    },
    delete: async () => {
      throw err('general_argument_invalid', 'Create another project before deleting the last one.')
    },
    clearDefaultApiKey: async (revoke = true) => {
      if (services.db.dialect === 'sqlite') clearInstanceApiKey(services.db, revoke)
      else await clearInstanceApiKeyAsync(services.db, revoke)
      if (services.config.bootstrap) services.config.bootstrap.apiKey = undefined
    },
  }
}
