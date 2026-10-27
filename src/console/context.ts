/** The context every console page handler receives. */
import type { RouteContext, Router } from '~/lib/router'
import type { SchemaAdmin } from '~/schema/admin'
import type { Services } from '~/services'
import type { Admin, ConsoleAuth } from './auth'
import type { Form } from './forms'
import type { Html } from './html'
import type { Flash } from './layout'

export interface ConsoleContext {
  services: Services
  schema: SchemaAdmin
  auth: ConsoleAuth
  admin: Admin
  form: Form
  request: Request
  url: URL
  /** Render a full console page. */
  render(title: string, section: string, body: Html): Response
  /** Navigate with a flash message, htmx-aware. */
  go(location: string, flash?: Flash): Response
  /** Return to the referring page with a flash message. */
  back(flash: Flash): Response
}

export type ConsoleRoute = RouteContext<ConsoleContext>
export type ConsoleRouter = Router<ConsoleContext>
