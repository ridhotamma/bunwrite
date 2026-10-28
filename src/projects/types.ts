import type { Services } from '~/services'
import type { FunctionRow } from '~/functions/service'
import type { SiteRow } from '~/sites/service'

export interface ProjectInfo {
  id: string
  name: string
  orgId: string
  createdAt: string
  updatedAt: string
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
  findFunction(functionId: string): ProjectRuntime | null
  /** The project and function a request's Host header points at, if any. */
  findFunctionByHost(host: string): { project: ProjectRuntime; fn: FunctionRow } | null
  /** The project and site a request's Host header points at, if any. */
  findSite(host: string): { project: ProjectRuntime; site: SiteRow } | null
  create(input: ProjectCreateInput): { project: ProjectRuntime; apiKey?: string }
  /** Keep the registry in step with a project's Settings page. */
  update(id: string, fields: { name?: string; orgId?: string }): ProjectInfo
  /** Delete a non-default project and its database, uploads and backups. */
  delete(id: string): Promise<void>
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
    findFunction: (functionId) => (services.functions.list().some((f) => f.id === functionId) ? runtime : null),
    findFunctionByHost: (host) => {
      const fn = services.functions.byHost(host)
      return fn ? { project: runtime, fn } : null
    },
    findSite: (host) => {
      const site = services.sites.byHost(host)
      return site ? { project: runtime, site } : null
    },
    create: () => {
      throw new Error('Project creation needs a ProjectManager.')
    },
    update: (id, fields) => {
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
      throw new Error('The default project cannot be deleted.')
    },
  }
}
