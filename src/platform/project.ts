/**
 * The Project service: services, protocols, sign-in methods, policies and
 * mock phone numbers, which `appwrite pull/push settings` read and write.
 * API keys and console admins only.
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { err } from '~/lib/errors'
import { bool, json, list, noContent, str } from '~/lib/http'
import { resolveId } from '~/lib/ids'
import { page } from '~/lib/paging'
import type { Router } from '~/lib/router'
import type { ProjectInfo } from '~/projects/types'
import type { Services } from '~/services'
import type { MockPhone } from '~/settings/access'
import { localeParam, TEMPLATE_IDS, TEMPLATE_LOCALE, templateIdParam, type TemplateFields, type TemplateId } from '~/mail/templates'
import { variableModel } from '~/variables/model'
import { PROJECT_SCOPE } from '~/variables/service'

const templateModel = (id: TemplateId, t: TemplateFields) => ({ templateId: id, locale: TEMPLATE_LOCALE, ...t })

/** Appwrite's Project model, with what this server has. */
export function projectModel(info: ProjectInfo, services: Services) {
  const smtp = services.config.smtp
  return {
    $id: info.id,
    $createdAt: info.createdAt,
    $updatedAt: info.updatedAt,
    name: info.name,
    description: '',
    teamId: info.orgId,
    region: 'default',
    logo: '',
    url: '',
    legalName: '',
    legalCountry: '',
    legalState: '',
    legalCity: '',
    legalAddress: '',
    legalTaxId: '',
    devKeys: [],
    smtpEnabled: Boolean(smtp),
    smtpSenderName: smtp?.senderName ?? '',
    smtpSenderEmail: smtp?.senderEmail ?? '',
    smtpReplyToName: '',
    smtpReplyToEmail: '',
    smtpHost: smtp?.host ?? '',
    smtpPort: smtp?.port ?? 0,
    smtpUsername: smtp?.user ?? '',
    smtpPassword: '',
    smtpSecure: smtp?.secure ? 'tls' : '',
    pingCount: 0,
    pingedAt: '',
    labels: [],
    status: 'active',
    onboarding: {},
    authDuration: services.config.sessionDuration,
    authLimit: services.access.policy('user-limit').total,
    authSessionsLimit: services.config.sessionsLimit,
    authMethods: services.access.authMethods(),
    services: services.access.services(),
    protocols: services.access.protocols(),
    blocks: [],
    consoleAccessedAt: '',
    platforms: [],
    webhooks: [],
    keys: [],
  }
}

const mockModel = (m: MockPhone) => ({ $id: m.number, number: m.number, otp: m.otp, $createdAt: m.createdAt, $updatedAt: m.updatedAt })

function enabledParam(params: Record<string, unknown>): boolean {
  if (typeof params.enabled !== 'boolean') throw err('general_argument_invalid', 'Invalid `enabled` param: Value must be a valid boolean')
  return params.enabled
}

const infoOf = (ctx: AppContext): ProjectInfo => ({
  id: ctx.config.projectId,
  name: ctx.config.projectName,
  orgId: ctx.config.orgId,
  createdAt: '',
  updatedAt: '',
})

export function projectRoutes(router: Router<AppContext>): void {
  router.get('/project', ({ ctx }) => {
    requireKey(ctx, 'project.read')
    return json(projectModel(infoOf(ctx), ctx))
  })

  // Project variables: available to every site and function in this project.
  router.get('/project/variables', ({ ctx, params }) => {
    requireKey(ctx, 'project.read')
    const { total, items } = page(
      ctx.variables.list(PROJECT_SCOPE).map((v) => variableModel(v, 'project', '')),
      list(params.queries),
    )
    return json({ total, variables: items })
  })

  router.post('/project/variables', ({ ctx, params }) => {
    requireKey(ctx, 'project.write')
    const key = str(params.key) ?? ''
    const id = resolveId(params.variableId ?? 'unique()', 'Variable ID')
    const row = ctx.variables.create(
      PROJECT_SCOPE,
      id,
      key,
      str(params.value) ?? '',
      bool(params.secret, false),
    )
    // The next request starts SSR apps with the new environment.
    for (const site of ctx.sites.list()) ctx.sites.ssr.stopSite(site.id)
    return json(variableModel(row, 'project', ''), 201)
  })

  router.get('/project/variables/:variableId', ({ ctx, path }) => {
    requireKey(ctx, 'project.read')
    return json(variableModel(ctx.variables.get(PROJECT_SCOPE, path.variableId!), 'project', ''))
  })

  router.put('/project/variables/:variableId', ({ ctx, path, params }) => {
    requireKey(ctx, 'project.write')
    const row = ctx.variables.update(PROJECT_SCOPE, path.variableId!, {
      key: str(params.key),
      value: str(params.value),
      secret: params.secret === undefined ? undefined : bool(params.secret, false),
    })
    for (const site of ctx.sites.list()) ctx.sites.ssr.stopSite(site.id)
    return json(variableModel(row, 'project', ''))
  })

  router.delete('/project/variables/:variableId', ({ ctx, path }) => {
    requireKey(ctx, 'project.write')
    ctx.variables.deleteById(PROJECT_SCOPE, path.variableId!)
    for (const site of ctx.sites.list()) ctx.sites.ssr.stopSite(site.id)
    return noContent()
  })

  router.patch('/project/services/:serviceId', ({ ctx, path, params }) => {
    requireKey(ctx, 'project.write')
    ctx.access.setService(path.serviceId!, enabledParam(params))
    return json(projectModel(infoOf(ctx), ctx))
  })

  router.patch('/project/protocols/:protocolId', ({ ctx, path, params }) => {
    requireKey(ctx, 'project.write')
    ctx.access.setProtocol(path.protocolId!, enabledParam(params))
    return json(projectModel(infoOf(ctx), ctx))
  })

  router.patch('/project/auth-methods/:methodId', ({ ctx, path, params }) => {
    requireKey(ctx, 'project.write')
    ctx.access.setAuthMethod(path.methodId!, enabledParam(params))
    return json(projectModel(infoOf(ctx), ctx))
  })

  router.get('/project/policies', ({ ctx, params }) => {
    requireKey(ctx, 'policies.read')
    const { total, items } = page(ctx.access.policies(), list(params.queries))
    return json({ total, policies: items })
  })

  router.get('/project/policies/:policyId', ({ ctx, path }) => {
    requireKey(ctx, 'policies.read')
    return json(ctx.access.policy(path.policyId!))
  })

  router.patch('/project/policies/:policyId', ({ ctx, path, params }) => {
    requireKey(ctx, 'policies.write')
    return json(ctx.access.updatePolicy(path.policyId!, params))
  })

  // Email templates. Only English is sent, so `locale` must be "en" (or left out).
  router.get('/project/templates/email', ({ ctx, params }) => {
    requireKey(ctx, 'templates.read')
    // Appwrite lists the templates that were changed from their default.
    const custom = TEMPLATE_IDS.filter((id) => ctx.templates.customized(id)).map((id) => ({ $id: id, ...templateModel(id, ctx.templates.get(id)) }))
    const { total, items } = page(custom, list(params.queries))
    return json({ total, templates: items.map(({ $id: _, ...t }) => t) })
  })

  router.get('/project/templates/email/:templateId', ({ ctx, path, params }) => {
    requireKey(ctx, 'templates.read')
    const id = templateIdParam(path.templateId)
    localeParam(params.locale)
    return json(templateModel(id, ctx.templates.get(id)))
  })

  router.patch('/project/templates/email', ({ ctx, params }) => {
    requireKey(ctx, 'templates.write')
    const id = templateIdParam(params.templateId)
    localeParam(params.locale)
    return json(templateModel(id, ctx.templates.update(id, params)))
  })

  router.get('/project/mock-phones', ({ ctx, params }) => {
    requireKey(ctx, 'project.read')
    const { total, items } = page(ctx.access.mockPhones().map(mockModel), list(params.queries))
    return json({ total, mockNumbers: items.map(({ $id: _, ...m }) => m) })
  })

  router.post('/project/mock-phones', ({ ctx, params }) => {
    requireKey(ctx, 'project.write')
    const { $id: _, ...m } = mockModel(ctx.access.createMockPhone(params.number, params.otp))
    return json(m, 201)
  })

  router.get('/project/mock-phones/:number', ({ ctx, path }) => {
    requireKey(ctx, 'project.read')
    const { $id: _, ...m } = mockModel(ctx.access.mockPhone(path.number!))
    return json(m)
  })

  router.put('/project/mock-phones/:number', ({ ctx, path, params }) => {
    requireKey(ctx, 'project.write')
    const { $id: _, ...m } = mockModel(ctx.access.updateMockPhone(path.number!, params.otp))
    return json(m)
  })

  router.delete('/project/mock-phones/:number', ({ ctx, path }) => {
    requireKey(ctx, 'project.write')
    ctx.access.deleteMockPhone(path.number!)
    return noContent()
  })
}
