/** The context every console page handler receives. */
import type { RouteContext, Router } from '~/lib/router'
import type { OrganizationMember, OrganizationService } from '~/organizations/service'
import type { ProjectInfo, ProjectResolver } from '~/projects/types'
import type { SchemaAdmin } from '~/schema/admin'
import type { Services } from '~/services'
import type { VcsHub } from '~/vcs/hub'
import type { Observability } from '~/observability'
import type { Admin, ConsoleAuth } from './auth'
import type { Form } from './forms'
import type { Html } from './html'
import type { Flash } from './layout'
import type { RateLimiter } from '~/lib/limits'

export interface ConsoleContext {
  services: Services
  schema: SchemaAdmin
  auth: ConsoleAuth
  admin: Admin
  /** The admin's organization membership: role and display name. */
  member: OrganizationMember
  form: Form
  request: Request
  url: URL
  /** Shared console rate limiter (database-backed across workers). */
  limiter: RateLimiter
  /** Client IP resolved through the trusted-proxy list. */
  ip: string
  /** Project registry and switcher. */
  projects: ProjectResolver
  organizations: OrganizationService
  /** Git deployments: the GitHub App, installations and repository links. */
  hub: VcsHub
  /** Provider status and feature flags for the Observability pages. */
  observability: Observability
  currentProject: ProjectInfo
  /** Null on the project-selection pages before a project is chosen. */
  selectedProjectId: string | null
  /** Render a full console page. */
  render(title: string, section: string, body: Html): Response
  /** Navigate with a flash message, htmx-aware. */
  go(location: string, flash?: Flash): Response
  /** Return to the referring page with a flash message. */
  back(flash: Flash): Response
}

export type ConsoleRoute = RouteContext<ConsoleContext>
export type ConsoleRouter = Router<ConsoleContext>
